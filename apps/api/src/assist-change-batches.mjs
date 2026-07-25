import fs from 'node:fs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { createAssistWorktree, applyAssistWorktree, assistReviewSnapshot, publicWorktree, removeAssistWorktree, rollbackAssistWorktree } from './assist-v3-worktree.mjs';
import { gitResult } from './assist-v3-git.mjs';
import { requireProject, requireSession } from './assist-v3-domain.mjs';
import { withProjectLifecycleLock } from './project-lifecycle-operations.mjs';
import { assertManagedProjectWritable } from './project-lifecycle.mjs';
import { publishAssistRepositoryReview } from './assist-repository-review.mjs';
import { assertControlledProjectWrite, assertControlledTaskWrite } from './execution-governance.mjs';
const heldLocks = new Map();
export async function ensureSessionChangeBatch(sessionId) {
  const snapshot = await readState(), session = requireSession(snapshot, sessionId), project = requireProject(snapshot, session.project_id);
  const existing = snapshot.assist_change_batches.find((item) => item.id === session.active_change_batch_id && item.status === 'open')
    || snapshot.assist_change_batches.find((item) => item.session_id === session.id && item.status === 'open');
  if (existing) {
    const worktree = snapshot.worktrees.find((item) => item.id === existing.worktree_id);
    if (!worktree || !fs.existsSync(worktree.path)) throw new HttpError(409, { error: 'assist_change_batch_unavailable', batch_id: existing.id });
    if (session.active_change_batch_id !== existing.id) await mutate((state) => { const current = requireSession(state, session.id); current.active_change_batch_id = existing.id; current.updated_at = now(); });
    return { batch: existing, worktree };
  }

  const batchId = id('acb');
  const repositoryWorkspace = snapshot.repository_workspaces.find((item) => item.id === session.repository_workspace_id && item.project_id === project.id && item.status === 'active') || null;
  if (repositoryWorkspace?.stale) throw new HttpError(409, { error: 'repository_workspace_stale', repository_workspace_id: repositoryWorkspace.id });
  const worktree = await createAssistWorktree(project, { id: `batch-${batchId}` }, repositoryWorkspace);
  Object.assign(worktree, { turn_id: null, kind: 'assist_change_batch' });
  try {
    return await mutate((state) => {
      const currentSession = requireSession(state, session.id), actor = owner(state);
      const raced = state.assist_change_batches.find((item) => item.session_id === session.id && item.status === 'open');
      if (raced) throw new HttpError(409, { error: 'assist_change_batch_race', batch_id: raced.id });
      const batch = {
        id: batchId, session_id: session.id, project_id: project.id, worktree_id: worktree.id,
        repository_workspace_id: worktree.repository_workspace_id || null,
        base_commit: worktree.base_commit, head_commit: worktree.head_commit, target_hash: null,
        status: 'open', write_lock: null, applied_at: null, rolled_back_at: null, closed_at: null,
        created_by_user_id: actor.id, created_at: now(), updated_at: now()
      };
      state.worktrees.push(worktree); state.assist_change_batches.push(batch);
      Object.assign(currentSession, { active_change_batch_id: batch.id, updated_at: now() });
      addTrace(state, 'assist.session.created', { project_id: project.id, target_type: 'assist_change_batch', target_id: batch.id, summary: '创建线程级 Assist change batch。' }, actor.id);
      return { batch, worktree };
    });
  } catch (error) {
    await removeAssistWorktree(project, worktree).catch(() => undefined);
    if (error instanceof HttpError && error.payload?.error === 'assist_change_batch_race') return ensureSessionChangeBatch(sessionId);
    throw error;
  }
}
export async function getSessionChangeBatch(sessionId) {
  const state = await readState(), session = requireSession(state, sessionId, true);
  const batch = state.assist_change_batches.find((item) => item.id === session.active_change_batch_id && item.status === 'open')
    || state.assist_change_batches.find((item) => item.session_id === session.id && item.status === 'open');
  return batch ? { batch, worktree: state.worktrees.find((item) => item.id === batch.worktree_id) || null } : null;
}
export async function acquireBatchWriteLock(batchId, holder) {
  const ownerId = `${holder.kind}:${holder.id}`;
  if (heldLocks.has(batchId)) {
    const active = heldLocks.get(batchId);
    throw new HttpError(423, { error: 'assist_change_batch_locked', holder: active.owner, retryable: true });
  }
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  heldLocks.set(batchId, { owner: ownerId, gate });
  try {
    await mutate((state) => {
      const batch = state.assist_change_batches.find((item) => item.id === batchId && item.status === 'open');
      if (!batch) throw new HttpError(409, { error: 'assist_change_batch_not_open' });
      if (batch.write_lock && batch.write_lock.owner !== ownerId) throw new HttpError(423, { error: 'assist_change_batch_locked', holder: batch.write_lock.owner, retryable: true });
      batch.write_lock = { owner: ownerId, kind: holder.kind, source_id: holder.id, acquired_at: now(), process_id: process.pid };
      batch.updated_at = now();
    });
  } catch (error) { heldLocks.delete(batchId); releaseGate(); throw error; }
  let released = false;
  return async () => {
    if (released) return; released = true;
    await mutate((state) => {
      const batch = state.assist_change_batches.find((item) => item.id === batchId);
      if (batch?.write_lock?.owner === ownerId) { batch.write_lock = null; batch.updated_at = now(); }
    }).catch(() => undefined);
    if (heldLocks.get(batchId)?.owner === ownerId) heldLocks.delete(batchId);
    releaseGate();
  };
}

export async function createBatchCheckpoint(batchId, { source, sourceId, phase, status = 'completed' }) {
  const snapshot = await readState(), batch = snapshot.assist_change_batches.find((item) => item.id === batchId), worktree = snapshot.worktrees.find((item) => item.id === batch?.worktree_id);
  if (!batch || !worktree || batch.status !== 'open') throw new HttpError(409, { error: 'assist_change_batch_not_open' });
  const beforeCommit = gitResult(worktree.path, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
  const changes = gitResult(worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 15_000).stdout;
  if (phase === 'after' && changes) {
    gitResult(worktree.path, ['add', '-A'], 15_000);
    const committed = gitResult(worktree.path, ['-c', 'user.name=AI Workspace', '-c', 'user.email=aiws@local.invalid', 'commit', '-m', `checkpoint(aiws): ${safeMessage(source)} ${safeMessage(sourceId)}`], 30_000, true);
    if (!committed.ok) throw new HttpError(409, { error: 'assist_checkpoint_commit_failed' });
  }
  const afterCommit = gitResult(worktree.path, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
  const review = await assistReviewSnapshot({ id: batch.project_id }, { ...worktree, project_id: batch.project_id }).catch(() => null);
  const changedFiles = review?.changed_files || parseChangedPaths(changes);
  const checkpoint = {
    id: id('acp'), batch_id: batch.id, session_id: batch.session_id,
    turn_id: source === 'assist_turn' ? sourceId : null, terminal_id: source.includes('cli') ? sourceId : null,
    source, source_id: sourceId, phase, before_commit: beforeCommit, after_commit: afterCommit,
    target_hash: review?.target_hash || hashString(JSON.stringify({ beforeCommit, afterCommit, changedFiles })),
    changed_files: changedFiles, status, created_at: now()
  };
  return mutate((state) => {
    const current = state.assist_change_batches.find((item) => item.id === batch.id && item.status === 'open');
    const currentWorktree = state.worktrees.find((item) => item.id === worktree.id);
    if (!current || !currentWorktree) throw new HttpError(409, { error: 'assist_change_batch_not_open' });
    state.assist_checkpoints.push(checkpoint);
    Object.assign(current, { head_commit: afterCommit, target_hash: checkpoint.target_hash, updated_at: now() });
    Object.assign(currentWorktree, { head_commit: afterCommit, target_hash: checkpoint.target_hash, updated_at: now() });
    return checkpoint;
  });
}

export async function getChangeBatchReview(batchId) {
  const snapshot = await readState(), batch = snapshot.assist_change_batches.find((item) => item.id === batchId);
  if (!batch) throw new HttpError(404, { error: 'assist_change_batch_not_found' });
  return withProjectLifecycleLock(batch.project_id, () => getChangeBatchReviewLocked(batchId));
}
async function getChangeBatchReviewLocked(batchId) {
  const state = await readState(), batch = state.assist_change_batches.find((item) => item.id === batchId);
  if (!batch) throw new HttpError(404, { error: 'assist_change_batch_not_found' });
  const project = requireProject(state, batch.project_id), worktree = state.worktrees.find((item) => item.id === batch.worktree_id);
  if (!worktree) throw new HttpError(409, { error: 'assist_change_batch_unavailable' });
  const review = await assistReviewSnapshot(project, worktree);
  if (batch.status === 'open') await mutate((currentState) => {
    requireProject(currentState, batch.project_id);
    const current = currentState.assist_change_batches.find((item) => item.id === batch.id);
    const currentWorktree = currentState.worktrees.find((item) => item.id === worktree.id);
    if (current) Object.assign(current, { target_hash: review.target_hash, head_commit: review.head_commit, updated_at: now() });
    if (currentWorktree && !['applied', 'rolled_back'].includes(currentWorktree.status)) Object.assign(currentWorktree, { target_hash: review.target_hash, head_commit: review.head_commit, status: review.changed_files.length ? 'review_ready' : 'active', updated_at: now() });
  });
  const refreshed = await readState(), currentBatch = refreshed.assist_change_batches.find((item) => item.id === batch.id), currentWorktree = refreshed.worktrees.find((item) => item.id === worktree.id);
  return {
    batch: publicBatch(currentBatch, currentWorktree), status: currentBatch.status,
    changed_files: review.changed_files, diff: review.diff, target_hash: review.target_hash,
    base_commit: review.base_commit, head_commit: review.head_commit,
    checkpoints: refreshed.assist_checkpoints.filter((item) => item.batch_id === batch.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  };
}

export async function applyChangeBatch(batchId, expectedTargetHash, executionBinding = {}) {
  const state = await readState(), batch = state.assist_change_batches.find((item) => item.id === batchId);
  if (!batch) throw new HttpError(404, { error: 'assist_change_batch_not_found' });
  return withProjectLifecycleLock(batch.project_id, () => applyChangeBatchLocked(batchId, expectedTargetHash, executionBinding));
}
async function applyChangeBatchLocked(batchId, expectedTargetHash, executionBinding) {
  const existing = await closedBatchResult(batchId, 'applied');
  if (existing) return existing;
  const release = await acquireBatchWriteLock(batchId, { kind: 'review_apply', id: batchId });
  try {
    const state = await readState(), batch = state.assist_change_batches.find((item) => item.id === batchId), project = requireProject(state, batch?.project_id), worktree = state.worktrees.find((item) => item.id === batch?.worktree_id);
    if (!batch || !worktree) throw new HttpError(404, { error: 'assist_change_batch_not_found' });
    assertManagedProjectWritable(project);
    const boundTurn = state.assist_turns.filter((item) => item.change_batch_id === batch.id && item.task_execution_id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    const boundExecution = executionBinding.task_execution_id || boundTurn?.task_execution_id || null;
    const task = state.workflow_nodes.find((item) => item.id === state.task_executions.find((entry) => entry.id === boundExecution)?.task_id);
    if (task) assertControlledTaskWrite(state, task.id, { task_execution_id: boundExecution, lease_token: executionBinding.lease_token }, 'assist_apply');
    else assertControlledProjectWrite(state, { projectId: project.id, taskExecutionId: boundExecution, leaseToken: executionBinding.lease_token, operation: 'assist_apply' });
    if (batch.status === 'applied') return { idempotent: true, batch: publicBatch(batch, worktree) };
    if (batch.status !== 'open') throw new HttpError(409, { error: 'assist_change_batch_not_open', status: batch.status });
    if (worktree.repository_workspace_id) {
      const published = await mutate(async (currentState) => {
        const currentBatch = currentState.assist_change_batches.find((item) => item.id === batch.id && item.status === 'open');
        const currentWorktree = currentState.worktrees.find((item) => item.id === worktree.id);
        const actor = owner(currentState);
        if (!currentBatch || !currentWorktree || !actor) throw new HttpError(409, { error: 'assist_change_batch_not_open' });
        const result = await publishAssistRepositoryReview(currentState, { project: requireProject(currentState, batch.project_id), batch: currentBatch, worktree: currentWorktree, expectedTargetHash, actorId: actor.id });
        Object.assign(currentBatch, { pull_request_intent_id: result.pull_request_intent_id, review_ref: result.review_ref, review_sha: result.project_commit, updated_at: now() });
        return { ...result, worktree: structuredClone(currentWorktree) };
      });
      await removeAssistWorktree(project, published.worktree);
      return mutate((currentState) => closeBatch(currentState, batch.id, published.worktree, 'applied', published));
    }
    const result = await applyAssistWorktree(project, worktree, expectedTargetHash);
    gitResult(project.repo_path, ['add', '-A'], 15_000);
    const committed = gitResult(project.repo_path, ['-c', 'user.name=AI Workspace', '-c', 'user.email=aiws@local.invalid', 'commit', '-m', `apply(aiws): change batch ${safeMessage(batch.id)}`], 30_000, true);
    if (!committed.ok) throw new HttpError(409, { error: 'assist_change_batch_apply_commit_failed' });
    result.project_commit = gitResult(project.repo_path, ['rev-parse', 'HEAD'], 5_000).stdout.trim();
    await removeAssistWorktree(project, worktree);
    return mutate((currentState) => closeBatch(currentState, batch.id, worktree, 'applied', result));
  } finally { await release(); }
}

export async function rollbackChangeBatch(batchId, expectedTargetHash = null) {
  const state = await readState(), batch = state.assist_change_batches.find((item) => item.id === batchId);
  if (!batch) throw new HttpError(404, { error: 'assist_change_batch_not_found' });
  return withProjectLifecycleLock(batch.project_id, () => rollbackChangeBatchLocked(batchId, expectedTargetHash));
}
async function rollbackChangeBatchLocked(batchId, expectedTargetHash = null) {
  const existing = await closedBatchResult(batchId, 'rolled_back');
  if (existing) return existing;
  const release = await acquireBatchWriteLock(batchId, { kind: 'review_rollback', id: batchId });
  try {
    const state = await readState(), batch = state.assist_change_batches.find((item) => item.id === batchId), project = requireProject(state, batch?.project_id), worktree = state.worktrees.find((item) => item.id === batch?.worktree_id);
    if (!batch || !worktree) throw new HttpError(404, { error: 'assist_change_batch_not_found' });
    assertManagedProjectWritable(project);
    if (batch.status === 'rolled_back') return { idempotent: true, batch: publicBatch(batch, worktree) };
    if (batch.status !== 'open') throw new HttpError(409, { error: 'assist_change_batch_not_open', status: batch.status });
    const result = await rollbackAssistWorktree(project, worktree, expectedTargetHash);
    return mutate((currentState) => closeBatch(currentState, batch.id, worktree, 'rolled_back', result));
  } finally { await release(); }
}

export async function recoverChangeBatchLocks() {
  return mutate((state) => {
    let cleared = 0;
    for (const batch of state.assist_change_batches.filter((item) => item.status === 'open' && item.write_lock)) {
      batch.write_lock = null; batch.recovered_lock_at = now(); batch.updated_at = now(); cleared++;
    }
    return cleared;
  });
}

export function publicBatch(batch, worktree = null) {
  if (!batch) return null;
  return {
    id: batch.id, session_id: batch.session_id, project_id: batch.project_id, worktree_id: batch.worktree_id,
    base_commit: batch.base_commit, head_commit: batch.head_commit, target_hash: batch.target_hash,
    applied_project_commit: batch.applied_project_commit || null,
    repository_workspace_id: batch.repository_workspace_id || null, review_ref: batch.review_ref || null,
    pull_request_intent_id: batch.pull_request_intent_id || null,
    status: batch.status, locked: Boolean(batch.write_lock), applied_at: batch.applied_at,
    rolled_back_at: batch.rolled_back_at, closed_at: batch.closed_at, created_at: batch.created_at, updated_at: batch.updated_at,
    worktree: publicWorktree(worktree)
  };
}

function closeBatch(state, batchId, worktree, status, result) {
  const batch = state.assist_change_batches.find((item) => item.id === batchId), currentWorktree = state.worktrees.find((item) => item.id === worktree.id);
  if (!batch || !currentWorktree) throw new HttpError(409, { error: 'assist_change_batch_not_found' });
  const closedAt = now();
  Object.assign(batch, { status, write_lock: null, target_hash: worktree.target_hash, head_commit: worktree.head_commit, applied_project_commit: result?.project_commit || null, review_ref: result?.review_ref || batch.review_ref || null, pull_request_intent_id: result?.pull_request_intent_id || batch.pull_request_intent_id || null, [`${status}_at`]: closedAt, closed_at: closedAt, updated_at: closedAt });
  Object.assign(currentWorktree, { ...worktree, status, removed_at: closedAt, updated_at: closedAt });
  const session = state.assist_sessions.find((item) => item.id === batch.session_id);
  if (session?.active_change_batch_id === batch.id) { session.active_change_batch_id = null; session.updated_at = closedAt; }
  for (const turn of state.assist_turns.filter((item) => item.change_batch_id === batch.id)) {
    turn.review_status = status; turn.review = { ...(turn.review || {}), status, target_hash: batch.target_hash }; turn.updated_at = closedAt;
  }
  return { idempotent: Boolean(result?.idempotent), batch: publicBatch(batch, currentWorktree), changed_files: result?.changed_files || [], target_hash: batch.target_hash, project_commit: batch.applied_project_commit, pull_request_intent_id: batch.pull_request_intent_id };
}

async function closedBatchResult(batchId, expectedStatus) {
  const state = await readState(), batch = state.assist_change_batches.find((item) => item.id === batchId);
  if (!batch || batch.status !== expectedStatus) return null;
  const worktree = state.worktrees.find((item) => item.id === batch.worktree_id);
  return { idempotent: true, batch: publicBatch(batch, worktree), changed_files: [], target_hash: batch.target_hash, project_commit: batch.applied_project_commit || null };
}

function parseChangedPaths(value) {
  return String(value || '').split('\0').filter(Boolean).map((line) => ({ code: line.slice(0, 2), status: line.slice(0, 2) === '??' ? 'untracked' : 'modified', path: line.slice(3).replaceAll('\\', '/') })).filter((item) => item.path);
}

function safeMessage(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80); }
