import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MAX_GIT_BUNDLE_BYTES = 100 * 1024 * 1024;
export const GIT_BUNDLE_MEDIA_TYPE = 'application/x-git-bundle';

const GIT_LINK_MODES = new Set(['120000', '160000']);

export class TerminalBundleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TerminalBundleError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new TerminalBundleError(code, message, details);
}

function asAbsolute(root, value) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, String(value || ''));
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    fail('bundle_path_outside_root', 'bundle path must remain inside the managed root', { path: resolved });
  }
  return resolved;
}

function normalizedPath(value) {
  const raw = String(value || '').replaceAll('\\', '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    fail('bundle_path_invalid', 'repository entry path is invalid', { path: raw });
  }
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail('bundle_path_invalid', 'repository entry path contains traversal', { path: raw });
  }
  return parts.join('/');
}

function lstatOrFail(target, code, message) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    fail(code, message, { path: target, cause: error?.code || 'missing' });
  }
  return stat;
}

function assertNoSymlinkComponents(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    fail('bundle_path_outside_root', 'path escapes the managed root', { path: resolved });
  }
  const components = [base, ...path.relative(base, resolved).split(path.sep).filter(Boolean).map((part, index, parts) => path.join(base, ...parts.slice(0, index + 1)))];
  for (const component of components) {
    if (fs.existsSync(component) && fs.lstatSync(component).isSymbolicLink()) {
      fail('bundle_symlink_not_allowed', 'symlink path components are not allowed', { path: component });
    }
  }
}

function inspectFilesystem(root, excludedPath = null) {
  const files = [];
  const directories = [];
  const entries = [];
  const excluded = excludedPath ? path.resolve(excludedPath) : null;
  const visit = (current, relative = '') => {
    const names = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of names) {
      const target = path.join(current, entry.name);
      if (excluded && path.resolve(target) === excluded) continue;
      const rel = normalizedPath(relative ? `${relative}/${entry.name}` : entry.name);
      const stat = lstatOrFail(target, 'bundle_source_unavailable', 'repository entry cannot be inspected');
      entries.push(rel);
      if (stat.isSymbolicLink()) fail('bundle_symlink_not_allowed', 'repository symlinks cannot be packed', { path: rel });
      if (entry.name === '.git' && relative) fail('bundle_nested_git_not_allowed', 'nested Git metadata cannot be packed', { path: rel });
      if (stat.isDirectory()) {
        directories.push(rel);
        if (entry.name !== '.git') visit(target, rel);
      } else if (stat.isFile()) files.push(rel);
      else fail('bundle_entry_type_invalid', 'repository entry is not a regular file or directory', { path: rel });
    }
  };
  visit(root);
  return { files, directories, entries };
}

function parseGitIndexEntries(output) {
  const entries = [];
  for (const record of String(output || '').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const header = record.slice(0, tab).split(' ');
    const mode = header[0];
    const object = header[1];
    const entryPath = record.slice(tab + 1);
    entries.push({ mode, object, path: entryPath });
  }
  return entries;
}

async function git(repositoryRoot, args, options = {}) {
  try {
    const result = await execFileAsync('git', ['-c', `safe.directory=${repositoryRoot}`, '-C', repositoryRoot, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024
    });
    return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  } catch (error) {
    fail(options.code || 'bundle_git_failed', options.message || 'Git bundle operation failed', {
      exit_code: error?.code,
      stderr: String(error?.stderr || '').slice(0, 512)
    });
  }
}

function assertRepositoryRoot(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const stat = lstatOrFail(root, 'bundle_source_unavailable', 'repository root is unavailable');
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('bundle_source_invalid', 'repository root must be a regular directory', { path: root });
  const gitPath = path.join(root, '.git');
  const gitStat = lstatOrFail(gitPath, 'bundle_source_invalid', 'repository does not contain Git metadata');
  if (gitStat.isSymbolicLink()) fail('bundle_symlink_not_allowed', 'Git metadata cannot be a symlink', { path: gitPath });
  return root;
}

export function inspectRepositoryTree(repositoryRoot, options = {}) {
  const root = assertRepositoryRoot(repositoryRoot);
  const excluded = options.outputPath ? path.resolve(String(options.outputPath)) : null;
  const tree = inspectFilesystem(root, excluded);
  const collisions = new Map();
  for (const entry of tree.entries) {
    const key = entry.normalize('NFC').toLowerCase();
    const values = collisions.get(key) || [];
    values.push(entry);
    collisions.set(key, values);
  }
  const caseCollisions = [...collisions.values()].filter((values) => new Set(values).size > 1).map((pathsValue) => pathsValue.sort());
  return { repository_root: root, files: tree.files.sort(), directories: tree.directories.sort(), entries: tree.entries.sort(), case_collisions: caseCollisions };
}

export async function validateRepositoryTree(repositoryRoot, options = {}) {
  const report = inspectRepositoryTree(repositoryRoot, options);
  if (report.case_collisions.length) {
    fail('bundle_case_collision', 'repository contains case-colliding paths', { paths: report.case_collisions });
  }
  const tracked = await git(report.repository_root, ['ls-files', '--stage', '-z'], { code: 'bundle_source_invalid', message: 'cannot inspect the Git index' });
  const links = [];
  for (const entry of parseGitIndexEntries(tracked.stdout)) {
    if (GIT_LINK_MODES.has(entry.mode)) links.push(entry);
    normalizedPath(entry.path);
  }
  if (links.length) {
    const submodule = links.find((entry) => entry.mode === '160000');
    if (submodule) fail('bundle_submodule_not_allowed', 'submodules cannot be packed into a native terminal bundle', { path: submodule.path, object: submodule.object });
    const symlink = links.find((entry) => entry.mode === '120000');
    if (symlink) fail('bundle_symlink_not_allowed', 'tracked symlinks cannot be packed', { path: symlink.path });
  }
  await git(report.repository_root, ['rev-parse', '--is-inside-work-tree'], { code: 'bundle_source_invalid', message: 'source is not a Git worktree' });
  return { ...report, tracked_entries: parseGitIndexEntries(tracked.stdout).map((entry) => ({ path: normalizedPath(entry.path), mode: entry.mode, object: entry.object })) };
}

export const validateRepositoryForBundle = validateRepositoryTree;

function validateRef(ref) {
  const value = String(ref || 'HEAD').trim();
  if (!value || value.startsWith('-') || value.includes('..') || /[\u0000-\u001f\u007f\\\s]/.test(value)) {
    fail('bundle_ref_invalid', 'Git ref is invalid', { ref: value });
  }
  return value;
}

function resolveOutputPath(repositoryRoot, outputPath, outputRoot = null) {
  const root = path.resolve(repositoryRoot);
  const base = outputRoot ? path.resolve(outputRoot) : root;
  const output = path.isAbsolute(String(outputPath || '')) ? path.resolve(String(outputPath)) : path.resolve(base, String(outputPath || ''));
  if (output !== base && !output.startsWith(`${base}${path.sep}`)) fail('bundle_output_outside_root', 'bundle output is outside the permitted directory', { path: output });
  assertNoSymlinkComponents(base, path.dirname(output));
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (stat.isSymbolicLink()) fail('bundle_symlink_not_allowed', 'bundle output cannot be a symlink', { path: output });
    if (!stat.isFile()) fail('bundle_output_invalid', 'bundle output must be a regular file', { path: output });
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  assertNoSymlinkComponents(base, path.dirname(output));
  return output;
}

function hashFile(file) {
  const stat = fs.statSync(file);
  const digest = createHash('sha256');
  const stream = fs.createReadStream(file);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve({ size_bytes: stat.size, sha256: digest.digest('hex') }));
  });
}

function parseBundleHeads(output) {
  return String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sha, ...refParts] = line.split(/\s+/);
    return { sha, ref: refParts.join(' ') };
  }).filter((entry) => /^[a-f0-9]{40}$/.test(entry.sha));
}

function createArguments(repositoryRoot, output, ref, options) {
  const args = ['bundle', 'create', output, ref];
  const exclusions = Array.isArray(options.exclude) ? options.exclude : options.exclude ? [options.exclude] : [];
  for (const exclusion of exclusions) {
    const value = String(exclusion).trim();
    if (!/^[a-f0-9]{40}$/.test(value)) fail('bundle_ref_invalid', 'bundle exclusion must be a commit SHA', { exclusion: value });
    args.push(`^${value}`);
  }
  return args;
}

function normalizeCreateInput(repositoryOrInput, outputPath, options) {
  if (repositoryOrInput && typeof repositoryOrInput === 'object' && !Array.isArray(repositoryOrInput)) {
    return { ...repositoryOrInput };
  }
  return { repositoryRoot: repositoryOrInput, outputPath, ...(options || {}) };
}

export async function createGitBundle(repositoryOrInput, outputPath, options = {}) {
  const input = normalizeCreateInput(repositoryOrInput, outputPath, options);
  const root = assertRepositoryRoot(input.repositoryRoot || input.repository_root);
  const destination = resolveOutputPath(root, input.outputPath || input.output_path || 'repository.bundle', input.outputRoot || input.output_root || null);
  const ref = validateRef(input.ref || 'HEAD');
  await validateRepositoryTree(root, { outputPath: destination });
  const resolved = await git(root, ['rev-parse', '--verify', `${ref}^{commit}`], { code: 'bundle_ref_invalid', message: 'Git ref cannot be resolved' });
  const headSha = resolved.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(headSha)) fail('bundle_ref_invalid', 'Git ref did not resolve to a commit', { ref });
  try {
    await git(root, createArguments(root, destination, ref, input), { code: 'bundle_create_failed', message: 'Git bundle creation failed', timeout: input.timeoutMs || 120_000 });
    const stat = lstatOrFail(destination, 'bundle_output_missing', 'Git bundle output is missing');
    if (stat.isSymbolicLink() || !stat.isFile()) fail('bundle_output_invalid', 'Git bundle output is not a regular file', { path: destination });
    if (stat.size > (input.maxBytes || MAX_GIT_BUNDLE_BYTES)) fail('bundle_too_large', 'Git bundle exceeds the configured size limit', { size_bytes: stat.size, limit: input.maxBytes || MAX_GIT_BUNDLE_BYTES });
    await git(root, ['bundle', 'verify', destination], { code: 'bundle_verify_failed', message: 'Git bundle verification failed' });
    const heads = parseBundleHeads((await git(root, ['bundle', 'list-heads', destination], { code: 'bundle_verify_failed', message: 'Git bundle refs cannot be read' })).stdout);
    const digest = await hashFile(destination);
    return {
      path: destination,
      relative_path: path.relative(root, destination).replaceAll('\\', '/'),
      media_type: GIT_BUNDLE_MEDIA_TYPE,
      sha256: digest.sha256,
      size_bytes: digest.size_bytes,
      ref,
      head_sha: headSha,
      refs: heads,
      verified: true
    };
  } catch (error) {
    try { fs.rmSync(destination, { force: true }); } catch { /* Remove incomplete output on failure. */ }
    throw error;
  }
}

export async function verifyGitBundle(bundlePath, expected = {}) {
  const file = path.resolve(String(bundlePath || ''));
  const stat = lstatOrFail(file, 'bundle_output_missing', 'Git bundle output is missing');
  if (stat.isSymbolicLink() || !stat.isFile()) fail('bundle_output_invalid', 'Git bundle must be a regular file', { path: file });
  const maxBytes = Number(expected.maxBytes || MAX_GIT_BUNDLE_BYTES);
  if (stat.size > maxBytes) fail('bundle_too_large', 'Git bundle exceeds the configured size limit', { size_bytes: stat.size, limit: maxBytes });
  const digest = await hashFile(file);
  if (expected.sha256 && String(expected.sha256) !== digest.sha256) fail('bundle_hash_mismatch', 'Git bundle SHA-256 does not match metadata', { expected: expected.sha256, actual: digest.sha256 });
  const cwd = path.dirname(file);
  try { await execFileAsync('git', ['bundle', 'verify', file], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 }); }
  catch (error) { fail('bundle_verify_failed', 'Git bundle verification failed', { stderr: String(error?.stderr || '').slice(0, 512) }); }
  let heads;
  try {
    const result = await execFileAsync('git', ['bundle', 'list-heads', file], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    heads = parseBundleHeads(result.stdout);
  } catch (error) { fail('bundle_verify_failed', 'Git bundle refs cannot be read', { stderr: String(error?.stderr || '').slice(0, 512) }); }
  if (expected.ref && !heads.some((entry) => entry.ref === expected.ref || entry.ref.endsWith(`/${expected.ref}`))) fail('bundle_ref_mismatch', 'Git bundle does not contain the expected ref', { expected: expected.ref, refs: heads });
  if (expected.head_sha && !heads.some((entry) => entry.sha === expected.head_sha)) fail('bundle_head_mismatch', 'Git bundle does not contain the expected commit', { expected: expected.head_sha, refs: heads });
  return { path: file, sha256: digest.sha256, size_bytes: digest.size_bytes, refs: heads, verified: true };
}

export const validateGitBundle = verifyGitBundle;
export const createWindowsGitBundle = createGitBundle;
