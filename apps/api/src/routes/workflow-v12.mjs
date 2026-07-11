import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { runCodexJson, extractMessage } from '../codex-service.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { createChangeProposal, workflowTemplates, now } from '../../../../packages/shared/index.mjs';
import { AIWS_HOME } from '../config.mjs';

const allowedTypes = new Set(['goal_definition', 'research', 'analysis', 'execution', 'retrospective']);

export const workflowV12Routes = [
  makeRoute('PUT', '/workflows/:id/layout', saveLayout),
  makeRoute('POST', '/workflows/:id/proposals', createWorkflowProposal)
];

async function saveLayout({ res, params, body }) {
  const positions = new Map((body.nodes || []).map((item) => [item.id, item.position]));
  const result = await mutate((state) => {
    const actor = owner(state), workflow = state.workflows.find((item) => item.id === params.id);
    if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
    const nodes = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
    for (const node of nodes) if (positions.has(node.id)) node.position = validPosition(positions.get(node.id));
    workflow.graph_json = graphFor(nodes);
    workflow.updated_at = now();
    addTrace(state, 'workflow.layout.saved', { project_id: workflow.project_id, workspace_id: workflow.workspace_id, target_id: workflow.id, summary: `保存 ${positions.size} 个节点位置。` }, actor.id);
    return { workflow_id: workflow.id, nodes: nodes.map((node) => ({ id: node.id, position: node.position })) };
  });
  return send(res, 200, result);
}

async function createWorkflowProposal({ res, params, body, query }) {
  const state = await readState(), workflow = state.workflows.find((item) => item.id === params.id);
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  const project = state.projects.find((item) => item.id === workflow.project_id);
  let nodes = [], title, summary, after, applyAction;
  if (body.action === 'add_node') {
    nodes = [normalizeNode(body.node, 0)]; title = `添加${nodes[0].title}`; summary = '向当前工作流添加一个节点'; after = { nodes }; applyAction = { type: 'workflow_nodes_create', workflow_id: workflow.id };
  } else if (body.action === 'apply_template') {
    nodes = workflowTemplates.map((item, index) => normalizeNode({ ...item, dependency_indexes: index ? [index - 1] : [], position: { x: 90 + (index % 3) * 280, y: 100 + Math.floor(index / 3) * 220 } }, index)); title = '应用五阶段工作流模板'; summary = '添加目标、调研、分析、执行和复盘节点'; after = { nodes }; applyAction = { type: 'workflow_nodes_create', workflow_id: workflow.id };
  } else if (body.action === 'ai_generate') {
    nodes = await generateNodes(state, project, body, query); title = 'Codex 生成工作流'; summary = `根据项目目标生成 ${nodes.length} 个节点`; after = { nodes }; applyAction = { type: 'workflow_nodes_create', workflow_id: workflow.id };
  } else if (body.action === 'remove_node') {
    const node = state.workflow_nodes.find((item) => item.id === body.node_id && item.workflow_id === workflow.id);
    if (!node) throw new HttpError(404, { error: 'node_not_found' });
    title = `移除节点：${node.title}`; summary = '归档节点工作区并移除相关依赖'; after = { node_id: node.id }; applyAction = { type: 'workflow_node_remove', workflow_id: workflow.id, node_id: node.id };
  } else if (body.action === 'update_node') {
    const node = state.workflow_nodes.find((item) => item.id === body.node_id && item.workflow_id === workflow.id);
    if (!node) throw new HttpError(404, { error: 'node_not_found' });
    const nextTitle = String(body.patch?.title || node.title).trim().slice(0, 100);
    const patch = { title: nextTitle, goal: String(body.patch?.goal ?? node.goal).trim().slice(0, 2000) || nextTitle, type: allowedTypes.has(body.patch?.type) ? body.patch.type : node.type };
    title = `更新节点：${node.title}`; summary = '调整节点类型、标题或目标'; after = patch; applyAction = { type: 'workflow_node_update', workflow_id: workflow.id, node_id: node.id };
  } else if (body.action === 'connect_nodes') {
    const source = state.workflow_nodes.find((item) => item.id === body.source_id && item.workflow_id === workflow.id), target = state.workflow_nodes.find((item) => item.id === body.target_id && item.workflow_id === workflow.id);
    if (!source || !target || source.id === target.id) throw new HttpError(400, { error: 'invalid_node_dependency' });
    title = `连接 ${source.title} → ${target.title}`; summary = '添加 finish-to-start 依赖'; after = { source_id: source.id, target_id: target.id }; applyAction = { type: 'workflow_nodes_connect', workflow_id: workflow.id, source_id: source.id, target_id: target.id };
  } else throw new HttpError(400, { error: 'unsupported_workflow_action' });
  const result = await mutate((data) => {
    const actor = owner(data);
    const proposal = createChangeProposal({ projectId: workflow.project_id, workspaceId: workflow.workspace_id, changeType: 'workflow_graph', title, summary, before: graphFor(data.workflow_nodes.filter((item) => item.workflow_id === workflow.id)), after, impact: ['工作流结构', '节点 Contract 与工作区'], risks: ['变更会影响后续执行顺序'], applyAction, actorId: actor.id });
    proposal.target_hash_mode = 'state';
    data.change_proposals.push(proposal);
    addTrace(data, 'change_proposal.created', { project_id: workflow.project_id, workspace_id: workflow.workspace_id, target_id: proposal.id, summary: proposal.title }, actor.id);
    return proposal;
  });
  return send(res, 201, result);
}

async function generateNodes(state, project, body, query) {
  if (testAdapter(body, query)) return [normalizeNode({ type: 'goal_definition', title: '明确测试目标', goal: project.goal }, 0), normalizeNode({ type: 'execution', title: '执行测试任务', goal: '完成并验证目标', dependency_indexes: [0] }, 1)];
  const profile = state.codex_profiles.find((item) => item.is_active && item.status === 'validated');
  if (!profile) throw new HttpError(409, { error: 'active_codex_profile_required' });
  let output = '';
  const prompt = `Generate a concise workflow for this project goal: ${project.goal || project.title}. Return only JSON: {"nodes":[{"type":"goal_definition|research|analysis|execution|retrospective","title":"...","goal":"...","dependency_indexes":[0]}]}. Use 2-8 nodes.`;
  const run = await runCodexJson({ state, profile, prompt, cwd: project.repo_path || project.workspace_root || AIWS_HOME, sandbox: 'read-only', onEvent: (event) => { output += extractMessage(event); } });
  if (!run.ok) throw new HttpError(502, { error: 'codex_workflow_generation_failed', detail: run.stderr.slice(-1000) });
  const parsed = parseJson(output || run.stdout);
  if (!Array.isArray(parsed.nodes) || !parsed.nodes.length || parsed.nodes.length > 12) throw new HttpError(502, { error: 'invalid_codex_workflow_result' });
  return parsed.nodes.map(normalizeNode);
}

function normalizeNode(value = {}, index = 0) { const type = allowedTypes.has(value.type) ? value.type : 'execution'; return { type, title: String(value.title || workflowTemplates.find((item) => item.type === type)?.title || '新节点').slice(0, 100), goal: String(value.goal || '').slice(0, 2000), dependency_indexes: Array.isArray(value.dependency_indexes) ? value.dependency_indexes.filter((item) => Number.isInteger(item) && item >= 0 && item < index) : [], position: validPosition(value.position || { x: 100 + (index % 3) * 280, y: 110 + Math.floor(index / 3) * 220 }) }; }
function validPosition(value) { return { x: Math.max(-10000, Math.min(10000, Number(value?.x) || 0)), y: Math.max(-10000, Math.min(10000, Number(value?.y) || 0)) }; }
function graphFor(nodes) { return { nodes: nodes.map((node) => ({ id: node.id, type: node.type, label: node.title, position: node.position })), edges: nodes.flatMap((node) => (node.dependencies || []).map((dependency, index) => ({ id: `${dependency.node_id}-${node.id}-${index}`, source: dependency.node_id, target: node.id }))).filter((edge) => edge.source) }; }
function parseJson(text) { const cleaned = String(text).replace(/```(?:json)?/g, '').replace(/```/g, ''); const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}'); try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { throw new HttpError(502, { error: 'codex_json_parse_failed' }); } }
