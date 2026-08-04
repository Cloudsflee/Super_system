#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_SNAPSHOT_SCHEMA = 'aiws.source_snapshot.v1';

const SNAPSHOT_FIELDS = ['base_sha', 'entries', 'files', 'head_sha', 'schema_version', 'source_sha256', 'tree_sha'],
  ENTRY_FIELDS = ['mode', 'object_id', 'object_type', 'path'];

export function buildSourceSnapshot({ root, baseSha, headSha, treeSha }) {
  const sourceRoot = path.resolve(required(root, 'source_snapshot_root_required')),
    base = resolveCommit(sourceRoot, baseSha, 'source_snapshot_base_sha_invalid'),
    head = resolveCommit(sourceRoot, headSha, 'source_snapshot_head_sha_invalid'),
    tree = resolveTree(sourceRoot, head),
    expectedTree = commitSha(treeSha, 'source_snapshot_tree_sha_invalid');
  if (head !== resolveCommit(sourceRoot, 'HEAD', 'source_snapshot_head_mismatch'))
    throw snapshotError('source_snapshot_head_mismatch');
  if (tree !== expectedTree) throw snapshotError('source_snapshot_tree_mismatch');
  if (gitBuffer(sourceRoot, ['status', '--porcelain=v1', '-z']).length)
    throw snapshotError('source_snapshot_worktree_not_clean');
  const entries = parseTree(gitBuffer(sourceRoot, ['ls-tree', '-r', '-z', '--full-tree', head])),
    payload = {
      schema_version: SOURCE_SNAPSHOT_SCHEMA,
      base_sha: base,
      head_sha: head,
      tree_sha: tree,
      files: entries.map((entry) => entry.path),
      entries
    };
  return { ...payload, source_sha256: documentHash(payload) };
}

export function validateSourceSnapshot(value) {
  if (!value || value.schema_version !== SOURCE_SNAPSHOT_SCHEMA) throw snapshotError('source_snapshot_schema_invalid');
  if (!hasExactFields(value, SNAPSHOT_FIELDS)) throw snapshotError('source_snapshot_fields_invalid');
  const entries = Array.isArray(value.entries) ? value.entries : null,
    files = Array.isArray(value.files) ? value.files : null;
  if (!entries || !files || entries.length !== files.length || entries.length === 0)
    throw snapshotError('source_snapshot_entries_invalid');
  if (
    commitSha(value.base_sha, 'source_snapshot_base_sha_invalid') !== value.base_sha ||
    commitSha(value.head_sha, 'source_snapshot_head_sha_invalid') !== value.head_sha ||
    commitSha(value.tree_sha, 'source_snapshot_tree_sha_invalid') !== value.tree_sha
  )
    throw snapshotError('source_snapshot_identity_not_canonical');
  let previous = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index],
      file = files[index];
    if (!validSnapshotEntry(entry, file, previous)) throw snapshotError('source_snapshot_entries_invalid');
    previous = file;
  }
  const payload = {
    schema_version: value.schema_version,
    base_sha: value.base_sha,
    head_sha: value.head_sha,
    tree_sha: value.tree_sha,
    files,
    entries
  };
  if (value.source_sha256 !== documentHash(payload)) throw snapshotError('source_snapshot_hash_invalid');
  return { ...payload, source_sha256: value.source_sha256 };
}

export function readSourceSnapshot(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw snapshotError('source_snapshot_read_invalid', { reason: error.code || error.message });
  }
  return validateSourceSnapshot(value);
}

export function writeSourceSnapshot(file, value) {
  validateSourceSnapshot(value);
  const output = path.resolve(file),
    directory = path.dirname(output),
    temporary = `${output}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, output);
}

function validSnapshotEntry(entry, file, previous) {
  return Boolean(
    entry &&
    hasExactFields(entry, ENTRY_FIELDS) &&
    entry.path === file &&
    safeRelativePath(file) &&
    /^(100644|100755|120000|160000)$/.test(entry.mode || '') &&
    ['blob', 'commit'].includes(entry.object_type) &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.object_id || '') &&
    (entry.mode === '160000') === (entry.object_type === 'commit') &&
    (previous == null || comparePath(previous, file) < 0)
  );
}

function hasExactFields(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function parseTree(buffer) {
  return Buffer.from(buffer)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf('\t'),
        metadata = record.slice(0, separator).split(' '),
        file = record.slice(separator + 1);
      if (separator < 0 || metadata.length !== 3 || !safeRelativePath(file))
        throw snapshotError('source_snapshot_tree_record_invalid');
      return { path: file, mode: metadata[0], object_type: metadata[1], object_id: metadata[2] };
    })
    .sort((left, right) => comparePath(left.path, right.path));
}

function safeRelativePath(value) {
  return Boolean(
    typeof value === 'string' &&
    value &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.split('/').includes('..') &&
    path.posix.normalize(value) === value
  );
}

function resolveCommit(root, value, code) {
  const reference = String(value || '').trim();
  if (!reference) throw snapshotError(code);
  const resolved = gitBuffer(root, ['rev-parse', '--verify', `${reference}^{commit}`])
    .toString('utf8')
    .trim()
    .toLowerCase();
  return commitSha(resolved, code);
}

function resolveTree(root, head) {
  const resolved = gitBuffer(root, ['rev-parse', '--verify', `${head}^{tree}`])
    .toString('utf8')
    .trim()
    .toLowerCase();
  return commitSha(resolved, 'source_snapshot_tree_sha_invalid');
}

function gitBuffer(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw snapshotError('source_snapshot_git_failed', {
      args,
      stderr: Buffer.from(result.stderr || '')
        .toString('utf8')
        .trim()
        .slice(0, 1000)
    });
  return Buffer.from(result.stdout || '');
}

function commitSha(value, code) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) throw snapshotError(code);
  return normalized;
}

function documentHash(value) {
  return createHash('sha256')
    .update(Buffer.from(JSON.stringify(value), 'utf8'))
    .digest('hex');
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function required(value, code) {
  if (!value) throw snapshotError(code);
  return value;
}

function snapshotError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function parseCli(argv) {
  const options = {},
    fields = {
      '--git-root': 'root',
      '--output': 'output',
      '--base': 'baseSha',
      '--head': 'headSha',
      '--tree': 'treeSha'
    };
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields[argv[index]],
      value = argv[index + 1];
    if (!field || value == null) throw snapshotError('source_snapshot_argument_invalid', { argument: argv[index] });
    options[field] = value;
    index += 1;
  }
  return options;
}

function runCli(argv) {
  const options = parseCli(argv),
    root = path.resolve(required(options.root, 'source_snapshot_root_required')),
    output = path.resolve(required(options.output, 'source_snapshot_output_required')),
    relativeOutput = path.relative(root, output);
  if (relativeOutput === '' || (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput)))
    throw snapshotError('source_snapshot_output_inside_root');
  const snapshot = buildSourceSnapshot(options);
  writeSourceSnapshot(output, snapshot);
  process.stdout.write(`${JSON.stringify({ files: snapshot.files.length, source_sha256: snapshot.source_sha256 })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.code || error.message}\n`);
    process.exitCode = 1;
  }
}
