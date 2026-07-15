import { makeRoute, send, HttpError } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { appendEvent, cancelAssistRun, decideAction, recordActionResult, startAssistRun } from '../assist-runtime.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { createAgentSession, id, now } from '../../../../packages/shared/index.mjs';
import { assertProjectLifecycleIdle } from '../project-lifecycle-operations.mjs';

export const assistV12Routes = [
  makeRoute('GET', '/assist/v2/sessions', listSessions),
  makeRoute('POST', '/assist/v2/sessions', createSession),
  makeRoute('GET', '/assist/v2/sessions/:id', getSession),
  makeRoute('POST', '/assist/v2/sessions/:id/messages', sendMessage),
  makeRoute('GET', '/assist/v2/sessions/:id/events', streamEvents),
  makeRoute('POST', '/assist/v2/sessions/:id/cancel', cancelRun),
  makeRoute('POST', '/assist/v2/sessions/:id/retry', retryRun),
  makeRoute('POST', '/assist/v2/sessions/:id/actions/:actionId/confirm', confirmAction),
  makeRoute('POST', '/assist/v2/sessions/:id/actions/:actionId/reject', rejectAction),
  makeRoute('POST', '/assist/v2/sessions/:id/actions/:actionId/result', actionResult)
];

async function createSession({ res, body }) {
  const result = await mutate((state) => {
    const actor = owner(state), project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === body.project_id));
    const scopeType = body.scope_type || 'project';
    if (!['project', 'node'].includes(scopeType)) throw new HttpError(400, { error: 'invalid_assist_session_scope' });
    const node = scopeType === 'node' ? state.workflow_nodes.find((item) => item.id === body.scope_id) : null;
    if (scopeType === 'node' && (!node || !state.workflows.some((item) => item.id === node.workflow_id && item.project_id === project.id))) throw new HttpError(404, { error: 'node_not_found' });
    let parent = body.parent_session_id ? state.assist_sessions.find((item) => item.id === body.parent_session_id && item.version === 2) : null;
    if (body.parent_session_id && !parent) throw new HttpError(404, { error: 'parent_assist_session_not_found' });
    if (parent && parent.project_id !== project.id) throw new HttpError(409, { error: 'assist_parent_project_mismatch' });
    if (node && !parent) parent = state.assist_sessions.filter((item) => item.version === 2 && item.project_id === project.id && item.scope_type === 'project').at(-1);
    if (node && !parent) { parent = makeSession({ actor, project, scopeType: 'project', scopeId: project.id, viewContext: {} }); attachAgentSession(state, { actor, project, session: parent }); state.assist_sessions.push(parent); }
    if (parent && !parent.agent_session_id) attachAgentSession(state, { actor, project, session: parent });
    const session = makeSession({ actor, project, node, scopeType, scopeId: node?.id || project.id, parentId: parent?.id, viewContext: body.view_context || {} });
    attachAgentSession(state, { actor, project, node, session, parentAgentId: parent?.agent_session_id });
    state.assist_sessions.push(session);
    addTrace(state, 'assist.session.created', { project_id: project.id, workspace_id: session.workspace_id, node_id: session.node_id, target_id: session.id, summary: `Assist session: ${session.scope_type}` }, actor.id);
    return session;
  });
  return send(res, 201, result);
}

async function listSessions({ res, query }) {
  const state = await readState();
  let sessions = state.assist_sessions.filter((item) => item.version === 2);
  if (query.project_id) sessions = sessions.filter((item) => item.project_id === query.project_id);
  if (query.scope_type) sessions = sessions.filter((item) => item.scope_type === query.scope_type);
  if (query.scope_id) sessions = sessions.filter((item) => item.scope_id === query.scope_id);
  sessions.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const limit = Math.max(1, Math.min(100, Number(query.limit || 20)));
  return send(res, 200, sessions.slice(0, limit));
}

async function getSession({ res, params }) {
  const state = await readState(), session = state.assist_sessions.find((item) => item.id === params.id && item.version === 2);
  if (!session) throw new HttpError(404, { error: 'assist_session_not_found' });
  const events = state.assist_events.filter((item) => item.session_id === session.id);
  return send(res, 200, { ...session, messages: state.assist_messages.filter((item) => item.session_id === session.id), actions: state.ui_action_intents.filter((item) => item.session_id === session.id), last_event_id: Math.max(0, ...events.map((item) => item.sequence || 0)) });
}

async function sendMessage({ res, params, body, query }) {
  if (!String(body.content || '').trim()) throw new HttpError(400, { error: 'message_content_required' });
  const message = await mutate((state) => {
    const session = state.assist_sessions.find((item) => item.id === params.id && item.version === 2);
    if (!session) throw new HttpError(404, { error: 'assist_session_not_found' });
    requireSessionProject(state, session);
    if (session.status === 'running') throw new HttpError(409, { error: 'assist_session_running' });
    const actor = owner(state), item = { id: id('amsg'), session_id: session.id, role: 'user', content: String(body.content).slice(0, 30000), status: 'completed', created_at: now() };
    if (body.view_context && typeof body.view_context === 'object') session.view_context = body.view_context;
    state.assist_messages.push(item); Object.assign(session, { status: 'running', updated_at: now() });
    addTrace(state, 'assist.message.created', { project_id: session.project_id, workspace_id: session.workspace_id, node_id: session.node_id, target_id: item.id, summary: '用户发送 Assist 消息。' }, actor.id);
    return item;
  });
  const adapter = testAdapter(body, query) ? body.test_response || { message: '测试 Assist 已完成。', actions: [] } : null;
  setImmediate(() => startAssistRun(params.id, adapter));
  return send(res, 202, { message, status: 'running' });
}

async function streamEvents({ req, res, params, query }) {
  let cursor = Number(query.after || req.headers['last-event-id'] || 0);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n');
  await new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const state = await readState(), session = state.assist_sessions.find((item) => item.id === params.id && item.version === 2);
        if (!session) { clearInterval(timer); res.end(); resolve(); return; }
        const events = state.assist_events.filter((item) => item.session_id === session.id && item.sequence > cursor).sort((a, b) => a.sequence - b.sequence);
        for (const event of events) { cursor = event.sequence; res.write(`id: ${event.sequence}\nevent: assist\ndata: ${JSON.stringify(event)}\n\n`); }
        if (['completed', 'failed', 'cancelled'].includes(session.status) && !events.length) { clearInterval(timer); res.end(); resolve(); }
      } catch { clearInterval(timer); res.end(); resolve(); }
    }, 150);
    req.on('close', () => { clearInterval(timer); resolve(); });
  });
}

async function cancelRun({ res, params }) { return send(res, 200, await cancelAssistRun(params.id)); }
async function retryRun({ res, params, body, query }) { const state = await readState(); const last = state.assist_messages.filter((item) => item.session_id === params.id && item.role === 'user').at(-1); if (!last) throw new HttpError(409, { error: 'no_message_to_retry' }); await mutate((data) => { const session = data.assist_sessions.find((item) => item.id === params.id && item.version === 2); if (!session) throw new HttpError(404, { error: 'assist_session_not_found' }); requireSessionProject(data, session); if (session.status === 'running') throw new HttpError(409, { error: 'assist_session_running' }); Object.assign(session, { status: 'running', error: null, updated_at: now() }); }); const adapter = testAdapter(body, query) ? body.test_response || { message: '重试完成。', actions: [] } : null; setImmediate(() => startAssistRun(params.id, adapter)); return send(res, 202, { status: 'running' }); }
async function confirmAction({ res, params }) { return send(res, 200, await decideAction(params.id, params.actionId, 'confirm')); }
async function rejectAction({ res, params }) { return send(res, 200, await decideAction(params.id, params.actionId, 'reject')); }
async function actionResult({ res, params, body }) { return send(res, 200, await recordActionResult(params.id, params.actionId, body)); }
function makeSession({ actor, project, node, scopeType, scopeId, parentId, viewContext }) { return { id: id('asst'), version: 2, project_id: project.id, workspace_id: node?.workspace_id || project.current_workspace_id, node_id: node?.id || null, scope_type: scopeType, scope_id: scopeId, parent_session_id: parentId || null, view_context: viewContext, codex_thread_id: null, status: 'idle', created_by_user_id: actor.id, created_at: now(), updated_at: now() }; }

function attachAgentSession(state, { actor, project, node, session, parentAgentId = null }) {
  const agent = createAgentSession({ projectId: project.id, workspaceId: session.workspace_id, scopeType: session.scope_type, scopeId: session.scope_id, parentSessionId: parentAgentId, title: `${node?.title || project.title} Codex`, actorId: actor.id });
  state.agent_sessions.push(agent);
  session.agent_session_id = agent.id;
  const workspace = state.workspaces.find((item) => item.id === session.workspace_id);
  if (workspace) workspace.active_agent_session_id = agent.id;
  addTrace(state, 'agent_session.created', { project_id: project.id, workspace_id: session.workspace_id, node_id: node?.id, target_type: 'agent_session', target_id: agent.id, summary: `创建层级 Codex 会话：${agent.title}` }, actor.id);
  return agent;
}

function requireSessionProject(state, session) { return assertProjectLifecycleIdle(state.projects.find((item) => item.id === session.project_id)); }
