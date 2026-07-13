import { HttpError } from './http.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { readProjectFile } from './file-service.mjs';
import {
  attachmentHash, boundedInt, cleanText, inferContentType, makeSession, modelPolicy,
  normalizeAttachmentKind, normalizeSelection, publicAttachment, requireProject, requireSession,
  requireTurn, resolveScope, safeRelativePath, safeViewContext, sessionDetail, sessionSummary
} from './assist-v3-domain.mjs';

export async function listV3Sessions(query = {}) {
  const state = await readState();
  let sessions = state.assist_sessions.filter((item) => item.version === 3);
  if (query.project_id) sessions = sessions.filter((item) => item.project_id === query.project_id);
  if (query.scope_type) sessions = sessions.filter((item) => item.scope_type === query.scope_type);
  if (query.scope_id) sessions = sessions.filter((item) => item.scope_id === query.scope_id);
  if (query.pinned === 'true' || query.pinned === true) sessions = sessions.filter((item) => item.pinned === true);
  if (query.archived === 'only') sessions = sessions.filter((item) => Boolean(item.archived_at));
  else if (query.archived !== 'include') sessions = sessions.filter((item) => !item.archived_at);
  const search = cleanText(query.search || query.q, 200).toLowerCase();
  if (search) {
    const matching = new Set(state.assist_messages.filter((item) => String(item.content || '').toLowerCase().includes(search)).map((item) => item.session_id));
    sessions = sessions.filter((item) => String(item.title || '').toLowerCase().includes(search) || matching.has(item.id));
  }
  sessions.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.updated_at).localeCompare(String(a.updated_at)));
  return sessions.slice(0, boundedInt(query.limit, 1, 100, 30)).map((session) => sessionSummary(state, session));
}

export async function createV3Session(input = {}) {
  return mutate((state) => {
    const actor = owner(state), project = requireProject(state, input.project_id);
    const scope = resolveScope(state, project, input.scope_type || 'project', input.scope_id || project.id);
    const parent = input.parent_session_id ? requireSession(state, input.parent_session_id) : null;
    if (parent && parent.project_id !== project.id) throw new HttpError(409, { error: 'assist_parent_scope_mismatch' });
    const session = makeSession({ actor, project, scope, title: input.title, parentSessionId: parent?.id || null, viewContext: safeViewContext(input.view_context) });
    state.assist_sessions.push(session);
    addTrace(state, 'assist.session.created', { project_id: project.id, workspace_id: session.workspace_id, node_id: session.node_id, target_id: session.id, summary: `Assist V3 session: ${session.title}` }, actor.id);
    return session;
  });
}
export async function getV3Session(sessionId) { const state = await readState(), session = requireSession(state, sessionId); return sessionDetail(state, session); }
export async function updateV3Session(sessionId, input = {}) {
  return mutate((state) => {
    const session = requireSession(state, sessionId);
    if (input.title !== undefined) { const title = cleanText(input.title, 120); if (!title) throw new HttpError(400, { error: 'assist_session_title_required' }); session.title = title; }
    if (input.pinned !== undefined) session.pinned = input.pinned === true;
    if (input.view_context !== undefined) session.view_context = safeViewContext(input.view_context);
    session.updated_at = now(); return session;
  });
}
export async function archiveV3Session(sessionId) {
  return mutate((state) => {
    const session = requireSession(state, sessionId);
    if (state.assist_turns.some((item) => item.session_id === session.id && ['queued', 'preparing', 'running', 'waiting_approval', 'stopping'].includes(item.status))) throw new HttpError(409, { error: 'assist_session_running' });
    if (!session.archived_at) Object.assign(session, { archived_at: now(), lifecycle: 'archived', pinned: false, updated_at: now() });
    return session;
  });
}
export async function restoreV3Session(sessionId) { return mutate((state) => { const session = requireSession(state, sessionId, true); Object.assign(session, { archived_at: null, lifecycle: 'active', updated_at: now() }); return session; }); }
export async function forkV3Session(sessionId, input = {}) {
  return mutate((state) => {
    const actor = owner(state), source = requireSession(state, sessionId, true), project = requireProject(state, source.project_id);
    const fromTurn = input.from_turn_id ? requireTurn(state, input.from_turn_id) : state.assist_turns.filter((item) => item.session_id === source.id && ['completed', 'failed', 'stopped', 'interrupted'].includes(item.status)).at(-1);
    if (fromTurn && fromTurn.session_id !== source.id) throw new HttpError(409, { error: 'assist_fork_turn_scope_mismatch' });
    const scope = resolveScope(state, project, source.scope_type, source.scope_id);
    const forked = makeSession({ actor, project, scope, title: input.title || `${source.title} · Fork`, parentSessionId: source.parent_session_id, viewContext: source.view_context || {} });
    const resume = input.resume_context !== false;
    Object.assign(forked, {
      forked_from_session_id: source.id, forked_from_turn_id: fromTurn?.id || null,
      codex_thread_id: resume ? source.codex_thread_id || null : null,
      legacy_codex_thread_id: resume ? source.legacy_codex_thread_id || null : null,
      native_thread_generation: resume ? source.native_thread_generation || 2 : 2,
      runtime_profile_id: resume ? source.runtime_profile_id || null : null,
      runtime_affinity_key: resume ? source.runtime_affinity_key || null : null,
      active_change_batch_id: null
    });
    state.assist_sessions.push(forked);
    addTrace(state, 'assist.session.created', { project_id: project.id, workspace_id: forked.workspace_id, node_id: forked.node_id, target_id: forked.id, summary: `Fork Assist V3 session: ${forked.title}` }, actor.id);
    return forked;
  });
}

export async function listV3Attachments(sessionId, query = {}) {
  const state = await readState(); requireSession(state, sessionId, true);
  let items = state.attachments.filter((item) => item.session_id === sessionId);
  if (query.turn_id) items = items.filter((item) => item.turn_id === query.turn_id);
  return items.map(publicAttachment);
}
export async function createV3Attachment(sessionId, input = {}) {
  const snapshot = await readState(), sourceSession = requireSession(snapshot, sessionId), sourceProject = requireProject(snapshot, sourceSession.project_id);
  const sourceKind = normalizeAttachmentKind(input.kind), sourcePath = input.path === undefined ? null : safeRelativePath(input.path);
  const projectFile = ['project_file', 'monaco_file'].includes(sourceKind) && sourcePath ? await readProjectFile(sourceProject.id, sourcePath) : null;
  return mutate((state) => {
    const actor = owner(state), session = requireSession(state, sessionId), project = requireProject(state, session.project_id);
    const kind = sourceKind, turn = input.turn_id ? requireTurn(state, input.turn_id) : null;
    if (turn && turn.session_id !== session.id) throw new HttpError(409, { error: 'attachment_turn_scope_mismatch' });
    const fileRef = input.file_ref_id ? state.file_refs.find((item) => item.id === input.file_ref_id) : null;
    if (input.file_ref_id && !fileRef) throw new HttpError(404, { error: 'attachment_file_ref_not_found' });
    if (fileRef && !fileRefBelongsToProject(state, fileRef, project.id)) throw new HttpError(404, { error: 'attachment_file_ref_not_found' });
    const relativePath = sourcePath;
    const selectionText = kind === 'selection' || kind === 'text' ? cleanText(input.text || input.content, 100_000) : projectFile ? cleanText(projectFile.content, 100_000) : '';
    const contentType = cleanText(input.content_type || input.mime_type || fileRef?.content_type || inferContentType(relativePath), 200) || 'application/octet-stream';
    const size = Number(fileRef?.size_bytes ?? input.size_bytes ?? Buffer.byteLength(selectionText, 'utf8'));
    if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024) throw new HttpError(413, { error: 'attachment_too_large', max_bytes: 25 * 1024 * 1024 });
    const attachment = {
      id: id('att'), project_id: project.id, session_id: session.id, turn_id: turn?.id || null, kind,
      title: cleanText(input.title || relativePath || kind, 200), file_ref_id: fileRef?.id || null,
      relative_path: relativePath, content_type: contentType, size_bytes: size,
      sha256: fileRef?.sha256 || attachmentHash(selectionText, input.sha256), selection: normalizeSelection(input.selection),
      text: selectionText || null, model_policy: modelPolicy(kind, contentType), status: 'ready', created_by_user_id: actor.id,
      created_at: now(), updated_at: now()
    };
    state.attachments.push(attachment); return publicAttachment(attachment);
  });
}

function fileRefBelongsToProject(state, fileRef, projectId) {
  if (fileRef.project_id === projectId || fileRef.meta?.project_id === projectId) return true;
  if (fileRef.workspace_id && state.workspaces.some((item) => item.id === fileRef.workspace_id && item.project_id === projectId)) return true;
  if (fileRef.meta?.run_id && state.node_runs.some((item) => item.id === fileRef.meta.run_id && item.project_id === projectId)) return true;
  if (fileRef.meta?.terminal_session_id && state.terminal_sessions.some((item) => item.id === fileRef.meta.terminal_session_id && item.project_id === projectId)) return true;
  if (fileRef.meta?.context_pack_id) { const pack = state.context_packs.find((item) => item.id === fileRef.meta.context_pack_id), workspace = state.workspaces.find((item) => item.id === pack?.source_workspace_id); if (workspace?.project_id === projectId) return true; }
  return false;
}
