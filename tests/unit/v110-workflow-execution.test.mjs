import assert from 'node:assert/strict';

import { emptyState } from '../../apps/api/src/state.mjs';
import {
  assertTaskExecutionLease, completeTaskExecutionInState, createWorkflowExecutionInState,
  failTaskExecutionInState, issueTaskExecutionLeaseInState, reconcileWorkflowExecutionInState,
  retryTaskExecutionInState, taskExecutionReadiness, transitionTaskExecutionInState
} from '../../apps/api/src/workflow-execution-domain.mjs';
import { assertControlledProjectWrite, assertControlledTaskWrite } from '../../apps/api/src/execution-governance.mjs';
import { normalizeState19Defaults } from '../../apps/api/src/state-migration-v19.mjs';

const migrated = emptyState();
Object.assign(migrated, { migrated_to_schema_19_at: '2026-07-23T00:00:00.000Z', workflow_nodes: [{ id: 'legacy-task', role: 'task', created_at: '2026-07-22T00:00:00.000Z' }, { id: 'managed-task', role: 'task', created_at: '2026-07-24T00:00:00.000Z' }] });
normalizeState19Defaults(migrated, '2026-07-23T01:00:00.000Z');
assert.equal(migrated.workflow_nodes[0].execution_evidence_status, 'external_unverified');
assert.equal(migrated.workflow_nodes[1].execution_evidence_status, 'managed');

const state = fixture();
assert.throws(() => assertControlledTaskWrite(state, 'task-a', {}, 'node_run'), (error) => error.payload?.error === 'workflow_execution_required');
assert.throws(() => assertControlledProjectWrite(state, { projectId: 'project-1', operation: 'pull_request_intent' }), (error) => error.payload?.error === 'workflow_execution_required');
const created = createWorkflowExecutionInState(state, 'workflow-1', { operation_key: 'start-1' }, 'owner');
assert.equal(created.workflow_execution.workflow_revision, 3);
assert.equal(created.task_executions.some((item) => item.task_id === 'task-legacy'), false);
assert.equal(created.task_executions.filter((item) => item.status === 'queued').length, 2);
const join = created.task_executions.find((item) => item.task_id === 'task-join');
assert.equal(join.status, 'pending');
assert.equal(taskExecutionReadiness(state, join).reasons.filter((item) => item.code === 'task_dependency_waiting').length, 2);

const first = created.task_executions.find((item) => item.task_id === 'task-a');
const lease = issueTaskExecutionLeaseInState(state, first.id, { holder: 'unit', ttlMs: 60_000 });
assert.equal(first.status, 'running');
assert.throws(() => assertTaskExecutionLease(state, { taskExecutionId: first.id, leaseToken: 'wrong', taskId: first.task_id }), (error) => error.payload?.error === 'task_execution_lease_invalid');
assert.equal(assertTaskExecutionLease(state, { taskExecutionId: first.id, leaseToken: lease.lease_token, taskId: first.task_id }).execution.id, first.id);
transitionTaskExecutionInState(state, first, 'verifying');
completeTaskExecutionInState(state, first.id);
assert.deepEqual(first.readiness, { ready: true, reasons: [], checked_at: first.readiness.checked_at });

const second = created.task_executions.find((item) => item.task_id === 'task-b');
transitionTaskExecutionInState(state, second, 'running');
transitionTaskExecutionInState(state, second, 'verifying');
completeTaskExecutionInState(state, second.id);
reconcileWorkflowExecutionInState(state, created.workflow_execution.id);
assert.equal(join.status, 'queued');
failTaskExecutionInState(state, join.id, { errorCode: 'manual_conflict', retryClass: 'deterministic' });
const retry = retryTaskExecutionInState(state, join.id, 'owner');
assert.equal(retry.attempt, 2);
assert.equal(retry.supersedes_id, join.id);
assert.equal(join.status, 'superseded');
assert.equal(retry.status, 'queued');

const transientState = fixture(), transientWorkflow = createWorkflowExecutionInState(transientState, 'workflow-1', {}, 'owner');
const transientFirst = transientWorkflow.task_executions.find((item) => item.task_id === 'task-a');
failTaskExecutionInState(transientState, transientFirst.id, { errorCode: 'runner_timeout', retryClass: 'transient' });
const transientSecond = retryTaskExecutionInState(transientState, transientFirst.id, null);
failTaskExecutionInState(transientState, transientSecond.id, { errorCode: 'runner_timeout', retryClass: 'transient' });
assert.throws(() => retryTaskExecutionInState(transientState, transientSecond.id, null), (error) => error.payload?.error === 'task_execution_auto_retry_exhausted');
const explicitRetry = retryTaskExecutionInState(transientState, transientSecond.id, 'owner');
assert.equal(explicitRetry.attempt, 3);
assert.equal(explicitRetry.retry_input_snapshot_hash, null);

const duplicate = createWorkflowExecutionInState(state, 'workflow-1', { operation_key: 'start-1' }, 'owner');
assert.equal(duplicate.idempotent, true);
const stale = fixture(), staleCreated = createWorkflowExecutionInState(stale, 'workflow-1', {}, 'owner');
stale.workflow_nodes.find((item) => item.id === 'task-a').execution_revision = 2;
const staleTask = staleCreated.task_executions.find((item) => item.task_id === 'task-a');
assert.throws(() => issueTaskExecutionLeaseInState(stale, staleTask.id), (error) => error.payload?.error === 'task_execution_revision_superseded');
console.log('V1.10 workflow readiness, lease, retry, and revision isolation unit tests passed');

function fixture() {
  const value = emptyState();
  value.projects.push({ id: 'project-1', title: 'DAG', deleted_at: null });
  value.workflows.push({ id: 'workflow-1', project_id: 'project-1', workflow_revision: 3, planning_quality: 'verified' });
  value.workflow_nodes.push(
    { id: 'workstream-1', workflow_id: 'workflow-1', role: 'workstream', title: 'Delivery', dependencies: [], order_index: 0 },
    { ...task('task-legacy', [], 0), execution_evidence_status: 'external_unverified' },
    task('task-a', [], 1), task('task-b', [], 2), task('task-join', ['task-a', 'task-b'], 3)
  );
  value.node_contracts.push(...['legacy', 'a', 'b', 'join'].map((name) => ({ id: `contract-${name}`, node_id: `task-${name}`, version: 1, expected_inputs: [], expected_outputs: [] })));
  return value;
}

function task(id, dependencies, order) { const suffix = id.replace('task-', ''); return { id, workflow_id: 'workflow-1', parent_node_id: 'workstream-1', role: 'task', title: id, task_kind: 'manual', execution_mode: 'manual', execution_revision: 1, current_contract_id: `contract-${suffix}`, dependencies: dependencies.map((node_id) => ({ node_id, type: 'finish_to_start' })), order_index: order }; }
