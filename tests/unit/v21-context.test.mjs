import assert from 'node:assert/strict';

import {
  CONTEXT_PACK_SCHEMA,
  CONTEXT_SELECTION_SCHEMA,
  buildContextSearchIndex,
  contextHash,
  createContextSelection,
  ensureContextCollections,
  reconcileContextProjectionState,
  searchContextSearchIndex
} from '../../packages/system-context/src/index.mjs';
import { prepareTaskExecutionContext } from '../../apps/api/src/task-execution-context.mjs';
import {
  ContextProjectorCoordinator,
  claimContextProjectionJobsInState
} from '../../apps/api/src/context-projector-coordinator.mjs';
import { waitForProjectionLeaseSettlement } from '../../apps/api/src/context-projection-wait.mjs';
import { emptyState } from '../../apps/api/src/state.mjs';

const selectionState = ensureContextCollections({});
const mandatory = selectableNode('mandatory', { title: '原始证据' }),
  anchor = selectableNode('anchor', { title: '当前任务' });
selectionState.context_nodes.push(anchor, mandatory);
for (const node of selectionState.context_nodes) {
  const version = selectableVersion(node, 8);
  node.current_version_id = version.id;
  selectionState.context_document_versions.push(version);
}
const selection = createContextSelection(selectionState, {
  id: 'selection-v2',
  actorId: 'owner',
  projectId: 'project',
  anchorNodeId: anchor.id,
  candidateNodeIds: [anchor.id],
  tokenBudget: 8,
  mandatoryEvidenceNodeIds: [mandatory.id],
  rubricHash: 'a'.repeat(64),
  outcomeContractHash: 'b'.repeat(64),
  retrievalPlan: { strategy: 'minisearch_graph_deterministic', query: '原始证据' },
  schemaVersion: CONTEXT_SELECTION_SCHEMA
});
assert.equal(selection.schema_version, 'aiws.context_selection.v2');
assert.deepEqual(
  selection.included.map((item) => item.node_id),
  [mandatory.id]
);
assert.deepEqual(selection.mandatory_evidence.covered_node_ids, [mandatory.id]);
assert.equal(selection.excluded.find((item) => item.node_id === anchor.id)?.reason, 'budget_exceeded');
assert.equal(selection.rubric_hash, 'a'.repeat(64));

const insufficient = createContextSelection(selectionState, {
  id: 'selection-v2-insufficient',
  actorId: 'owner',
  projectId: 'project',
  candidateNodeIds: [anchor.id],
  tokenBudget: 7,
  mandatoryEvidenceNodeIds: [mandatory.id],
  schemaVersion: CONTEXT_SELECTION_SCHEMA
});
assert.deepEqual(insufficient.mandatory_evidence.missing_node_ids, [mandatory.id]);

const search = await buildContextSearchIndex({
  nodes: [mandatory, anchor],
  documentVersions: selectionState.context_document_versions,
  edges: [],
  readDocument: async (version) =>
    version.node_id === mandatory.id ? '交付回执包含权威来源与反证记录。' : '普通任务上下文。'
});
assert.equal(searchContextSearchIndex(search.index, '权威来源')[0]?.node_id, mandatory.id);
assert.equal(searchContextSearchIndex(search.index, '交付回执')[0]?.node_id, mandatory.id);

const packState = packFixture();
const prepared = prepareTaskExecutionContext(packState, packState._input);
assert.equal(prepared.context_pack.schema_version, CONTEXT_PACK_SCHEMA);
assert.equal(prepared.context_pack.version, 5);
assert.equal(prepared.context_pack.context_selection_id, packState.context_selections[0].id);
assert.equal(prepared.context_pack.rubric_hash, packState.workflows[0].quality_rubric_hash);
assert.equal(prepared.context_pack.outcome_contract_hash, packState.workflows[0].outcome_contract_hash);
assert.deepEqual(prepared.context_pack.context_document_versions, ['version-pack-anchor']);
assert.deepEqual(prepared.context_pack.document_version_bindings, [
  {
    node_id: 'node-pack-anchor',
    document_version_id: 'version-pack-anchor',
    content_sha256: packState.context_document_versions[0].content_sha256
  }
]);
delete packState._input;

const aba = { projects: [{ id: 'project-aba', title: 'A' }] };
reconcileContextProjectionState(aba, { sourceCollections: ['projects'], timestamp: '2026-07-30T00:00:00.000Z' });
const abaNode = () =>
    aba.context_nodes.find((node) => node.source_collection === 'projects' && node.source_id === 'project-aba'),
  aHash = abaNode().source_hash;
aba.projects[0].title = 'B';
reconcileContextProjectionState(aba, { sourceCollections: ['projects'], timestamp: '2026-07-30T00:01:00.000Z' });
const bHash = abaNode().source_hash;
assert.notEqual(aHash, bHash);
aba.projects[0].title = 'A';
reconcileContextProjectionState(aba, { sourceCollections: ['projects'], timestamp: '2026-07-30T00:02:00.000Z' });
assert.equal(abaNode().source_hash, aHash);
assert.equal(
  aba.context_projection_jobs.filter((job) => job.expected_source_hash === aHash && job.status === 'pending').length,
  1
);
assert.equal(
  aba.context_projection_jobs.some((job) => job.expected_source_hash === bHash),
  false
);

const backlog = ensureContextCollections({});
for (let index = 0; index < 47; index += 1)
  backlog.context_projection_jobs.push({
    id: `job-${String(index).padStart(2, '0')}`,
    node_id: `node-${index}`,
    expected_source_hash: contextHash(index),
    status: index === 0 ? 'running' : 'pending',
    attempts: 0,
    lease:
      index === 0
        ? { holder: 'dead-worker', acquired_at: '2026-07-29T00:00:00.000Z', expires_at: '2026-07-29T00:00:30.000Z' }
        : null,
    created_at: `2026-07-30T00:00:${String(index).padStart(2, '0')}.000Z`,
    updated_at: '2026-07-30T00:00:00.000Z'
  });
const firstBatch = claimContextProjectionJobsInState(backlog, {
  holder: 'worker-1',
  batchSize: 25,
  leaseMs: 30_000,
  timestamp: '2026-07-30T01:00:00.000Z'
});
assert.equal(firstBatch.recovered, 1);
assert.equal(firstBatch.node_ids.length, 25);
assert.equal(backlog.context_projection_jobs.filter((job) => job.status === 'running').length, 25);
for (const job of backlog.context_projection_jobs.filter((item) => item.status === 'running')) {
  job.status = 'completed';
  job.lease = null;
}
const secondBatch = claimContextProjectionJobsInState(backlog, {
  holder: 'worker-1',
  batchSize: 25,
  leaseMs: 30_000,
  timestamp: '2026-07-30T01:00:31.000Z'
});
assert.equal(secondBatch.node_ids.length, 22);

const activeFailure = {
  job: { status: 'running', lease: { expires_at: new Date(Date.now() + 10_000).toISOString() } }
};
let leaseReads = 0;
const settledLease = await waitForProjectionLeaseSettlement({
  readState: async () => ({ failures: ++leaseReads < 2 ? [activeFailure] : [] }),
  collectFailures: (state) => state.failures,
  failureOptions: {},
  state: { failures: [activeFailure] },
  failures: [activeFailure],
  timeoutMs: 100,
  pollMs: 1
});
assert.equal(leaseReads, 2);
assert.deepEqual(settledLease.failures, []);

const coordinator = new ContextProjectorCoordinator({ intervalMs: 250, batchSize: 25, leaseMs: 30_000 });
try {
  const payload = {
    node: selectableNode('worker-render', { title: 'Worker recovery' }),
    record: { id: 'worker-render', status: 'ready' },
    edges: [],
    relatedNodes: []
  };
  assert.match((await coordinator.request('render', payload)).markdown, /Worker recovery/);
  coordinator.restartWorker();
  assert.match((await coordinator.request('render', payload)).markdown, /Worker recovery/);
} finally {
  await coordinator.stop();
}

console.log('V2.1 Selection v2, Context Pack v5, CJK search, lease/backlog and Worker recovery tests passed');

function selectableNode(id, patch = {}) {
  return {
    id,
    uri: `aiws://context/nodes/${id}`,
    kind: 'record',
    source_collection: 'fixtures',
    source_id: id,
    project_id: 'project',
    parent_id: null,
    title: id,
    deterministic_summary: id,
    status: 'active',
    sensitivity: 'internal',
    authority: 'authoritative',
    freshness: { status: 'current' },
    required_scopes: ['context:read', 'project:read'],
    source_hash: contextHash({ id }),
    sort: { type_order: 120, order_index: 0, stable_id: id },
    ...patch
  };
}

function selectableVersion(node, tokenEstimate) {
  return {
    id: `version-${node.id}`,
    node_id: node.id,
    source_hash: node.source_hash,
    content_sha256: contextHash(`content:${node.id}`),
    token_estimate: tokenEstimate
  };
}

function packFixture() {
  const state = emptyState();
  state.schema_version = 21;
  const project = {
      id: 'project-pack',
      title: 'Pack fixture',
      goal: 'Bind exact context versions',
      status: 'active',
      settings: { token_budget: 1000 }
    },
    workspace = { id: 'workspace-pack', project_id: project.id, workflow_node_id: 'task-pack', title: 'Task' },
    task = {
      id: 'task-pack',
      workflow_id: 'workflow-pack',
      parent_node_id: 'workstream-pack',
      workspace_id: workspace.id,
      role: 'task',
      title: 'Build fixture',
      task_kind: 'build',
      execution_revision: 1,
      current_contract_id: 'contract-pack',
      dependencies: [],
      order_index: 1
    },
    contract = {
      id: 'contract-pack',
      node_id: task.id,
      version: 1,
      expected_inputs: [],
      expected_outputs: [],
      required_context: []
    },
    workflow = {
      id: 'workflow-pack',
      project_id: project.id,
      title: 'Pack workflow',
      planning_quality: 'verified',
      workflow_revision: 1,
      outcome_contract_hash: 'c'.repeat(64),
      quality_rubric_hash: 'd'.repeat(64),
      quality_rubric: {
        schema_version: 'aiws.quality_rubric.v1',
        version: 1,
        criteria: [
          {
            id: 'not-applicable',
            title: 'Not applicable',
            evaluator: 'evidence_refs',
            mandatory: false,
            applicable: false,
            expected: null,
            authority_mapping: {}
          }
        ]
      }
    },
    workflowExecution = {
      id: 'execution-pack',
      project_id: project.id,
      workflow_id: workflow.id,
      workflow_revision: 1,
      outcome_contract_hash: workflow.outcome_contract_hash,
      quality_rubric_hash: workflow.quality_rubric_hash
    },
    taskExecution = {
      id: 'task-execution-pack',
      workflow_execution_id: workflowExecution.id,
      task_id: task.id,
      task_revision: 1,
      contract_id: contract.id,
      contract_version: 1
    },
    node = selectableNode('node-pack-anchor', {
      project_id: project.id,
      source_collection: 'workflow_nodes',
      source_id: task.id
    }),
    version = { ...selectableVersion(node, 20), id: 'version-pack-anchor' };
  node.current_version_id = version.id;
  state.projects.push(project);
  state.workspaces.push(workspace);
  state.workflows.push(workflow);
  state.workflow_nodes.push(task);
  state.node_contracts.push(contract);
  state.workflow_executions.push(workflowExecution);
  state.task_executions.push(taskExecution);
  state.context_nodes.push(node);
  state.context_document_versions.push(version);
  state._input = {
    project,
    workspace,
    workflow,
    workflowExecution,
    task,
    taskExecution,
    contract,
    actorId: 'owner',
    receiverName: 'CodexRunner'
  };
  return state;
}
