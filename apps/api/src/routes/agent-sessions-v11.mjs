import { makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { createAgentSession, createSubSubmission } from '../../../../packages/shared/index.mjs';

export const agentSessionV11Routes = [
  makeRoute('GET', '/agent-sessions', listAgentSessions),
  makeRoute('POST', '/agent-sessions', createAgentSessionRoute),
  makeRoute('POST', '/agent-sessions/:id/submissions', createSubmissionRoute)
];

async function listAgentSessions({ res, query }) {
  const state = await readState();
  let sessions = state.agent_sessions;
  if (query.scope_type) sessions = sessions.filter((item) => item.scope_type === query.scope_type);
  if (query.scope_id) sessions = sessions.filter((item) => item.scope_id === query.scope_id);
  return send(res, 200, sessions);
}

async function createAgentSessionRoute({ res, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const project = state.projects.find((item) => item.id === body.project_id) || state.projects.at(-1);
    const workspace = state.workspaces.find((item) => item.id === body.workspace_id) || state.workspaces.find((item) => item.project_id === project?.id && item.type === body.scope_type);
    const parent = body.parent_session_id || findParentSession(state, { project, body });
    const session = createAgentSession({
      projectId: project?.id || body.project_id,
      workspaceId: workspace?.id || body.workspace_id || null,
      scopeType: body.scope_type || 'project',
      scopeId: body.scope_id || project?.id,
      parentSessionId: parent,
      title: body.title,
      actorId: actor.id
    });
    state.agent_sessions.push(session);
    if (workspace) workspace.active_agent_session_id = session.id;
    addTrace(state, 'agent_session.created', { project_id: session.project_id, workspace_id: session.workspace_id, target_type: 'agent_session', target_id: session.id, summary: `创建 Codex 会话：${session.title}` }, actor.id);
    return session;
  });
  return send(res, 201, result);
}

function findParentSession(state, { project, body }) {
  if ((body.scope_type || 'project') === 'project') return null;
  return state.agent_sessions.find((item) => item.project_id === project?.id && item.scope_type === 'project' && item.status === 'active')?.id || null;
}

async function createSubmissionRoute({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const from = state.agent_sessions.find((item) => item.id === params.id);
    if (!from) return { error: 'agent_session_not_found' };
    const to = state.agent_sessions.find((item) => item.id === (body.to_session_id || from.parent_session_id)) || null;
    const submission = createSubSubmission({
      projectId: from.project_id,
      workspaceId: from.workspace_id,
      nodeId: body.node_id || null,
      fromSessionId: from.id,
      toSessionId: to?.id || null,
      title: body.title,
      summary: body.summary,
      changes: body.changes || [],
      evidenceRefs: body.evidence_refs || [],
      risks: body.risks || [],
      actorId: actor.id
    });
    state.submissions.push(submission);
    addTrace(state, 'agent_session.submission.created', { project_id: submission.project_id, workspace_id: submission.workspace_id, node_id: submission.node_id, target_type: 'submission', target_id: submission.id, summary: `SubSubmission：${submission.title}`, data: submission }, actor.id);
    return submission;
  });
  return result?.error ? send(res, 404, result) : send(res, 201, result);
}
