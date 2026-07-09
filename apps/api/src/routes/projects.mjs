import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { nodeBundle, projectBundle } from '../helpers.mjs';
import { applyContractPatch, createNodeWorkspace, createProject, defaultContractForNode, recommendWorkflow, validateNodeContract, now } from '../../../../packages/shared/index.mjs';

export const projectRoutes = [
  makeRoute('GET', '/projects', async ({ res }) => {
    const state = await readState();
    return send(res, 200, state.projects.map((project) => ({ ...project, workflow_count: state.workflows.filter((w) => w.project_id === project.id).length, asset_count: state.assets.filter((a) => a.project_id === project.id).length, run_count: state.node_runs.filter((r) => r.project_id === project.id).length })));
  }),
  makeRoute('POST', '/projects', async ({ res, body }) => {
    const result = await mutate((state) => { const actor = owner(state); const created = createProject({ ...body, created_by_user_id: actor.id }); state.projects.push(created.project); state.workspaces.push(created.workspace); addTrace(state, 'project.created', { project_id: created.project.id, workspace_id: created.workspace.id, summary: `创建 Project：${created.project.title}`, data: created.project }, actor.id); return created; });
    return send(res, 201, result);
  }),
  makeRoute('GET', '/projects/:id', async ({ res, params }) => { const bundle = projectBundle(await readState(), params.id); return bundle ? send(res, 200, bundle) : send(res, 404, { error: 'project_not_found' }); }),
  makeRoute('POST', '/workflows/recommend', async ({ res, body }) => {
    const result = await mutate((state) => { const actor = owner(state); const project = state.projects.find((p) => p.id === body.project_id); if (!project) throw new HttpError(404, 'project_not_found'); const wf = recommendWorkflow(project, actor.id); state.workflows.push(wf.workflow); state.workflow_nodes.push(...wf.nodes); addTrace(state, 'workflow.recommended', { project_id: project.id, workspace_id: project.current_workspace_id, target_type: 'workflow', target_id: wf.workflow.id, summary: `推荐工作流：${wf.workflow.title}` }, actor.id); return wf; });
    return send(res, 201, result);
  }),
  makeRoute('POST', '/workflows/:id/confirm', async ({ res, params }) => {
    const result = await mutate((state) => {
      const actor = owner(state); const workflow = state.workflows.find((w) => w.id === params.id); if (!workflow) throw new HttpError(404, 'workflow_not_found'); const project = state.projects.find((p) => p.id === workflow.project_id);
      Object.assign(workflow, { status: 'confirmed', confirmed_by: 'human', confirmed_by_user_id: actor.id, updated_at: now() });
      const nodes = state.workflow_nodes.filter((n) => n.workflow_id === workflow.id).sort((a, b) => a.order_index - b.order_index); const workspaces = [], contracts = [];
      for (const node of nodes) { node.status = 'ready'; const ws = createNodeWorkspace(project, node, actor.id); node.workspace_id = ws.id; state.workspaces.push(ws); workspaces.push(ws); const contract = defaultContractForNode(node, project, actor.id, 'confirmed'); node.current_contract_id = contract.id; state.node_contracts.push(contract); contracts.push(contract); addTrace(state, 'node_contract.created', { project_id: project.id, workspace_id: ws.id, node_id: node.id, target_id: contract.id, summary: `创建节点契约：${node.title}` }, actor.id); addTrace(state, 'node_contract.confirmed', { project_id: project.id, workspace_id: ws.id, node_id: node.id, target_id: contract.id, summary: `确认节点契约：${node.title}` }, actor.id); }
      addTrace(state, 'workflow.confirmed', { project_id: project.id, workspace_id: project.current_workspace_id, target_id: workflow.id, summary: `确认工作流：${workflow.title}` }, actor.id);
      return { workflow, nodes, workspaces, contracts };
    });
    return send(res, 200, result);
  }),
  makeRoute('GET', '/workflows/:id', async ({ res, params }) => { const state = await readState(); const workflow = state.workflows.find((w) => w.id === params.id); if (!workflow) return send(res, 404, { error: 'workflow_not_found' }); const nodes = state.workflow_nodes.filter((n) => n.workflow_id === workflow.id).sort((a, b) => a.order_index - b.order_index); return send(res, 200, { workflow, nodes, contracts: state.node_contracts.filter((c) => nodes.some((n) => n.id === c.node_id)) }); }),
  makeRoute('GET', '/workspaces/:id', async ({ res, params }) => {
    const state = await readState(); const workspace = state.workspaces.find((w) => w.id === params.id); if (!workspace) return send(res, 404, { error: 'workspace_not_found' }); const node = workspace.workflow_node_id ? state.workflow_nodes.find((n) => n.id === workspace.workflow_node_id) : null; const project = state.projects.find((p) => p.id === workspace.project_id); const contract = node ? state.node_contracts.find((c) => c.id === node.current_contract_id) : null;
    return send(res, 200, { workspace, project, node, contract, runs: state.node_runs.filter((r) => r.workspace_id === workspace.id), context_packs: state.context_packs.filter((c) => c.source_workspace_id === workspace.id), assets: state.assets.filter((a) => a.workspace_id === workspace.id || a.project_id === project?.id), digests: state.digests.filter((d) => d.workspace_id === workspace.id), traces: state.traces.filter((t) => t.workspace_id === workspace.id || t.project_id === project?.id).slice(-200) });
  }),
  makeRoute('POST', '/nodes/:id/contract', upsertContract),
  makeRoute('PUT', '/nodes/:id/contract', upsertContract)
];

async function upsertContract({ res, params, body }) {
  const result = await mutate((state) => { const actor = owner(state); const { node, project, workspace, contract: current } = nodeBundle(state, params.id); if (!node) throw new HttpError(404, 'node_not_found'); const patch = body.contract || body.patch || body; const next = current ? applyContractPatch(current, patch, actor.id) : { ...defaultContractForNode(node, project, actor.id), ...patch }; if (body.confirm === true || patch.status === 'confirmed') Object.assign(next, { status: 'confirmed', confirmed_by: 'human', confirmed_by_user_id: actor.id }); const validation = validateNodeContract(next); if (!validation.ok) throw new HttpError(400, { error: 'invalid_contract', details: validation.errors }); if (current) current.status = 'superseded'; state.node_contracts.push(next); node.current_contract_id = next.id; addTrace(state, 'node_contract.created', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_id: next.id, summary: `更新 Node Contract v${next.version}` }, actor.id); if (next.status === 'confirmed') addTrace(state, 'node_contract.confirmed', { project_id: project.id, workspace_id: workspace?.id, node_id: node.id, target_id: next.id, summary: `确认 Node Contract v${next.version}` }, actor.id); return { contract: next, validation }; });
  return send(res, 200, result);
}
