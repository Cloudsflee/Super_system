import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { ASSIST_DIR } from './config.mjs';
import { hashString, id, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { publicWorktree } from './assist-v3-worktree.mjs';
import { publicOperation } from './assist-operation-metadata.mjs';

export const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
export const TURN_MODES = new Set(['default', 'plan']);
const CODEX_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/+:@-]{0,199}$/;
const REASONING_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

export function requireProject(state, projectId) {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  if (project.lifecycle_operation) throw new HttpError(423, { error: 'project_lifecycle_operation_in_progress', operation: project.lifecycle_operation.type || null });
  return project;
}
export function requireSession(state, sessionId, includeArchived = false, includeDeleted = false) {
  const session = state.assist_sessions.find((item) => item.id === sessionId && item.version === 3);
  if (!session || (!includeArchived && session.archived_at) || (!includeDeleted && session.deleted_at)) throw new HttpError(404, { error: 'assist_session_not_found' });
  requireProject(state, session.project_id);
  return session;
}
export function requireTurn(state, turnId) {
  const turn = state.assist_turns.find((item) => item.id === turnId);
  if (!turn) throw new HttpError(404, { error: 'assist_turn_not_found' });
  requireSession(state, turn.session_id, true);
  return turn;
}
export function activeTurn(state, sessionId) { return state.assist_turns.find((item) => item.session_id === sessionId && ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(item.status)) || null; }
export function hasActiveTurn(state, sessionId, excluded = null) { return state.assist_turns.some((item) => item.session_id === sessionId && item.id !== excluded && ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(item.status)); }
export function queuePosition(state, turn) { return state.assist_turns.filter((item) => item.session_id === turn.session_id && item.status === 'queued' && String(item.created_at) <= String(turn.created_at)).length; }
export function cancelPendingTurnApprovals(state, turnId, reason = 'turn_ended') {
  let count = 0;
  for (const approval of state.runtime_approvals.filter((item) => item.turn_id === turnId && item.status === 'pending')) {
    Object.assign(approval, { status: 'cancelled', attention_state: 'resolved', cancelled_reason: cleanText(reason, 200) || 'turn_ended', cancelled_at: now(), revision: Number(approval.revision || 1) + 1, updated_at: now() });
    count++;
  }
  return count;
}

export function resolveScope(state, project, type, scopeId) {
  if (!['project', 'node'].includes(type)) throw new HttpError(400, { error: 'invalid_assist_scope' });
  if (type === 'project') return { type, id: project.id, workspaceId: project.current_workspace_id || null, nodeId: null, node: null };
  const node = state.workflow_nodes.find((item) => item.id === scopeId && state.workflows.some((workflow) => workflow.id === item.workflow_id && workflow.project_id === project.id));
  if (!node) throw new HttpError(404, { error: 'node_not_found' });
  return { type, id: node.id, workspaceId: node.workspace_id || state.workspaces.find((item) => item.workflow_node_id === node.id)?.id || null, nodeId: node.id, node };
}

export function makeSession({ actor, project, scope, title, parentSessionId, viewContext, clarificationPolicy = 'ask' }) {
  const created = now();
  return {
    id: id('asst'), version: 3, project_id: project.id, workspace_id: scope.workspaceId, node_id: scope.nodeId,
    scope_type: scope.type, scope_id: scope.id, parent_session_id: parentSessionId,
    title: cleanText(title, 120) || `${scope.node?.title || project.title} · Assist`, status: 'idle', lifecycle: 'active',
    pinned: false, archived_at: null, codex_thread_id: null, legacy_codex_thread_id: null,
    native_thread_generation: 2, native_thread_repair_required: false, runtime_profile_id: null, runtime_affinity_key: null,
    forked_from_session_id: null, forked_from_turn_id: null, forked_from_codex_turn_id: null,
    historical_shared_codex_thread_id: null, delete_batch_id: null, deleted_at: null,
    purge_after: null, purge_stage: null, purge_retry_at: null,
    active_change_batch_id: null, view_context: viewContext || {}, clarification_policy: normalizeClarificationPolicy(clarificationPolicy),
    created_by_user_id: actor.id, created_at: created, updated_at: created
  };
}
export function makeTurn({ actor, session, mode, content, input, attachmentIds, options, configuration }) {
  const created = now();
  return {
    id: id('atrn'), session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, node_id: session.node_id,
    parent_turn_id: options.parentTurnId || null, retry_of_turn_id: options.retryOfTurnId || null, follow_up_kind: options.followUpKind || null,
    mode, collaboration_mode: mode, prompt: content, output_text: '', status: 'queued', profile_id: configuration.profile?.id || null,
    configuration_id: configuration.configuration?.id || null,
    model: configuration.model, reasoning: configuration.reasoning, view_context: safeViewContext(input.view_context ?? session.view_context),
    context_pack_id: null, worktree_id: null, change_batch_id: null, attachment_ids: attachmentIds, attachment_manifest: [], codex_thread_id: null, codex_turn_id: null, usage: null,
    code_access: null, code_read_only_reason: null, operation_reference_id: cleanText(input.operation_reference_id, 200) || null,
    review_status: 'pending', review: { status: 'pending', viewed_files: {}, comment_count: 0 },
    created_by_user_id: actor.id, started_at: null, completed_at: null, created_at: created, updated_at: created
  };
}

export function sessionSummary(state, session) {
  const { runtime_affinity_key: _runtimeAffinityKey, ...visible } = session;
  const turns = state.assist_turns.filter((item) => item.session_id === session.id);
  const last = turns.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
  const descendants = sessionDescendantIds(state, session.id);
  const activeDescendants = descendants.filter((key) => !state.assist_sessions.find((item) => item.id === key)?.deleted_at).length;
  return { ...visible, deletable: Boolean(session.forked_from_session_id && !session.deleted_at), descendant_count: activeDescendants, deleted_descendant_count: descendants.length - activeDescendants, turn_count: turns.length, last_turn: last ? { id: last.id, mode: last.mode, status: last.status, updated_at: last.updated_at } : null };
}
export function sessionDetail(state, session) {
  const visible = sessionSummary(state, session);
  const turns = state.assist_turns.filter((item) => item.session_id === session.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const events = state.assist_events.filter((item) => item.session_id === session.id);
  const batch = state.assist_change_batches.find((item) => item.id === session.active_change_batch_id) || null;
  return { ...visible, change_batch: batch ? publicChangeBatch(batch, state.worktrees.find((item) => item.id === batch.worktree_id)) : null, turns: turns.map((turn) => turnDetail(state, turn, state.worktrees.find((item) => item.id === turn.worktree_id))), attachments: state.attachments.filter((item) => item.session_id === session.id).map(publicAttachment), last_event_id: Math.max(0, ...events.map((item) => Number(item.sequence) || 0)) };
}
export function turnDetail(state, turn, worktree) {
  const { attachment_manifest: _attachmentManifest, test_adapter: _testAdapter, test_response: _testResponse, ...visible } = turn;
  return { ...visible, worktree: publicWorktree(worktree), attachments: (turn.attachment_ids || []).map((key) => state.attachments.find((item) => item.id === key)).filter(Boolean).map(publicAttachment), actions: [], operations: state.assist_operations.filter((item) => item.turn_id === turn.id).map(publicOperation), user_inputs: state.runtime_user_inputs.filter((item) => item.turn_id === turn.id).map(publicRuntimeUserInput), comments: state.human_reviews.filter((item) => item.target_type === 'assist_turn' && item.target_id === turn.id), last_event_id: Math.max(0, ...state.assist_events.filter((item) => item.turn_id === turn.id).map((item) => Number(item.sequence) || 0)) };
}
export function publicAttachment(item) {
  return { id: item.id, project_id: item.project_id, session_id: item.session_id || null, turn_id: item.turn_id || null, kind: item.kind, title: item.title || item.label || item.kind, original_filename: item.original_filename || item.title || null, file_ref_id: item.file_ref_id || null, relative_path: item.relative_path || null, url: item.url || null, content_type: item.detected_mime_type || item.content_type || null, client_mime_type: item.client_mime_type || item.content_type || null, detected_mime_type: item.detected_mime_type || item.content_type || null, preview_kind: item.preview_kind || 'metadata', storage_status: item.storage_status || 'metadata_only', content_deleted_at: item.content_deleted_at || null, size_bytes: item.size_bytes || 0, sha256: item.sha256 || null, selection: item.selection || null, model_policy: item.model_policy || 'artifact_only', status: item.status, created_at: item.created_at, updated_at: item.updated_at };
}

export function normalizeAttachmentIds(state, session, values) {
  if (!Array.isArray(values) || values.length > 20) throw new HttpError(400, { error: 'invalid_attachment_ids' });
  const unique = [...new Set(values.map(String))];
  for (const key of unique) if (!state.attachments.some((item) => item.id === key && item.session_id === session.id && item.project_id === session.project_id && !item.deleted_at && !item.content_deleted_at && item.storage_status !== 'deleted')) throw new HttpError(404, { error: 'attachment_not_found', attachment_id: key });
  return unique;
}
export function normalizeAttachmentKind(value) {
  const kind = String(value || 'project_attachment');
  if (!['project_file', 'monaco_file', 'selection', 'image', 'project_attachment', 'artifact', 'text', 'url'].includes(kind)) throw new HttpError(400, { error: 'unsupported_attachment_kind' });
  return kind;
}
export function modelPolicy(kind, type) {
  if (kind === 'artifact') return 'artifact_only';
  if (kind === 'image' || /^image\/(?:png|jpeg|webp|gif)$/i.test(type)) return 'image';
  if (kind === 'selection' || kind === 'text' || kind === 'url' || /^text\//i.test(type) || /(?:json|javascript|typescript|xml|yaml|markdown)$/i.test(type)) return 'injectable';
  return 'artifact_only';
}
export function safeRelativePath(value) {
  const raw = String(value || '').replaceAll('\\', '/').trim();
  if (!raw || raw.length > 2000 || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.split('/').includes('..') || /[\0\r\n]/.test(raw)) throw new HttpError(400, { error: 'invalid_attachment_path' });
  return raw.replace(/^\.\//, '');
}
export function normalizeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const start = boundedInt(value.start_line, 1, 10_000_000, 1);
  return { start_line: start, start_column: boundedInt(value.start_column, 1, 1_000_000, 1), end_line: boundedInt(value.end_line, 1, 10_000_000, start), end_column: boundedInt(value.end_column, 1, 1_000_000, 1) };
}

export function readableProjectCwd(project) {
  const configured = String(project.repo_path || '').trim();
  if (configured && fs.existsSync(configured)) return path.resolve(configured);
  const projectId = String(project.id || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(projectId)) throw new HttpError(409, { error: 'assist_workspace_unavailable' });
  return path.join(ASSIST_DIR, projectId);
}
export function assertAgentProjectReady(project) {
  if (project.status !== 'active') throw new HttpError(409, { error: 'project_not_active' });
  if (project.managed_workspace_state !== 'ready') throw new HttpError(409, { error: 'workspace_migration_required', state: project.managed_workspace_state || 'unknown' });
}
export function projectWriteUnavailableReason(project) {
  if (project?.status !== 'active') return 'project_not_active';
  if (project?.managed_workspace_state !== 'ready') return 'workspace_migration_required';
  return null;
}
export function isWritableTurn(turn, project) { return turn?.collaboration_mode !== 'plan' && turn?.mode !== 'plan' && !projectWriteUnavailableReason(project); }

export function normalizeTurnCollaborationMode(input = {}) {
  const explicit = input.collaboration_mode == null ? null : String(input.collaboration_mode).toLowerCase();
  const legacy = input.mode == null ? null : String(input.mode).toLowerCase();
  if (explicit && !TURN_MODES.has(explicit)) throw removedOrUnsupportedMode(explicit);
  let mapped = null;
  if (legacy === 'ask' || legacy === 'default') mapped = 'default';
  else if (legacy === 'plan') mapped = 'plan';
  else if (legacy) throw removedOrUnsupportedMode(legacy);
  if (explicit && mapped && explicit !== mapped) throw new HttpError(400, { error: 'assist_collaboration_mode_conflict', collaboration_mode: explicit, mode: legacy });
  return explicit || mapped || 'default';
}
export function normalizeClarificationPolicy(value) {
  const policy = String(value || 'ask').toLowerCase();
  if (!['ask', 'auto_recommend'].includes(policy)) throw new HttpError(400, { error: 'assist_clarification_policy_invalid', clarification_policy: policy });
  return policy;
}
export function safeViewContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const text = JSON.stringify(maskSecretsDeep(value));
  if (Buffer.byteLength(text, 'utf8') > 100_000) throw new HttpError(413, { error: 'assist_view_context_too_large' });
  return JSON.parse(text);
}
export function resolveAssistTurnConfiguration(state, input = {}, { allowMissingProfile = false } = {}) {
  const configurationId = cleanText(input.configuration_id, 200);
  let configuration = configurationId ? state.assist_configurations.find((item) => item.id === configurationId) : null;
  if (configurationId && !configuration) throw new HttpError(404, { error: 'assist_configuration_not_found' });
  const requestedId = cleanText(input.profile_id, 200);
  const requestedProfile = requestedId ? state.codex_profiles.find((item) => item.id === requestedId && item.status === 'validated') : null;
  if (requestedId && !requestedProfile) throw new HttpError(404, { error: 'validated_profile_not_found' });
  if (!configuration && requestedProfile?.assist_configuration) configuration = state.assist_configurations.find((item) => item.legacy_profile_id === requestedProfile.id) || { id: null, base_profile_id: requestedProfile.base_profile_id, model: requestedProfile.model, reasoning: requestedProfile.reasoning };
  const baseProfileId = configuration?.base_profile_id || requestedProfile?.base_profile_id || requestedProfile?.id;
  const profile = baseProfileId
    ? state.codex_profiles.find((item) => item.id === baseProfileId && item.status === 'validated' && !item.assist_configuration)
    : state.codex_profiles.find((item) => item.is_active && item.status === 'validated' && !item.assist_configuration) || state.codex_profiles.find((item) => item.status === 'validated' && !item.assist_configuration);
  if (!profile && !allowMissingProfile) throw new HttpError(409, { error: 'active_codex_profile_required' });
  const model = normalizeAssistModel(input.model ?? configuration?.model ?? requestedProfile?.model ?? profile?.model ?? (allowMissingProfile ? 'test' : ''));
  const reasoning = normalizeAssistReasoning(input.reasoning ?? configuration?.reasoning ?? requestedProfile?.reasoning ?? profile?.reasoning ?? 'high');
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
export function publicProfile(profile) { return { id: profile.id, name: profile.name, model: profile.model, reasoning: profile.reasoning, kind: profile.kind }; }
export function persistedWorktreeFields(value) { return Object.fromEntries(['status', 'target_hash', 'applied_target_hash', 'head_commit', 'applied_at', 'rolled_back_at', 'updated_at'].map((key) => [key, value[key]])); }

export function cleanText(value, max = 10_000) { return String(value ?? '').replace(/\0/g, '').slice(0, max).trim(); }
export function cleanHash(value) { const text = String(value || '').toLowerCase(); return /^[a-f0-9]{64}$/.test(text) ? text : null; }
export function boundedInt(value, min, max, fallback) { const number = Number(value); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; }
export function safeNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
export function safeViewPath(value) { try { return safeRelativePath(value); } catch { return null; } }
export function attachmentHash(text, fallback) { return text ? hashString(text) : cleanHash(fallback); }
export function inferContentType(filePath) { return ({ '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.js': 'text/javascript', '.jsx': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' })[path.extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream'; }
export function publicErrorCode(error) {
  if (error instanceof HttpError && typeof error.payload === 'object') return cleanText(error.payload.error, 200) || 'assist_turn_failed';
  const code = String(error?.code || '');
  const message = String(error?.message || '');
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
  const affinityKey = hashString(JSON.stringify({ profile_id: profile.id, provider: profile.provider || null, base_url: profile.base_url || null, credential_ref: profile.credential_ref_id || profile.credential_ref || null, codex_home: profile.codex_home || null }));
  if (session.runtime_profile_id && (session.runtime_profile_id !== profile.id || session.runtime_affinity_key !== affinityKey)) {
    throw new HttpError(409, { error: 'assist_profile_affinity_conflict', current_profile_id: session.runtime_profile_id, requested_profile_id: profile.id, action: 'fork_thread' });
  }
  session.runtime_profile_id = profile.id; session.runtime_affinity_key = affinityKey; session.updated_at = now();
  return session;
}

function sessionDescendantIds(state, sessionId) {
  const result = [], queue = [sessionId], seen = new Set([sessionId]);
  while (queue.length) {
    const parent = queue.shift();
    for (const child of state.assist_sessions.filter((item) => item.version === 3 && item.forked_from_session_id === parent)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id); result.push(child.id); queue.push(child.id);
    }
  }
  return result;
}

function removedOrUnsupportedMode(value) {
  if (value === 'agent' || value === 'cli') return new HttpError(410, { error: 'assist_mode_removed', mode: value, allowed: [...TURN_MODES], action: value === 'cli' ? 'open_terminal' : 'use_default' });
  return new HttpError(400, { error: 'unsupported_assist_mode', mode: value, allowed: [...TURN_MODES] });
}

function publicRuntimeUserInput(item) {
  return { id: item.id, session_id: item.session_id, turn_id: item.turn_id, item_id: item.item_id, questions: item.questions, status: item.status, contains_secret: Boolean(item.contains_secret), auto_resolution_ms: item.auto_resolution_ms ?? null, expires_at: item.expires_at || null, responded_at: item.responded_at || null, cancelled_at: item.cancelled_at || null, created_at: item.created_at, updated_at: item.updated_at };
}

function publicChangeBatch(batch, worktree) {
  return { id: batch.id, session_id: batch.session_id, project_id: batch.project_id, worktree_id: batch.worktree_id, base_commit: batch.base_commit, head_commit: batch.head_commit, target_hash: batch.target_hash, status: batch.status, locked: Boolean(batch.write_lock), created_at: batch.created_at, updated_at: batch.updated_at, worktree: publicWorktree(worktree) };
}
