import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { nodeBundle, projectBundle } from '../helpers.mjs';
import { createDraftProjectRecords } from '../project-lifecycle.mjs';
import { assertProjectLifecycleIdle } from '../project-lifecycle-operations.mjs';

export const projectRoutes = [
  makeRoute('GET', '/projects', async ({ res, query }) => {
    const state = await readState();
    const projects = state.projects.filter((project) => query.deleted === 'only' ? Boolean(project.deleted_at) : query.deleted === 'include' ? true : !project.deleted_at).map((project) => ({ ...project, workflow_count: state.workflows.filter((w) => w.project_id === project.id).length, asset_count: state.assets.filter((a) => a.project_id === project.id).length, run_count: state.node_runs.filter((r) => r.project_id === project.id).length }));
    return send(res, 200, projects.sort((a, b) => String(b.last_opened_at || b.updated_at).localeCompare(String(a.last_opened_at || a.updated_at))));
  }),
  makeRoute('POST', '/projects', async ({ res, body }) => {
    const result = await mutate((state) => {
      const actor = owner(state), operationKey = String(body.operation_key || '').trim().slice(0, 100);
      if (operationKey) {
        const intake = state.project_intakes.find((item) => item.operation_key === operationKey && item.created_by_user_id === actor.id);
        const existing = intake && state.projects.find((item) => item.id === intake.project_id);
        if (existing) return { project: existing, workspace: state.workspaces.find((item) => item.id === existing.current_workspace_id), intake, brief: state.project_briefs.filter((item) => item.project_id === existing.id).at(-1), workflow_draft: state.workflow_drafts.find((item) => item.project_id === existing.id) || null, assist_session: state.assist_sessions.find((item) => item.version === 3 && item.project_id === existing.id), onboarding_route: `/projects/${existing.id}/onboarding`, idempotent: true };
      }
      const created = createDraftProjectRecords(body, actor);
      if (operationKey) created.intake.operation_key = operationKey;
      state.projects.push(created.project); state.workspaces.push(created.workspace); state.project_intakes.push(created.intake); state.project_briefs.push(created.brief); state.workflow_drafts.push(created.workflowDraft); state.assist_sessions.push(created.session);
      addTrace(state, 'project.created', { project_id: created.project.id, workspace_id: created.workspace.id, target_id: created.intake.id, summary: `创建 draft Project：${created.project.title}`, data: { onboarding_route: created.onboarding_route } }, actor.id);
      addTrace(state, 'assist.session.created', { project_id: created.project.id, workspace_id: created.workspace.id, target_id: created.session.id, summary: '创建项目引导 Assist V3 Session。' }, actor.id);
      return { ...created, workflow_draft: created.workflowDraft, assist_session: created.session, idempotent: false };
    });
    return send(res, 201, result);
  }),
  makeRoute('GET', '/projects/:id', async ({ res, params }) => { const state = await readState(); const bundle = projectBundle(state, params.id); if (!bundle) return send(res, 404, { error: 'project_not_found' }); bundle.nodes = bundle.nodes.map((node) => decorateNode(state, node)); return send(res, 200, bundle); }),
  makeRoute('GET', '/workflows/:id', async ({ res, params }) => { const state = await readState(); const workflow = state.workflows.find((w) => w.id === params.id), project = state.projects.find((item) => item.id === workflow?.project_id && !item.deleted_at); if (!workflow || !project) return send(res, 404, { error: 'workflow_not_found' }); const nodes = state.workflow_nodes.filter((n) => n.workflow_id === workflow.id).sort((a, b) => a.order_index - b.order_index); return send(res, 200, { workflow, nodes, contracts: state.node_contracts.filter((c) => nodes.some((n) => n.id === c.node_id)) }); }),
  makeRoute('GET', '/workspaces/:id', async ({ res, params }) => {
    const state = await readState(); const workspace = state.workspaces.find((w) => w.id === params.id); if (!workspace) return send(res, 404, { error: 'workspace_not_found' }); const node = workspace.workflow_node_id ? state.workflow_nodes.find((n) => n.id === workspace.workflow_node_id) : null; const project = state.projects.find((p) => p.id === workspace.project_id && !p.deleted_at); if (!project) return send(res, 404, { error: 'workspace_not_found' }); const contract = node ? state.node_contracts.find((c) => c.id === node.current_contract_id) : null;
    return send(res, 200, { workspace, project, node, contract, runs: state.node_runs.filter((r) => r.workspace_id === workspace.id), context_packs: state.context_packs.filter((c) => c.source_workspace_id === workspace.id), assets: state.assets.filter((a) => a.workspace_id === workspace.id || a.project_id === project?.id), digests: state.digests.filter((d) => d.workspace_id === workspace.id), traces: state.traces.filter((t) => t.workspace_id === workspace.id || t.project_id === project?.id).slice(-200) });
  }),
  makeRoute('GET', '/nodes/:id/workspace', nodeWorkspace),
  makeRoute('PUT', '/nodes/:id/workspace-data', saveWorkspaceData)
];

async function nodeWorkspace({ res, params }) {
  const state = await readState(), bundle = nodeBundle(state, params.id);
  if (!bundle.node || !bundle.workflow || !bundle.project || !bundle.workspace) throw new HttpError(404, { error: 'node_workspace_not_found' });
  const data = state.node_workspace_data.find((item) => item.node_id === bundle.node.id)?.data || {};
  return send(res, 200, { ...bundle, node: decorateNode(state, bundle.node), data, runs: state.node_runs.filter((item) => item.node_id === bundle.node.id), code_changes: state.code_changes.filter((item) => item.node_id === bundle.node.id), assets: state.assets.filter((item) => item.node_id === bundle.node.id || item.project_id === bundle.project.id), traces: state.traces.filter((item) => item.node_id === bundle.node.id || item.project_id === bundle.project.id).slice(-300) });
}

async function saveWorkspaceData({ res, params, body }) {
  const result = await mutate((state) => { const actor = owner(state), bundle = nodeBundle(state, params.id); if (!bundle.node || !bundle.workflow || !bundle.project || !bundle.workspace) throw new HttpError(404, { error: 'node_workspace_not_found' }); assertProjectLifecycleIdle(bundle.project); let record = state.node_workspace_data.find((item) => item.node_id === bundle.node.id); if (!record) { record = { id: `nwd_${Date.now().toString(16)}`, node_id: bundle.node.id, project_id: bundle.project.id, workspace_id: bundle.workspace.id, data: {}, created_at: new Date().toISOString() }; state.node_workspace_data.push(record); } Object.assign(record, { data: body.data || {}, updated_at: new Date().toISOString(), updated_by_user_id: actor.id }); bundle.workspace.open_questions = Array.isArray(record.data.questions) ? record.data.questions : bundle.workspace.open_questions; addTrace(state, 'node.workspace.updated', { project_id: bundle.project.id, workspace_id: bundle.workspace.id, node_id: bundle.node.id, summary: `保存节点工作区：${bundle.node.title}` }, actor.id); return record; });
  return send(res, 200, result);
}

function decorateNode(state, node) { const runs = state.node_runs.filter((item) => item.node_id === node.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); return { ...node, latest_run: runs[0] || null, output_count: state.assets.filter((item) => item.node_id === node.id).length, pending_approval_count: state.change_proposals.filter((item) => item.node_id === node.id && item.status === 'pending').length }; }
