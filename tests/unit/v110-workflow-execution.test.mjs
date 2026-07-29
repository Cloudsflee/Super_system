import assert from 'node:assert/strict';

import { emptyState } from '../../apps/api/src/state.mjs';
import {
  assertTaskExecutionLease,
  completeTaskExecutionInState,
  createWorkflowExecutionInState,
  failTaskExecutionInState,
  issueTaskExecutionLeaseInState,
  reconcileWorkflowExecutionInState,
  retryTaskExecutionInState,
  taskExecutionReadiness,
  transitionTaskExecutionInState
} from '../../apps/api/src/workflow-execution-domain.mjs';
import { assertControlledProjectWrite, assertControlledTaskWrite } from '../../apps/api/src/execution-governance.mjs';
import { normalizeState19Defaults } from '../../apps/api/src/state-migration-v19.mjs';
import { authoritativeWorkstreamStatus } from '../../apps/api/src/workflow-execution-projection.mjs';

assert.equal(authoritativeWorkstreamStatus({ status: 'needs_review' }), 'needs_review');
assert.equal(authoritativeWorkstreamStatus({ status: 'completed' }), 'completed');
assert.equal(
  authoritativeWorkstreamStatus({
    status: 'ready_for_submission',
    latest_submission_id: 'submission-1',
    reviewed_at: '2026-07-28T00:00:00.000Z',
    review: { decision: 'approve' }
  }),
  'completed'
);
assert.equal(
  authoritativeWorkstreamStatus({
    status: 'ready',
    latest_submission_id: null,
    reviewed_at: null,
    review: { decision: 'approve' }
  }),
  null
);

const migrated = emptyState();
Object.assign(migrated, {
  migrated_to_schema_19_at: '2026-07-23T00:00:00.000Z',
  workflow_nodes: [
    { id: 'legacy-task', role: 'task', created_at: '2026-07-22T00:00:00.000Z' },
    { id: 'managed-task', role: 'task', created_at: '2026-07-24T00:00:00.000Z' }
  ]
});
normalizeState19Defaults(migrated, '2026-07-23T01:00:00.000Z');
assert.equal(migrated.workflow_nodes[0].execution_evidence_status, 'external_unverified');
assert.equal(migrated.workflow_nodes[1].execution_evidence_status, 'managed');

const state = fixture();
assert.throws(
  () => assertControlledTaskWrite(state, 'task-a', {}, 'node_run'),
  (error) => error.payload?.error === 'workflow_execution_required'
);
assert.throws(
  () => assertControlledProjectWrite(state, { projectId: 'project-1', operation: 'pull_request_intent' }),
  (error) => error.payload?.error === 'workflow_execution_required'
);
const created = createWorkflowExecutionInState(state, 'workflow-1', { operation_key: 'start-1' }, 'owner');
assert.equal(created.workflow_execution.workflow_revision, 3);
assert.equal(
  created.task_executions.some((item) => item.task_id === 'task-legacy'),
  false
);
assert.equal(created.task_executions.filter((item) => item.status === 'queued').length, 2);
const join = created.task_executions.find((item) => item.task_id === 'task-join');
assert.equal(join.status, 'pending');
assert.equal(
  taskExecutionReadiness(state, join).reasons.filter((item) => item.code === 'task_dependency_waiting').length,
  2
);

const first = created.task_executions.find((item) => item.task_id === 'task-a');
const lease = issueTaskExecutionLeaseInState(state, first.id, { holder: 'unit', ttlMs: 60_000 });
assert.equal(first.status, 'running');
assert.throws(
  () => assertTaskExecutionLease(state, { taskExecutionId: first.id, leaseToken: 'wrong', taskId: first.task_id }),
  (error) => error.payload?.error === 'task_execution_lease_invalid'
);
assert.equal(
  assertTaskExecutionLease(state, { taskExecutionId: first.id, leaseToken: lease.lease_token, taskId: first.task_id })
    .execution.id,
  first.id
);
transitionTaskExecutionInState(state, first, 'verifying');
completeTaskExecutionInState(state, first.id);
assert.equal(first.readiness.ready, true);
assert.deepEqual(first.readiness.reasons, []);
assert.equal(first.readiness.handoff.schema_version, 'aiws.task_handoff_diagnostics.v1');
assert.equal(first.readiness.handoff.handoff_status, 'ready');

const second = created.task_executions.find((item) => item.task_id === 'task-b');
transitionTaskExecutionInState(state, second, 'running');
transitionTaskExecutionInState(state, second, 'verifying');
completeTaskExecutionInState(state, second.id);
reconcileWorkflowExecutionInState(state, created.workflow_execution.id);
assert.equal(join.status, 'queued');
failTaskExecutionInState(state, join.id, { errorCode: 'manual_conflict', retryClass: 'deterministic' });
join.input_snapshot_hash = 'f'.repeat(64);
join.input_snapshot_hash_version = 2;
const retry = retryTaskExecutionInState(state, join.id, 'owner');
assert.equal(retry.attempt, 2);
assert.equal(retry.supersedes_id, join.id);
assert.equal(join.status, 'superseded');
assert.equal(retry.status, 'queued');
assert.equal(retry.retry_input_snapshot_hash, 'f'.repeat(64));
assert.equal(retry.retry_input_snapshot_hash_version, 2);

const transientState = fixture(),
  transientWorkflow = createWorkflowExecutionInState(transientState, 'workflow-1', {}, 'owner');
const transientFirst = transientWorkflow.task_executions.find((item) => item.task_id === 'task-a');
failTaskExecutionInState(transientState, transientFirst.id, { errorCode: 'runner_timeout', retryClass: 'transient' });
const transientSecond = retryTaskExecutionInState(transientState, transientFirst.id, null);
failTaskExecutionInState(transientState, transientSecond.id, { errorCode: 'runner_timeout', retryClass: 'transient' });
assert.throws(
  () => retryTaskExecutionInState(transientState, transientSecond.id, null),
  (error) => error.payload?.error === 'task_execution_auto_retry_exhausted'
);
const explicitRetry = retryTaskExecutionInState(transientState, transientSecond.id, 'owner');
assert.equal(explicitRetry.attempt, 3);
assert.equal(explicitRetry.retry_input_snapshot_hash, null);

const deployState = fixture(),
  deployTask = deployState.workflow_nodes.find((item) => item.id === 'task-a');
Object.assign(deployTask, { task_kind: 'deploy', execution_mode: 'codex' });
const deployRun = createWorkflowExecutionInState(deployState, 'workflow-1', {}, 'owner'),
  deployExecution = deployRun.task_executions.find((item) => item.task_id === deployTask.id);
assert.equal(deployExecution.executor, 'assist');
Object.assign(deployExecution, {
  executor: 'repository_integrate',
  input_snapshot_hash: 'e'.repeat(64),
  input_snapshot_hash_version: 3
});
failTaskExecutionInState(deployState, deployExecution.id, {
  errorCode: 'pull_request_intent_no_changes',
  retryClass: 'deterministic'
});
const deployRetry = retryTaskExecutionInState(deployState, deployExecution.id, 'owner');
assert.equal(deployRetry.executor, 'assist');
assert.equal(deployRetry.executor_reclassified_from, 'repository_integrate');
assert.equal(deployRetry.retry_input_snapshot_hash, null);
assert.equal(deployRetry.retry_input_snapshot_hash_version, null);

const midIntegrationState = fixture(),
  midIntegrationTask = midIntegrationState.workflow_nodes.find((item) => item.id === 'task-join'),
  downstreamTask = task('task-after-integration', ['task-join'], 4);
Object.assign(midIntegrationTask, { task_kind: 'integration', execution_mode: 'codex' });
midIntegrationState.workflow_nodes.push(downstreamTask);
midIntegrationState.node_contracts.push({
  id: 'contract-after-integration',
  node_id: downstreamTask.id,
  version: 1,
  expected_inputs: [],
  expected_outputs: []
});
const midIntegrationRun = createWorkflowExecutionInState(midIntegrationState, 'workflow-1', {}, 'owner'),
  midIntegration = midIntegrationRun.task_executions.find((item) => item.task_id === 'task-join'),
  downstream = midIntegrationRun.task_executions.find((item) => item.task_id === downstreamTask.id),
  upstream = midIntegrationRun.task_executions.find((item) => item.task_id === 'task-a'),
  initialIntegrationWait = taskExecutionReadiness(midIntegrationState, midIntegration).reasons.find(
    (item) => item.code === 'workstream_tasks_incomplete'
  );
assert.ok(initialIntegrationWait.task_execution_ids.includes(upstream.id));
assert.equal(initialIntegrationWait.task_execution_ids.includes(downstream.id), false);
for (const taskId of ['task-a', 'task-b']) {
  const execution = midIntegrationRun.task_executions.find((item) => item.task_id === taskId);
  transitionTaskExecutionInState(midIntegrationState, execution, 'running');
  transitionTaskExecutionInState(midIntegrationState, execution, 'verifying');
  completeTaskExecutionInState(midIntegrationState, execution.id);
}
assert.equal(
  taskExecutionReadiness(midIntegrationState, midIntegration).reasons.some(
    (item) => item.code === 'workstream_tasks_incomplete'
  ),
  false
);

const duplicate = createWorkflowExecutionInState(state, 'workflow-1', { operation_key: 'start-1' }, 'owner');
assert.equal(duplicate.idempotent, true);
const localized = fixture();
localized.workflow_nodes.find((item) => item.id === 'workstream-1').title = '每日设计信号产品';
localized.repository_connections.push({
  id: 'connection-localized',
  project_id: 'project-1',
  repository_id: 'repository-localized',
  sync_status: 'ready'
});
const localizedRun = createWorkflowExecutionInState(
    localized,
    'workflow-1',
    {
      repositories: [
        {
          workstream_id: 'workstream-1',
          connection_id: 'connection-localized',
          base_ref: 'main',
          base_sha: 'a'.repeat(40)
        }
      ]
    },
    'owner'
  ),
  localizedBranch = localizedRun.repository_lines[0].branch;
assert.match(localizedBranch, /^aiws\/workstream-1-[a-f0-9]{8}$/);
assert.match(localizedBranch, /^[A-Za-z0-9._/-]+$/);
const stale = fixture(),
  staleCreated = createWorkflowExecutionInState(stale, 'workflow-1', {}, 'owner');
stale.workflow_nodes.find((item) => item.id === 'task-a').execution_revision = 2;
const staleTask = staleCreated.task_executions.find((item) => item.task_id === 'task-a');
assert.throws(
  () => issueTaskExecutionLeaseInState(stale, staleTask.id),
  (error) => error.payload?.error === 'task_execution_revision_superseded'
);

const resumed = fixture(),
  continuationTask = {
    ...task('task-continuation', ['task-join'], 4),
    execution_evidence_status: 'external_unverified'
  };
resumed.workflow_nodes.push(continuationTask);
resumed.node_contracts.push({
  id: 'contract-continuation',
  node_id: continuationTask.id,
  version: 1,
  expected_inputs: [],
  expected_outputs: []
});
const resumeRun = createWorkflowExecutionInState(resumed, 'workflow-1', {}, 'owner');
assert.equal(
  resumeRun.task_executions.some((item) => item.task_id === continuationTask.id),
  false
);
for (const taskId of ['task-a', 'task-b']) {
  const execution = resumeRun.task_executions.find((item) => item.task_id === taskId);
  transitionTaskExecutionInState(resumed, execution, 'running');
  transitionTaskExecutionInState(resumed, execution, 'verifying');
  completeTaskExecutionInState(resumed, execution.id);
}
reconcileWorkflowExecutionInState(resumed, resumeRun.workflow_execution.id);
const failedJoin = resumeRun.task_executions.find((item) => item.task_id === 'task-join');
Object.assign(failedJoin, {
  input_snapshot_hash: '3'.repeat(64),
  evidence: { source: 'legacy_execution_promotion' },
  context_snapshot: {
    repository_snapshot: {
      repository_line_id: 'repository-line-1',
      fixed_sha: '7'.repeat(40)
    }
  }
});
resumed.repository_lines.push({
  id: 'repository-line-1',
  workflow_execution_id: resumeRun.workflow_execution.id,
  workstream_id: failedJoin.workstream_id,
  head_sha: '7'.repeat(40),
  checkout_path: null,
  status: 'active'
});
failTaskExecutionInState(resumed, failedJoin.id, { errorCode: 'legacy_partial', retryClass: 'deterministic' });
Object.assign(resumeRun.workflow_execution, {
  status: 'failed',
  completed_at: '2026-07-27T00:00:00.000Z'
});
const resumedRetry = retryTaskExecutionInState(resumed, failedJoin.id, 'owner'),
  enrolled = resumed.task_executions.find(
    (item) => item.workflow_execution_id === resumeRun.workflow_execution.id && item.task_id === continuationTask.id
  ),
  reopened = resumed.execution_events.find((item) => item.type === 'workflow.reopened');
assert.equal(resumeRun.workflow_execution.status, 'running');
assert.equal(resumeRun.workflow_execution.completed_at, null);
assert.equal(resumedRetry.status, 'queued');
assert.equal(resumedRetry.retry_input_snapshot_hash, null);
assert.equal(enrolled.status, 'pending');
assert.equal(continuationTask.execution_evidence_status, 'managed');
assert.deepEqual(reopened.data.continuation_task_ids, [continuationTask.id]);
const repositoryLine = resumed.repository_lines[0];
Object.assign(repositoryLine, { head_sha: 'd'.repeat(40), checkout_path: '/stale/checkout' });
resumedRetry.retry_input_snapshot_hash = '3'.repeat(64);
const repeatedRetry = retryTaskExecutionInState(resumed, failedJoin.id, 'owner');
assert.equal(repeatedRetry.id, resumedRetry.id);
assert.equal(repeatedRetry.retry_input_snapshot_hash, null);
assert.equal(repositoryLine.head_sha, '7'.repeat(40));
assert.equal(repositoryLine.checkout_path, null);
assert.equal(resumed.task_executions.filter((item) => item.supersedes_id === failedJoin.id).length, 1);
assert.ok(resumed.execution_events.some((item) => item.type === 'repository_line.retry_head_restored'));
resumeRun.workflow_execution.executor_config = { runner: 'history_promotion' };
resumedRetry.input_snapshot_hash = '8'.repeat(64);
resumedRetry.input_snapshot_hash_version = 1;
issueTaskExecutionLeaseInState(resumed, resumedRetry.id, { holder: 'dispatcher:assist' });
const recoveredRetry = retryTaskExecutionInState(resumed, failedJoin.id, 'owner');
assert.notEqual(recoveredRetry.id, resumedRetry.id);
assert.equal(recoveredRetry.attempt, 3);
assert.equal(recoveredRetry.supersedes_id, resumedRetry.id);
assert.equal(recoveredRetry.retry_input_snapshot_hash, '8'.repeat(64));
assert.equal(recoveredRetry.retry_input_snapshot_hash_version, 1);
assert.equal(resumedRetry.status, 'superseded');
assert.equal(resumeRun.workflow_execution.status, 'running');
assert.equal(resumeRun.workflow_execution.executor_config.runner, undefined);
assert.ok(resumed.execution_events.some((item) => item.type === 'workflow.legacy_runner_recovered'));
console.log('V1.10 workflow readiness, lease, retry, and revision isolation unit tests passed');

function fixture() {
  const value = emptyState();
  value.projects.push({ id: 'project-1', title: 'DAG', deleted_at: null });
  value.workflows.push({
    id: 'workflow-1',
    project_id: 'project-1',
    workflow_revision: 3,
    planning_quality: 'verified'
  });
  value.workflow_nodes.push(
    {
      id: 'workstream-1',
      workflow_id: 'workflow-1',
      role: 'workstream',
      title: 'Delivery',
      dependencies: [],
      order_index: 0
    },
    { ...task('task-legacy', [], 0), execution_evidence_status: 'external_unverified' },
    task('task-a', [], 1),
    task('task-b', [], 2),
    task('task-join', ['task-a', 'task-b'], 3)
  );
  value.node_contracts.push(
    ...['legacy', 'a', 'b', 'join'].map((name) => ({
      id: `contract-${name}`,
      node_id: `task-${name}`,
      version: 1,
      expected_inputs: [],
      expected_outputs: []
    }))
  );
  return value;
}

function task(id, dependencies, order) {
  const suffix = id.replace('task-', '');
  return {
    id,
    workflow_id: 'workflow-1',
    parent_node_id: 'workstream-1',
    role: 'task',
    title: id,
    task_kind: 'manual',
    execution_mode: 'manual',
    execution_revision: 1,
    current_contract_id: `contract-${suffix}`,
    dependencies: dependencies.map((node_id) => ({ node_id, type: 'finish_to_start' })),
    order_index: order
  };
}
