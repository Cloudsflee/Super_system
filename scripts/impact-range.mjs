import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { normalizePath } from './v175-lib.mjs';
import { readSourceSnapshot } from './source-snapshot.mjs';

export function collectImpactRange({ base = null, head = null, env = process.env, cwd = process.cwd() } = {}) {
  const requestedBase = base || env.AIWS_TEST_BASE_SHA || null,
    requestedHead = head || env.AIWS_TEST_HEAD_SHA || null,
    snapshot = configuredSnapshot(env, cwd);
  if (Boolean(requestedBase) !== Boolean(requestedHead)) throw impactError('impact_range_incomplete');
  if (snapshot) {
    if (
      (requestedBase && String(requestedBase).toLowerCase() !== snapshot.base_sha) ||
      (requestedHead && String(requestedHead).toLowerCase() !== snapshot.head_sha)
    )
      throw impactError('impact_snapshot_range_mismatch', {
        requested_base: requestedBase,
        requested_head: requestedHead,
        snapshot_base: snapshot.base_sha,
        snapshot_head: snapshot.head_sha
      });
    return {
      mode: 'source-snapshot',
      base_sha: snapshot.base_sha,
      head_sha: snapshot.head_sha,
      tree_sha: snapshot.tree_sha,
      source_sha256: snapshot.source_sha256,
      changes: snapshot.files.map((file) => ({ status: 'A', path: file })),
      files: [...snapshot.files]
    };
  }
  if (requestedBase || requestedHead) {
    const baseSha = resolveCommit(requestedBase, cwd, 'impact_base_not_found'),
      headSha = resolveCommit(requestedHead, cwd, 'impact_head_not_found'),
      changes = parseNameStatus(diffBuffer(cwd, baseSha, headSha)),
      files = uniqueSorted(changes.flatMap((change) => [change.old_path, change.path]).filter(Boolean));
    return { mode: 'committed-range', base_sha: baseSha, head_sha: headSha, changes, files };
  }

  const changes = parseNameStatus(diffBuffer(cwd, 'HEAD', null)),
    untracked = splitNul(gitBuffer(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])).map((file) => ({
      status: 'A',
      path: normalizePath(file)
    })),
    combined = [...changes, ...untracked],
    files = uniqueSorted(combined.flatMap((change) => [change.old_path, change.path]).filter(Boolean));
  return {
    mode: 'working-tree',
    base_sha: resolveCommit('HEAD', cwd, 'impact_base_not_found'),
    head_sha: null,
    changes: combined,
    files
  };
}

export function trackedFilesNul(cwd = process.cwd(), env = process.env) {
  const snapshot = configuredSnapshot(env, cwd);
  if (snapshot) return [...snapshot.files];
  return uniqueSorted(splitNul(gitBuffer(cwd, ['ls-files', '-z'])).map(normalizePath));
}

function configuredSnapshot(env, cwd) {
  const configured = env?.AIWS_IMPACT_SNAPSHOT;
  if (!configured) return null;
  const file = path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
  try {
    return readSourceSnapshot(file);
  } catch (error) {
    throw impactError('impact_snapshot_invalid', { reason: error.code || error.message });
  }
}

export function parseNameStatus(buffer) {
  const tokens = splitNul(buffer),
    changes = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++];
    if (!statusToken) continue;
    const status = statusToken[0];
    if (!'ACDMRTUXB'.includes(status)) throw impactError('impact_diff_status_invalid', { status: statusToken });
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[index++],
        nextPath = tokens[index++];
      if (!oldPath || !nextPath) throw impactError('impact_diff_record_invalid', { status: statusToken });
      changes.push({
        status,
        score: Number(statusToken.slice(1) || 0),
        old_path: normalizePath(oldPath),
        path: normalizePath(nextPath)
      });
    } else {
      const file = tokens[index++];
      if (!file) throw impactError('impact_diff_record_invalid', { status: statusToken });
      changes.push({ status, path: normalizePath(file) });
    }
  }
  return changes;
}

function diffBuffer(cwd, base, head) {
  const range = head ? [base, head] : [base];
  return gitBuffer(cwd, ['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACDMRTUXB', ...range]);
}

function resolveCommit(reference, cwd, code) {
  try {
    return gitBuffer(cwd, ['rev-parse', '--verify', `${reference}^{commit}`])
      .toString('utf8')
      .trim()
      .toLowerCase();
  } catch (error) {
    throw impactError(code, { reference, reason: error.message });
  }
}

function gitBuffer(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw impactError('impact_git_failed', {
      args,
      stderr: Buffer.from(result.stderr || '')
        .toString('utf8')
        .trim()
        .slice(0, 2000)
    });
  return Buffer.from(result.stdout || '');
}

function splitNul(buffer) {
  return Buffer.from(buffer || '')
    .toString('utf8')
    .split('\0')
    .filter((value) => value.length > 0);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function impactError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
