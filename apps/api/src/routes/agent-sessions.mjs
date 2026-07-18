import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { createAgentSession, createSubSubmission } from '../../../../packages/shared/index.mjs';
import { assertProjectLifecycleIdle } from '../project-lifecycle-operations.mjs';

export const agentSessionRoutes = [
  makeRoute('GET', '/agent-sessions', listAgentSessions),
  makeRoute('POST', '/agent-sessions', createAgentSessionRoute),
  makeRoute('POST', '/agent-sessions/:id/submissions', createSubmissionRoute),
  makeRoute('POST', '/nodes/:id/submissions', createNodeSubmissionRoute)
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
    const project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === body.project_id));
    const scopeType = body.scope_type || 'project';
    if (!['project', 'node'].includes(scopeType)) throw new HttpError(400, { error: 'invalid_agent_session_scope' });
    const node = scopeType === 'node' ? state.workflow_nodes.find((item) => item.id === body.scope_id && state.workflows.some((workflow) => workflow.id === item.workflow_id && workflow.project_id === project.id)) : null;
    if (scopeType === 'node' && !node) throw new HttpError(404, { error: 'node_not_found' });
    const workspace = body.workspace_id
      ? state.workspaces.find((item) => item.id === body.workspace_id && item.project_id === project.id && (!node || item.workflow_node_id === node.id || item.id === node.workspace_id))
      : node ? state.workspaces.find((item) => item.project_id === project.id && (item.workflow_node_id === node.id || item.id === node.workspace_id)) : state.workspaces.find((item) => item.id === project.current_workspace_id && item.project_id === project.id);
    if (body.workspace_id && !workspace) throw new HttpError(404, { error: 'workspace_not_found' });
    const parentId = body.parent_session_id || findParentSession(state, { project, body });
    const parent = parentId ? state.agent_sessions.find((item) => item.id === parentId && item.project_id === project.id) : null;
    if (parentId && !parent) throw new HttpError(409, { error: 'parent_agent_session_required' });
    const session = createAgentSession({
      projectId: project.id,
      workspaceId: workspace?.id || null,
      scopeType,
      scopeId: node?.id || project.id,
      parentSessionId: parent?.id || null,
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
  return state.agent_sessions.filter((item) => item.project_id === project?.id && item.scope_type === 'project' && item.status === 'active').at(-1)?.id || null;
}

async function createSubmissionRoute({ res, params, body }) {
  if (!String(body.summary || '').trim()) throw new HttpError(400, { error: 'submission_summary_required' });
  const result = await mutate((state) => {
    const actor = owner(state);
    const from = state.agent_sessions.find((item) => item.id === params.id);
    if (!from) return { error: 'agent_session_not_found' };
    assertProjectLifecycleIdle(state.projects.find((item) => item.id === from.project_id));
    const to = state.agent_sessions.find((item) => item.id === (body.to_session_id || from.parent_session_id)) || null;
    if (!to || to.project_id !== from.project_id) throw new HttpError(409, { error: 'parent_agent_session_required' });
    if (from.scope_type === 'node' && body.node_id && body.node_id !== from.scope_id) throw new HttpError(409, { error: 'agent_submission_scope_mismatch' });
    const nodeId = body.node_id || (from.scope_type === 'node' ? from.scope_id : null);
    const node = nodeId ? state.workflow_nodes.find((item) => item.id === nodeId && state.workflows.some((workflow) => workflow.id === item.workflow_id && workflow.project_id === from.project_id)) : null;
    if (nodeId && !node) throw new HttpError(404, { error: 'node_not_found' });
    const workspace = node ? state.workspaces.find((item) => item.project_id === from.project_id && (item.workflow_node_id === node.id || item.id === node.workspace_id)) : null;
    const submission = createSubSubmission({
      projectId: from.project_id,
      workspaceId: workspace?.id || from.workspace_id,
      nodeId: node?.id || null,
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

async function createNodeSubmissionRoute({ res, params, body }) {
  if (!String(body.summary || '').trim()) throw new HttpError(400, { error: 'submission_summary_required' });
  const result = await mutate((state) => {
    const actor = owner(state), node = state.workflow_nodes.find((item) => item.id === params.id);
    const workflow = state.workflows.find((item) => item.id === node?.workflow_id);
    if (!node || !workflow) throw new HttpError(404, { error: 'node_workspace_not_found' });
    const project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === workflow?.project_id));
    const workspace = state.workspaces.find((item) => item.id === node?.workspace_id);
    if (!workspace) throw new HttpError(404, { error: 'node_workspace_not_found' });
    let top = state.agent_sessions.filter((item) => item.project_id === project.id && item.scope_type === 'project' && item.status === 'active').at(-1);
    if (!top) { top = createAgentSession({ projectId: project.id, workspaceId: project.current_workspace_id, scopeType: 'project', scopeId: project.id, title: `${project.title} Codex`, actorId: actor.id }); state.agent_sessions.push(top); addTrace(state, 'agent_session.created', { project_id: project.id, workspace_id: project.current_workspace_id, target_type: 'agent_session', target_id: top.id, summary: `创建 Codex 会话：${top.title}` }, actor.id); }
    let child = state.agent_sessions.filter((item) => item.project_id === project.id && item.scope_type === 'node' && item.scope_id === node.id && item.status === 'active').at(-1);
    if (!child) { child = createAgentSession({ projectId: project.id, workspaceId: workspace.id, scopeType: 'node', scopeId: node.id, parentSessionId: top.id, title: `${node.title} Codex`, actorId: actor.id }); state.agent_sessions.push(child); addTrace(state, 'agent_session.created', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, target_type: 'agent_session', target_id: child.id, summary: `创建 Codex 会话：${child.title}` }, actor.id); }
    const submission = createSubSubmission({ projectId: project.id, workspaceId: workspace.id, nodeId: node.id, fromSessionId: child.id, toSessionId: child.parent_session_id || top.id, title: body.title || `${node.title} 提交`, summary: body.summary, changes: body.changes || [], evidenceRefs: body.evidence_refs || [], risks: body.risks || [], actorId: actor.id });
    state.submissions.push(submission);
    addTrace(state, 'agent_session.submission.created', { project_id: project.id, workspace_id: workspace.id, node_id: node.id, target_type: 'submission', target_id: submission.id, summary: `SubSubmission：${submission.title}`, data: submission }, actor.id);
    return submission;
  });
  return send(res, 201, result);
}
