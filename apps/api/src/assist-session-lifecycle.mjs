import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { ATTACHMENT_DIR } from './config.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { runCodexAppServerRpc } from './codex-app-server.mjs';
import { coordinateAssistSession } from './assist-session-coordinator.mjs';
import { getSessionChangeBatch, rollbackChangeBatch } from './assist-change-batches.mjs';
import { purgeAssistSessionsInState } from './state-purge.mjs';
import { withProjectLifecycleLock } from './project-lifecycle-operations.mjs';
import {
  cleanText, makeSession, readableProjectCwd, requireProject, requireSession, requireTurn,
  resolveAssistTurnConfiguration, resolveScope, sessionSummary
} from './assist-v3-domain.mjs';
import { id, now } from '../../../packages/shared/index.mjs';

const ACTIVE_TURN_STATES = new Set(['queued', 'preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping']);
const ACTIVE_TERMINAL_STATES = new Set(['starting', 'running', 'connected', 'stopping']);
const DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_RETRY_MS = 5 * 60 * 1000;
let purgeInFlight = null;

export function forkV3Session(sessionId, input = {}, dependencies = {}) {
  return coordinateAssistSession(sessionId, () => performNativeFork(sessionId, input, dependencies));
}

async function performNativeFork(sessionId, input, { rpc = runCodexAppServerRpc } = {}) {
  const state = await readState();
  const source = requireSession(state, sessionId, true), project = requireProject(state, source.project_id);
  const fromTurn = resolveForkTurn(state, source, input.from_turn_id);
  if (!source.codex_thread_id || source.native_thread_generation === 1 || source.native_thread_repair_required) {
    throw new HttpError(409, { error: 'assist_native_fork_source_required', action: 'complete_turn_before_fork' });
  }
  const configuration = resolveForkProfile(state, source, input);
  const profile = { ...configuration.profile, model: configuration.model, reasoning: configuration.reasoning };
  const batch = await getSessionChangeBatch(source.id);
  const cwd = batch?.worktree?.path || readableProjectCwd(project);
  const sourceThreadId = source.codex_thread_id;
  let response;
  try {
    response = await rpc({
      state, profile, cwd, sandbox: 'read-only', resumeId: sourceThreadId, createThread: false,
      method: 'thread/fork', params: { ...(fromTurn?.codex_turn_id ? { turnId: fromTurn.codex_turn_id } : {}), ephemeral: false }, projectId: project.id
    });
  } catch (error) {
    throw nativeForkError(error);
  }
  const forkedThreadId = nativeForkThreadId(response);
  if (!forkedThreadId || forkedThreadId === sourceThreadId) throw new HttpError(502, { error: 'assist_native_fork_failed', reason: 'independent_thread_missing' });

  try {
    return await mutate((current) => {
      const actor = owner(current), currentSource = requireSession(current, source.id, true), currentProject = requireProject(current, source.project_id);
      if (currentSource.codex_thread_id !== sourceThreadId) throw new HttpError(409, { error: 'assist_native_fork_source_changed', retryable: true });
      const currentTurn = fromTurn ? requireTurn(current, fromTurn.id) : null;
      if (currentTurn && currentTurn.session_id !== currentSource.id) throw new HttpError(409, { error: 'assist_fork_turn_scope_mismatch' });
      const scope = resolveScope(current, currentProject, currentSource.scope_type, currentSource.scope_id);
      const forked = makeSession({ actor, project: currentProject, scope, title: input.title || `${currentSource.title} · Fork`, parentSessionId: currentSource.id, viewContext: currentSource.view_context || {}, clarificationPolicy: currentSource.clarification_policy || 'ask' });
      Object.assign(forked, {
        forked_from_session_id: currentSource.id, forked_from_turn_id: currentTurn?.id || null,
        forked_from_codex_turn_id: currentTurn?.codex_turn_id || null, codex_thread_id: forkedThreadId,
        legacy_codex_thread_id: null, historical_shared_codex_thread_id: null,
        native_thread_generation: 2, native_thread_repair_required: false,
        runtime_profile_id: currentSource.runtime_profile_id || profile.id,
        runtime_affinity_key: currentSource.runtime_affinity_key || null, active_change_batch_id: null
      });
      current.assist_sessions.push(forked);
      addTrace(current, 'assist.session.forked', { project_id: currentProject.id, target_id: forked.id, source_session_id: currentSource.id, source_turn_id: currentTurn?.id || null, summary: `Native Fork: ${forked.title}` }, actor.id);
      return sessionSummary(current, forked);
    });
  } catch (error) {
    const cleanupError = await deleteOrphanNativeThread({ rpc, state, profile, cwd, threadId: forkedThreadId, projectId: project.id }).then(() => null, (failure) => failure);
    if (cleanupError) await recordOrphanNativeThread(source, forkedThreadId, cleanupError).catch(() => undefined);
    throw error;
  }
}

export async function deleteV3Session(sessionId, { clock = () => new Date() } = {}) {
  return mutate((state) => {
    const actor = owner(state), session = requireSession(state, sessionId, true);
    if (!session.forked_from_session_id) throw new HttpError(409, { error: 'assist_root_session_not_deletable' });
    const subtree = collectSessionSubtree(state, session.id).filter((item) => !item.deleted_at);
    assertSubtreeIdle(state, subtree);
    const deletedAt = clock().toISOString(), purgeAfter = new Date(clock().getTime() + DELETE_RETENTION_MS).toISOString(), batchId = id('adel');
    for (const item of subtree) Object.assign(item, { delete_batch_id: batchId, deleted_at: deletedAt, purge_after: purgeAfter, purge_stage: 'pending', purge_retry_at: null, lifecycle: 'deleted', pinned: false, updated_at: deletedAt });
    addTrace(state, 'assist.session.deleted', { project_id: session.project_id, target_id: session.id, delete_batch_id: batchId, descendant_count: Math.max(0, subtree.length - 1), purge_after: purgeAfter, summary: `Soft-deleted Assist Fork subtree: ${session.title}` }, actor.id);
    return { delete_batch_id: batchId, deleted_at: deletedAt, purge_after: purgeAfter, deleted_session_ids: subtree.map((item) => item.id), session: sessionSummary(state, session) };
  });
}

export async function restoreDeletedV3Session(sessionId, { clock = () => new Date() } = {}) {
  return mutate((state) => {
    const actor = owner(state), session = requireSession(state, sessionId, true, true);
    if (!session.deleted_at || !session.delete_batch_id) return { restored_session_ids: [], session: sessionSummary(state, session) };
    if (!session.purge_after || new Date(session.purge_after).getTime() <= clock().getTime()) throw new HttpError(410, { error: 'assist_delete_batch_expired' });
    const batchId = session.delete_batch_id;
    const restored = collectSessionSubtree(state, session.id, { includeDeleted: true }).filter((item) => item.delete_batch_id === batchId && item.deleted_at);
    const restoredAt = clock().toISOString();
    for (const item of restored) Object.assign(item, { delete_batch_id: null, deleted_at: null, purge_after: null, purge_stage: null, purge_retry_at: null, lifecycle: item.archived_at ? 'archived' : 'active', updated_at: restoredAt });
    addTrace(state, 'assist.session.restored_deleted', { project_id: session.project_id, target_id: session.id, delete_batch_id: batchId, restored_count: restored.length, summary: `Restored deleted Assist Fork subtree: ${session.title}` }, actor.id);
    return { delete_batch_id: batchId, restored_session_ids: restored.map((item) => item.id), session: sessionSummary(state, session) };
  });
}

export function purgeExpiredDeletedSessions(options = {}) {
  if (purgeInFlight) return purgeInFlight;
  const current = performExpiredSessionPurge(options); purgeInFlight = current;
  return current.finally(() => { if (purgeInFlight === current) purgeInFlight = null; });
}

async function performExpiredSessionPurge({ clock = () => new Date(), rpc = runCodexAppServerRpc } = {}) {
  const snapshot = await readState();
  const currentTime = clock().getTime();
  const expired = snapshot.assist_sessions.filter((item) => item.version === 3 && item.deleted_at && item.purge_after && new Date(item.purge_after).getTime() <= currentTime && (!item.purge_retry_at || new Date(item.purge_retry_at).getTime() <= currentTime));
  const batches = [...new Set(expired.map((item) => item.delete_batch_id).filter(Boolean))];
  const results = [];
  for (const batchId of batches) {
    const projectId = expired.find((item) => item.delete_batch_id === batchId)?.project_id;
    try {
      const result = await withProjectLifecycleLock(projectId, async () => {
        const current = await readState(), session = current.assist_sessions.find((item) => item.delete_batch_id === batchId && item.deleted_at), project = current.projects.find((item) => item.id === session?.project_id);
        return !project || project.deleted_at || project.lifecycle_operation ? null : purgeDeleteBatch(batchId, { clock, rpc });
      });
      if (result) results.push(result);
    }
    catch (error) { await recordPurgeFailure(batchId, error, clock); results.push({ delete_batch_id: batchId, purged: false, error: safeErrorCode(error) }); }
  }
  return results;
}

export function attachDeletedSessionSweeper(server, { intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => { void purgeExpiredDeletedSessions().catch(() => undefined); }, Math.max(1_000, intervalMs)); timer.unref?.();
  server.once('close', () => clearInterval(timer)); return timer;
}

async function purgeDeleteBatch(batchId, { clock, rpc }) {
  await markPurgeStage(batchId, 'closing_batches', clock);
  let state = await readState();
  const sessions = state.assist_sessions.filter((item) => item.delete_batch_id === batchId && item.deleted_at);
  if (!sessions.length) return { delete_batch_id: batchId, purged: true, session_count: 0 };
  assertSubtreeIdle(state, sessions, { allowOpenBatches: true });
  for (const session of sessions) {
    const batch = state.assist_change_batches.find((item) => item.session_id === session.id && item.status === 'open');
    if (batch) await rollbackChangeBatch(batch.id, batch.target_hash || null);
  }
  state = await readState();
  await markPurgeStage(batchId, 'removing_resources', clock);
  const refreshed = state.assist_sessions.filter((item) => item.delete_batch_id === batchId && item.deleted_at);
  const sessionIds = new Set(refreshed.map((item) => item.id));
  const turnIds = new Set(state.assist_turns.filter((item) => sessionIds.has(item.session_id)).map((item) => item.id));
  for (const attachment of state.attachments.filter((item) => sessionIds.has(item.session_id) || turnIds.has(item.turn_id))) await removeManagedAttachment(attachment.managed_path);
  await markPurgeStage(batchId, 'deleting_threads', clock);
  for (const session of [...refreshed].sort((a, b) => sessionDepth(state, b.id) - sessionDepth(state, a.id))) await deleteIndependentNativeThread(state, session, rpc);

  const purgedAt = clock().toISOString();
  return mutate((current) => {
    const currentSessions = current.assist_sessions.filter((item) => item.delete_batch_id === batchId && item.deleted_at);
    const currentIds = new Set(currentSessions.map((item) => item.id));
    purgeAssistSessionsInState(current, currentIds);
    addTrace(current, 'assist.session.purged', { delete_batch_id: batchId, session_count: currentIds.size, purged_at: purgedAt, summary: 'Purged expired Assist Fork subtree.' });
    return { delete_batch_id: batchId, purged: true, session_count: currentIds.size };
  });
}

export function collectSessionSubtree(state, sessionId, { includeDeleted = true } = {}) {
  const result = [], queue = [sessionId], seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const session = state.assist_sessions.find((item) => item.id === current && item.version === 3);
    if (!session) continue;
    if (includeDeleted || !session.deleted_at) result.push(session);
    for (const child of state.assist_sessions.filter((item) => item.version === 3 && item.forked_from_session_id === current)) queue.push(child.id);
  }
  return result;
}

function resolveForkTurn(state, source, turnId) {
  const turn = turnId ? requireTurn(state, turnId) : state.assist_turns.filter((item) => item.session_id === source.id && item.status === 'completed').sort((a, b) => String(a.completed_at || a.updated_at).localeCompare(String(b.completed_at || b.updated_at))).at(-1) || null;
  if (turn && turn.session_id !== source.id) throw new HttpError(409, { error: 'assist_fork_turn_scope_mismatch' });
  if (turn && turn.status !== 'completed') throw new HttpError(409, { error: 'assist_fork_turn_not_completed', status: turn.status });
  return turn;
}
function resolveForkProfile(state, source, input) {
  if (source.runtime_profile_id) {
    const profile = state.codex_profiles.find((item) => item.id === source.runtime_profile_id && item.status === 'validated' && !item.assist_configuration);
    if (!profile) throw new HttpError(409, { error: 'assist_runtime_profile_unavailable' });
    if (input.profile_id && input.profile_id !== profile.id) throw new HttpError(409, { error: 'assist_profile_affinity_conflict', current_profile_id: profile.id, requested_profile_id: input.profile_id });
    return { profile, model: input.model || profile.model, reasoning: input.reasoning || profile.reasoning };
  }
  return resolveAssistTurnConfiguration(state, input);
}
function nativeForkThreadId(response) { return cleanText(response?.result?.thread?.id || response?.result?.threadId || response?.result?.thread_id || response?.forked_thread_id, 300) || null; }
function nativeForkError(error) { if (error instanceof HttpError) return error; return new HttpError(502, { error: 'assist_native_fork_failed', reason: safeErrorCode(error), retryable: true }); }
async function deleteOrphanNativeThread({ rpc, state, profile, cwd, threadId, projectId }) { try { return await rpc({ state, profile, cwd, sandbox: 'read-only', resumeId: threadId, createThread: false, method: 'thread/delete', params: {}, projectId }); } catch (error) { if (!nativeThreadMissing(error)) throw error; } }
async function recordOrphanNativeThread(source, threadId, error) { return mutate((state) => addTrace(state, 'assist.native_thread.orphaned', { project_id: source.project_id, target_id: source.id, data: { native_thread_id: threadId, cleanup_error: safeErrorCode(error) }, summary: 'Native Fork cleanup requires retry.' })); }
function assertSubtreeIdle(state, sessions, { allowOpenBatches = false } = {}) {
  const ids = new Set(sessions.map((item) => item.id));
  const turn = state.assist_turns.find((item) => ids.has(item.session_id) && ACTIVE_TURN_STATES.has(item.status));
  if (turn) throw new HttpError(409, { error: 'assist_session_busy', resource: 'turn', resource_id: turn.id, session_id: turn.session_id });
  const terminal = state.terminal_sessions.find((item) => ids.has(item.assist_session_id) && ACTIVE_TERMINAL_STATES.has(item.status));
  if (terminal) throw new HttpError(409, { error: 'assist_session_busy', resource: 'terminal', resource_id: terminal.id, session_id: terminal.assist_session_id });
  const batch = state.assist_change_batches.find((item) => ids.has(item.session_id) && (item.write_lock || !allowOpenBatches && item.status === 'open'));
  if (batch) throw new HttpError(409, { error: 'assist_session_busy', resource: batch.write_lock ? 'write_lock' : 'change_batch', resource_id: batch.id, session_id: batch.session_id });
}
async function deleteIndependentNativeThread(state, session, rpc) {
  const threadId = session.codex_thread_id;
  if (!threadId || threadId === session.historical_shared_codex_thread_id) return;
  if (state.assist_sessions.some((item) => item.id !== session.id && item.codex_thread_id === threadId)) return;
  const profile = state.codex_profiles.find((item) => item.id === session.runtime_profile_id && item.status === 'validated' && !item.assist_configuration);
  const project = state.projects.find((item) => item.id === session.project_id && !item.deleted_at);
  if (!profile || !project) throw new HttpError(409, { error: 'assist_native_thread_cleanup_unavailable' });
  try { await rpc({ state, profile, cwd: readableProjectCwd(project), sandbox: 'read-only', resumeId: threadId, createThread: false, method: 'thread/delete', params: {}, projectId: project.id }); }
  catch (error) { if (!nativeThreadMissing(error)) throw error; }
}
async function removeManagedAttachment(file) {
  if (!file) return;
  const root = await fsp.realpath(ATTACHMENT_DIR), full = path.resolve(file), lexicalRelative = path.relative(root, full);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) throw new HttpError(409, { error: 'attachment_storage_outside_root' });
  const stat = await fsp.lstat(full).catch(() => null); if (!stat) return;
  if (stat?.isSymbolicLink()) throw new HttpError(409, { error: 'attachment_storage_symlink' });
  const real = await fsp.realpath(full), realRelative = path.relative(root, real);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new HttpError(409, { error: 'attachment_storage_outside_root' });
  await fsp.rm(real, { force: true });
  await fsp.rm(path.dirname(real), { recursive: true, force: true }).catch(() => undefined);
}
async function markPurgeStage(batchId, stage, clock) { return mutate((state) => { const at = clock().toISOString(); for (const item of state.assist_sessions.filter((entry) => entry.delete_batch_id === batchId && entry.deleted_at)) Object.assign(item, { purge_stage: stage, purge_retry_at: null, updated_at: at }); }); }
async function recordPurgeFailure(batchId, _error, clock) { return mutate((state) => { const date = clock(), retry = new Date(date.getTime() + PURGE_RETRY_MS).toISOString(); for (const item of state.assist_sessions.filter((entry) => entry.delete_batch_id === batchId && entry.deleted_at)) Object.assign(item, { purge_stage: 'retry_pending', purge_retry_at: retry, updated_at: date.toISOString() }); }); }
function sessionDepth(state, sessionId) { let depth = 0, current = state.assist_sessions.find((item) => item.id === sessionId), seen = new Set(); while (current?.forked_from_session_id && !seen.has(current.id)) { seen.add(current.id); depth += 1; current = state.assist_sessions.find((item) => item.id === current.forked_from_session_id); } return depth; }
function safeErrorCode(error) { const value = String(error?.payload?.error || error?.code || error?.message || 'assist_cleanup_failed'); return /^[a-z0-9_.-]{1,160}$/i.test(value) ? value : 'assist_cleanup_failed'; }
function nativeThreadMissing(error) { return /(?:thread.*(?:not[ _-]?found|does not exist)|unknown[ _-]?thread)/i.test(String(error?.message || error?.payload?.error || '')); }

export { DELETE_RETENTION_MS };
