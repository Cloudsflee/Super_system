import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, command } from './http.mjs';
import { WORKSPACE_DIR } from './config.mjs';
import { hashString } from '../../../packages/shared/index.mjs';
import { isGitRepo } from './git-utils.mjs';

const MAX_DIFF_BYTES = 5 * 1024 * 1024;

export function reviewSnapshotForPath(repoPath, baseCommit) {
  if (!isGitRepo(repoPath)) throw new HttpError(409, { error: 'worktree_repository_unavailable' });
  const status = gitResult(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 15_000);
  const changedFiles = parsePorcelainZ(status.stdout);
  const tracked = gitResult(repoPath, ['diff', '--binary', '--full-index', baseCommit, '--'], 30_000, true);
  if (!tracked.ok) throw new HttpError(409, { error: 'review_diff_failed', detail: detail(tracked) });
  let diffText = tracked.stdout;
  for (const file of changedFiles.filter((item) => item.status === 'untracked')) {
    assertRelativeGitPath(file.path);
    const untracked = gitResult(repoPath, ['diff', '--no-index', '--binary', '--', '/dev/null', file.path], 30_000, true);
    if (!untracked.stdout) throw new HttpError(409, { error: 'review_untracked_diff_failed', path: file.path });
    diffText += `${diffText && !diffText.endsWith('\n') ? '\n' : ''}${untracked.stdout}`;
  }
  if (Buffer.byteLength(diffText, 'utf8') > MAX_DIFF_BYTES) throw new HttpError(413, { error: 'review_diff_too_large', max_bytes: MAX_DIFF_BYTES });
  const headCommit = gitResult(repoPath, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
  const targetHash = hashString(JSON.stringify({ baseCommit, headCommit, files: changedFiles, diff: diffText }));
  return { changedFiles, diff: diffText, targetHash, headCommit };
}

export async function managedRepository(project) {
  if (!project || project.deleted_at) throw new HttpError(404, { error: 'project_not_found' });
  if (project.status !== 'active') throw new HttpError(409, { error: 'project_not_active' });
  if (project.managed_workspace_state !== 'ready') throw new HttpError(409, { error: 'workspace_migration_required', state: project.managed_workspace_state || 'unknown' });
  const expected = path.join(WORKSPACE_DIR, safeSegment(project.id), 'repo'), configured = path.resolve(String(project.repo_path || ''));
  assertWithin(WORKSPACE_DIR, configured);
  const expectedReal = await fsp.realpath(expected).catch(() => null), configuredReal = await fsp.realpath(configured).catch(() => null);
  if (!expectedReal || !configuredReal || normalizePath(expectedReal) !== normalizePath(configuredReal) || !isGitRepo(configuredReal)) throw new HttpError(409, { error: 'managed_repository_required' });
  return configuredReal;
}
export function validateWorktreeOwnership(project, worktree) {
  if (!worktree || worktree.project_id !== project?.id || !worktree.path) throw new HttpError(404, { error: 'worktree_not_found' });
  assertWithin(worktreeRoot(project.id), worktree.path);
}
export function worktreeRoot(projectId) { const root = path.join(WORKSPACE_DIR, safeSegment(projectId), 'worktrees'); assertWithin(WORKSPACE_DIR, root); return root; }
export function gitResult(cwd, args, timeout, allowFailure = false) {
  const result = command('git', args, cwd, timeout, { GIT_TERMINAL_PROMPT: '0' });
  if (!allowFailure && !result.ok) throw new HttpError(409, { error: 'git_operation_failed', detail: detail(result) });
  return result;
}
export async function writePrivatePatch(projectId, worktreeId, content) {
  const root = path.join(WORKSPACE_DIR, safeSegment(projectId), '.review'), file = path.join(root, `${safeSegment(worktreeId)}-${Date.now()}.patch`);
  assertWithin(root, file); await fsp.mkdir(root, { recursive: true }); await fsp.writeFile(file, content, { encoding: 'utf8', mode: 0o600 }); return file;
}
export async function safeRemove(root, target) { assertWithin(root, target); await fsp.rm(target, { recursive: true, force: true }); }
export function detail(result) { return String(result?.stderr || result?.error || '').slice(-2000); }
export function safeSegment(value) { const result = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_'); if (!result || result === '.' || result === '..') throw new HttpError(400, { error: 'invalid_managed_path_segment' }); return result; }

function parsePorcelainZ(value) {
  const tokens = String(value || '').split('\0'), files = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]; if (!token) continue;
    const code = token.slice(0, 2), filePath = token.slice(3); if (!filePath) continue; assertRelativeGitPath(filePath);
    const renamed = code.includes('R') || code.includes('C'), from = renamed ? tokens[++index] || null : null; if (from) assertRelativeGitPath(from);
    files.push({ path: filePath.replaceAll('\\', '/'), previous_path: from?.replaceAll('\\', '/') || null, status: statusName(code), code });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function statusName(code) { if (code === '??') return 'untracked'; if (code.includes('R')) return 'renamed'; if (code.includes('C')) return 'copied'; if (code.includes('D')) return 'deleted'; if (code.includes('A')) return 'added'; if (code.includes('U')) return 'conflicted'; return 'modified'; }
function assertRelativeGitPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) throw new HttpError(409, { error: 'invalid_changed_file_path' });
}
function assertWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(403, { error: 'managed_path_boundary_violation' });
}
function normalizePath(value) { const normalized = path.resolve(value); return process.platform === 'win32' ? normalized.toLowerCase() : normalized; }
