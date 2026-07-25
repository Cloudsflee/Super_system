import assert from 'node:assert/strict';

import { emptyState } from '../../apps/api/src/state.mjs';
import {
  evaluateTaskExecutionContextFreshness,
  prepareTaskExecutionContext
} from '../../apps/api/src/task-execution-context.mjs';
import {
  createExecutionOutputAssets,
  recordAssetLineage,
  validateTaskOutputBindings
} from '../../apps/api/src/task-output-service.mjs';

const state = fixture();
const scope = {
  actor: { id: 'owner' },
  project: state.projects[0],
  workflow: state.workflows[0],
  workspace: state.workspaces.find((item) => item.id === 'workspace-task-2'),
  task: state.workflow_nodes.find((item) => item.id === 'task-2'),
  contract: state.node_contracts[0],
  repositoryWorkspaceId: 'repository-workspace-1'
};

const nodeRun = prepareTaskExecutionContext(state, { ...scope, purpose: 'node_run', receiverName: 'CodexRunner' });
const delivery = prepareTaskExecutionContext(state, { ...scope, purpose: 'delivery', receiverName: 'CodexRunner' });
assert.equal(nodeRun.context.schema_version, 'aiws.task_execution_context.v2');
assert.equal(nodeRun.context.input_snapshot_hash, delivery.context.input_snapshot_hash);
assert.equal(nodeRun.context.repository_snapshot.snapshot_hash, delivery.context.repository_snapshot.snapshot_hash);
assert.deepEqual(
  nodeRun.context.inputs.flatMap((item) => item.asset_versions || []).map((item) => item.version_id),
  ['version-upstream-1']
);
assert.deepEqual(
  nodeRun.context_pack.content_json.confirmed_assets.map((item) => item.id),
  ['asset-upstream']
);
assert.equal(nodeRun.context_pack.content_json.submissions.length, 0);
assert.equal(nodeRun.context_pack.memory_manifest.policy.sibling_context_included, false);

const missing = structuredClone(state);
missing.submissions = [];
assert.throws(() => prepareTaskExecutionContext(missing, scope), notReady('dependency_output_binding_missing'));
const legacy = legacyFixture();
const legacyPrepared = prepareTaskExecutionContext(legacy.state, legacy.scope);
const legacyInput = legacyPrepared.context.inputs.find((item) => item.key === 'upstream');
assert.equal(legacyInput.representation, 'legacy_accepted_dependency');
assert.equal(legacyInput.legacy_compatibility, true);
assert.equal(legacyInput.legacy_accepted_dependency.delivery.commit_sha, 'a'.repeat(40));
assert.match(legacyInput.legacy_accepted_dependency.snapshot_hash, /^[a-f0-9]{64}$/);
assert.deepEqual(
  legacyPrepared.context.inputs.flatMap((item) => item.asset_versions || []),
  []
);
assert.equal(evaluateTaskExecutionContextFreshness(legacy.state, legacyPrepared.context).current, true);
legacy.state.deliveries[0].test_results[0].status = 'failed';
assert.equal(
  evaluateTaskExecutionContextFreshness(legacy.state, legacyPrepared.context).reasons[0].code,
  'legacy_dependency_acceptance_changed'
);
const staleRepository = structuredClone(state);
staleRepository.repository_workspaces[0].stale = true;
staleRepository.repository_workspaces[0].sync_status = 'stale';
assert.throws(() => prepareTaskExecutionContext(staleRepository, scope), notReady('repository_workspace_stale'));
const mismatchedVersion = structuredClone(state),
  mismatchedScope = {
    ...scope,
    project: mismatchedVersion.projects[0],
    workflow: mismatchedVersion.workflows[0],
    workspace: mismatchedVersion.workspaces.find((item) => item.id === 'workspace-task-2'),
    task: mismatchedVersion.workflow_nodes.find((item) => item.id === 'task-2'),
    contract: structuredClone(scope.contract)
  };
mismatchedScope.contract.expected_inputs[0].selector = 'repository_version';
mismatchedVersion.asset_versions.find((item) => item.id === 'version-upstream-extra').repository_sha = 'c'.repeat(40);
assert.throws(
  () => prepareTaskExecutionContext(mismatchedVersion, mismatchedScope),
  notReady('repository_snapshot_version_mismatch')
);

const execution = {
  id: 'delivery-1',
  operation_id: 'delivery-operation-1',
  contract_snapshot: scope.contract,
  task_execution_context: nodeRun.context,
  input_snapshot_hash: nodeRun.context.input_snapshot_hash,
  commit_sha: 'b'.repeat(40),
  test_results: [{ name: 'test', status: 'passed' }],
  input_superseded: false
};
const produced = createExecutionOutputAssets(state, {
  actorId: 'owner',
  project: scope.project,
  task: scope.task,
  workspace: scope.workspace,
  execution,
  candidates: [
    {
      output_key: 'code_change',
      asset_type: 'CodeChangeAsset',
      title: 'Accepted code',
      summary: 'Fixed SHA code change'
    },
    { output_key: 'decision_record', asset_type: 'DecisionAsset', title: 'Decision record', summary: 'Human decision' }
  ]
});
assert.deepEqual(
  produced.assets.map((item) => item.status),
  ['confirmed', 'candidate']
);
assert.deepEqual(
  produced.bindings.map((item) => item.key),
  ['code_change']
);
assert.equal(state.asset_relations.length, 1);
assert.equal(state.asset_relations[0].relation_type, 'derived_from');
assert.equal(state.asset_relations[0].source_asset_version_id, 'version-upstream-1');
assert.throws(
  () =>
    validateTaskOutputBindings(state, {
      task: scope.task,
      contract: scope.contract,
      bindings: produced.bindings,
      projectId: scope.project.id
    }),
  outputNotReady('required_output_binding_missing')
);

const decisionAsset = produced.assets.find((item) => item.output_key === 'decision_record');
decisionAsset.status = 'confirmed';
const decisionVersion = state.asset_versions.find((item) => item.asset_id === decisionAsset.id);
const allBindings = [
  ...produced.bindings,
  {
    key: 'decision_record',
    asset_id: decisionAsset.id,
    version_id: decisionVersion.id,
    asset_type: decisionAsset.asset_type,
    acceptance_criteria: ['Decision accepted']
  }
];
const accepted = validateTaskOutputBindings(state, {
  task: scope.task,
  contract: scope.contract,
  bindings: allBindings,
  projectId: scope.project.id
});
assert.equal(accepted.errors.length, 0);
recordAssetLineage(state, nodeRun.context, accepted.bindings, execution.id);
assert.equal(state.asset_relations.length, 2);

state.asset_versions.push({
  id: 'version-upstream-2',
  asset_id: 'asset-upstream',
  title: 'Upstream v2',
  summary: 'Replaced input'
});
state.assets.find((item) => item.id === 'asset-upstream').current_version_id = 'version-upstream-2';
const superseded = evaluateTaskExecutionContextFreshness(state, nodeRun.context);
assert.equal(superseded.current, false);
assert.equal(
  superseded.reasons.some((item) => item.code === 'input_asset_version_superseded'),
  true
);

console.log('V1.9 Task execution context and typed asset tests passed');

function fixture() {
  const value = emptyState();
  value.projects.push({
    id: 'project-1',
    title: 'Typed delivery',
    goal: 'Deliver verified assets',
    current_workspace_id: 'workspace-root',
    default_repository_workspace_id: 'repository-workspace-1',
    settings: { token_budget: 12000 }
  });
  value.workspaces.push(
    { id: 'workspace-root', project_id: 'project-1', title: 'Project', status: 'active' },
    {
      id: 'workspace-workstream',
      project_id: 'project-1',
      workflow_node_id: 'workstream-1',
      title: 'Outcome',
      status: 'active'
    },
    {
      id: 'workspace-task-1',
      project_id: 'project-1',
      workflow_node_id: 'task-1',
      title: 'Evidence',
      status: 'active'
    },
    { id: 'workspace-task-2', project_id: 'project-1', workflow_node_id: 'task-2', title: 'Delivery', status: 'active' }
  );
  value.workflows.push({
    id: 'workflow-1',
    project_id: 'project-1',
    workspace_id: 'workspace-root',
    status: 'active',
    planning_quality: 'verified'
  });
  value.workflow_nodes.push(
    {
      id: 'workstream-1',
      workflow_id: 'workflow-1',
      workspace_id: 'workspace-workstream',
      role: 'workstream',
      title: 'Outcome',
      status: 'running',
      dependencies: []
    },
    {
      id: 'task-1',
      workflow_id: 'workflow-1',
      workspace_id: 'workspace-task-1',
      role: 'task',
      parent_node_id: 'workstream-1',
      title: 'Evidence',
      goal: 'Prepare evidence',
      status: 'completed',
      execution_revision: 1,
      dependencies: [],
      latest_submission_id: 'submission-1'
    },
    {
      id: 'task-2',
      workflow_id: 'workflow-1',
      workspace_id: 'workspace-task-2',
      role: 'task',
      parent_node_id: 'workstream-1',
      title: 'Delivery',
      goal: 'Deliver from evidence',
      task_kind: 'code',
      execution_mode: 'codex',
      capability_tags: ['execution'],
      acceptance_criteria: ['Code accepted', 'Decision accepted'],
      status: 'ready',
      execution_revision: 1,
      dependencies: [{ node_id: 'task-1', type: 'finish_to_start' }]
    }
  );
  value.node_contracts.push(contract());
  value.project_briefs.push({
    id: 'brief-1',
    project_id: 'project-1',
    version: 1,
    revision: 1,
    status: 'confirmed',
    content: { summary: 'Verified delivery brief' }
  });
  value.digests.push({
    id: 'digest-1',
    workspace_id: 'workspace-workstream',
    version: 1,
    status: 'confirmed',
    summary: 'Accepted upstream evidence'
  });
  value.decisions.push({
    id: 'decision-1',
    project_id: 'project-1',
    status: 'confirmed',
    title: 'Delivery decision',
    summary: 'Use fixed inputs'
  });
  value.assets.push(
    {
      id: 'asset-upstream',
      project_id: 'project-1',
      workspace_id: 'workspace-task-1',
      node_id: 'task-1',
      asset_type: 'ResearchEvidenceAsset',
      title: 'Upstream evidence',
      status: 'confirmed',
      current_version_id: 'version-upstream-1'
    },
    {
      id: 'asset-upstream-extra',
      project_id: 'project-1',
      workspace_id: 'workspace-task-1',
      node_id: 'task-1',
      asset_type: 'RepositoryVersionAsset',
      title: 'Upstream repository',
      status: 'confirmed',
      current_version_id: 'version-upstream-extra'
    },
    {
      id: 'asset-sibling',
      project_id: 'project-1',
      workspace_id: 'workspace-task-1',
      node_id: 'sibling-task',
      asset_type: 'DecisionAsset',
      title: 'Unrelated sibling',
      status: 'confirmed',
      current_version_id: 'version-sibling-1'
    }
  );
  value.asset_versions.push(
    {
      id: 'version-upstream-1',
      asset_id: 'asset-upstream',
      title: 'Upstream v1',
      summary: 'Immutable accepted evidence',
      evidence_refs: ['review:1']
    },
    {
      id: 'version-upstream-extra',
      asset_id: 'asset-upstream-extra',
      repository_sha: 'a'.repeat(40),
      title: 'Repository v1',
      summary: 'Must be filtered by selector'
    },
    { id: 'version-sibling-1', asset_id: 'asset-sibling', title: 'Sibling v1', summary: 'Must stay excluded' }
  );
  value.submissions.push({
    id: 'submission-1',
    project_id: 'project-1',
    node_id: 'task-1',
    status: 'accepted',
    output_bindings: [
      { key: 'research_result', asset_id: 'asset-upstream', version_id: 'version-upstream-1' },
      { key: 'repository_version', asset_id: 'asset-upstream-extra', version_id: 'version-upstream-extra' }
    ],
    created_at: '2026-07-21T00:00:00.000Z'
  });
  value.repository_workspaces.push({
    id: 'repository-workspace-1',
    project_id: 'project-1',
    connection_id: 'connection-1',
    ref: 'main',
    fixed_sha: 'a'.repeat(40),
    current_sha: 'a'.repeat(40),
    mode: 'read_write',
    scope: { type: 'project', id: 'project-1', path_prefixes: ['.'] },
    managed_path: 'C:/managed/repository-workspace-1',
    status: 'active',
    sync_status: 'ready',
    stale: false
  });
  return value;
}

function contract() {
  return {
    id: 'contract-2',
    node_id: 'task-2',
    version: 1,
    contract_schema_version: 2,
    node_goal: 'Deliver from evidence',
    expected_inputs: [
      {
        key: 'upstream',
        kind: 'asset_version',
        required: true,
        source: 'dependency',
        selector: 'research_result',
        ref_id: 'task-1',
        version_id: null
      },
      {
        key: 'repository',
        kind: 'repository',
        required: true,
        source: 'repository_workspace',
        selector: 'fixed_sha',
        ref_id: null,
        version_id: null
      }
    ],
    expected_outputs: [
      {
        key: 'code_change',
        kind: 'asset',
        required: true,
        asset_type: 'CodeChangeAsset',
        acceptance_criteria: ['Code accepted'],
        confirmation_policy: 'system_evidence'
      },
      {
        key: 'decision_record',
        kind: 'asset',
        required: true,
        asset_type: 'DecisionAsset',
        acceptance_criteria: ['Decision accepted'],
        confirmation_policy: 'human'
      }
    ],
    acceptance_criteria: ['Code accepted', 'Decision accepted'],
    allowed_tools: ['codex_runner']
  };
}

function legacyFixture() {
  const value = fixture();
  value.node_contracts[0].expected_inputs[0].selector = 'required_outputs';
  value.assets = value.assets.filter((item) => item.node_id !== 'task-1');
  value.asset_versions = value.asset_versions.filter((item) =>
    value.assets.some((asset) => asset.id === item.asset_id)
  );
  value.submissions[0].output_bindings = [];
  Object.assign(
    value.workflow_nodes.find((item) => item.id === 'task-1'),
    {
      review: { decision: 'approve', summary: 'Accepted before typed outputs existed' },
      reviewed_at: '2026-07-20T00:05:00.000Z'
    }
  );
  value.deliveries.push({
    id: 'delivery-legacy-1',
    project_id: 'project-1',
    task_id: 'task-1',
    status: 'completed',
    commit_sha: 'a'.repeat(40),
    pr_url: 'https://example.test/pull/1',
    pr_state: 'draft',
    test_results: [{ command: 'node --test', status: 'passed', exit_code: 0 }],
    completed_at: '2026-07-20T00:04:00.000Z'
  });
  return {
    state: value,
    scope: {
      actor: { id: 'owner' },
      project: value.projects[0],
      workflow: value.workflows[0],
      workspace: value.workspaces.find((item) => item.id === 'workspace-task-2'),
      task: value.workflow_nodes.find((item) => item.id === 'task-2'),
      contract: value.node_contracts[0],
      repositoryWorkspaceId: 'repository-workspace-1'
    }
  };
}

function notReady(reason) {
  return (error) =>
    error?.payload?.error === 'task_context_not_ready' && error.payload.reasons.some((item) => item.code === reason);
}
function outputNotReady(reason) {
  return (error) =>
    error?.payload?.error === 'task_outputs_not_ready' && error.payload.reasons.some((item) => item.code === reason);
}
