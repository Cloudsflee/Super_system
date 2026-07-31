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
  activeTurn,
  assertSessionScope,
  bindSessionRuntimeProfile,
  cancelPendingTurnApprovals,
  cleanText,
  hasActiveTurn,
  makeTurn,
  normalizeAttachmentIds,
  normalizeTurnCollaborationMode,
  projectWriteUnavailableReason,
  queuePosition,
  requireProject,
  requireSession,
  requireTurn,
  resolveAssistTurnConfiguration,
  TERMINAL_TURN_STATES,
  turnDetail
} from './assist-v3-domain.mjs';
import { assertControlledTaskWrite } from './execution-governance.mjs';
import { prepareTaskExecutionInState } from './task-execution-service.mjs';
import { ensureContextProjection } from './context-service.mjs';
import { normalizeTestResponse, retryTurnInput } from './assist-v3-turn-input.mjs';

export async function createV3Turn(sessionId, input = {}, options = {}) {
  const content = cleanText(input.content ?? input.prompt, 100_000),
    mode = normalizeTurnCollaborationMode(input);
  if (!content) throw new HttpError(400, { error: 'assist_turn_content_required' });
  await ensureTurnContextProjection(sessionId);
  const adapted = testAdapter(input);
  const result = await mutate((state) =>
    createV3TurnInState(state, { sessionId, input, options, content, mode, adapted })
  );
  scheduleV3Session(sessionId);
  return result;
}

async function ensureTurnContextProjection(sessionId) {
  const state = await readState();
  const session = state.assist_sessions.find((item) => item.id === sessionId);
  if (session?.project_id) await ensureContextProjection({ projectId: session.project_id });
}

async function createV3TurnInState(state, { sessionId, input, options, content, mode, adapted }) {
  const actor = owner(state);
  const session = requireSession(state, sessionId);
  const project = requireProject(state, session.project_id);
  assertSessionScope(state, session, input);
  if (session.archived_at) throw new HttpError(409, { error: 'assist_session_archived' });
  const attachmentIds = normalizeAttachmentIds(state, session, input.attachment_ids || []);
  const configuration = resolveAssistTurnConfiguration(state, input, { allowMissingProfile: adapted });
  const operationReference = resolveTurnOperationReference(state, session, project, input.operation_reference_id);
  if (configuration.profile) bindSessionRuntimeProfile(session, configuration.profile);
  const turn = makeTurn({ actor, session, mode, content, input, attachmentIds, options, configuration });
  const control = resolveTurnControl(state, project, session, mode, input);
  if (control.controlled) await prepareTaskExecutionInState(state, control.task_execution.id);
  bindTurnRepositoryWorkspace(state, project, session, turn);
  if (operationReference) assertOperationReferenceView(operationReference, turn.view_context);
  turn.attachment_manifest = turnAttachmentManifest(state, attachmentIds);
  const readOnlyReason = turnReadOnlyReason(project, mode, control.activeWorkflowExecution, control.scopedTaskId);
  assignTurnExecution(turn, control, readOnlyReason, adapted, input);
  assignTurnContext(state, { actor, project, session, turn, attachmentIds, control });
  persistCreatedTurn(state, { actor, project, session, turn, content, mode, readOnlyReason });
  return turn;
}

function resolveTurnOperationReference(state, session, project, operationReferenceId) {
  if (!operationReferenceId) return null;
  const reference = state.assist_operations.find((item) => item.id === operationReferenceId);
  if (!reference) throw new HttpError(404, { error: 'assist_operation_reference_not_found' });
  const matchesSession = reference.session_id === session.id;
  const matchesProject = !reference.project_id || reference.project_id === project.id;
  if (!matchesSession || !matchesProject)
    throw new HttpError(409, { error: 'assist_operation_reference_scope_mismatch' });
  return reference;
}

function resolveTurnControl(state, project, session, mode, input) {
  const activeWorkflowExecution = state.workflow_executions.find(
    (item) => item.project_id === project.id && ['running', 'paused'].includes(item.status)
  );
  const scopedTaskId = turnScopedTaskId(state, session);
  const control =
    activeWorkflowExecution && mode !== 'plan' && scopedTaskId
      ? assertControlledTaskWrite(
          state,
          scopedTaskId,
          { task_execution_id: input.task_execution_id, lease_token: input.lease_token },
          'assist'
        )
      : { controlled: false };
  return { ...control, activeWorkflowExecution, scopedTaskId };
}

function turnScopedTaskId(state, session) {
  if (session.scope_type === 'task') return session.scope_id;
  if (!session.node_id) return null;
  return state.workflow_nodes.find((item) => item.id === session.node_id)?.role === 'task' ? session.node_id : null;
}

function bindTurnRepositoryWorkspace(state, project, session, turn) {
  if (turn.repository_workspace_id) {
    const available = state.repository_workspaces.some(
      (item) => item.id === turn.repository_workspace_id && item.project_id === project.id && item.status === 'active'
    );
    if (!available) throw new HttpError(404, { error: 'repository_workspace_not_found' });
  }
  if (session.active_change_batch_id && turn.repository_workspace_id !== session.repository_workspace_id)
    throw new HttpError(409, {
      error: 'assist_repository_workspace_change_batch_active',
      change_batch_id: session.active_change_batch_id
    });
  if (turn.repository_workspace_id) session.repository_workspace_id = turn.repository_workspace_id;
}

function turnAttachmentManifest(state, attachmentIds) {
  return attachmentIds.map((key) => {
    const item = state.attachments.find((entry) => entry.id === key);
    return {
      id: item.id,
      sha256: item.sha256 || null,
      size_bytes: Number(item.size_bytes || 0),
      detected_mime_type: item.detected_mime_type || item.content_type || 'application/octet-stream',
      storage_status: item.storage_status || 'external',
      relative_path: item.relative_path || null
    };
  });
}

function turnReadOnlyReason(project, mode, activeWorkflowExecution, scopedTaskId) {
  if (mode === 'plan') return 'plan_mode';
  if (activeWorkflowExecution && !scopedTaskId) return 'workflow_execution_project_exploration';
  return projectWriteUnavailableReason(project);
}

function assignTurnExecution(turn, control, readOnlyReason, adapted, input) {
  Object.assign(turn, {
    code_access: readOnlyReason ? 'read_only' : 'workspace_write',
    code_read_only_reason: readOnlyReason,
    task_execution_id: control.task_execution?.id || null
  });
  if (adapted)
    Object.assign(turn, {
      test_adapter: true,
      test_response: normalizeTestResponse(input.test_response, input.test_delay_ms)
    });
}

function assignTurnContext(state, { actor, project, session, turn, attachmentIds, control }) {
  if (control.controlled) {
    turn.context_pack_id = control.task_execution.context_snapshot.context_pack_id;
    return;
  }
  const context = createTurnContext(state, { actor, project, session, turn, attachmentIds });
  turn.context_pack_id = context.pack.id;
  state.context_sufficiency_checks.push(context.check);
  state.context_packs.push(context.pack);
}

function persistCreatedTurn(state, { actor, project, session, turn, content, mode, readOnlyReason }) {
  state.assist_turns.push(turn);
  state.assist_messages.push(createdUserMessage(session.id, turn.id, content));
  Object.assign(session, {
    status: hasActiveTurn(state, session.id) ? 'running' : 'queued',
    view_context: turn.view_context,
    updated_at: now()
  });
  pushV3Event(state, session.id, turn.id, 'queued', {
    collaboration_mode: mode,
    code_access: turn.code_access,
    code_read_only_reason: readOnlyReason,
    queue_position: queuePosition(state, turn)
  });
  addTrace(
    state,
    'assist.message.created',
    {
      project_id: project.id,
      workspace_id: session.workspace_id,
      node_id: session.node_id,
      target_id: turn.id,
      summary: `Assist V3 ${mode} Turn 已排队。`
    },
    actor.id
  );
}

function createdUserMessage(sessionId, turnId, content) {
  return {
    id: id('amsg'),
    session_id: sessionId,
    turn_id: turnId,
    role: 'user',
    content,
    status: 'completed',
    created_at: now()
  };
}

function assertOperationReferenceView(operation, viewContext) {
  const view = operationReferenceView(viewContext);
  if (!operationReferenceMatchesView(operation, view))
    throw new HttpError(409, { error: 'assist_operation_reference_scope_mismatch' });
}

function operationReferenceView(viewContext) {
  return {
    route: cleanText(viewContext?.route, 2_000),
    surfaceId: cleanText(viewContext?.surface?.id || viewContext?.surface?.surface_id, 200),
    surfaceRevision: cleanText(viewContext?.surface?.revision, 200),
    browserId: cleanText(viewContext?.browser_instance_id || viewContext?.surface?.browser_instance_id, 200)
  };
}

function operationReferenceMatchesView(operation, view) {
  if (operation.route && view.route !== operation.route) return false;
  if (operation.surface_id && view.surfaceId !== operation.surface_id) return false;
  if (operation.surface_revision && view.surfaceRevision !== operation.surface_revision) return false;
  return !operation.browser_instance_id || view.browserId === operation.browser_instance_id;
}

export async function retryV3Turn(turnId, input = {}) {
  const state = await readState(),
    source = requireTurn(state, turnId),
    session = requireSession(state, source.session_id, true);
  if (!TERMINAL_TURN_STATES.has(source.status))
    throw new HttpError(409, { error: 'assist_turn_not_retryable', status: source.status });
  return createV3Turn(session.id, retryTurnInput(source, input), { retryOfTurnId: source.id, followUpKind: 'retry' });
}

export async function stopV3Turn(turnId, reason = 'user_stop') {
  abortV3Turn(turnId);
  const result = await mutate((state) => {
    const turn = requireTurn(state, turnId),
      session = requireSession(state, turn.session_id, true);
    if (TERMINAL_TURN_STATES.has(turn.status)) return turn;
    Object.assign(turn, {
      status: 'stopped',
      stopped_reason: cleanText(reason, 200) || 'user_stop',
      completed_at: now(),
      updated_at: now()
    });
    cancelPendingTurnApprovals(state, turn.id, turn.stopped_reason);
    if (!hasActiveTurn(state, session.id, turn.id)) Object.assign(session, { status: 'idle', updated_at: now() });
    pushV3Event(state, session.id, turn.id, 'stopped', { reason: turn.stopped_reason });
    return turn;
  });
  scheduleV3Session(result.session_id);
  return result;
}
export async function createV3FollowUp(sessionId, input = {}, kind = 'queue') {
  if (!['queue', 'steer', 'interrupt'].includes(kind)) throw new HttpError(400, { error: 'invalid_follow_up_kind' });
  const state = await readState(),
    session = requireSession(state, sessionId),
    running = activeTurn(state, session.id);
  let content = cleanText(input.content ?? input.prompt, 100_000);
  if (kind === 'interrupt' && !content) content = 'Stop the current task and summarize the safe stopping point.';
  if (!content) throw new HttpError(400, { error: 'assist_turn_content_required' });
  const turn = await createV3Turn(
    session.id,
    {
      ...input,
      content,
      collaboration_mode: input.collaboration_mode || (running?.collaboration_mode === 'plan' ? 'plan' : 'default')
    },
    { followUpKind: kind, parentTurnId: running?.id || null }
  );
  if (running && kind !== 'queue') {
    await mutate((data) => {
      const current = data.assist_turns.find((item) => item.id === running.id);
      if (current && !TERMINAL_TURN_STATES.has(current.status))
        pushV3Event(data, session.id, current.id, kind === 'steer' ? 'steered' : 'interrupted', {
          follow_up_turn_id: turn.id
        });
    });
    abortV3Turn(running.id);
    await mutate((data) => {
      const current = data.assist_turns.find((item) => item.id === running.id);
      if (current && !TERMINAL_TURN_STATES.has(current.status))
        Object.assign(current, {
          status: 'interrupted',
          interrupted_by_turn_id: turn.id,
          completed_at: now(),
          updated_at: now()
        });
    });
    await mutate((data) => {
      cancelPendingTurnApprovals(data, running.id, kind === 'steer' ? 'turn_steered' : 'turn_interrupted');
    });
  }
  scheduleV3Session(session.id);
  return turn;
}
export async function getV3Turn(turnId) {
  const state = await readState(),
    turn = requireTurn(state, turnId);
  return turnDetail(
    state,
    turn,
    state.worktrees.find((item) => item.id === turn.worktree_id)
  );
}

export async function recoverAssistV3Runtime() {
  const [recoveredBatchLocks, recoveredOperations] = await Promise.all([
    recoverChangeBatchLocks(),
    recoverAssistOperations()
  ]);
  const result = await mutate((state) => {
    let count = 0;
    for (const turn of state.assist_turns.filter((item) =>
      ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(item.status)
    )) {
      Object.assign(turn, {
        status: 'interrupted',
        error_code: 'service_restarted',
        completed_at: now(),
        updated_at: now()
      });
      cancelPendingTurnApprovals(state, turn.id, 'service_restarted');
      pushV3Event(state, turn.session_id, turn.id, 'interrupted', { reason: 'service_restarted' });
      count++;
    }
    const turns = new Map(state.assist_turns.map((item) => [item.id, item]));
    const orphaned = new Set(
      state.runtime_approvals
        .filter(
          (item) =>
            item.turn_id &&
            item.status === 'pending' &&
            (!turns.has(item.turn_id) || TERMINAL_TURN_STATES.has(turns.get(item.turn_id).status))
        )
        .map((item) => item.turn_id)
    );
    let repairedApprovals = 0;
    for (const turnId of orphaned)
      repairedApprovals += cancelPendingTurnApprovals(state, turnId, 'orphaned_runtime_approval');
    for (const session of state.assist_sessions.filter((item) => item.version === 3 && item.status === 'running'))
      Object.assign(session, { status: 'idle', updated_at: now() });
    return {
      interrupted_turns: count,
      repaired_approvals: repairedApprovals,
      queued_session_ids: [
        ...new Set(state.assist_turns.filter((item) => item.status === 'queued').map((item) => item.session_id))
      ]
    };
  });
  for (const sessionId of result.queued_session_ids) scheduleV3Session(sessionId);
  return {
    interrupted_turns: result.interrupted_turns,
    repaired_approvals: result.repaired_approvals,
    recovered_batch_locks: recoveredBatchLocks,
    recovered_operations: recoveredOperations,
    resumed_queues: result.queued_session_ids.length
  };
}
