import { HttpError } from './http.mjs';
import { FORMAL_WORKSTREAM_LIMIT, isProcessStageTitle } from './workflow-hierarchy-domain.mjs';

export const STARTUP_WORKFLOW_MAX_NODES = FORMAL_WORKSTREAM_LIMIT;
export const STARTUP_WORKFLOW_TYPES = Object.freeze(['workstream', 'task']);
export const STARTUP_WORKFLOW_POLICY = [
  'Top-level nodes are independently acceptable outcome Workstreams, never generic process phases.',
  'Each Workstream needs a verifiable outcome, acceptance criteria, and an owner, permission, repository, external dependency, or deliverable boundary.',
  'Execution steps belong to Task nodes under one Workstream. Task dependencies stay between siblings in that Workstream.',
  `A reviewed draft may contain at most ${FORMAL_WORKSTREAM_LIMIT} Workstreams. Do not create coding, testing, review, or deployment phase chains.`
].join(' ');

// Retained as a compatibility export for callers compiled against V1.8.
export function defaultCodingWorkflowNode({ makeId, goal, features = [], acceptanceCriteria = [] }) {
  const scope = cleanList(features).join('；') || clean(goal, 3000) || '完成项目核心交付';
  const criteria = cleanList(acceptanceCriteria);
  const workstreamId = makeId('wfs', 'primary-deliverable');
  return {
    id: workstreamId, role: 'workstream', parent_node_id: null, type: 'execution', title: '核心成果交付',
    goal: scope, outcome: scope, category: 'deliverable', acceptance_criteria: criteria.length ? criteria : [`可验证交付：${scope}`],
    boundary: { deliverable: scope }, dependency_ids: [], position: { x: 80, y: 120 }, order_index: 0, plan_revision: 1,
    tasks: [{
      id: makeId('tsk', 'primary-deliverable-task'), role: 'task', parent_node_id: workstreamId, type: 'execution',
      title: '完成核心交付任务', goal: scope, task_kind: 'manual', execution_mode: 'manual', dependency_ids: [], order_index: 0
    }]
  };
}

export function assertStartupWorkflowOperations(nodes = [], operations = []) {
  const topLevel = new Set(nodes.filter(isTopLevel).map((node) => node.id));
  for (const operation of operations) {
    const type = String(operation?.type || operation?.op || '');
    if (type === 'add_node' || type === 'add_workstream' || type === 'add_task') {
      const node = operation?.node || {};
      const role = type === 'add_task' || node.role === 'task' || node.parent_node_id ? 'task' : 'workstream';
      if (role === 'workstream') {
        assertOutcomeTitle(node.title);
        topLevel.add(String(node.id || `pending-${topLevel.size}`));
      }
    } else if (type === 'delete_node') {
      topLevel.delete(String(operation.node_id || operation.id || ''));
    } else if (type === 'update_node') {
      const node = nodes.find((item) => item.id === (operation.node_id || operation.id));
      if (isTopLevel(node) && operation?.patch?.title !== undefined) assertOutcomeTitle(operation.patch.title);
    }
  }
  if (topLevel.size > STARTUP_WORKFLOW_MAX_NODES) throw new HttpError(409, {
    error: 'assist_workflow_top_level_limit', max_nodes: STARTUP_WORKFLOW_MAX_NODES,
    guidance: 'split_execution_steps_into_tasks_under_outcome_workstreams'
  });
  return topLevel.size;
}

export function isStartupWorkflowType(value) { return STARTUP_WORKFLOW_TYPES.includes(String(value || '')); }

function isTopLevel(node) { return Boolean(node) && node.role !== 'task' && !node.parent_node_id; }
function assertOutcomeTitle(value) {
  if (isProcessStageTitle(value)) throw new HttpError(409, { error: 'workflow_workstream_process_stage_forbidden', title: String(value || '') });
}
function cleanList(value) { return (Array.isArray(value) ? value : []).map((item) => clean(item, 1000)).filter(Boolean); }
function clean(value, max) { return String(value ?? '').replace(/\0/g, '').trim().slice(0, max); }
