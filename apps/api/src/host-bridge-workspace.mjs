import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STAGING_DIR } from './config.mjs';
import { HttpError, command } from './http.mjs';

export const HOST_BRIDGE_MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

export async function createHostBridgeWorkspaceBundle({ worktree, sessionId }) {
  const cwd = path.resolve(worktree?.path || '');
  if (!worktree?.id || !fs.existsSync(cwd)) throw new HttpError(409, { error: 'host_bridge_worktree_unavailable' });
  const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 15_000);
  if (status.stdout.trim()) throw new HttpError(409, { error: 'host_bridge_checkpoint_required' });
  const head = git(cwd, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
  validateBundlePaths(git(cwd, ['ls-tree', '-r', '-z', '--full-tree', head], 60_000).stdout);
  const transferId = `hbt_${randomBytes(10).toString('hex')}`;
  const bundleRef = `refs/aiws-transfer/${safe(sessionId)}-${randomBytes(6).toString('hex')}`;
  await fsp.mkdir(STAGING_DIR, { recursive: true, mode: 0o700 });
  const bundlePath = path.join(STAGING_DIR, `${transferId}.bundle`);
  git(cwd, ['update-ref', bundleRef, head], 10_000);
  try {
    git(cwd, ['bundle', 'create', bundlePath, bundleRef], 120_000);
  } finally {
    git(cwd, ['update-ref', '-d', bundleRef], 10_000, true);
  }
  const stat = await fsp.lstat(bundlePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > HOST_BRIDGE_MAX_BUNDLE_BYTES) {
    await fsp.rm(bundlePath, { force: true });
    throw new HttpError(413, { error: 'host_bridge_bundle_size_invalid', max_bytes: HOST_BRIDGE_MAX_BUNDLE_BYTES });
  }
  return {
    transfer_id: transferId,
    bundle_path: bundlePath,
    bundle_ref: bundleRef,
    base_commit: head,
    head_commit: head,
    size_bytes: stat.size,
    sha256: await fileHash(bundlePath),
    cleanup: () => fsp.rm(bundlePath, { force: true })
  };
}

export async function validateHostBridgeBundle({
  bundlePath,
  repositoryPath,
  expectedBase,
  expectedHead = null,
  maxBytes = HOST_BRIDGE_MAX_BUNDLE_BYTES
}) {
  const bundle = path.resolve(bundlePath),
    repository = path.resolve(repositoryPath),
    stat = await fsp.lstat(bundle).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes)
    throw new HttpError(413, { error: 'host_bridge_bundle_size_invalid', max_bytes: maxBytes });
  const listed = command('git', ['bundle', 'list-heads', bundle], repository, 30_000);
  const heads = String(listed.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (!listed.ok || heads.length !== 1 || !heads[0].endsWith(' refs/heads/aiws'))
    throw new HttpError(409, { error: 'host_bridge_bundle_refs_invalid' });
  if (expectedHead && !heads[0].startsWith(`${expectedHead} `))
    throw new HttpError(409, { error: 'host_bridge_bundle_head_mismatch' });
  const verify = command('git', ['bundle', 'verify', bundle], repository, 60_000);
  if (!verify.ok) throw new HttpError(409, { error: 'host_bridge_bundle_verify_failed' });
  const isolated = path.join(STAGING_DIR, `bridge-verify-${randomBytes(8).toString('hex')}`);
  await fsp.mkdir(isolated, { recursive: false, mode: 0o700 });
  try {
    let result = command('git', ['init', '--bare'], isolated, 20_000);
    if (!result.ok) throw new HttpError(409, { error: 'host_bridge_bundle_repo_init_failed' });
    result = command(
      'git',
      ['fetch', '--no-tags', bundle, 'refs/heads/aiws:refs/verify/heads/aiws'],
      isolated,
      120_000
    );
    if (!result.ok) throw new HttpError(409, { error: 'host_bridge_bundle_fetch_failed' });
    result = command('git', ['fsck', '--strict', '--no-reflogs'], isolated, 120_000);
    if (!result.ok) throw new HttpError(409, { error: 'host_bridge_bundle_fsck_failed' });
    if (expectedBase) {
      result = command('git', ['cat-file', '-e', `${expectedBase}^{commit}`], isolated, 20_000);
      if (!result.ok) throw new HttpError(409, { error: 'host_bridge_bundle_base_mismatch' });
      result = command(
        'git',
        ['merge-base', '--is-ancestor', expectedBase, 'refs/verify/heads/aiws'],
        isolated,
        20_000
      );
      if (!result.ok) throw new HttpError(409, { error: 'host_bridge_bundle_base_mismatch' });
    }
    const objects = command(
      'git',
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', '--batch-all-objects'],
      isolated,
      120_000
    );
    if (!objects.ok) throw new HttpError(409, { error: 'host_bridge_bundle_object_scan_failed' });
    validateObjects(objects.stdout);
    const tree = command('git', ['ls-tree', '-r', '-z', '--full-tree', 'refs/verify/heads/aiws'], isolated, 60_000);
    if (!tree.ok) throw new HttpError(409, { error: 'host_bridge_bundle_tree_failed' });
    validateBundlePaths(tree.stdout);
    return { ok: true, sha256: await fileHash(bundle), size_bytes: stat.size, head_commit: heads[0].split(' ')[0] };
  } finally {
    await fsp.rm(isolated, { recursive: true, force: true });
  }
}

export async function importHostBridgeWorkspaceBundle({ bundlePath, worktree, expectedBase, expectedHead }) {
  const cwd = path.resolve(worktree?.path || '');
  const verified = await validateHostBridgeBundle({ bundlePath, repositoryPath: cwd, expectedBase, expectedHead });
  const current = git(cwd, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
  if (current !== expectedBase)
    throw new HttpError(409, { error: 'host_bridge_batch_head_changed', expected: expectedBase, current });
  if (git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 15_000).stdout.trim())
    throw new HttpError(409, { error: 'host_bridge_batch_dirty' });
  const ref = `refs/aiws-return/${randomBytes(8).toString('hex')}`;
  try {
    git(cwd, ['fetch', '--no-tags', path.resolve(bundlePath), `refs/heads/aiws:${ref}`], 120_000);
    const returned = git(cwd, ['rev-parse', ref], 5_000).stdout.trim();
    if (returned !== verified.head_commit) throw new HttpError(409, { error: 'host_bridge_bundle_head_mismatch' });
    git(cwd, ['merge', '--ff-only', '--no-edit', returned], 60_000);
    return { ...verified, head_commit: returned };
  } finally {
    git(cwd, ['update-ref', '-d', ref], 10_000, true);
  }
}

function validateObjects(output) {
  const rows = String(output || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (rows.length > MAX_OBJECTS)
    throw new HttpError(413, { error: 'host_bridge_bundle_object_count_invalid', max_objects: MAX_OBJECTS });
  for (const row of rows) {
    const [, type, sizeText] = row.split(' '),
      size = Number(sizeText);
    if (type === 'blob' && (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES))
      throw new HttpError(413, { error: 'host_bridge_bundle_blob_too_large', max_bytes: MAX_BLOB_BYTES });
  }
}
function validateBundlePaths(output) {
  const casePaths = new Map();
  for (const entry of String(output || '')
    .split('\0')
    .filter(Boolean)) {
    const tab = entry.indexOf('\t'),
      meta = entry.slice(0, tab),
      file = entry.slice(tab + 1).replaceAll('\\', '/');
    if (
      !file ||
      file.startsWith('/') ||
      /^[A-Za-z]:/.test(file) ||
      file.split('/').includes('..') ||
      file.includes(':') ||
      /(^|\/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\/|$)/i.test(file)
    )
      throw new HttpError(409, { error: 'host_bridge_bundle_path_invalid' });
    if (/^120000\s/.test(meta)) throw new HttpError(409, { error: 'host_bridge_bundle_symlink_rejected', path: file });
    if (/^160000\s/.test(meta))
      throw new HttpError(409, { error: 'host_bridge_bundle_submodule_rejected', path: file });
    const folded = file.toLocaleLowerCase('en-US'),
      previous = casePaths.get(folded);
    if (previous && previous !== file)
      throw new HttpError(409, { error: 'host_bridge_bundle_case_collision', paths: [previous, file] });
    casePaths.set(folded, file);
  }
}
function git(cwd, args, timeout, allowFailure = false) {
  const result = command('git', args, cwd, timeout);
  if (!allowFailure && !result.ok)
    throw new HttpError(409, {
      error: 'host_bridge_git_failed',
      detail: String(result.stderr || result.error || '').slice(-1000)
    });
  return result;
}
function safe(value) {
  return String(value || 'session')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
}
async function fileHash(file) {
  const digest = crypto.createHash('sha256'),
    stream = fs.createReadStream(file);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}
