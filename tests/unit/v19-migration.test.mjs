import assert from 'node:assert/strict';

import { hashString } from '../../packages/shared/index.mjs';
import { migrateState16To17 } from '../../apps/api/src/state-migration-v17.mjs';
import { migrateState17To18, validateState18, V18_COLLECTIONS } from '../../apps/api/src/state-migration-v18.mjs';
import { purgeProjectInState } from '../../apps/api/src/state-purge.mjs';
import {
  applyLegacyWorkflowMigrationInState,
  validateLegacyMigrationMapping
} from '../../apps/api/src/workflow-migration-service.mjs';

const v17 = migrateState16To17({ schema_version: 12 }).state;
Object.assign(v17, legacyState());
const migrated = migrateState17To18(v17, { timestamp: '2026-07-18T00:00:00.000Z' });
assert.equal(migrated.state.schema_version, 18);
assert.equal(migrated.state.workflows[0].hierarchy_mode, 'legacy');
assert.equal(migrated.state.workflows[0].legacy_read_only, true);
assert.equal(
  migrated.state.workflow_nodes.every((item) => item.role === 'task' && item.legacy_read_only),
  true
);
assert.equal(migrated.state.assist_sessions[0].scope_status, 'legacy_read_only');
assert.equal(migrated.state.assist_sessions[0].read_only, true);
for (const collection of V18_COLLECTIONS) assert.ok(Array.isArray(migrated.state[collection]), collection);
validateState18(migrated.state);

const state = migrated.state;
const legacyNodeIds = state.workflow_nodes.map((item) => item.id);
const legacyWorkspaceIds = state.workflow_nodes.map((item) => item.workspace_id);
const legacyContractIds = state.workflow_nodes.map((item) => item.current_contract_id);
const referenceIds = {
  runs: state.node_runs.map((item) => item.id),
  assets: state.assets.map((item) => item.id),
  traces: state.traces.map((item) => item.id),
  assist: state.assist_sessions.map((item) => item.id)
};
const candidate = migrationCandidate(state.workflow_nodes);
assert.equal(validateLegacyMigrationMapping(state.workflow_nodes, candidate), true);
assert.throws(
  () =>
    validateLegacyMigrationMapping(state.workflow_nodes, {
      ...candidate,
      legacy_mapping: candidate.legacy_mapping.slice(1)
    }),
  code('workflow_migration_mapping_not_bijective')
);

const beforeFailedAttempt = JSON.stringify(state);
assert.throws(
  () => applyLegacyWorkflowMigrationInState(state, 'workflow-legacy', candidate, 'owner', { before_hash: 'wrong' }),
  code('workflow_migration_source_changed')
);
assert.equal(
  JSON.stringify(state),
  beforeFailedAttempt,
  'failed precondition does not partially mutate the legacy workflow'
);

const result = applyLegacyWorkflowMigrationInState(state, 'workflow-legacy', candidate, 'owner', {
  before_hash: hashString(JSON.stringify(state.workflow_nodes))
});
assert.equal(result.task_ids.length, 8);
assert.deepEqual(new Set(result.task_ids), new Set(legacyNodeIds));
assert.equal(result.workstream_ids.length, 2);
assert.equal(state.workflows[0].hierarchy_mode, 'two_level');
assert.equal(state.workflows[0].legacy_read_only, false);
assert.deepEqual(
  state.workflow_nodes.filter((item) => item.role === 'task').map((item) => item.workspace_id),
  legacyWorkspaceIds
);
assert.deepEqual(
  state.workflow_nodes.filter((item) => item.role === 'task').map((item) => item.current_contract_id),
  legacyContractIds
);
assert.deepEqual(
  state.node_runs.map((item) => item.id),
  referenceIds.runs
);
assert.deepEqual(
  state.assets.map((item) => item.id),
  referenceIds.assets
);
assert.deepEqual(
  state.traces.map((item) => item.id),
  referenceIds.traces
);
assert.deepEqual(
  state.assist_sessions.map((item) => item.id),
  referenceIds.assist
);
assert.equal(state.assist_sessions[0].scope_type, 'task');
assert.equal(state.assist_sessions[0].scope_status, 'active');
assert.equal(
  state.workflow_nodes.filter((item) => item.role === 'task').every((item) => item.migrated_from_legacy),
  true
);

const purgeState = structuredClone(state);
purgeState.projects.push({ id: 'project-other', title: 'Retained Project', current_workspace_id: 'workspace-other' });
purgeState.workspaces.push({ id: 'workspace-other', project_id: 'project-other' });
purgeState.workflows.push({ id: 'workflow-other', project_id: 'project-other', workspace_id: 'workspace-other' });
purgeState.workflow_migration_batches.push(
  {
    id: 'batch-exclusive',
    project_ids: ['project-legacy'],
    workflow_ids: ['workflow-legacy'],
    status: 'completed_with_failures'
  },
  {
    id: 'batch-shared',
    project_ids: ['project-legacy', 'project-other'],
    workflow_ids: ['workflow-legacy', 'workflow-other'],
    status: 'pending_approval'
  }
);
purgeState.workflow_migration_jobs.push(
  { id: 'job-exclusive', batch_id: 'batch-exclusive', project_id: 'project-legacy', workflow_id: 'workflow-legacy' },
  { id: 'job-shared-deleted', batch_id: 'batch-shared', project_id: 'project-legacy', workflow_id: 'workflow-legacy' },
  { id: 'job-shared-retained', batch_id: 'batch-shared', project_id: 'project-other', workflow_id: 'workflow-other' }
);
purgeState.mcp_clients.push(
  { id: 'mcp-exclusive', project_allowlist: ['project-legacy'] },
  { id: 'mcp-shared', project_allowlist: ['project-legacy', 'project-other'] },
  { id: 'mcp-global', project_allowlist: [] }
);
purgeState.assist_sessions.push({
  id: 'assist-legacy-wizard',
  target_type: 'project_wizard',
  target_id: 'project-legacy'
});
purgeState.assist_messages.push({ id: 'message-legacy-wizard', session_id: 'assist-legacy-wizard' });
purgeState.traces.push(
  { id: 'trace-mcp-deleted', target_type: 'mcp_client', target_id: 'mcp-exclusive', summary: 'Project-scoped client' },
  {
    id: 'trace-migration-deleted',
    target_type: 'workflow_migration_job',
    target_id: 'job-exclusive',
    summary: 'Legacy migration'
  }
);
purgeState.exchange_requests.push({
  id: 'exchange-deleted',
  source_project_id: 'project-legacy',
  target_project_id: 'project-other'
});
purgeState.exchange_grants.push({ id: 'grant-deleted', exchange_request_id: 'exchange-deleted' });
purgeState.context_packs.push({
  id: 'exchange-pack-deleted',
  exchange_request_id: 'exchange-deleted',
  exchange_grant_id: 'grant-deleted'
});
purgeState.legacy_project_allowlist_compat = ['project-legacy', 'project-other'];
purgeProjectInState(purgeState, 'project-legacy');
assert.equal(
  JSON.stringify(purgeState).includes('project-legacy'),
  false,
  'Project purge removes all legacy V1.9 references'
);
assert.equal(
  purgeState.workflow_migration_batches.some((item) => item.id === 'batch-exclusive'),
  false
);
assert.deepEqual(purgeState.workflow_migration_batches.find((item) => item.id === 'batch-shared')?.project_ids, [
  'project-other'
]);
assert.deepEqual(purgeState.workflow_migration_batches.find((item) => item.id === 'batch-shared')?.workflow_ids, [
  'workflow-other'
]);
assert.deepEqual(
  purgeState.workflow_migration_jobs.map((item) => item.id),
  ['job-shared-retained']
);
assert.equal(
  purgeState.mcp_clients.some((item) => item.id === 'mcp-exclusive'),
  false
);
assert.deepEqual(purgeState.mcp_clients.find((item) => item.id === 'mcp-shared')?.project_allowlist, ['project-other']);
assert.equal(
  purgeState.mcp_clients.some((item) => item.id === 'mcp-global'),
  true
);
assert.equal(
  purgeState.traces.some((item) => item.id === 'trace-mcp-deleted'),
  false
);
assert.equal(
  purgeState.traces.some((item) => item.id === 'trace-migration-deleted'),
  false
);
assert.equal(
  purgeState.assist_sessions.some((item) => item.id === 'assist-legacy-wizard'),
  false
);
assert.equal(
  purgeState.assist_messages.some((item) => item.id === 'message-legacy-wizard'),
  false
);
assert.equal(
  purgeState.exchange_requests.some((item) => item.id === 'exchange-deleted'),
  false
);
assert.equal(
  purgeState.exchange_grants.some((item) => item.id === 'grant-deleted'),
  false
);
assert.equal(
  purgeState.context_packs.some((item) => item.id === 'exchange-pack-deleted'),
  false
);
assert.deepEqual(purgeState.legacy_project_allowlist_compat, ['project-other']);

const legacyPurgeState = structuredClone(state);
for (const collection of [
  'exchange_requests',
  'exchange_grants',
  'workflow_migration_batches',
  'workflow_migration_jobs',
  'mcp_clients'
])
  delete legacyPurgeState[collection];
purgeProjectInState(legacyPurgeState, 'project-legacy');
assert.equal(
  legacyPurgeState.projects.some((item) => item.id === 'project-legacy'),
  false,
  'pre-V1.9 states can be purged without optional collections'
);

console.log('V1.9 state and semantic workflow migration unit tests passed');

function legacyState() {
  const nodes = Array.from({ length: 8 }, (_, index) => ({
    id: `legacy-${index + 1}`,
    workflow_id: 'workflow-legacy',
    workspace_id: `workspace-${index + 1}`,
    type:
      index === 0
        ? 'goal_definition'
        : index < 3
          ? 'research'
          : index < 5
            ? 'analysis'
            : index === 7
              ? 'retrospective'
              : 'execution',
    title: `Legacy step ${index + 1}`,
    goal: `Complete legacy step ${index + 1}`,
    status: index === 0 ? 'completed' : 'ready',
    order_index: index,
    dependencies: index ? [{ node_id: `legacy-${index}`, type: 'finish_to_start' }] : [],
    current_contract_id: `contract-${index + 1}`,
    position: { x: index * 120, y: 100 }
  }));
  return {
    projects: [
      {
        id: 'project-legacy',
        title: 'Eight node project',
        goal: 'Preserve all references',
        current_workspace_id: 'workspace-root',
        workflow_migration_status: 'pending',
        lifecycle_operation: null
      }
    ],
    workflows: [
      {
        id: 'workflow-legacy',
        project_id: 'project-legacy',
        workspace_id: 'workspace-root',
        title: 'Legacy workflow',
        status: 'active',
        version: 3
      }
    ],
    workflow_nodes: nodes,
    workspaces: [
      { id: 'workspace-root', project_id: 'project-legacy', status: 'active' },
      ...nodes.map((item) => ({
        id: item.workspace_id,
        project_id: 'project-legacy',
        workflow_node_id: item.id,
        title: item.title,
        goal: item.goal,
        status: 'active'
      }))
    ],
    node_contracts: nodes.map((item, index) => ({
      id: item.current_contract_id,
      node_id: item.id,
      version: 1,
      node_goal: item.goal,
      expected_inputs: [],
      expected_outputs: [],
      acceptance_criteria: ['accepted'],
      required_context: [],
      allowed_tools: [],
      asset_output_types: [],
      status: 'confirmed'
    })),
    node_runs: [{ id: 'run-legacy', project_id: 'project-legacy', node_id: 'legacy-6', status: 'completed' }],
    assets: [{ id: 'asset-legacy', project_id: 'project-legacy', node_id: 'legacy-3', status: 'ready' }],
    traces: [{ id: 'trace-legacy', project_id: 'project-legacy', node_id: 'legacy-4', event_type: 'legacy.event' }],
    assist_sessions: [
      {
        id: 'assist-legacy',
        version: 3,
        project_id: 'project-legacy',
        scope_type: 'node',
        scope_id: 'legacy-5',
        title: 'Legacy node thread',
        status: 'active',
        lifecycle: 'active',
        pinned: false,
        clarification_policy: 'ask'
      }
    ],
    agent_sessions: [{ id: 'agent-legacy', project_id: 'project-legacy', scope_type: 'node', scope_id: 'legacy-5' }]
  };
}

function migrationCandidate(nodes) {
  const workstreams = [
    {
      id: 'workstream-a',
      role: 'workstream',
      parent_node_id: null,
      title: 'Accepted evidence package',
      goal: 'Accepted evidence package',
      outcome: 'A reviewed evidence package.',
      category: 'deliverable',
      boundary: { deliverable: 'evidence-package' },
      acceptance_criteria: ['Evidence is traceable.'],
      dependency_ids: [],
      order_index: 0,
      plan_revision: 1
    },
    {
      id: 'workstream-b',
      role: 'workstream',
      parent_node_id: null,
      title: 'Validated implementation package',
      goal: 'Validated implementation package',
      outcome: 'A validated implementation package.',
      category: 'deliverable',
      boundary: { deliverable: 'implementation-package' },
      acceptance_criteria: ['Implementation evidence is accepted.'],
      dependency_ids: ['workstream-a'],
      order_index: 1,
      plan_revision: 1
    }
  ];
  const tasks = nodes.map((node, index) => ({
    id: node.id,
    role: 'task',
    parent_node_id: index < 4 ? 'workstream-a' : 'workstream-b',
    title: node.title,
    goal: node.goal,
    outcome: null,
    category: null,
    task_kind: taskKind(node.type),
    execution_mode: node.type === 'execution' ? 'codex' : 'assist',
    boundary: null,
    acceptance_criteria: ['Legacy result remains traceable.'],
    required: true,
    dependency_ids: index && index !== 4 ? [nodes[index - 1].id] : [],
    order_index: index % 4,
    plan_revision: null
  }));
  return {
    project_classification: 'legacy_migration',
    decomposition_basis: 'Two independently accepted outcomes.',
    evidence_refs: [{ section_id: 'legacy-workflow', quote: 'Preserve all nodes.' }],
    confidence: 0.95,
    repository_intent: [],
    nodes: [...workstreams, ...tasks],
    legacy_mapping: tasks.map((task) => ({
      legacy_node_id: task.id,
      task_id: task.id,
      workstream_id: task.parent_node_id
    }))
  };
}

function taskKind(type) {
  return (
    {
      goal_definition: 'analysis',
      research: 'research',
      analysis: 'analysis',
      execution: 'code',
      retrospective: 'review'
    }[type] || 'manual'
  );
}
function code(expected) {
  return (error) => error?.code === expected || error?.payload?.error === expected;
}
