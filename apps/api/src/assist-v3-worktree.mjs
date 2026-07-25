import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import {
  detail,
  gitResult,
  managedRepository,
  reviewSnapshotForPath,
  safeRemove,
  safeSegment,
  validateWorktreeOwnership,
  worktreeRoot,
  writePrivatePatch
} from './assist-v3-git.mjs';

export async function createAssistWorktree(project, turn, repositoryWorkspace = null) {
  const repoPath = repositoryWorkspace?.managed_path || (await managedRepository(project));
  const dirty = gitResult(repoPath, ['status', '--porcelain=v1', '--untracked-files=all'], 10_000);
  if (dirty.stdout.trim())
    throw new HttpError(409, {
      error: 'worktree_dirty_baseline',
      action: '先提交、暂存到其他分支或清理受管 checkout，再启动 Agent Turn。'
    });
  let base = gitResult(repoPath, ['rev-parse', 'HEAD'], 5_000, true).stdout.trim();
  if (!base) {
    const committed = gitResult(
      repoPath,
      [
        '-c',
        'user.name=AI Workspace',
        '-c',
        'user.email=aiws@local.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'chore(aiws): initialize managed workspace'
      ],
      20_000,
      true
    );
    if (!committed.ok)
      throw new HttpError(409, { error: 'worktree_baseline_commit_failed', detail: detail(committed) });
    base = gitResult(repoPath, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
  }
  const root = worktreeRoot(project.id),
    worktreeId = id('wtr'),
    target = path.join(root, safeSegment(turn.id));
  await fsp.mkdir(root, { recursive: true });
  if (fs.existsSync(target)) throw new HttpError(409, { error: 'worktree_path_exists' });
  const added = repositoryWorkspace
    ? gitResult(root, ['clone', '--no-hardlinks', '--no-checkout', repoPath, target], 60_000, true)
    : gitResult(repoPath, ['worktree', 'add', '--detach', target, base], 60_000, true);
  if (!added.ok) {
    await safeRemove(root, target);
    throw new HttpError(409, { error: 'worktree_create_failed', detail: detail(added) });
  }
  if (repositoryWorkspace) {
    const upstream = gitResult(repoPath, ['remote', 'get-url', 'origin'], 5_000, true);
    if (upstream.ok) gitResult(target, ['remote', 'set-url', 'origin', upstream.stdout.trim()], 5_000);
    const checked = gitResult(target, ['checkout', '--detach', base], 30_000, true);
    if (!checked.ok) {
      await safeRemove(root, target);
      throw new HttpError(409, { error: 'worktree_create_failed', detail: detail(checked) });
    }
  }
  return {
    id: worktreeId,
    project_id: project.id,
    repository_workspace_id: repositoryWorkspace?.id || null,
    turn_id: turn.id,
    kind: repositoryWorkspace ? 'assist_repository_clone' : 'assist_turn',
    repo_path: repoPath,
    path: target,
    base_commit: base,
    head_commit: base,
    dirty_baseline: false,
    status: 'active',
    target_hash: null,
    applied_target_hash: null,
    created_at: now(),
    updated_at: now()
  };
}

export async function assistReviewSnapshot(project, worktree) {
  validateWorktreeOwnership(project, worktree);
  const snapshot = reviewSnapshotForPath(worktree.path, worktree.base_commit);
  return {
    changed_files: snapshot.changedFiles,
    diff: snapshot.diff,
    target_hash: snapshot.targetHash,
    base_commit: worktree.base_commit,
    head_commit: snapshot.headCommit
  };
}

export async function applyAssistWorktree(project, worktree, expectedTargetHash) {
  validateWorktreeOwnership(project, worktree);
  if (!['active', 'changes_requested', 'review_ready'].includes(worktree.status)) {
    if (worktree.status === 'applied' && expectedTargetHash === worktree.target_hash)
      return { idempotent: true, worktree };
    throw new HttpError(409, { error: 'worktree_not_applyable', status: worktree.status });
  }
  const source = reviewSnapshotForPath(worktree.path, worktree.base_commit);
  if (!expectedTargetHash || expectedTargetHash !== source.targetHash)
    throw new HttpError(409, { error: 'review_stale', target_hash: source.targetHash });
  if (!source.changedFiles.length || !source.diff.trim()) throw new HttpError(409, { error: 'review_has_no_changes' });
  for (const file of source.changedFiles.filter((item) => item.status !== 'deleted')) {
    const stat = await fsp.lstat(path.join(worktree.path, file.path)).catch(() => null);
    if (stat?.isSymbolicLink())
      throw new HttpError(409, { error: 'review_symlink_change_not_allowed', path: file.path });
  }
  const repoPath = worktree.repository_workspace_id ? worktree.repo_path : await managedRepository(project),
    currentHead = gitResult(repoPath, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
  if (currentHead !== worktree.base_commit)
    throw new HttpError(409, {
      error: 'review_base_changed',
      base_commit: worktree.base_commit,
      current_commit: currentHead
    });
  if (gitResult(repoPath, ['status', '--porcelain=v1', '--untracked-files=all'], 10_000).stdout.trim())
    throw new HttpError(409, { error: 'review_target_dirty' });
  const patchFile = await writePrivatePatch(project.id, worktree.id, source.diff);
  try {
    const checked = gitResult(repoPath, ['apply', '--binary', '--check', patchFile], 30_000, true);
    if (!checked.ok) throw new HttpError(409, { error: 'review_apply_conflict', detail: detail(checked) });
    const applied = gitResult(repoPath, ['apply', '--binary', patchFile], 60_000, true);
    if (!applied.ok) throw new HttpError(409, { error: 'review_apply_failed', detail: detail(applied) });
  } finally {
    await fsp.rm(patchFile, { force: true });
  }
  const appliedSnapshot = reviewSnapshotForPath(repoPath, worktree.base_commit);
  Object.assign(worktree, {
    status: 'applied',
    target_hash: source.targetHash,
    head_commit: source.headCommit,
    applied_target_hash: appliedSnapshot.targetHash,
    applied_at: now(),
    updated_at: now()
  });
  return { idempotent: false, worktree, changed_files: source.changedFiles, target_hash: source.targetHash };
}

export async function rollbackAssistWorktree(project, worktree, expectedTargetHash = null) {
  validateWorktreeOwnership(project, worktree);
  if (worktree.status === 'rolled_back') return { idempotent: true, worktree };
  if (worktree.status === 'applied') {
    const repoPath = worktree.repository_workspace_id ? worktree.repo_path : await managedRepository(project),
      current = reviewSnapshotForPath(repoPath, worktree.base_commit);
    if (expectedTargetHash && expectedTargetHash !== current.targetHash)
      throw new HttpError(409, { error: 'review_stale', target_hash: current.targetHash });
    if (!worktree.applied_target_hash || current.targetHash !== worktree.applied_target_hash)
      throw new HttpError(409, { error: 'rollback_target_changed', target_hash: current.targetHash });
    const source = reviewSnapshotForPath(worktree.path, worktree.base_commit),
      patchFile = await writePrivatePatch(project.id, worktree.id, source.diff);
    try {
      const checked = gitResult(repoPath, ['apply', '--binary', '--reverse', '--check', patchFile], 30_000, true);
      if (!checked.ok) throw new HttpError(409, { error: 'rollback_conflict', detail: detail(checked) });
      const reversed = gitResult(repoPath, ['apply', '--binary', '--reverse', patchFile], 60_000, true);
      if (!reversed.ok) throw new HttpError(409, { error: 'rollback_failed', detail: detail(reversed) });
    } finally {
      await fsp.rm(patchFile, { force: true });
    }
  } else if (expectedTargetHash) {
    const source = reviewSnapshotForPath(worktree.path, worktree.base_commit);
    if (source.targetHash !== expectedTargetHash)
      throw new HttpError(409, { error: 'review_stale', target_hash: source.targetHash });
  }
  await removeAssistWorktree(project, worktree);
  Object.assign(worktree, { status: 'rolled_back', rolled_back_at: now(), updated_at: now() });
  return { idempotent: false, worktree };
}

export async function removeAssistWorktree(project, worktree) {
  validateWorktreeOwnership(project, worktree);
  const repoPath = worktree.repository_workspace_id ? null : await managedRepository(project);
  if (repoPath && fs.existsSync(worktree.path))
    gitResult(repoPath, ['worktree', 'remove', '--force', worktree.path], 30_000, true);
  await safeRemove(worktreeRoot(project.id), worktree.path);
  if (repoPath) gitResult(repoPath, ['worktree', 'prune'], 10_000, true);
}
export function publicWorktree(worktree) {
  if (!worktree) return null;
  return {
    id: worktree.id,
    project_id: worktree.project_id,
    turn_id: worktree.turn_id,
    kind: worktree.kind,
    base_commit: worktree.base_commit,
    head_commit: worktree.head_commit,
    status: worktree.status,
    target_hash: worktree.target_hash,
    applied_target_hash: worktree.applied_target_hash,
    created_at: worktree.created_at,
    updated_at: worktree.updated_at,
    applied_at: worktree.applied_at,
    rolled_back_at: worktree.rolled_back_at
  };
}
