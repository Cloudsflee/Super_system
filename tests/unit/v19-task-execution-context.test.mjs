import assert from 'node:assert/strict';

import { emptyState } from '../../apps/api/src/state.mjs';
import { contextPackToMarkdown } from '../../packages/shared/index.mjs';
import {
  evaluateTaskExecutionContextFreshness,
  executionInputHash,
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
assert.equal(nodeRun.context_pack.schema_version, 'aiws.context_pack.v4');
assert.equal(nodeRun.context_pack.version, 4);
assert.equal(nodeRun.context_pack.content_json.schema_version, 'aiws.context_pack.v4');
assert.equal(nodeRun.context_pack.context_selection_id, nodeRun.context_pack.content_json.context_selection_id);
assert.ok(state.context_selections.some((item) => item.id === nodeRun.context_pack.context_selection_id));
assert.equal(nodeRun.context.schema_version, 'aiws.task_execution_context.v2');
assert.equal(nodeRun.context.system_context.context_selection_id, nodeRun.context_pack.context_selection_id);
assert.match(nodeRun.context.system_context.context_map.uri, /^aiws:\/\/context\/map\/projects\//);
assert.equal(nodeRun.context.system_context.retrieval_protocol.tool, 'aiws_context');
assert.match(contextPackToMarkdown(nodeRun.context_pack), /"system_context"/);
assert.equal(nodeRun.context.input_snapshot_hash, delivery.context.input_snapshot_hash);
assert.equal(nodeRun.context.input_snapshot_hash_version, 2);
assert.equal(nodeRun.context.repository_snapshot.snapshot_hash, delivery.context.repository_snapshot.snapshot_hash);
const relocatedContext = structuredClone(nodeRun.context);
relocatedContext.repository_snapshot.managed_path = '/different/runtime/path';
for (const input of relocatedContext.inputs)
  if (input.repository_snapshot) input.repository_snapshot.managed_path = '/different/runtime/path';
assert.equal(executionInputHash(relocatedContext), nodeRun.context.input_snapshot_hash);
relocatedContext.repository_snapshot.fixed_sha = 'f'.repeat(40);
assert.notEqual(executionInputHash(relocatedContext), nodeRun.context.input_snapshot_hash);
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
assert.equal(nodeRun.context.workstream_digest, null);
assert.equal(nodeRun.context_pack.content_json.latest_digest, null);
assert.equal(nodeRun.context.project_brief, null);
assert.deepEqual(nodeRun.context.project_decisions, []);

const requiredContextState = fixture(),
  requiredContextScope = {
    ...scope,
    project: requiredContextState.projects[0],
    workflow: requiredContextState.workflows[0],
    workspace: requiredContextState.workspaces.find((item) => item.id === 'workspace-task-2'),
    task: requiredContextState.workflow_nodes.find((item) => item.id === 'task-2'),
    contract: structuredClone(requiredContextState.node_contracts[0])
  };
requiredContextScope.contract.expected_inputs.push({
  key: 'project_brief',
  kind: 'context',
  required: true,
  source: 'brief',
  selector: 'current',
  ref_id: null,
  version_id: null
});
requiredContextState.context_nodes.push({
  id: 'context-brief',
  uri: 'aiws://context/nodes/context-brief',
  kind: 'record',
  source_collection: 'project_briefs',
  source_id: 'brief-1',
  source_hash: 'brief-source-1',
  current_version_id: 'context-document-brief-1',
  project_id: 'project-1',
  parent_id: null,
  status: 'active',
  sensitivity: 'internal',
  authority: 'authoritative',
  freshness: { status: 'current' },
  required_scopes: [],
  sort: { type_order: 1, order_index: 0, stable_id: 'brief-1' }
});
requiredContextState.context_document_versions.push({
  id: 'context-document-brief-1',
  node_id: 'context-brief',
  source_hash: 'brief-source-1',
  content_sha256: '8'.repeat(64),
  token_estimate: 20
});
const requiredContextPrepared = prepareTaskExecutionContext(requiredContextState, requiredContextScope),
  requiredBriefDocument = requiredContextPrepared.context.system_context.document_versions.find(
    (item) => item.source_collection === 'project_briefs'
  );
assert.equal(requiredBriefDocument.required, true);
requiredContextState.context_nodes.find((item) => item.id === 'context-brief').current_version_id =
  'context-document-brief-2';
assert.equal(
  evaluateTaskExecutionContextFreshness(requiredContextState, requiredContextPrepared.context).reasons.some(
    (item) => item.code === 'required_context_document_superseded'
  ),
  true
);

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

const cross = crossWorkstreamFixture(),
  crossPrepared = prepareTaskExecutionContext(cross.state, cross.scope),
  outcomeInput = crossPrepared.context.inputs.find((item) => item.key === 'source_outcome');
assert.equal(outcomeInput.resolved_from.kind, 'workstream_outcome');
assert.equal(outcomeInput.resolved_from.workflow_execution_id, 'workflow-execution-current');
assert.deepEqual(
  outcomeInput.asset_versions.map((item) => item.version_id),
  ['version-terminal-deliverable']
);
assert.deepEqual(outcomeInput.resolved_from.selected_output_keys, ['terminal_deliverable']);
assert.deepEqual(outcomeInput.resolved_from.selected_outputs, [
  {
    output_key: 'terminal_deliverable',
    asset_id: 'asset-terminal-deliverable',
    version_id: 'version-terminal-deliverable',
    asset_type: 'DecisionAsset',
    producer_task_id: 'task-cross-source-terminal',
    producer_task_title: 'Publish terminal deliverable',
    producer_task_execution_id: 'task-execution-source-terminal'
  }
]);
assert.equal(
  outcomeInput.asset_versions.some((item) => item.version_id === 'version-outcome-old'),
  false
);
const crossSelection = cross.state.context_selections.find(
  (item) => item.id === crossPrepared.context.system_context.context_selection_id
);
assert.equal(
  crossSelection.included.find((item) => item.node_id === 'context-terminal-version').reason,
  'explicit_reference'
);
assert.equal(crossSelection.candidate_node_ids.includes('context-unrelated'), false);
const multiOutput = crossWorkstreamFixture();
multiOutput.state.asset_attestations
  .find((item) => item.id === 'attestation-outcome-current')
  .evidence.handoff_output_bindings.push({
    key: 'unselected_export',
    asset_id: 'asset-unselected-export',
    version_id: 'version-unselected-export',
    producer_task_id: 'task-cross-source-terminal',
    producer_task_execution_id: 'task-execution-source-terminal'
  });
assert.deepEqual(
  prepareTaskExecutionContext(multiOutput.state, multiOutput.scope).context.inputs[0].asset_versions.map(
    (item) => item.version_id
  ),
  ['version-terminal-deliverable']
);
const optionalOutput = crossWorkstreamFixture();
optionalOutput.scope.contract.expected_inputs[0].selector = 'required_outputs';
optionalOutput.state.asset_attestations
  .find((item) => item.id === 'attestation-outcome-current')
  .evidence.handoff_output_bindings.push({
    key: 'optional_export',
    asset_id: 'asset-optional-export',
    version_id: 'version-optional-export',
    required: false
  });
assert.deepEqual(
  prepareTaskExecutionContext(optionalOutput.state, optionalOutput.scope).context.inputs[0].asset_versions.map(
    (item) => item.version_id
  ),
  ['version-terminal-deliverable']
);
const fanIn = addSecondWorkstreamHandoff(crossWorkstreamFixture()),
  fanInPrepared = prepareTaskExecutionContext(fanIn.state, fanIn.scope);
assert.deepEqual(
  fanInPrepared.context.inputs.map((input) => input.asset_versions.map((item) => item.version_id)),
  [['version-terminal-deliverable'], ['version-second-deliverable']]
);
assert.equal(
  fanInPrepared.context.inputs.every(
    (input) => input.resolved_from.workflow_execution_id === 'workflow-execution-current'
  ),
  true
);
const changedHandoff = structuredClone(cross.state);
changedHandoff.asset_attestations.find((item) => item.id === 'attestation-outcome-current').decision = 'rejected';
assert.equal(
  evaluateTaskExecutionContextFreshness(changedHandoff, crossPrepared.context).reasons.some(
    (item) => item.code === 'workstream_handoff_changed'
  ),
  true
);
const ambiguousHandoff = crossWorkstreamFixture();
ambiguousHandoff.state.asset_attestations
  .find((item) => item.id === 'attestation-outcome-current')
  .evidence.handoff_output_bindings.push({
    key: 'terminal_deliverable',
    asset_id: 'asset-terminal-duplicate',
    version_id: 'version-terminal-duplicate',
    producer_task_id: 'task-cross-source-other',
    producer_task_execution_id: 'task-execution-source-other'
  });
assert.throws(
  () => prepareTaskExecutionContext(ambiguousHandoff.state, ambiguousHandoff.scope),
  notReady('workstream_dependency_selector_ambiguous')
);
const receiptAsInput = crossWorkstreamFixture();
receiptAsInput.scope.contract.expected_inputs[0].selector = 'workstream_outcome';
assert.throws(
  () => prepareTaskExecutionContext(receiptAsInput.state, receiptAsInput.scope),
  notReady('workstream_outcome_not_consumable')
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

function crossWorkstreamFixture() {
  const value = emptyState(),
    terminalBinding = {
      key: 'terminal_deliverable',
      asset_id: 'asset-terminal-deliverable',
      version_id: 'version-terminal-deliverable',
      asset_type: 'DecisionAsset',
      content_sha256: '1'.repeat(64),
      attestation_id: 'attestation-terminal-deliverable',
      producer_task_id: 'task-cross-source-terminal',
      producer_task_execution_id: 'task-execution-source-terminal'
    };
  const project = {
      id: 'project-cross',
      title: 'Cross workstream handoff',
      goal: 'Consume an accepted upstream outcome',
      current_workspace_id: 'workspace-cross-root',
      settings: { token_budget: 12000 }
    },
    workflow = {
      id: 'workflow-cross',
      project_id: project.id,
      planning_quality: 'verified',
      workflow_revision: 1
    },
    task = {
      id: 'task-cross-target',
      workflow_id: workflow.id,
      workspace_id: 'workspace-cross-target',
      parent_node_id: 'workstream-target',
      role: 'task',
      title: 'Consume upstream outcome',
      goal: 'Use the exact accepted deliverable',
      task_kind: 'manual',
      execution_mode: 'manual',
      status: 'ready',
      execution_revision: 1,
      current_contract_id: 'contract-cross-target',
      dependencies: []
    },
    contract = {
      id: task.current_contract_id,
      node_id: task.id,
      version: 1,
      node_goal: task.goal,
      expected_inputs: [
        {
          key: 'source_outcome',
          kind: 'asset_version',
          required: true,
          source: 'workstream_dependency',
          selector: 'terminal_deliverable',
          ref_id: 'workstream-source',
          version_id: null
        }
      ],
      expected_outputs: [
        {
          key: 'target_result',
          kind: 'asset',
          required: true,
          asset_type: 'DecisionAsset',
          acceptance_criteria: ['Target result accepted'],
          confirmation_policy: 'human'
        }
      ],
      acceptance_criteria: ['Target result accepted'],
      allowed_tools: ['assist']
    },
    workflowExecution = {
      id: 'workflow-execution-current',
      project_id: project.id,
      workflow_id: workflow.id,
      workflow_revision: 1,
      status: 'running'
    },
    taskExecution = {
      id: 'task-execution-target',
      workflow_execution_id: workflowExecution.id,
      project_id: project.id,
      workflow_id: workflow.id,
      workstream_id: task.parent_node_id,
      task_id: task.id,
      task_revision: 1,
      contract_id: contract.id,
      contract_version: 1,
      status: 'queued'
    };
  value.projects.push(project);
  value.workflows.push(workflow);
  value.workspaces.push(
    { id: 'workspace-cross-root', project_id: project.id, title: 'Project' },
    { id: task.workspace_id, project_id: project.id, workflow_node_id: task.id, title: task.title }
  );
  value.workflow_nodes.push(
    {
      id: 'workstream-source',
      workflow_id: workflow.id,
      role: 'workstream',
      title: 'Accepted source outcome',
      dependencies: []
    },
    {
      id: 'workstream-target',
      workflow_id: workflow.id,
      role: 'workstream',
      title: 'Target outcome',
      dependencies: [{ node_id: 'workstream-source', type: 'finish_to_start' }]
    },
    {
      id: 'task-cross-source-terminal',
      workflow_id: workflow.id,
      parent_node_id: 'workstream-source',
      role: 'task',
      title: 'Publish terminal deliverable',
      dependencies: []
    },
    task
  );
  value.node_contracts.push(contract);
  value.workflow_executions.push(workflowExecution);
  value.task_executions.push(taskExecution);
  value.assets.push(
    {
      id: terminalBinding.asset_id,
      project_id: project.id,
      node_id: 'task-cross-source-terminal',
      asset_type: terminalBinding.asset_type,
      output_key: terminalBinding.key,
      title: 'Terminal deliverable',
      status: 'confirmed',
      current_version_id: terminalBinding.version_id
    },
    crossOutcomeAsset(project.id, 'old', 'workflow-execution-old'),
    crossOutcomeAsset(project.id, 'current', workflowExecution.id)
  );
  value.asset_versions.push(
    crossVersion(
      terminalBinding.version_id,
      terminalBinding.asset_id,
      terminalBinding.content_sha256,
      'Terminal deliverable'
    ),
    crossVersion('version-outcome-old', 'asset-outcome-old', '2'.repeat(64), 'Old outcome'),
    crossVersion('version-outcome-current', 'asset-outcome-current', '3'.repeat(64), 'Current outcome')
  );
  addCrossContextDocuments(value, project.id, terminalBinding.version_id);
  value.asset_attestations.push(
    {
      id: terminalBinding.attestation_id,
      asset_version_id: terminalBinding.version_id,
      decision: 'accepted',
      attestor_type: 'human'
    },
    crossOutcomeAttestation('old', 'workflow-execution-old', terminalBinding),
    crossOutcomeAttestation('current', workflowExecution.id, terminalBinding)
  );
  return {
    state: value,
    scope: { project, workflow, workspace: value.workspaces[1], task, contract, taskExecution, workflowExecution }
  };
}

function addCrossContextDocuments(state, projectId, terminalVersionId) {
  const nodes = [
    {
      id: 'context-terminal-version',
      kind: 'asset_version',
      source_collection: 'asset_versions',
      source_id: terminalVersionId,
      title: 'Terminal deliverable version',
      source_hash: 'context-source-terminal',
      current_version_id: 'context-document-terminal',
      order_index: 0
    },
    {
      id: 'context-unrelated',
      kind: 'record',
      source_collection: 'decisions',
      source_id: 'unrelated-decision',
      title: 'Unrelated decision',
      source_hash: 'context-source-unrelated',
      current_version_id: 'context-document-unrelated',
      order_index: 1
    }
  ];
  for (const node of nodes)
    state.context_nodes.push({
      ...node,
      uri: `aiws://context/nodes/${node.id}`,
      project_id: projectId,
      parent_id: null,
      status: 'active',
      sensitivity: 'internal',
      authority: 'authoritative',
      freshness: { status: 'current' },
      required_scopes: [],
      sort: { type_order: 1, order_index: node.order_index, stable_id: node.source_id }
    });
  state.context_document_versions.push(
    {
      id: 'context-document-terminal',
      node_id: 'context-terminal-version',
      source_hash: 'context-source-terminal',
      content_sha256: '4'.repeat(64),
      token_estimate: 30
    },
    {
      id: 'context-document-unrelated',
      node_id: 'context-unrelated',
      source_hash: 'context-source-unrelated',
      content_sha256: '5'.repeat(64),
      token_estimate: 30
    }
  );
}

function crossOutcomeAsset(projectId, suffix, workflowExecutionId) {
  return {
    id: `asset-outcome-${suffix}`,
    project_id: projectId,
    node_id: 'workstream-source',
    asset_type: 'WorkstreamOutcomeAsset',
    output_key: 'workstream_outcome',
    title: `${suffix} outcome`,
    status: 'confirmed',
    current_version_id: `version-outcome-${suffix}`,
    provenance_workflow_execution_id: workflowExecutionId,
    created_at: suffix === 'old' ? '2026-07-20T00:00:00.000Z' : '2026-07-21T00:00:00.000Z'
  };
}

function addSecondWorkstreamHandoff(fixture) {
  const { state, scope } = fixture,
    binding = {
      key: 'second_deliverable',
      asset_id: 'asset-second-deliverable',
      version_id: 'version-second-deliverable',
      asset_type: 'DecisionAsset',
      content_sha256: '6'.repeat(64),
      producer_task_id: 'task-cross-source-second-terminal',
      producer_task_execution_id: 'task-execution-source-second-terminal'
    };
  state.workflow_nodes.push(
    {
      id: 'workstream-source-second',
      workflow_id: scope.workflow.id,
      role: 'workstream',
      title: 'Second accepted source outcome',
      dependencies: []
    },
    {
      id: binding.producer_task_id,
      workflow_id: scope.workflow.id,
      parent_node_id: 'workstream-source-second',
      role: 'task',
      title: 'Publish second deliverable',
      dependencies: []
    }
  );
  state.workflow_nodes
    .find((item) => item.id === 'workstream-target')
    .dependencies.push({ node_id: 'workstream-source-second', type: 'finish_to_start' });
  scope.contract.expected_inputs.push({
    key: 'second_outcome',
    kind: 'asset_version',
    required: true,
    source: 'workstream_dependency',
    selector: binding.key,
    ref_id: 'workstream-source-second',
    version_id: null
  });
  state.assets.push(
    {
      id: binding.asset_id,
      project_id: scope.project.id,
      node_id: binding.producer_task_id,
      asset_type: binding.asset_type,
      output_key: binding.key,
      title: 'Second terminal deliverable',
      status: 'confirmed',
      current_version_id: binding.version_id
    },
    {
      id: 'asset-outcome-second',
      project_id: scope.project.id,
      node_id: 'workstream-source-second',
      asset_type: 'WorkstreamOutcomeAsset',
      output_key: 'workstream_outcome',
      title: 'Second outcome',
      status: 'confirmed',
      current_version_id: 'version-outcome-second',
      provenance_workflow_execution_id: scope.workflowExecution.id,
      created_at: '2026-07-21T00:00:00.000Z'
    }
  );
  state.asset_versions.push(
    crossVersion(binding.version_id, binding.asset_id, binding.content_sha256, 'Second terminal deliverable'),
    crossVersion('version-outcome-second', 'asset-outcome-second', '7'.repeat(64), 'Second outcome')
  );
  state.asset_attestations.push({
    id: 'attestation-outcome-second',
    asset_version_id: 'version-outcome-second',
    decision: 'accepted',
    attestor_type: 'trusted_verifier',
    evidence: {
      workflow_execution_id: scope.workflowExecution.id,
      handoff_output_bindings: [binding],
      terminal_output_bindings: [binding]
    }
  });
  return fixture;
}

function crossOutcomeAttestation(suffix, workflowExecutionId, binding) {
  return {
    id: `attestation-outcome-${suffix}`,
    asset_version_id: `version-outcome-${suffix}`,
    decision: 'accepted',
    attestor_type: 'trusted_verifier',
    evidence: {
      workflow_execution_id: workflowExecutionId,
      handoff_output_bindings: [binding],
      terminal_output_bindings: [binding]
    }
  };
}

function crossVersion(id, assetId, contentSha256, title) {
  return {
    id,
    asset_id: assetId,
    title,
    summary: title,
    verification_status: 'verified',
    immutable: true,
    content_sha256: contentSha256,
    payload_kind: 'json',
    media_type: 'application/json',
    size_bytes: 20,
    blob_refs: [],
    manifest: {}
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
