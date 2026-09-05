import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function resolveGitCommit(root, ref) {
  const value = String(ref || '').trim();
  if (!value || /[\0\r\n]/.test(value)) throw gitError('git_ref_invalid', value);
  const result = runGit(root, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], 'utf8');
  if (result.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(String(result.stdout || '').trim())) {
    throw gitError('git_ref_unverifiable', value, result);
  }
  return result.stdout.trim();
}

export function readGitBlob(root, commit, sourcePath) {
  const relativePath = normalizeGitPath(sourcePath);
  const resolvedCommit = resolveGitCommit(root, commit);
  const object = runGit(root, ['rev-parse', '--verify', '--end-of-options', `${resolvedCommit}:${relativePath}`], 'utf8');
  const objectId = String(object.stdout || '').trim();
  if (object.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(objectId)) {
    throw gitError('git_blob_unverifiable', relativePath, object);
  }
  const type = runGit(root, ['cat-file', '-t', objectId], 'utf8');
  if (type.status !== 0 || String(type.stdout || '').trim() !== 'blob') {
    throw gitError('git_object_not_blob', relativePath, type);
  }
  const blob = runGit(root, ['cat-file', 'blob', objectId], null);
  if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
    throw gitError('git_blob_unverifiable', relativePath, blob);
  }
  return { commit: resolvedCommit, object_id: objectId, path: relativePath, bytes: blob.stdout };
}

export function verifyPinnedSourceFiles({ root, sourceCommit, sourceFiles, errorPrefix = 'golden_source_unverifiable' }) {
  const sourceDrift = [];
  const proofs = [];
  for (const source of sourceFiles || []) {
    const sourcePath = normalizeGitPath(source?.path);
    let blob;
    try {
      blob = readGitBlob(root, sourceCommit, sourcePath);
    } catch (error) {
      throw sourceError(errorPrefix, sourcePath, error);
    }
    const pinnedSha256 = sha256Bytes(blob.bytes);
    if (pinnedSha256 !== source.sha256) {
      throw sourceError(errorPrefix, sourcePath, new Error(`pinned_sha256_mismatch:${pinnedSha256}`));
    }
    const currentPath = path.join(root, ...sourcePath.split('/'));
    const currentSha256 = fs.existsSync(currentPath) && fs.statSync(currentPath).isFile()
      ? sha256Bytes(fs.readFileSync(currentPath))
      : null;
    if (currentSha256 !== source.sha256) sourceDrift.push(sourcePath);
    proofs.push({ path: sourcePath, object_id: blob.object_id, sha256: pinnedSha256 });
  }
  return { source_commit: resolveGitCommit(root, sourceCommit), source_drift: sourceDrift, source_proofs: proofs };
}

function normalizeGitPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..') || /[\0\r\n]/.test(normalized)) {
    throw gitError('git_path_invalid', normalized);
  }
  return normalized;
}

function runGit(root, args, encoding) {
  return spawnSync('git', args, {
    cwd: path.resolve(root),
    encoding,
    windowsHide: true,
    shell: false,
    maxBuffer: MAX_GIT_OUTPUT_BYTES
  });
}

function gitError(code, value, result = null) {
  const error = new Error(`${code}:${value}`);
  error.code = code;
  error.details = { value, exit_status: result?.status ?? null, signal: result?.signal ?? null };
  return error;
}

function sourceError(prefix, sourcePath, cause) {
  const error = new Error(`${prefix}:${sourcePath}`);
  error.code = prefix;
  error.details = { path: sourcePath, cause: cause?.code || cause?.message || String(cause) };
  error.cause = cause;
  return error;
}
