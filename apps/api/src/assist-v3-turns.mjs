import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { testAdapter } from './test-adapter.mjs';
import { createTurnContext } from './assist-v3-context.mjs';
import { abortV3Turn, scheduleV3Session } from './assist-v3-runtime.mjs';
import { pushV3Event } from './assist-v3-events.mjs';
import { recoverChangeBatchLocks } from './assist-change-batches.mjs';
import { recoverAssistOperations } from './assist-operations.mjs';
import {
  activeTurn, bindSessionRuntimeProfile, cancelPendingTurnApprovals, cleanText, hasActiveTurn, makeTurn, normalizeAttachmentIds,
  normalizeTurnCollaborationMode, projectWriteUnavailableReason, queuePosition, requireProject, requireSession, requireTurn,
  resolveAssistTurnConfiguration, TERMINAL_TURN_STATES, turnDetail
} from './assist-v3-domain.mjs';

export async function createV3Turn(sessionId, input = {}, options = {}) {
  const content = cleanText(input.content ?? input.prompt, 100_000), mode = normalizeTurnCollaborationMode(input);
  if (!content) throw new HttpError(400, { error: 'assist_turn_content_required' });
  const adapted = testAdapter(input);
  const result = await mutate((state) => {
    const actor = owner(state), session = requireSession(state, sessionId), project = requireProject(state, session.project_id);
    if (session.archived_at) throw new HttpError(409, { error: 'assist_session_archived' });
    const attachmentIds = normalizeAttachmentIds(state, session, input.attachment_ids || []);
    const configuration = resolveAssistTurnConfiguration(state, input, { allowMissingProfile: adapted });
    if (configuration.profile) bindSessionRuntimeProfile(session, configuration.profile);
    const turn = makeTurn({ actor, session, mode, content, input, attachmentIds, options, configuration });
    turn.attachment_manifest = attachmentIds.map((key) => {
      const item = state.attachments.find((entry) => entry.id === key);
      return { id: item.id, sha256: item.sha256 || null, size_bytes: Number(item.size_bytes || 0), detected_mime_type: item.detected_mime_type || item.content_type || 'application/octet-stream', storage_status: item.storage_status || 'external', relative_path: item.relative_path || null };
    });
    const readOnlyReason = mode === 'plan' ? 'plan_mode' : projectWriteUnavailableReason(project);
    Object.assign(turn, { code_access: readOnlyReason ? 'read_only' : 'workspace_write', code_read_only_reason: readOnlyReason });
    if (adapted) Object.assign(turn, { test_adapter: true, test_response: normalizeTestResponse(input.test_response, input.test_delay_ms) });
    const context = createTurnContext(state, { actor, project, session, turn, attachmentIds });
    turn.context_pack_id = context.pack.id;
    state.context_sufficiency_checks.push(context.check); state.context_packs.push(context.pack); state.assist_turns.push(turn);
    state.assist_messages.push({ id: id('amsg'), session_id: session.id, turn_id: turn.id, role: 'user', content, status: 'completed', created_at: now() });
    Object.assign(session, { status: hasActiveTurn(state, session.id) ? 'running' : 'queued', view_context: turn.view_context, updated_at: now() });
    pushV3Event(state, session.id, turn.id, 'queued', { collaboration_mode: mode, code_access: turn.code_access, code_read_only_reason: readOnlyReason, queue_position: queuePosition(state, turn) });
    addTrace(state, 'assist.message.created', { project_id: project.id, workspace_id: session.workspace_id, node_id: session.node_id, target_id: turn.id, summary: `Assist V3 ${mode} Turn 已排队。` }, actor.id);
    return turn;
  });
  scheduleV3Session(sessionId); return result;
}

export async function retryV3Turn(turnId, input = {}) {
  const state = await readState(), source = requireTurn(state, turnId), session = requireSession(state, source.session_id, true);
  if (!TERMINAL_TURN_STATES.has(source.status)) throw new HttpError(409, { error: 'assist_turn_not_retryable', status: source.status });
  const adapter = source.test_adapter && process.env.NODE_ENV === 'test' ? { adapter: 'test', test_response: input.test_response || source.test_response } : {};
  return createV3Turn(session.id, { ...adapter, ...input, content: input.content || source.prompt, collaboration_mode: input.collaboration_mode || source.collaboration_mode || (source.mode === 'plan' ? 'plan' : 'default'), attachment_ids: input.attachment_ids || source.attachment_ids || [], profile_id: input.profile_id || (source.profile_id === 'test_adapter' ? undefined : source.profile_id), configuration_id: input.configuration_id || source.configuration_id, model: input.model || source.model, reasoning: input.reasoning || source.reasoning, view_context: input.view_context || source.view_context }, { retryOfTurnId: source.id, followUpKind: 'retry' });
}
export async function stopV3Turn(turnId, reason = 'user_stop') {
  abortV3Turn(turnId);
  const result = await mutate((state) => {
    const turn = requireTurn(state, turnId), session = requireSession(state, turn.session_id, true);
    if (TERMINAL_TURN_STATES.has(turn.status)) return turn;
    Object.assign(turn, { status: 'stopped', stopped_reason: cleanText(reason, 200) || 'user_stop', completed_at: now(), updated_at: now() });
    cancelPendingTurnApprovals(state, turn.id, turn.stopped_reason);
    if (!hasActiveTurn(state, session.id, turn.id)) Object.assign(session, { status: 'idle', updated_at: now() });
    pushV3Event(state, session.id, turn.id, 'stopped', { reason: turn.stopped_reason }); return turn;
  });
  scheduleV3Session(result.session_id); return result;
}
export async function createV3FollowUp(sessionId, input = {}, kind = 'queue') {
  if (!['queue', 'steer', 'interrupt'].includes(kind)) throw new HttpError(400, { error: 'invalid_follow_up_kind' });
  const state = await readState(), session = requireSession(state, sessionId), running = activeTurn(state, session.id);
  let content = cleanText(input.content ?? input.prompt, 100_000);
  if (kind === 'interrupt' && !content) content = 'Stop the current task and summarize the safe stopping point.';
  if (!content) throw new HttpError(400, { error: 'assist_turn_content_required' });
  const turn = await createV3Turn(session.id, { ...input, content, collaboration_mode: input.collaboration_mode || (running?.collaboration_mode === 'plan' ? 'plan' : 'default') }, { followUpKind: kind, parentTurnId: running?.id || null });
  if (running && kind !== 'queue') {
    await mutate((data) => { const current = data.assist_turns.find((item) => item.id === running.id); if (current && !TERMINAL_TURN_STATES.has(current.status)) pushV3Event(data, session.id, current.id, kind === 'steer' ? 'steered' : 'interrupted', { follow_up_turn_id: turn.id }); });
    abortV3Turn(running.id);
    await mutate((data) => { const current = data.assist_turns.find((item) => item.id === running.id); if (current && !TERMINAL_TURN_STATES.has(current.status)) Object.assign(current, { status: 'interrupted', interrupted_by_turn_id: turn.id, completed_at: now(), updated_at: now() }); });
    await mutate((data) => { cancelPendingTurnApprovals(data, running.id, kind === 'steer' ? 'turn_steered' : 'turn_interrupted'); });
  }
  scheduleV3Session(session.id); return turn;
}
export async function getV3Turn(turnId) { const state = await readState(), turn = requireTurn(state, turnId); return turnDetail(state, turn, state.worktrees.find((item) => item.id === turn.worktree_id)); }

export async function recoverAssistV3Runtime() {
  const [recoveredBatchLocks, recoveredOperations] = await Promise.all([recoverChangeBatchLocks(), recoverAssistOperations()]);
  const result = await mutate((state) => {
    let count = 0;
    for (const turn of state.assist_turns.filter((item) => ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(item.status))) { Object.assign(turn, { status: 'interrupted', error_code: 'service_restarted', completed_at: now(), updated_at: now() }); cancelPendingTurnApprovals(state, turn.id, 'service_restarted'); pushV3Event(state, turn.session_id, turn.id, 'interrupted', { reason: 'service_restarted' }); count++; }
    const turns = new Map(state.assist_turns.map((item) => [item.id, item]));
    const orphaned = new Set(state.runtime_approvals.filter((item) => item.turn_id && item.status === 'pending' && (!turns.has(item.turn_id) || TERMINAL_TURN_STATES.has(turns.get(item.turn_id).status))).map((item) => item.turn_id));
    let repairedApprovals = 0;
    for (const turnId of orphaned) repairedApprovals += cancelPendingTurnApprovals(state, turnId, 'orphaned_runtime_approval');
    for (const session of state.assist_sessions.filter((item) => item.version === 3 && item.status === 'running')) Object.assign(session, { status: 'idle', updated_at: now() });
    return { interrupted_turns: count, repaired_approvals: repairedApprovals, queued_session_ids: [...new Set(state.assist_turns.filter((item) => item.status === 'queued').map((item) => item.session_id))] };
  });
  for (const sessionId of result.queued_session_ids) scheduleV3Session(sessionId);
  return { interrupted_turns: result.interrupted_turns, repaired_approvals: result.repaired_approvals, recovered_batch_locks: recoveredBatchLocks, recovered_operations: recoveredOperations, resumed_queues: result.queued_session_ids.length };
}

function normalizeTestResponse(value, delayValue) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    message: cleanText(source.message || 'Test Assist V3 Turn completed.', 100_000),
    delay_ms: Math.max(0, Math.min(2_000, Number(source.delay_ms ?? delayValue ?? 10) || 0)),
    events: Array.isArray(source.events) ? source.events.slice(0, 100).map(normalizeTestEvent) : [],
    files: Array.isArray(source.files) ? source.files.slice(0, 50).map((file) => ({ path: cleanText(file?.path, 2_000), content: String(file?.content ?? '').slice(0, 200_000) })) : [],
    actions: Array.isArray(source.actions) ? source.actions.slice(0, 50) : []
  };
}
function normalizeTestEvent(event) {
  const type = cleanText(event?.type, 100), data = event?.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {};
  const fields = {
    text: ['text'], plan: ['text', 'status'], command: ['command', 'status', 'exit_code', 'output'],
    file_change: ['changes', 'status'], test: ['name', 'status', 'summary'], mcp: ['server', 'tool', 'status'],
    search: ['query', 'status'], usage: ['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens'],
    approval: ['external_id', 'approval_type', 'status'], reasoning_summary: ['summary'], status: ['status']
  }[type] || [];
  return { type, data: Object.fromEntries(fields.filter((key) => data[key] !== undefined).map((key) => [key, data[key]])) };
}
