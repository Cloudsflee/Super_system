import { cloneStateValue as structuredClone } from './state-clone.mjs';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { hashString, id, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { publicWorktree } from './assist-v3-worktree.mjs';
import { publicOperation } from './assist-operation-metadata.mjs';
import { publicAttachment, safeRelativePath } from './assist-attachment-domain.mjs';
export {
  modelPolicy,
  normalizeAttachmentIds,
  normalizeAttachmentKind,
  normalizeSelection,
  publicAttachment,
  safeRelativePath
} from './assist-attachment-domain.mjs';
export {
  assertAgentProjectReady,
  isWritableTurn,
  projectWriteUnavailableReason,
  readableProjectCwd
} from './assist-project-readiness.mjs';
export const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
export const TURN_MODES = new Set(['default', 'plan']);
const CODEX_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/+:@-]{0,199}$/;
const REASONING_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
export function requireProject(state, projectId) {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  if (project.lifecycle_operation)
    throw new HttpError(423, {
      error: 'project_lifecycle_operation_in_progress',
      operation: project.lifecycle_operation.type || null
    });
  return project;
}
export function requireSession(state, sessionId, includeArchived = false, includeDeleted = false) {
  const session = state.assist_sessions.find((item) => item.id === sessionId && item.version === 3);
  if (!session || (!includeArchived && session.archived_at) || (!includeDeleted && session.deleted_at))
    throw new HttpError(404, { error: 'assist_session_not_found' });
  requireProject(state, session.project_id);
  return session;
}
export function requireTurn(state, turnId) {
  const turn = state.assist_turns.find((item) => item.id === turnId);
  if (!turn) throw new HttpError(404, { error: 'assist_turn_not_found' });
  requireSession(state, turn.session_id, true);
  return turn;
}
export function activeTurn(state, sessionId) {
  return (
    state.assist_turns.find(
      (item) =>
        item.session_id === sessionId &&
        ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(item.status)
    ) || null
  );
}
export function hasActiveTurn(state, sessionId, excluded = null) {
  return state.assist_turns.some(
    (item) =>
      item.session_id === sessionId &&
      item.id !== excluded &&
      ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(item.status)
  );
}
export function queuePosition(state, turn) {
  return state.assist_turns.filter(
    (item) =>
      item.session_id === turn.session_id &&
      item.status === 'queued' &&
      String(item.created_at) <= String(turn.created_at)
  ).length;
}
export function cancelPendingTurnApprovals(state, turnId, reason = 'turn_ended') {
  let count = 0;
  for (const approval of state.runtime_approvals.filter(
    (item) => item.turn_id === turnId && item.status === 'pending'
  )) {
    Object.assign(approval, {
      status: 'cancelled',
      attention_state: 'resolved',
      cancelled_reason: cleanText(reason, 200) || 'turn_ended',
      cancelled_at: now(),
      revision: Number(approval.revision || 1) + 1,
      updated_at: now()
    });
    count++;
  }
  return count;
}
export function resolveScope(state, project, type, scopeId) {
  if (!['project', 'workflow', 'workstream', 'task'].includes(type))
    throw new HttpError(400, { error: 'invalid_assist_scope', allowed: ['project', 'workflow', 'workstream', 'task'] });
  if (type === 'project') {
    if (scopeId && scopeId !== project.id) throw new HttpError(409, { error: 'assist_scope_project_mismatch' });
    return scopeRecord(state, project, type, project.id, null, null);
  }
  if (type === 'workflow') {
    const workflow = state.workflows.find(
      (item) => item.id === scopeId && item.project_id === project.id && item.status !== 'archived'
    );
    if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
    return scopeRecord(state, project, type, workflow.id, workflow, null);
  }
  const node = state.workflow_nodes.find(
    (item) =>
      item.id === scopeId &&
      item.role === type &&
      !item.legacy_read_only &&
      state.workflows.some(
        (workflow) =>
          workflow.id === item.workflow_id && workflow.project_id === project.id && workflow.status !== 'archived'
      )
  );
  if (!node) throw new HttpError(404, { error: type === 'workstream' ? 'workstream_not_found' : 'task_not_found' });
  const workflow = state.workflows.find((item) => item.id === node.workflow_id);
  return scopeRecord(state, project, type, node.id, workflow, node);
}

export function makeSession({
  actor,
  project,
  scope,
  title,
  parentSessionId,
  viewContext,
  clarificationPolicy = 'ask'
}) {
  const created = now();
  return {
    id: id('asst'),
    version: 3,
    project_id: project.id,
    workspace_id: scope.workspaceId,
    node_id: scope.nodeId,
    scope_type: scope.type,
    scope_id: scope.id,
    parent_session_id: parentSessionId,
    title: cleanText(title, 120) || `${scope.node?.title || project.title} · Assist`,
    status: 'idle',
    lifecycle: 'active',
    pinned: false,
    archived_at: null,
    codex_thread_id: null,
    legacy_codex_thread_id: null,
    native_thread_generation: 2,
    native_thread_repair_required: false,
    runtime_profile_id: null,
    runtime_affinity_key: null,
    forked_from_session_id: null,
    forked_from_turn_id: null,
    forked_from_codex_turn_id: null,
    historical_shared_codex_thread_id: null,
    delete_batch_id: null,
    deleted_at: null,
    purge_after: null,
    purge_stage: null,
    purge_retry_at: null,
    active_change_batch_id: null,
    repository_workspace_id: repositoryWorkspaceId(viewContext),
    view_context: viewContext || {},
    clarification_policy: normalizeClarificationPolicy(clarificationPolicy),
    scope_status: 'active',
    scope_snapshot: structuredClone(scope.snapshot),
    scope_breadcrumb: structuredClone(scope.breadcrumb),
    read_only: false,
    created_by_user_id: actor.id,
    created_at: created,
    updated_at: created
  };
}
export function makeTurn({ actor, session, mode, content, input, attachmentIds, options, configuration }) {
  const created = now();
  return {
    id: id('atrn'),
    session_id: session.id,
    project_id: session.project_id,
    workspace_id: session.workspace_id,
    node_id: session.node_id,
    parent_turn_id: options.parentTurnId || null,
    retry_of_turn_id: options.retryOfTurnId || null,
    follow_up_kind: options.followUpKind || null,
    mode,
    collaboration_mode: mode,
    prompt: content,
    output_text: '',
    status: 'queued',
    profile_id: configuration.profile?.id || null,
    configuration_id: configuration.configuration?.id || null,
    model: configuration.model,
    reasoning: configuration.reasoning,
    repository_workspace_id:
      cleanText(
        input.repository_workspace_id || repositoryWorkspaceId(input.view_context) || session.repository_workspace_id,
        200
      ) || null,
    view_context: safeViewContext(input.view_context ?? session.view_context),
    context_pack_id: null,
    worktree_id: null,
    change_batch_id: null,
    attachment_ids: attachmentIds,
    attachment_manifest: [],
    codex_thread_id: null,
    codex_turn_id: null,
    usage: null,
    code_access: null,
    code_read_only_reason: null,
    operation_reference_id: cleanText(input.operation_reference_id, 200) || null,
    review_status: 'pending',
    review: { status: 'pending', viewed_files: {}, comment_count: 0 },
    created_by_user_id: actor.id,
    started_at: null,
    completed_at: null,
    created_at: created,
    updated_at: created
  };
}
export function sessionSummary(state, session) {
  const { runtime_affinity_key: _runtimeAffinityKey, ...visible } = session;
  const turns = state.assist_turns.filter((item) => item.session_id === session.id);
  const last = turns.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
  const descendants = sessionDescendantIds(state, session.id);
  const activeDescendants = descendants.filter(
    (key) => !state.assist_sessions.find((item) => item.id === key)?.deleted_at
  ).length;
  return {
    ...visible,
    scope_breadcrumb: currentScopeBreadcrumb(state, session),
    scope_label: scopeLabel(session.scope_type),
    deletable: Boolean(session.forked_from_session_id && !session.deleted_at),
    descendant_count: activeDescendants,
    deleted_descendant_count: descendants.length - activeDescendants,
    turn_count: turns.length,
    last_turn: last ? { id: last.id, mode: last.mode, status: last.status, updated_at: last.updated_at } : null
  };
}

export function assertSessionScope(state, session, input = {}) {
  if (
    (input.project_id && input.project_id !== session.project_id) ||
    (input.scope_type && input.scope_type !== session.scope_type) ||
    (input.scope_id && input.scope_id !== session.scope_id)
  )
    throw new HttpError(409, {
      error: 'assist_session_scope_mismatch',
      expected: { project_id: session.project_id, scope_type: session.scope_type, scope_id: session.scope_id }
    });
  if (session.scope_status !== 'active' || session.read_only)
    throw new HttpError(409, {
      error: 'assist_scope_read_only',
      scope_status: session.scope_status || 'invalidated',
      scope_snapshot: session.scope_snapshot || null
    });
  const project = state.projects.find((item) => item.id === session.project_id && !item.deleted_at);
  if (!project) throw new HttpError(409, { error: 'assist_scope_invalidated' });
  try {
    resolveScope(state, project, session.scope_type, session.scope_id);
  } catch (error) {
    Object.assign(session, {
      scope_status: 'invalidated',
      read_only: true,
      invalidated_at: now(),
      invalidated_reason: error?.payload?.error || 'scope_missing',
      updated_at: now()
    });
    throw new HttpError(409, { error: 'assist_scope_invalidated', scope_snapshot: session.scope_snapshot || null });
  }
  return session;
}
export function invalidateAssistScopesInState(state, scopeIds, reason = 'scope_removed') {
  const ids = new Set(Array.isArray(scopeIds) ? scopeIds : [scopeIds]);
  const invalidated = [];
  for (const session of state.assist_sessions.filter(
    (item) => item.version === 3 && ids.has(item.scope_id) && item.scope_status !== 'invalidated'
  )) {
    Object.assign(session, {
      scope_status: 'invalidated',
      read_only: true,
      invalidated_at: now(),
      invalidated_reason: reason,
      updated_at: now()
    });
    invalidated.push(session.id);
  }
  return invalidated;
}
function scopeRecord(state, project, type, scopeId, workflow, node) {
  const parent =
    node?.role === 'task'
      ? state.workflow_nodes.find((item) => item.id === node.parent_node_id && item.role === 'workstream')
      : null;
  const breadcrumb = [{ type: 'project', id: project.id, label: project.title }];
  if (workflow) breadcrumb.push({ type: 'workflow', id: workflow.id, label: workflow.title });
  if (parent) breadcrumb.push({ type: 'workstream', id: parent.id, label: parent.title });
  if (node) breadcrumb.push({ type: node.role, id: node.id, label: node.title });
  return {
    type,
    id: scopeId,
    workflow,
    node,
    nodeId: node?.id || null,
    workspaceId: node?.workspace_id || workflow?.workspace_id || project.current_workspace_id || null,
    breadcrumb,
    snapshot: {
      project_id: project.id,
      project_title: project.title,
      scope_type: type,
      scope_id: scopeId,
      scope_title: node?.title || workflow?.title || project.title,
      workflow_id: workflow?.id || null,
      parent_workstream_id: parent?.id || (node?.role === 'workstream' ? node.id : null),
      breadcrumb,
      captured_at: now()
    }
  };
}
function currentScopeBreadcrumb(state, session) {
  if (session.scope_status !== 'active') return session.scope_snapshot?.breadcrumb || session.scope_breadcrumb || [];
  const project = state.projects.find((item) => item.id === session.project_id && !item.deleted_at);
  if (!project) return session.scope_snapshot?.breadcrumb || session.scope_breadcrumb || [];
  try {
    return resolveScope(state, project, session.scope_type, session.scope_id).breadcrumb;
  } catch {
    return session.scope_snapshot?.breadcrumb || session.scope_breadcrumb || [];
  }
}

function scopeLabel(type) {
  return (
    { project: 'Project', workflow: 'Workflow', workstream: 'Workstream', task: 'Task', node: 'Legacy node' }[type] ||
    String(type || 'Scope')
  );
}
export function sessionDetail(state, session) {
  const visible = sessionSummary(state, session);
  const turns = state.assist_turns
    .filter((item) => item.session_id === session.id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const events = state.assist_events.filter((item) => item.session_id === session.id);
  const batch = state.assist_change_batches.find((item) => item.id === session.active_change_batch_id) || null;
  return {
    ...visible,
    change_batch: batch
      ? publicChangeBatch(
          batch,
          state.worktrees.find((item) => item.id === batch.worktree_id)
        )
      : null,
    turns: turns.map((turn) =>
      turnDetail(
        state,
        turn,
        state.worktrees.find((item) => item.id === turn.worktree_id)
      )
    ),
    attachments: state.attachments.filter((item) => item.session_id === session.id).map(publicAttachment),
    last_event_id: Math.max(0, ...events.map((item) => Number(item.sequence) || 0))
  };
}
export function turnDetail(state, turn, worktree) {
  const {
    attachment_manifest: _attachmentManifest,
    test_adapter: _testAdapter,
    test_response: _testResponse,
    ...visible
  } = turn;
  return {
    ...visible,
    worktree: publicWorktree(worktree),
    attachments: (turn.attachment_ids || [])
      .map((key) => state.attachments.find((item) => item.id === key))
      .filter(Boolean)
      .map(publicAttachment),
    actions: [],
    operations: state.assist_operations
      .filter((item) => item.turn_id === turn.id)
      .map((item) => publicOperation(item, state)),
    user_inputs: state.runtime_user_inputs.filter((item) => item.turn_id === turn.id).map(publicRuntimeUserInput),
    comments: state.human_reviews.filter((item) => item.target_type === 'assist_turn' && item.target_id === turn.id),
    last_event_id: Math.max(
      0,
      ...state.assist_events.filter((item) => item.turn_id === turn.id).map((item) => Number(item.sequence) || 0)
    )
  };
}
export function normalizeTurnCollaborationMode(input = {}) {
  const explicit = input.collaboration_mode == null ? null : String(input.collaboration_mode).toLowerCase();
  const legacy = input.mode == null ? null : String(input.mode).toLowerCase();
  if (explicit && !TURN_MODES.has(explicit)) throw removedOrUnsupportedMode(explicit);
  let mapped = null;
  if (legacy === 'ask' || legacy === 'default') mapped = 'default';
  else if (legacy === 'plan') mapped = 'plan';
  else if (legacy) throw removedOrUnsupportedMode(legacy);
  if (explicit && mapped && explicit !== mapped)
    throw new HttpError(400, {
      error: 'assist_collaboration_mode_conflict',
      collaboration_mode: explicit,
      mode: legacy
    });
  return explicit || mapped || 'default';
}
export function normalizeClarificationPolicy(value) {
  const policy = String(value || 'ask').toLowerCase();
  if (!['ask', 'auto_recommend'].includes(policy))
    throw new HttpError(400, { error: 'assist_clarification_policy_invalid', clarification_policy: policy });
  return policy;
}
export function safeViewContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const text = JSON.stringify(maskSecretsDeep(value));
  if (Buffer.byteLength(text, 'utf8') > 100_000) throw new HttpError(413, { error: 'assist_view_context_too_large' });
  return JSON.parse(text);
}
function repositoryWorkspaceId(value) {
  return cleanText(value?.repository_workspace_id || value?.surface?.repository_workspace_id, 200) || null;
}
export function resolveAssistTurnConfiguration(state, input = {}, { allowMissingProfile = false } = {}) {
  const configurationId = cleanText(input.configuration_id, 200);
  let configuration = configurationId ? state.assist_configurations.find((item) => item.id === configurationId) : null;
  if (configurationId && !configuration) throw new HttpError(404, { error: 'assist_configuration_not_found' });
  const requestedId = cleanText(input.profile_id, 200);
  const requestedProfile = requestedId
    ? state.codex_profiles.find((item) => item.id === requestedId && item.status === 'validated')
    : null;
  if (requestedId && !requestedProfile) throw new HttpError(404, { error: 'validated_profile_not_found' });
  if (!configuration && requestedProfile?.assist_configuration)
    configuration = state.assist_configurations.find((item) => item.legacy_profile_id === requestedProfile.id) || {
      id: null,
      base_profile_id: requestedProfile.base_profile_id,
      model: requestedProfile.model,
      reasoning: requestedProfile.reasoning
    };
  const baseProfileId = configuration?.base_profile_id || requestedProfile?.base_profile_id || requestedProfile?.id;
  const profile = baseProfileId
    ? state.codex_profiles.find(
        (item) => item.id === baseProfileId && item.status === 'validated' && !item.assist_configuration
      )
    : state.codex_profiles.find(
        (item) => item.is_active && item.status === 'validated' && !item.assist_configuration
      ) || state.codex_profiles.find((item) => item.status === 'validated' && !item.assist_configuration);
  if (!profile && !allowMissingProfile) throw new HttpError(409, { error: 'active_codex_profile_required' });
  const model = normalizeAssistModel(
    input.model ??
      configuration?.model ??
      requestedProfile?.model ??
      profile?.model ??
      (allowMissingProfile ? 'test' : '')
  );
  const reasoning = normalizeAssistReasoning(
    input.reasoning ?? configuration?.reasoning ?? requestedProfile?.reasoning ?? profile?.reasoning ?? 'high'
  );
  return { profile, configuration, model, reasoning };
}
export function normalizeAssistModel(value) {
  const model = cleanText(value, 200);
  if (!CODEX_MODEL_PATTERN.test(model)) throw new HttpError(400, { error: 'invalid_assist_model' });
  return model;
}
export function normalizeAssistReasoning(value) {
  const reasoning = cleanText(value, 64).toLowerCase();
  if (!REASONING_PATTERN.test(reasoning)) throw new HttpError(400, { error: 'invalid_assist_reasoning' });
  return reasoning;
}
export function publicProfile(profile) {
  return { id: profile.id, name: profile.name, model: profile.model, reasoning: profile.reasoning, kind: profile.kind };
}
export function persistedWorktreeFields(value) {
  return Object.fromEntries(
    ['status', 'target_hash', 'applied_target_hash', 'head_commit', 'applied_at', 'rolled_back_at', 'updated_at'].map(
      (key) => [key, value[key]]
    )
  );
}

export function cleanText(value, max = 10_000) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .slice(0, max)
    .trim();
}
export function cleanHash(value) {
  const text = String(value || '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}
export function boundedInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}
export function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
export function safeViewPath(value) {
  try {
    return safeRelativePath(value);
  } catch {
    return null;
  }
}
export function attachmentHash(text, fallback) {
  return text ? hashString(text) : cleanHash(fallback);
}
export function inferContentType(filePath) {
  return (
    {
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.ts': 'text/typescript',
      '.tsx': 'text/typescript',
      '.js': 'text/javascript',
      '.jsx': 'text/javascript',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf'
    }[path.extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream'
  );
}
export function publicErrorCode(error) {
  if (error instanceof HttpError && typeof error.payload === 'object')
    return cleanText(error.payload.error, 200) || 'assist_turn_failed';
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === 'codex_state_runtime_incompatible' || /failed to initialize (?:sqlite )?state runtime/i.test(message))
    return 'codex_runtime_state_incompatible';
  if (/timeout/i.test(message)) return 'codex_timeout';
  if (code === 'native_plan_unavailable') return 'codex_native_plan_unavailable';
  if (code === 'app_server_start_failed') return 'codex_runtime_start_failed';
  if (code === 'app_server_turn_failed') return 'codex_turn_failed';
  if (/runner_mount|workspace.*(?:missing|unavailable|outside)/i.test(message)) return 'assist_workspace_unavailable';
  if (message === 'active_codex_profile_required') return message;
  if (/auth/i.test(message)) return 'codex_auth_failed';
  if (/codex_(?:app_server_)?(?:exit|turn)|responses api/i.test(message)) return 'codex_turn_failed';
  return 'assist_turn_failed';
}

export function bindSessionRuntimeProfile(session, profile) {
  if (!profile?.id) return session;
  const affinityKey = hashString(
    JSON.stringify({
      profile_id: profile.id,
      provider: profile.provider || null,
      base_url: profile.base_url || null,
      credential_ref: profile.credential_ref_id || profile.credential_ref || null,
      codex_home: profile.codex_home || null
    })
  );
  if (
    session.runtime_profile_id &&
    (session.runtime_profile_id !== profile.id || session.runtime_affinity_key !== affinityKey)
  ) {
    throw new HttpError(409, {
      error: 'assist_profile_affinity_conflict',
      current_profile_id: session.runtime_profile_id,
      requested_profile_id: profile.id,
      action: 'fork_thread'
    });
  }
  session.runtime_profile_id = profile.id;
  session.runtime_affinity_key = affinityKey;
  session.updated_at = now();
  return session;
}
function sessionDescendantIds(state, sessionId) {
  const result = [],
    queue = [sessionId],
    seen = new Set([sessionId]);
  while (queue.length) {
    const parent = queue.shift();
    for (const child of state.assist_sessions.filter(
      (item) => item.version === 3 && item.forked_from_session_id === parent
    )) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

function removedOrUnsupportedMode(value) {
  if (value === 'agent' || value === 'cli')
    return new HttpError(410, {
      error: 'assist_mode_removed',
      mode: value,
      allowed: [...TURN_MODES],
      action: value === 'cli' ? 'open_terminal' : 'use_default'
    });
  return new HttpError(400, { error: 'unsupported_assist_mode', mode: value, allowed: [...TURN_MODES] });
}

function publicRuntimeUserInput(item) {
  return {
    id: item.id,
    session_id: item.session_id,
    turn_id: item.turn_id,
    item_id: item.item_id,
    questions: item.questions,
    status: item.status,
    contains_secret: Boolean(item.contains_secret),
    auto_resolution_ms: item.auto_resolution_ms ?? null,
    expires_at: item.expires_at || null,
    responded_at: item.responded_at || null,
    cancelled_at: item.cancelled_at || null,
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

function publicChangeBatch(batch, worktree) {
  return {
    id: batch.id,
    session_id: batch.session_id,
    project_id: batch.project_id,
    worktree_id: batch.worktree_id,
    base_commit: batch.base_commit,
    head_commit: batch.head_commit,
    target_hash: batch.target_hash,
    status: batch.status,
    locked: Boolean(batch.write_lock),
    created_at: batch.created_at,
    updated_at: batch.updated_at,
    worktree: publicWorktree(worktree)
  };
}
