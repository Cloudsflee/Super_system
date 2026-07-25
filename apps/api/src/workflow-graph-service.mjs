import {
  applyContractPatch, createChangeProposal, createNodeWorkspace, defaultContractForNode,
  hashString, now
} from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { invalidateAssistScopesInState } from './assist-v3-domain.mjs';
import { assertCompletedTaskDefinitions, prepareWorkflowGraphPatch, workflowGraphHash, workflowGraphSnapshot, workflowVisualGraph } from './workflow-graph-validation.mjs';
import { assertWorkflowHierarchy, normalizeWorkflowHierarchyNodes } from './workflow-hierarchy-domain.mjs';
import { assertWorkflowPlanningQuality } from './workflow-quality.mjs';

export { prepareWorkflowGraphPatch, workflowGraphHash, workflowGraphSnapshot, workflowVisualGraph } from './workflow-graph-validation.mjs';

export function workflowAssistSurfaceId(workflowId) { return `workflow-${workflowId}`; }
export function workflowAssistSurfaceRevision(workflow) { return `${workflow.id}:v${Number(workflow.workflow_revision || workflow.version || 1)}`; }

export function currentProjectWorkflow(state, projectId) {
  return state.workflows
    .filter((item) => item.project_id === projectId && item.status !== 'archived')
    .sort((left, right) => Number(right.version || 0) - Number(left.version || 0) || String(right.created_at || '').localeCompare(String(left.created_at || '')))[0] || null;
}

export function createWorkflowGraphProposalInState(state, workflowId, input, actorId, metadata = {}) {
  const workflow = state.workflows.find((item) => item.id === workflowId && (!metadata.project_id || item.project_id === metadata.project_id));
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  assertWorkflowExecutionInactive(state, workflow.id);
  let operations = structuredClone(input.operations || []), replacement = null;
  if (metadata.replaces_proposal_id) {
    replacement = state.change_proposals.find((item) => item.id === metadata.replaces_proposal_id);
    if (!replacement || replacement.apply_action?.type !== 'workflow_graph_patch' || replacement.apply_action.workflow_id !== workflow.id) throw new HttpError(409, { error: 'assist_operation_reference_proposal_scope_mismatch' });
    if (replacement.status !== 'pending') throw new HttpError(409, { error: 'assist_operation_reference_proposal_resolved', proposal_status: replacement.status });
    operations = [...structuredClone(replacement.apply_action.operations || []), ...operations];
  }
  const prepared = prepareWorkflowGraphPatch(state, workflow.id, { parent_node_id: input.parent_node_id || null, expected_revision: input.expected_revision, operations });
  const target = proposalTarget(prepared, metadata.target_id);
  const proposal = createChangeProposal({
    projectId: workflow.project_id,
    workspaceId: workflow.workspace_id,
    nodeId: target.node_id,
    changeType: 'workflow_graph_patch',
    title: clean(metadata.title, 200) || `调整工作流：${target.label}`,
    summary: clean(metadata.summary, 1000) || summarizeOperations(prepared.operations),
    before: prepared.before,
    after: prepared.after,
    impact: ['工作流结构', '执行顺序', '节点 Workspace 与 Contract'],
    risks: prepared.destructive ? ['包含节点删除，只有批准并应用后才会归档对应 Workspace'] : ['应用后会更新正式工作流 revision'],
    applyAction: {
      type: 'workflow_graph_patch', workflow_id: workflow.id, parent_node_id: prepared.parent_node_id || null, expected_revision: prepared.expected_revision,
      operations: prepared.operations, before_hash: prepared.before_hash, candidate_hash: prepared.after_hash
    },
    actorId
  });
  Object.assign(proposal, {
    target_hash_mode: 'workflow_graph_v2', target_hash_version: 2, target_hash: prepared.before_hash,
    destructive: prepared.destructive, operations_json: structuredClone(prepared.operations),
    workflow_id: workflow.id, workflow_revision: prepared.parent_node_id ? Number(workflow.workflow_revision || workflow.version || 1) : prepared.expected_revision,
    parent_node_id: prepared.parent_node_id || null, plan_revision: prepared.parent_node_id ? prepared.expected_revision : null,
    replaces_proposal_id: replacement?.id || null
  });
  state.change_proposals.push(proposal);
  if (replacement) Object.assign(replacement, {
    status: 'superseded', attention_state: 'resolved', superseded_by_proposal_id: proposal.id,
    revision: Number(replacement.revision || 1) + 1, updated_at: now()
  });
  return { proposal, ...prepared, target };
}

export function createWorkflowReplanProposalInState(state, workflowId, candidateInput, actorId, metadata = {}) {
  const workflow = state.workflows.find((item) => item.id === workflowId && (!metadata.project_id || item.project_id === metadata.project_id));
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  assertWorkflowExecutionInactive(state, workflow.id);
  const project = state.projects.find((item) => item.id === workflow.project_id), brief = currentBrief(state, workflow.project_id);
  const current = formalNodes(state, workflow.id), candidate = normalizeWorkflowHierarchyNodes(candidateInput.nodes || []);
  assertWorkflowHierarchy(candidate, { mode: 'formal', requireTasks: true });
  assertCompletedTaskDefinitions(current, candidate);
  const quality = assertWorkflowPlanningQuality({ nodes: candidate, project, brief, projectClassification: candidateInput.project_classification, briefCoverage: candidateInput.brief_coverage });
  const revision = Number(workflow.workflow_revision || workflow.version || 1), before = fullSnapshot(workflow, current, revision), after = fullSnapshot(workflow, quality.nodes, revision + 1);
  const proposal = createChangeProposal({
    projectId: workflow.project_id, workspaceId: workflow.workspace_id, nodeId: null,
    changeType: 'workflow_replan_replace', title: clean(metadata.title, 200) || `重规划工作流：${workflow.title}`,
    summary: clean(metadata.summary, 1000) || '以通过质量门禁的新 Task DAG 替换正式工作流。', before, after,
    impact: ['正式 Workflow', 'Task DAG', 'Node Contract', '资产输入输出'],
    risks: ['批准前不修改正式工作流；已完成 Task 定义保持冻结。'],
    applyAction: { type: 'workflow_replan_replace', workflow_id: workflow.id, expected_revision: revision, before_hash: digest(before), candidate_hash: digest(after), candidate: quality.nodes, brief_coverage: quality.brief_coverage, project_classification: candidateInput.project_classification },
    actorId
  });
  Object.assign(proposal, { target_hash_mode: 'workflow_replan_v1', target_hash_version: 1, target_hash: digest(before), workflow_id: workflow.id, workflow_revision: revision, generation_id: metadata.generation_id || null });
  state.change_proposals.push(proposal);
  return { proposal, before, after, candidate: quality.nodes };
}

export function applyWorkflowGraphPatchInState(state, proposal) {
  const action = proposal?.apply_action || {};
  const workflow = state.workflows.find((item) => item.id === action.workflow_id && item.project_id === proposal.project_id);
  if (!workflow) return { type: 'workflow_graph_patch', skipped: 'workflow_missing' };
  assertWorkflowExecutionInactive(state, workflow.id);
  const parent = action.parent_node_id ? state.workflow_nodes.find((item) => item.id === action.parent_node_id && item.workflow_id === workflow.id && item.role === 'workstream') : null;
  const currentRevision = parent ? Number(parent.plan_revision || 1) : Number(workflow.workflow_revision || workflow.version || 1);
  if (currentRevision !== Number(action.expected_revision)) throw stale(parent ? 'workstream_plan_revision_changed' : 'workflow_revision_changed', workflow, currentRevision, action.parent_node_id);
  const current = workflowGraphSnapshot(state, workflow, action.parent_node_id || null);
  if (action.before_hash && workflowGraphHash(current) !== action.before_hash) throw stale('workflow_graph_changed', workflow);
  let prepared;
  try { prepared = prepareWorkflowGraphPatch(state, workflow.id, { parent_node_id: action.parent_node_id || null, expected_revision: action.expected_revision, operations: action.operations }); }
  catch (error) {
    if (error instanceof HttpError && error.status === 409) throw stale(error.payload?.error || 'workflow_validation_changed', workflow);
    throw error;
  }
  if (action.candidate_hash && prepared.after_hash !== action.candidate_hash) throw stale('workflow_candidate_changed', workflow);
  if (proposal.after_json && workflowGraphHash(proposal.after_json) !== prepared.after_hash) throw stale('proposal_candidate_changed', workflow);
  applyCandidate(state, workflow, prepared.candidate, proposal.approved_by_user_id || proposal.created_by_user_id);
  if (prepared.parent_node_id) {
    const currentParent = state.workflow_nodes.find((item) => item.id === prepared.parent_node_id && item.workflow_id === workflow.id);
    if (currentParent) currentParent.plan_revision = prepared.expected_revision + 1;
  } else {
    workflow.version = prepared.expected_revision + 1;
    workflow.workflow_revision = prepared.expected_revision + 1;
  }
  workflow.graph_json = workflowVisualGraph(state.workflow_nodes.filter((item) => item.workflow_id === workflow.id));
  workflow.updated_at = now();
  return {
    type: 'workflow_graph_patch', workflow_id: workflow.id, parent_node_id: prepared.parent_node_id || null,
    revision: prepared.parent_node_id ? prepared.expected_revision + 1 : workflow.workflow_revision || workflow.version,
    node_ids: prepared.candidate.map((item) => item.id), operations: prepared.operations
  };
}

export function applyWorkflowReplanInState(state, proposal) {
  const action = proposal?.apply_action || {}, workflow = state.workflows.find((item) => item.id === action.workflow_id && item.project_id === proposal.project_id);
  if (!workflow) return { type: 'workflow_replan_replace', skipped: 'workflow_missing' };
  assertWorkflowExecutionInactive(state, workflow.id);
  const revision = Number(workflow.workflow_revision || workflow.version || 1);
  if (revision !== Number(action.expected_revision)) throw stale('workflow_revision_changed', workflow, revision);
  const current = formalNodes(state, workflow.id), before = fullSnapshot(workflow, current, revision);
  if (action.before_hash && digest(before) !== action.before_hash) throw stale('workflow_graph_changed', workflow);
  const candidate = normalizeWorkflowHierarchyNodes(action.candidate || []);
  assertWorkflowHierarchy(candidate, { mode: 'formal', requireTasks: true }); assertCompletedTaskDefinitions(current, candidate);
  const quality = assertWorkflowPlanningQuality({ nodes: candidate, project: state.projects.find((item) => item.id === workflow.project_id), brief: currentBrief(state, workflow.project_id), projectClassification: action.project_classification, briefCoverage: action.brief_coverage });
  const after = fullSnapshot(workflow, quality.nodes, revision + 1);
  if (action.candidate_hash && digest(after) !== action.candidate_hash) throw stale('workflow_candidate_changed', workflow);
  applyCandidate(state, workflow, quality.nodes, proposal.approved_by_user_id || proposal.created_by_user_id);
  Object.assign(workflow, { version: revision + 1, workflow_revision: revision + 1, planning_quality: 'verified', project_classification: action.project_classification, brief_coverage: quality.brief_coverage, graph_json: workflowVisualGraph(state.workflow_nodes.filter((item) => item.workflow_id === workflow.id)), updated_at: now() });
  return { type: 'workflow_replan_replace', workflow_id: workflow.id, revision: workflow.workflow_revision, node_ids: quality.nodes.map((item) => item.id) };
}

function applyCandidate(state, workflow, candidate, actorId) {
  const project = state.projects.find((item) => item.id === workflow.project_id);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  const existing = new Map(state.workflow_nodes.filter((item) => item.workflow_id === workflow.id).map((item) => [item.id, item]));
  const workspaceIdByNodeId = new Map([...existing.values()].map((node) => [node.id, node.workspace_id]).filter(([, workspaceId]) => workspaceId));
  const retainedIds = new Set(candidate.map((item) => item.id));
  for (const node of existing.values()) if (!retainedIds.has(node.id)) {
    const workspace = state.workspaces.find((item) => item.id === node.workspace_id || item.workflow_node_id === node.id);
    if (workspace) Object.assign(workspace, { status: 'archived', updated_at: now() });
  }
  invalidateAssistScopesInState(state, [...existing.keys()].filter((nodeId) => !retainedIds.has(nodeId)), 'workflow_node_removed');
  const finalNodes = candidate.map((source) => {
    let node = existing.get(source.id);
    if (!node) {
      node = {
        id: source.id, workflow_id: workflow.id, workspace_id: null, type: source.type, title: source.title, goal: source.goal,
        role: source.role, parent_node_id: source.parent_node_id, outcome: source.outcome, category: source.category,
        task_kind: source.task_kind, execution_mode: source.execution_mode, boundary: source.boundary,
        acceptance_criteria: source.acceptance_criteria, required: source.required !== false, repository_intent: source.repository_intent || null,
        capability_tags: source.capability_tags || [], input_slots: source.input_slots || [], output_slots: source.output_slots || [], atomic_justification: source.atomic_justification || null,
        repository_target_ids: source.repository_target_ids || [], plan_revision: source.role === 'workstream' ? Number(source.plan_revision || 1) : null,
        status: source.status || 'ready', execution_revision: Number(source.execution_revision || 1), order_index: source.order_index, dependencies: [], current_contract_id: null,
        template_outputs: [], position: source.position, legacy_read_only: false, created_at: now(), updated_at: now()
      };
      const workspace = createNodeWorkspace(project, node, actorId), contract = defaultContractForNode(node, project, actorId, 'confirmed');
      workspace.type = source.role;
      if (source.role === 'task') {
        const parentWorkspaceId = workspaceIdByNodeId.get(source.parent_node_id);
        if (!parentWorkspaceId) throw new HttpError(409, { error: 'workflow_task_parent_workspace_missing', node_id: source.id, parent_node_id: source.parent_node_id });
        workspace.parent_workspace_id = parentWorkspaceId;
      }
      if (source.acceptance_criteria?.length) contract.acceptance_criteria = [...source.acceptance_criteria];
      if (source.role === 'task') { contract.expected_inputs = structuredClone(source.input_slots || []); contract.expected_outputs = structuredClone(source.output_slots || []); }
      if (source.role === 'workstream') { contract.node_goal = source.outcome; contract.expected_outputs = [{ label: source.outcome, required: true }]; contract.boundary = structuredClone(source.boundary || {}); }
      node.workspace_id = workspace.id; node.current_contract_id = contract.id;
      state.workspaces.push(workspace); state.node_contracts.push(contract);
      workspaceIdByNodeId.set(node.id, workspace.id);
    } else {
      const typeChanged = node.type !== source.type, goalChanged = node.goal !== source.goal;
      const contractChanged = typeChanged || goalChanged || Number(source.execution_revision || 1) > Number(node.execution_revision || 1)
        || JSON.stringify(node.dependencies || []) !== JSON.stringify(source.dependency_ids.map((nodeId) => ({ node_id: nodeId, type: 'finish_to_start' })))
        || JSON.stringify(node.input_slots || []) !== JSON.stringify(source.input_slots || [])
        || JSON.stringify(node.output_slots || []) !== JSON.stringify(source.output_slots || [])
        || JSON.stringify(node.acceptance_criteria || []) !== JSON.stringify(source.acceptance_criteria || []);
      Object.assign(node, {
        type: source.type, title: source.title, goal: source.goal, order_index: source.order_index,
        role: source.role, parent_node_id: source.parent_node_id, outcome: source.outcome, category: source.category,
        task_kind: source.task_kind, execution_mode: source.execution_mode, boundary: source.boundary,
        acceptance_criteria: source.acceptance_criteria, required: source.required !== false, repository_intent: source.repository_intent || null,
        capability_tags: source.capability_tags || [], input_slots: source.input_slots || [], output_slots: source.output_slots || [], atomic_justification: source.atomic_justification || null,
        repository_target_ids: source.repository_target_ids || node.repository_target_ids || [], plan_revision: source.role === 'workstream' ? Number(source.plan_revision || node.plan_revision || 1) : null,
        position: source.position, dependencies: source.dependency_ids.map((nodeId) => ({ node_id: nodeId, type: 'finish_to_start' })), updated_at: now()
      });
      if (Number(source.execution_revision || 1) > Number(node.execution_revision || 1)) Object.assign(node, { status: source.status || 'ready', execution_revision: Number(source.execution_revision), reopened_from_revision: source.reopened_from_revision || Number(node.execution_revision || 1), reopen_reason: source.reopen_reason || null, latest_submission_id: null, reviewed_at: null, reviewed_by_user_id: null });
      if (contractChanged) refreshContract(state, project, node, actorId, typeChanged);
      const workspace = state.workspaces.find((item) => item.id === node.workspace_id || item.workflow_node_id === node.id);
      if (workspace) {
        const parentWorkspaceId = node.role === 'task' ? workspaceIdByNodeId.get(node.parent_node_id) : project.current_workspace_id;
        if (node.role === 'task' && !parentWorkspaceId) throw new HttpError(409, { error: 'workflow_task_parent_workspace_missing', node_id: node.id, parent_node_id: node.parent_node_id });
        Object.assign(workspace, {
          title: node.title, goal: node.goal,
          ...(node.role ? { type: node.role, parent_workspace_id: parentWorkspaceId } : {}),
          updated_at: now()
        });
        workspaceIdByNodeId.set(node.id, workspace.id);
      }
    }
    node.dependencies = source.dependency_ids.map((nodeId) => ({ node_id: nodeId, type: 'finish_to_start' }));
    return node;
  });
  for (const task of finalNodes.filter((node) => node.role === 'task' && !existing.has(node.id))) {
    task.status = task.dependencies.every((dependency) => finalNodes.find((node) => node.id === dependency.node_id)?.status === 'completed') ? 'ready' : 'blocked';
  }
  for (const workstream of finalNodes.filter((node) => node.role === 'workstream' && node.status === 'completed')) {
    if (finalNodes.some((node) => node.role === 'task' && node.parent_node_id === workstream.id && node.required !== false && node.status !== 'completed')) {
      Object.assign(workstream, { status: 'ready', completed_at: null, updated_at: now() });
    }
  }
  state.workflow_nodes = [...state.workflow_nodes.filter((item) => item.workflow_id !== workflow.id), ...finalNodes];
}

function refreshContract(state, project, node, actorId, reset) {
  const current = state.node_contracts.find((item) => item.id === node.current_contract_id);
  const next = !current || reset ? defaultContractForNode(node, project, actorId, 'confirmed') : applyContractPatch(current, { node_goal: node.goal, expected_inputs: structuredClone(node.input_slots || []), expected_outputs: structuredClone(node.output_slots || []), acceptance_criteria: structuredClone(node.acceptance_criteria || []) }, actorId);
  if (current) current.status = 'superseded';
  Object.assign(next, {
    version: Number(current?.version || 0) + 1, status: 'confirmed', confirmed_by: 'human', confirmed_by_user_id: actorId
  });
  state.node_contracts.push(next); node.current_contract_id = next.id;
}

function assertWorkflowExecutionInactive(state, workflowId) { const active = state.workflow_executions?.find((item) => item.workflow_id === workflowId && ['running', 'paused'].includes(item.status)); if (active) throw new HttpError(409, { error: 'workflow_execution_active_replan_forbidden', workflow_execution_id: active.id }); }

function clean(value, max = 120) { return String(value ?? '').replace(/\0/g, '').trim().slice(0, max); }
function proposalTarget(prepared, targetId) { const idValue = clean(targetId, 120); const node = prepared.after.nodes.find((item) => item.id === idValue) || prepared.before.nodes.find((item) => item.id === idValue); const parent = prepared.parent_node_id || null; return { id: idValue || parent || prepared.workflow.id, node_id: node?.id || parent, label: node?.title || (parent ? '成果节点任务计划' : prepared.workflow.title) || '正式工作流' }; }
function summarizeOperations(operations) { const counts = new Map(); for (const item of operations) counts.set(item.type, (counts.get(item.type) || 0) + 1); const labels = { add_node: '新增', update_node: '修改', delete_node: '删除', reorder_nodes: '排序', connect: '连接', disconnect: '断开' }; return [...counts].map(([type, count]) => `${labels[type] || type} ${count} 项`).join('，'); }
function stale(reason, workflow, revision = Number(workflow.workflow_revision || workflow.version || 1), parentNodeId = null) { return new HttpError(409, { error: 'proposal_stale', reason, workflow_id: workflow.id, parent_node_id: parentNodeId, current_revision: revision }); }
function formalNodes(state, workflowId) { return normalizeWorkflowHierarchyNodes(state.workflow_nodes.filter((item) => item.workflow_id === workflowId).map((node) => ({ ...node, dependency_ids: (node.dependencies || []).map((item) => item.node_id) }))); }
function currentBrief(state, projectId) { return state.project_briefs.filter((item) => item.project_id === projectId && item.status !== 'superseded').sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null; }
function fullSnapshot(workflow, nodes, revision) { return { workflow_id: workflow.id, revision, nodes: nodes.map((node) => ({ ...node, dependencies: undefined, dependency_ids: [...(node.dependency_ids || [])].sort() })).sort((a, b) => String(a.id).localeCompare(String(b.id))) }; }
function digest(value) { return hashString(JSON.stringify(value)); }
