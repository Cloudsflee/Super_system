import assert from 'node:assert/strict';

import { hashString } from '../../packages/shared/index.mjs';
import { migrateState16To17 } from '../../apps/api/src/state-migration-v17.mjs';
import { migrateState17To18, validateState18, V18_COLLECTIONS } from '../../apps/api/src/state-migration-v18.mjs';
import { applyLegacyWorkflowMigrationInState, validateLegacyMigrationMapping } from '../../apps/api/src/workflow-migration-service.mjs';

const v17 = migrateState16To17({ schema_version: 12 }).state;
Object.assign(v17, legacyState());
const migrated = migrateState17To18(v17, { timestamp: '2026-07-18T00:00:00.000Z' });
assert.equal(migrated.state.schema_version, 18);
assert.equal(migrated.state.workflows[0].hierarchy_mode, 'legacy');
assert.equal(migrated.state.workflows[0].legacy_read_only, true);
assert.equal(migrated.state.workflow_nodes.every((item) => item.role === 'task' && item.legacy_read_only), true);
assert.equal(migrated.state.assist_sessions[0].scope_status, 'legacy_read_only');
assert.equal(migrated.state.assist_sessions[0].read_only, true);
for (const collection of V18_COLLECTIONS) assert.ok(Array.isArray(migrated.state[collection]), collection);
validateState18(migrated.state);

const state = migrated.state;
const legacyNodeIds = state.workflow_nodes.map((item) => item.id);
const legacyWorkspaceIds = state.workflow_nodes.map((item) => item.workspace_id);
const legacyContractIds = state.workflow_nodes.map((item) => item.current_contract_id);
const referenceIds = {
  runs: state.node_runs.map((item) => item.id), assets: state.assets.map((item) => item.id),
  traces: state.traces.map((item) => item.id), assist: state.assist_sessions.map((item) => item.id)
};
const candidate = migrationCandidate(state.workflow_nodes);
assert.equal(validateLegacyMigrationMapping(state.workflow_nodes, candidate), true);
assert.throws(() => validateLegacyMigrationMapping(state.workflow_nodes, { ...candidate, legacy_mapping: candidate.legacy_mapping.slice(1) }), code('workflow_migration_mapping_not_bijective'));

const beforeFailedAttempt = JSON.stringify(state);
assert.throws(() => applyLegacyWorkflowMigrationInState(state, 'workflow-legacy', candidate, 'owner', { before_hash: 'wrong' }), code('workflow_migration_source_changed'));
assert.equal(JSON.stringify(state), beforeFailedAttempt, 'failed precondition does not partially mutate the legacy workflow');

const result = applyLegacyWorkflowMigrationInState(state, 'workflow-legacy', candidate, 'owner', { before_hash: hashString(JSON.stringify(state.workflow_nodes)) });
assert.equal(result.task_ids.length, 8);
assert.deepEqual(new Set(result.task_ids), new Set(legacyNodeIds));
assert.equal(result.workstream_ids.length, 2);
assert.equal(state.workflows[0].hierarchy_mode, 'two_level');
assert.equal(state.workflows[0].legacy_read_only, false);
assert.deepEqual(state.workflow_nodes.filter((item) => item.role === 'task').map((item) => item.workspace_id), legacyWorkspaceIds);
assert.deepEqual(state.workflow_nodes.filter((item) => item.role === 'task').map((item) => item.current_contract_id), legacyContractIds);
assert.deepEqual(state.node_runs.map((item) => item.id), referenceIds.runs);
assert.deepEqual(state.assets.map((item) => item.id), referenceIds.assets);
assert.deepEqual(state.traces.map((item) => item.id), referenceIds.traces);
assert.deepEqual(state.assist_sessions.map((item) => item.id), referenceIds.assist);
assert.equal(state.assist_sessions[0].scope_type, 'task');
assert.equal(state.assist_sessions[0].scope_status, 'active');
assert.equal(state.workflow_nodes.filter((item) => item.role === 'task').every((item) => item.migrated_from_legacy), true);

console.log('V1.9 state and semantic workflow migration unit tests passed');

function legacyState() {
  const nodes = Array.from({ length: 8 }, (_, index) => ({
    id: `legacy-${index + 1}`, workflow_id: 'workflow-legacy', workspace_id: `workspace-${index + 1}`,
    type: index === 0 ? 'goal_definition' : index < 3 ? 'research' : index < 5 ? 'analysis' : index === 7 ? 'retrospective' : 'execution',
    title: `Legacy step ${index + 1}`, goal: `Complete legacy step ${index + 1}`, status: index === 0 ? 'completed' : 'ready', order_index: index,
    dependencies: index ? [{ node_id: `legacy-${index}`, type: 'finish_to_start' }] : [], current_contract_id: `contract-${index + 1}`, position: { x: index * 120, y: 100 }
  }));
  return {
    projects: [{ id: 'project-legacy', title: 'Eight node project', goal: 'Preserve all references', current_workspace_id: 'workspace-root', workflow_migration_status: 'pending', lifecycle_operation: null }],
    workflows: [{ id: 'workflow-legacy', project_id: 'project-legacy', workspace_id: 'workspace-root', title: 'Legacy workflow', status: 'active', version: 3 }],
    workflow_nodes: nodes,
    workspaces: [{ id: 'workspace-root', project_id: 'project-legacy', status: 'active' }, ...nodes.map((item) => ({ id: item.workspace_id, project_id: 'project-legacy', workflow_node_id: item.id, title: item.title, goal: item.goal, status: 'active' }))],
    node_contracts: nodes.map((item, index) => ({ id: item.current_contract_id, node_id: item.id, version: 1, node_goal: item.goal, expected_inputs: [], expected_outputs: [], acceptance_criteria: ['accepted'], required_context: [], allowed_tools: [], asset_output_types: [], status: 'confirmed' })),
    node_runs: [{ id: 'run-legacy', project_id: 'project-legacy', node_id: 'legacy-6', status: 'completed' }],
    assets: [{ id: 'asset-legacy', project_id: 'project-legacy', node_id: 'legacy-3', status: 'ready' }],
    traces: [{ id: 'trace-legacy', project_id: 'project-legacy', node_id: 'legacy-4', event_type: 'legacy.event' }],
    assist_sessions: [{ id: 'assist-legacy', version: 3, project_id: 'project-legacy', scope_type: 'node', scope_id: 'legacy-5', title: 'Legacy node thread', status: 'active', lifecycle: 'active', pinned: false, clarification_policy: 'ask' }],
    agent_sessions: [{ id: 'agent-legacy', project_id: 'project-legacy', scope_type: 'node', scope_id: 'legacy-5' }]
  };
}

function migrationCandidate(nodes) {
  const workstreams = [
    { id: 'workstream-a', role: 'workstream', parent_node_id: null, title: 'Accepted evidence package', goal: 'Accepted evidence package', outcome: 'A reviewed evidence package.', category: 'deliverable', boundary: { deliverable: 'evidence-package' }, acceptance_criteria: ['Evidence is traceable.'], dependency_ids: [], order_index: 0, plan_revision: 1 },
    { id: 'workstream-b', role: 'workstream', parent_node_id: null, title: 'Validated implementation package', goal: 'Validated implementation package', outcome: 'A validated implementation package.', category: 'deliverable', boundary: { deliverable: 'implementation-package' }, acceptance_criteria: ['Implementation evidence is accepted.'], dependency_ids: ['workstream-a'], order_index: 1, plan_revision: 1 }
  ];
  const tasks = nodes.map((node, index) => ({
    id: node.id, role: 'task', parent_node_id: index < 4 ? 'workstream-a' : 'workstream-b', title: node.title, goal: node.goal,
    outcome: null, category: null, task_kind: taskKind(node.type), execution_mode: node.type === 'execution' ? 'codex' : 'assist', boundary: null,
    acceptance_criteria: ['Legacy result remains traceable.'], required: true, dependency_ids: index && index !== 4 ? [nodes[index - 1].id] : [], order_index: index % 4, plan_revision: null
  }));
  return {
    project_classification: 'legacy_migration', decomposition_basis: 'Two independently accepted outcomes.', evidence_refs: [{ section_id: 'legacy-workflow', quote: 'Preserve all nodes.' }], confidence: 0.95, repository_intent: [],
    nodes: [...workstreams, ...tasks], legacy_mapping: tasks.map((task) => ({ legacy_node_id: task.id, task_id: task.id, workstream_id: task.parent_node_id }))
  };
}

function taskKind(type) { return ({ goal_definition: 'analysis', research: 'research', analysis: 'analysis', execution: 'code', retrospective: 'review' })[type] || 'manual'; }
function code(expected) { return (error) => error?.code === expected || error?.payload?.error === expected; }
