import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { id, workflowTemplates, now } from '../../../../packages/shared/index.mjs';
import { assertProjectLifecycleIdle, withProjectLifecycleLock } from '../project-lifecycle-operations.mjs';
import { createWorkflowGraphProposalInState, workflowVisualGraph } from '../workflow-graph-service.mjs';

const allowedTypes = new Set(['goal_definition', 'research', 'analysis', 'execution', 'retrospective']);

export const workflowV12Routes = [
  makeRoute('PUT', '/workflows/:id/layout', saveLayout),
  makeRoute('POST', '/workflows/:id/proposals', createWorkflowProposal)
];

async function saveLayout({ res, params, body }) {
  const positions = new Map((body.nodes || []).map((item) => [item.id, item.position]));
  const result = await mutate((state) => {
    const actor = owner(state),
      workflow = state.workflows.find((item) => item.id === params.id);
    if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
    assertProjectLifecycleIdle(state.projects.find((item) => item.id === workflow.project_id));
    const nodes = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
    for (const node of nodes) if (positions.has(node.id)) node.position = validPosition(positions.get(node.id));
    workflow.graph_json = workflowVisualGraph(nodes);
    workflow.updated_at = now();
    addTrace(
      state,
      'workflow.layout.saved',
      {
        project_id: workflow.project_id,
        workspace_id: workflow.workspace_id,
        target_id: workflow.id,
        summary: `保存 ${positions.size} 个节点位置。`
      },
      actor.id
    );
    return { workflow_id: workflow.id, nodes: nodes.map((node) => ({ id: node.id, position: node.position })) };
  });
  return send(res, 200, result);
}

async function createWorkflowProposal({ res, params, body, query }) {
  const snapshot = await readState(),
    source = snapshot.workflows.find((item) => item.id === params.id);
  if (!source) throw new HttpError(404, { error: 'workflow_not_found' });
  return withProjectLifecycleLock(source.project_id, () => createWorkflowProposalLocked({ res, params, body, query }));
}
async function createWorkflowProposalLocked({ res, params, body, query }) {
  const state = await readState(),
    workflow = state.workflows.find((item) => item.id === params.id);
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  const project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === workflow.project_id));
  let operations,
    title,
    summary,
    targetId = null;
  if (body.action === 'add_node') {
    const node = normalizeNode(body.node, 0);
    operations = nodesToAddOperations([node]);
    targetId = operations[0].node.id;
    title = `添加${node.title}`;
    summary = '向当前工作流添加一个节点';
  } else if (body.action === 'apply_template') {
    throw new HttpError(409, { error: 'legacy_workflow_template_removed', action: 'create_outcome_workstreams' });
  } else if (body.action === 'ai_generate') {
    throw new HttpError(409, {
      error: 'workflow_generation_async_required',
      endpoint: `/projects/${project.id}/workflow-draft/generations`
    });
  } else if (body.action === 'remove_node') {
    const node = state.workflow_nodes.find((item) => item.id === body.node_id && item.workflow_id === workflow.id);
    if (!node) throw new HttpError(404, { error: 'node_not_found' });
    operations = [{ type: 'delete_node', node_id: node.id }];
    targetId = node.id;
    title = `移除节点：${node.title}`;
    summary = '归档节点工作区并移除相关依赖';
  } else if (body.action === 'update_node') {
    const node = state.workflow_nodes.find((item) => item.id === body.node_id && item.workflow_id === workflow.id);
    if (!node) throw new HttpError(404, { error: 'node_not_found' });
    const nextTitle = String(body.patch?.title || node.title)
      .trim()
      .slice(0, 100);
    const patch = {
      title: nextTitle,
      goal:
        String(body.patch?.goal ?? node.goal)
          .trim()
          .slice(0, 2000) || nextTitle,
      type: allowedTypes.has(body.patch?.type) ? body.patch.type : node.type
    };
    operations = [{ type: 'update_node', node_id: node.id, patch }];
    targetId = node.id;
    title = `更新节点：${node.title}`;
    summary = '调整节点类型、标题或目标';
  } else if (body.action === 'connect_nodes') {
    const source = state.workflow_nodes.find((item) => item.id === body.source_id && item.workflow_id === workflow.id),
      target = state.workflow_nodes.find((item) => item.id === body.target_id && item.workflow_id === workflow.id);
    if (!source || !target || source.id === target.id) throw new HttpError(400, { error: 'invalid_node_dependency' });
    operations = [{ type: 'connect', node_id: target.id, dependency_id: source.id }];
    targetId = target.id;
    title = `连接 ${source.title} → ${target.title}`;
    summary = '添加 finish-to-start 依赖';
  } else if (body.action === 'patch_graph') {
    operations = body.operations;
    title = String(body.title || `优化工作流：${workflow.title}`).slice(0, 200);
    summary = String(body.summary || '一次性提交工作流结构调整').slice(0, 1000);
  } else throw new HttpError(400, { error: 'unsupported_workflow_action' });
  const result = await mutate((data) => {
    const actor = owner(data),
      currentWorkflow = data.workflows.find((item) => item.id === workflow.id);
    if (!currentWorkflow) throw new HttpError(404, { error: 'workflow_not_found' });
    assertProjectLifecycleIdle(data.projects.find((item) => item.id === currentWorkflow.project_id));
    const created = createWorkflowGraphProposalInState(
      data,
      currentWorkflow.id,
      {
        expected_revision:
          body.action === 'patch_graph'
            ? body.expected_revision
            : Number.isInteger(body.expected_revision)
              ? body.expected_revision
              : Number(currentWorkflow.version || 1),
        operations
      },
      actor.id,
      { project_id: currentWorkflow.project_id, target_id: targetId, title, summary }
    );
    const proposal = created.proposal;
    addTrace(
      data,
      'change_proposal.created',
      {
        project_id: workflow.project_id,
        workspace_id: workflow.workspace_id,
        target_id: proposal.id,
        summary: proposal.title
      },
      actor.id
    );
    return proposal;
  });
  return send(res, 201, result);
}

function normalizeNode(value = {}, index = 0) {
  const type = allowedTypes.has(value.type) ? value.type : 'execution';
  return {
    type,
    title: String(value.title || workflowTemplates.find((item) => item.type === type)?.title || '新节点').slice(0, 100),
    goal: String(value.goal || '').slice(0, 2000),
    dependency_indexes: Array.isArray(value.dependency_indexes)
      ? value.dependency_indexes.filter((item) => Number.isInteger(item) && item >= 0 && item < index)
      : [],
    position: validPosition(value.position || { x: 100 + (index % 3) * 280, y: 110 + Math.floor(index / 3) * 220 })
  };
}
function validPosition(value) {
  return {
    x: Math.max(-10000, Math.min(10000, Number(value?.x) || 0)),
    y: Math.max(-10000, Math.min(10000, Number(value?.y) || 0))
  };
}
function nodesToAddOperations(nodes) {
  const ids = nodes.map((node) => node.id || id('wfn'));
  return nodes.map((node, index) => ({
    type: 'add_node',
    node: {
      id: ids[index],
      type: node.type,
      title: node.title,
      goal: node.goal,
      dependency_ids: (node.dependency_indexes || []).map((dependencyIndex) => ids[dependencyIndex]).filter(Boolean),
      position: node.position
    }
  }));
}
