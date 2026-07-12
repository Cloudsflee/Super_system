import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { ASSIST_DIR } from './config.mjs';
import { hashString, id, maskSecretsDeep, now } from '../../../packages/shared/index.mjs';
import { publicWorktree } from './assist-v3-worktree.mjs';

export const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
export const TURN_MODES = new Set(['ask', 'plan', 'agent']);
export const ASSIST_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CODEX_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/+:@-]{0,199}$/;

export function requireProject(state, projectId) {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  return project;
}
export function requireSession(state, sessionId, includeArchived = false) {
  const session = state.assist_sessions.find((item) => item.id === sessionId && item.version === 3);
  if (!session || (!includeArchived && session.archived_at)) throw new HttpError(404, { error: 'assist_session_not_found' });
  return session;
}
export function requireTurn(state, turnId) {
  const turn = state.assist_turns.find((item) => item.id === turnId);
  if (!turn) throw new HttpError(404, { error: 'assist_turn_not_found' });
  return turn;
}
export function activeTurn(state, sessionId) { return state.assist_turns.find((item) => item.session_id === sessionId && ['preparing', 'running', 'waiting_approval', 'stopping'].includes(item.status)) || null; }
export function hasActiveTurn(state, sessionId, excluded = null) { return state.assist_turns.some((item) => item.session_id === sessionId && item.id !== excluded && ['preparing', 'running', 'waiting_approval', 'stopping'].includes(item.status)); }
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

export function makeSession({ actor, project, scope, title, parentSessionId, viewContext }) {
  const created = now();
  return {
    id: id('asst'), version: 3, project_id: project.id, workspace_id: scope.workspaceId, node_id: scope.nodeId,
    scope_type: scope.type, scope_id: scope.id, parent_session_id: parentSessionId,
    title: cleanText(title, 120) || `${scope.node?.title || project.title} · Assist`, status: 'idle', lifecycle: 'active',
    pinned: false, archived_at: null, codex_thread_id: null, view_context: viewContext || {},
    created_by_user_id: actor.id, created_at: created, updated_at: created
  };
}
export function makeTurn({ actor, session, mode, content, input, attachmentIds, options, configuration }) {
  const created = now();
  return {
    id: id('atrn'), session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, node_id: session.node_id,
    parent_turn_id: options.parentTurnId || null, retry_of_turn_id: options.retryOfTurnId || null, follow_up_kind: options.followUpKind || null,
    mode, prompt: content, output_text: '', status: 'queued', profile_id: configuration.profile?.id || null,
    model: configuration.model, reasoning: configuration.reasoning, view_context: safeViewContext(input.view_context ?? session.view_context),
    context_pack_id: null, worktree_id: null, attachment_ids: attachmentIds, codex_thread_id: null, usage: null,
    review_status: 'pending', review: { status: 'pending', viewed_files: {}, comment_count: 0 },
    created_by_user_id: actor.id, started_at: null, completed_at: null, created_at: created, updated_at: created
  };
}

export function sessionSummary(state, session) {
  const turns = state.assist_turns.filter((item) => item.session_id === session.id);
  const last = turns.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
  return { ...session, turn_count: turns.length, last_turn: last ? { id: last.id, mode: last.mode, status: last.status, updated_at: last.updated_at } : null };
}
export function sessionDetail(state, session) {
  const turns = state.assist_turns.filter((item) => item.session_id === session.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const events = state.assist_events.filter((item) => item.session_id === session.id);
  return { ...session, turns: turns.map((turn) => turnDetail(state, turn, state.worktrees.find((item) => item.id === turn.worktree_id))), attachments: state.attachments.filter((item) => item.session_id === session.id).map(publicAttachment), last_event_id: Math.max(0, ...events.map((item) => Number(item.sequence) || 0)) };
}
export function turnDetail(state, turn, worktree) {
  return { ...turn, worktree: publicWorktree(worktree), attachments: (turn.attachment_ids || []).map((key) => state.attachments.find((item) => item.id === key)).filter(Boolean).map(publicAttachment), actions: state.ui_action_intents.filter((item) => item.turn_id === turn.id), comments: state.human_reviews.filter((item) => item.target_type === 'assist_turn' && item.target_id === turn.id), last_event_id: Math.max(0, ...state.assist_events.filter((item) => item.turn_id === turn.id).map((item) => Number(item.sequence) || 0)) };
}
export function publicAttachment(item) {
  return { id: item.id, project_id: item.project_id, session_id: item.session_id || null, turn_id: item.turn_id || null, kind: item.kind, title: item.title || item.label || item.kind, file_ref_id: item.file_ref_id || null, relative_path: item.relative_path || null, url: item.url || null, content_type: item.content_type || null, size_bytes: item.size_bytes || 0, sha256: item.sha256 || null, selection: item.selection || null, model_policy: item.model_policy || 'artifact_only', status: item.status, created_at: item.created_at, updated_at: item.updated_at };
}

export function normalizeAttachmentIds(state, session, values) {
  if (!Array.isArray(values) || values.length > 20) throw new HttpError(400, { error: 'invalid_attachment_ids' });
  const unique = [...new Set(values.map(String))];
  for (const key of unique) if (!state.attachments.some((item) => item.id === key && item.session_id === session.id && item.project_id === session.project_id)) throw new HttpError(404, { error: 'attachment_not_found', attachment_id: key });
  return unique;
}
export function normalizeAttachmentKind(value) {
  const kind = String(value || 'project_attachment');
  if (!['project_file', 'monaco_file', 'selection', 'image', 'project_attachment', 'artifact', 'text'].includes(kind)) throw new HttpError(400, { error: 'unsupported_attachment_kind' });
  return kind;
}
export function modelPolicy(kind, type) {
  if (kind === 'artifact') return 'artifact_only';
  if (kind === 'image' || /^image\/(?:png|jpeg|webp|gif)$/i.test(type)) return 'image';
  if (kind === 'selection' || kind === 'text' || /^text\//i.test(type) || /(?:json|javascript|typescript|xml|yaml|markdown)$/i.test(type)) return 'injectable';
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
export function safeViewContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const text = JSON.stringify(maskSecretsDeep(value));
  if (Buffer.byteLength(text, 'utf8') > 100_000) throw new HttpError(413, { error: 'assist_view_context_too_large' });
  return JSON.parse(text);
}
export function resolveAssistTurnConfiguration(state, input = {}, { allowMissingProfile = false } = {}) {
  const requestedId = cleanText(input.profile_id, 200);
  const profile = requestedId
    ? state.codex_profiles.find((item) => item.id === requestedId && item.status === 'validated')
    : state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (requestedId && !profile) throw new HttpError(404, { error: 'validated_profile_not_found' });
  if (!profile && !allowMissingProfile) throw new HttpError(409, { error: 'active_codex_profile_required' });
  const model = normalizeAssistModel(input.model ?? profile?.model ?? (allowMissingProfile ? 'test' : ''));
  const reasoning = normalizeAssistReasoning(input.reasoning ?? profile?.reasoning ?? 'high');
  return { profile, model, reasoning };
}
export function normalizeAssistModel(value) {
  const model = cleanText(value, 200);
  if (!CODEX_MODEL_PATTERN.test(model)) throw new HttpError(400, { error: 'invalid_assist_model' });
  return model;
}
export function normalizeAssistReasoning(value) {
  const reasoning = cleanText(value, 20).toLowerCase();
  if (!ASSIST_REASONING_EFFORTS.has(reasoning)) throw new HttpError(400, { error: 'invalid_assist_reasoning', allowed: [...ASSIST_REASONING_EFFORTS] });
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
  if (code === 'app_server_start_failed') return 'codex_runtime_start_failed';
  if (code === 'app_server_turn_failed') return 'codex_turn_failed';
  if (/runner_mount|workspace.*(?:missing|unavailable|outside)/i.test(message)) return 'assist_workspace_unavailable';
  if (message === 'active_codex_profile_required') return message;
  if (/auth/i.test(message)) return 'codex_auth_failed';
  if (/codex_(?:app_server_)?(?:exit|turn)|responses api/i.test(message)) return 'codex_turn_failed';
  return 'assist_turn_failed';
}
