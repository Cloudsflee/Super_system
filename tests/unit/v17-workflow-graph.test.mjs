import assert from 'node:assert/strict';
import { createChangeProposal } from '../../packages/shared/index.mjs';

import { applyProposalAtomically } from '../../apps/api/src/proposal-atomic.mjs';
import { proposalTargetHash } from '../../apps/api/src/proposal-target.mjs';
import {
  createWorkflowGraphProposalInState, prepareWorkflowGraphPatch, workflowGraphHash, workflowGraphSnapshot
} from '../../apps/api/src/workflow-graph-service.mjs';

const actor = { id: 'owner-workflow-graph' };
const state = graphState();

const restructuring = createWorkflowGraphProposalInState(state, 'workflow-graph', { expected_revision: 1, operations: [
  { type: 'update_node', node_id: 'node-b', patch: { type: 'analysis', title: '方案分析', goal: '比较实现方案' } },
  add('node-d', '并行调研', ['node-a']),
  add('node-e', '并行验证', ['node-a']),
  add('node-f', '汇总方案', ['node-d', 'node-e']),
  add('node-g', '执行交付', ['node-f']),
  add('node-h', '交付复盘', ['node-g'], 'retrospective'),
  { type: 'disconnect', node_id: 'node-c', dependency_id: 'node-b' },
  { type: 'connect', node_id: 'node-c', dependency_id: 'node-f' },
  { type: 'reorder_nodes', ids: ['node-a', 'node-b', 'node-d', 'node-e', 'node-f', 'node-c', 'node-g', 'node-h'] }
] }, actor.id);

assert.equal(restructuring.proposal.change_type, 'workflow_graph_patch');
assert.equal(restructuring.proposal.target_hash_mode, 'workflow_graph_v2');
assert.equal(restructuring.after.nodes.length, 8);
assert.equal(state.workflows[0].version, 1, 'creating a proposal does not change the formal graph revision');
assert.deepEqual(state.workflow_nodes.map((node) => node.id), ['node-a', 'node-b', 'node-c']);
const hashBeforeLayout = proposalTargetHash(state, restructuring.proposal);
state.workflow_nodes[0].position = { x: 999, y: 777 };
assert.equal(proposalTargetHash(state, restructuring.proposal), hashBeforeLayout, 'layout is excluded from semantic graph hashes');

apply(restructuring.proposal);
assert.equal(state.workflows[0].version, 2);
assert.equal(state.workflow_nodes.length, 8);
assert.deepEqual(dependencies('node-d'), ['node-a']);
assert.deepEqual(dependencies('node-e'), ['node-a']);
assert.deepEqual(new Set(dependencies('node-f')), new Set(['node-d', 'node-e']));
assert.deepEqual(dependencies('node-c'), ['node-f']);
assert.deepEqual(state.workflow_nodes.sort(byOrder).map((node) => node.id), ['node-a', 'node-b', 'node-d', 'node-e', 'node-f', 'node-c', 'node-g', 'node-h']);
assert.ok(state.workflow_nodes.filter((node) => node.id.startsWith('node-') && !['node-a', 'node-b', 'node-c'].includes(node.id)).every((node) => node.workspace_id && node.current_contract_id));
assert.equal(state.node_contracts.find((item) => item.id === 'contract-b').status, 'superseded');
assert.notEqual(state.workflow_nodes.find((item) => item.id === 'node-b').current_contract_id, 'contract-b');

state.node_runs.push({ id: 'run-active', node_id: 'node-h', status: 'running' });
assert.throws(() => createWorkflowGraphProposalInState(state, 'workflow-graph', { expected_revision: 2, operations: [{ type: 'delete_node', node_id: 'node-h' }] }, actor.id), hasError('workflow_graph_active_node_run'));
state.node_runs.length = 0;
const deletion = createWorkflowGraphProposalInState(state, 'workflow-graph', { expected_revision: 2, operations: [{ type: 'delete_node', node_id: 'node-h' }] }, actor.id);
const staleSibling = createWorkflowGraphProposalInState(state, 'workflow-graph', { expected_revision: 2, operations: [{ type: 'update_node', node_id: 'node-c', patch: { title: '过期修改' } }] }, actor.id);
assert.equal(deletion.proposal.destructive, true);
apply(deletion.proposal);
assert.equal(state.workflows[0].version, 3);
assert.equal(state.workflow_nodes.some((node) => node.id === 'node-h'), false);
assert.equal(state.workspaces.find((item) => item.workflow_node_id === 'node-h').status, 'archived');
assert.throws(() => apply(staleSibling.proposal), hasError('proposal_stale'));

const base = graphState();
assert.throws(() => prepare(base, [{ type: 'add_node', node: { id: 'node-a', title: 'duplicate' } }]), hasError('workflow_graph_node_id_conflict'));
assert.throws(() => prepare(base, [{ type: 'reorder_nodes', ids: ['node-a', 'node-b'] }]), hasError('workflow_graph_reorder_invalid'));
assert.throws(() => prepare(base, [{ type: 'connect', node_id: 'node-a', dependency_id: 'node-a' }]), hasError('workflow_graph_self_dependency'));
assert.throws(() => prepare(base, [{ type: 'connect', node_id: 'node-a', dependency_id: 'node-c' }]), hasError('workflow_graph_cycle'));
assert.throws(() => prepare(base, ['node-a', 'node-b', 'node-c'].map((node_id) => ({ type: 'delete_node', node_id }))), hasError('workflow_graph_requires_node'));
const crowded = graphState();
for (let index = 0; index < 54; index += 1) {
  const extra = node(`crowded-${index}`, 'execution', `Crowded ${index}`, crowded.workflow_nodes.length, []);
  crowded.workflow_nodes.push(extra);
  crowded.workspaces.push({ id: extra.workspace_id, project_id: 'project-graph', workflow_node_id: extra.id, status: 'active' });
  crowded.node_contracts.push(contract(extra));
}
assert.throws(() => prepareWorkflowGraphPatch(crowded, 'workflow-graph', { expected_revision: 1, operations: Array.from({ length: 100 }, (_, index) => add(`overflow-${index}`, `Overflow ${index}`, [])) }), hasError('workflow_graph_node_limit'));
assert.equal(workflowGraphHash(workflowGraphSnapshot(base, 'workflow-graph')), workflowGraphHash(workflowGraphSnapshot(base, base.workflows[0])));

const legacy = graphState(), legacyBefore = legacyGraph(legacy);
const legacyProposal = createChangeProposal({ projectId: 'project-graph', workspaceId: 'workspace-root', changeType: 'workflow_graph', title: 'Legacy pending update', before: legacyBefore, after: { title: 'Legacy applied' }, applyAction: { type: 'workflow_node_update', workflow_id: 'workflow-graph', node_id: 'node-b' }, actorId: actor.id });
legacyProposal.target_hash_mode = 'state'; legacyProposal.target_hash = proposalTargetHash(legacy, legacyProposal); legacy.change_proposals.push(legacyProposal);
applyProposalAtomically(legacy, legacyProposal, actor, { revision: legacyProposal.revision, target_hash: legacyProposal.target_hash });
assert.equal(legacy.workflows[0].version, 2); assert.equal(legacy.workflow_nodes.find((item) => item.id === 'node-b').title, 'Legacy applied');

console.log('V1.7 formal workflow graph tests passed');

function prepare(value, operations) { return prepareWorkflowGraphPatch(value, 'workflow-graph', { expected_revision: 1, operations }); }
function apply(proposal) { return applyProposalAtomically(state, proposal, actor, { revision: proposal.revision, target_hash: proposal.target_hash }); }
function dependencies(nodeId) { return state.workflow_nodes.find((node) => node.id === nodeId).dependencies.map((item) => item.node_id); }
function add(id, title, dependency_ids, type = 'execution') { return { type: 'add_node', node: { id, type, title, goal: title, dependency_ids } }; }
function byOrder(left, right) { return left.order_index - right.order_index; }
function hasError(code) { return (error) => error?.payload?.error === code; }
function legacyGraph(value) { const nodes = value.workflow_nodes; return { nodes: nodes.map((item) => ({ id: item.id, type: item.type, label: item.title, position: item.position })), edges: nodes.flatMap((item) => item.dependencies.map((dependency, index) => ({ id: `${dependency.node_id}-${item.id}-${index}`, source: dependency.node_id, target: item.id }))) }; }
function graphState() {
  const nodes = [
    node('node-a', 'goal_definition', '目标', 0, []),
    node('node-b', 'execution', '实现', 1, ['node-a']),
    node('node-c', 'retrospective', '复盘', 2, ['node-b'])
  ];
  return {
    projects: [{ id: 'project-graph', title: 'Graph', goal: 'Ship', current_workspace_id: 'workspace-root', lifecycle_operation: null }],
    workflows: [{ id: 'workflow-graph', project_id: 'project-graph', workspace_id: 'workspace-root', title: 'Graph workflow', version: 1, status: 'active' }],
    workflow_nodes: nodes,
    workspaces: [{ id: 'workspace-root', project_id: 'project-graph', status: 'active' }, ...nodes.map((item) => ({ id: item.workspace_id, project_id: 'project-graph', workflow_node_id: item.id, status: 'active' }))],
    node_contracts: nodes.map((item) => contract(item)), node_runs: [], change_proposals: [], assist_sessions: []
  };
}
function node(id, type, title, order_index, dependencyIds) { return { id, workflow_id: 'workflow-graph', workspace_id: `workspace-${id}`, type, title, goal: title, status: 'ready', order_index, dependencies: dependencyIds.map((node_id) => ({ node_id, type: 'finish_to_start' })), current_contract_id: `contract-${id.at(-1)}`, position: { x: order_index * 100, y: 100 } }; }
function contract(nodeValue) { return { id: nodeValue.current_contract_id, node_id: nodeValue.id, version: 1, node_goal: nodeValue.goal, expected_inputs: [], expected_outputs: [{ label: 'result' }], acceptance_criteria: ['verified'], required_context: [], allowed_tools: ['assist'], asset_output_types: [], status: 'confirmed' }; }
