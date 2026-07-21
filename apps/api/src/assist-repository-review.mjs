import fsp from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './http.mjs';
import { assistReviewSnapshot } from './assist-v3-worktree.mjs';
import { detail, gitResult, safeSegment, validateWorktreeOwnership } from './assist-v3-git.mjs';
import { createPullRequestIntentInState } from './pull-request-intent-domain.mjs';
import {
  inspectRepositoryWorkspace, refreshRepositoryMirror, repositoryGitAuthEnv,
  requireRepositoryWorkspace, validateRepositoryRef
} from './repository-workspace-service.mjs';

export async function publishAssistRepositoryReview(state, { project, batch, worktree, expectedTargetHash, actorId }) {
  validateWorktreeOwnership(project, worktree);
  const workspace = requireRepositoryWorkspace(state, worktree.repository_workspace_id, project.id);
  const inspected = inspectRepositoryWorkspace(state, workspace.id);
  if (inspected.stale) throw new HttpError(409, { error: 'repository_workspace_stale', repository_workspace_id: workspace.id });
  if (inspected.dirty || inspected.current_sha !== worktree.base_commit) throw new HttpError(409, { error: 'review_base_changed', base_commit: worktree.base_commit, current_commit: inspected.current_sha });
  const review = await assistReviewSnapshot(project, worktree);
  if (!expectedTargetHash || expectedTargetHash !== review.target_hash) throw new HttpError(409, { error: 'review_stale', target_hash: review.target_hash });
  if (!review.changed_files.length || !review.diff.trim()) throw new HttpError(409, { error: 'review_has_no_changes' });
  await rejectSymlinks(worktree.path, review.changed_files);
  commitPendingChanges(worktree.path, batch.id);
  const headSha = gitResult(worktree.path, ['rev-parse', 'HEAD'], 5_000).stdout.trim().toLowerCase();
  if (headSha === worktree.base_commit) throw new HttpError(409, { error: 'review_has_no_changes' });
  const reviewRef = validateRepositoryRef(`aiws/review-${safeSegment(batch.id).slice(0, 42)}-${headSha.slice(0, 8)}`);
  const connection = state.repository_connections.find((item) => item.id === workspace.connection_id);
  if (!connection || connection.permissions?.push !== true || connection.permissions?.pull_requests !== true) throw new HttpError(403, { error: 'github_pull_request_write_required' });
  const remoteName = connection.remote_name || 'origin', remote = gitResult(worktree.path, ['remote', 'get-url', remoteName], 5_000, true);
  if (!remote.ok) throw new HttpError(409, { error: 'assist_review_remote_required' });
  const env = await repositoryGitAuthEnv(state, connection, remote.stdout.trim());
  const pushed = gitResult(worktree.path, ['push', '--set-upstream', remoteName, `HEAD:refs/heads/${reviewRef}`], 120_000, true, env);
  if (!pushed.ok) throw new HttpError(409, { error: 'assist_review_push_failed', detail: detail(pushed) });
  await refreshRepositoryMirror(state, project.id, workspace.connection_id, { fetch: true, env });
  const created = createPullRequestIntentInState(state, project.id, {
    repository_workspace_id: workspace.id, head_ref: reviewRef, head_sha: headSha,
    title: `Assist review: ${project.title}`, body: `Assist change batch ${batch.id}\n\n${review.changed_files.map((item) => `- ${item.path}`).join('\n')}`,
    operation_key: `assist-change-batch:${batch.id}`
  }, actorId);
  Object.assign(worktree, { target_hash: review.target_hash, head_commit: headSha, review_ref: reviewRef, review_sha: headSha, pull_request_intent_id: created.intent.id });
  return { changed_files: review.changed_files, target_hash: review.target_hash, project_commit: headSha, review_ref: reviewRef, pull_request_intent_id: created.intent.id, intent: created.intent };
}

function commitPendingChanges(repoPath, batchId) {
  const dirty = gitResult(repoPath, ['status', '--porcelain=v1', '--untracked-files=all'], 10_000).stdout.trim();
  if (!dirty) return;
  gitResult(repoPath, ['add', '-A'], 15_000);
  const committed = gitResult(repoPath, ['-c', 'user.name=AI Workspace', '-c', 'user.email=aiws@local.invalid', 'commit', '-m', `review(aiws): ${safeSegment(batchId)}`], 30_000, true);
  if (!committed.ok) throw new HttpError(409, { error: 'assist_review_commit_failed', detail: detail(committed) });
}

async function rejectSymlinks(root, files) {
  for (const file of files.filter((item) => item.status !== 'deleted')) {
    const stat = await fsp.lstat(path.join(root, file.path)).catch(() => null);
    if (stat?.isSymbolicLink()) throw new HttpError(409, { error: 'review_symlink_change_not_allowed', path: file.path });
  }
}
