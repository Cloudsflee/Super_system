import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { randomUUID } from 'node:crypto';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { projectWorkflowExecutionStateInState } from './workflow-execution-projection.mjs';
import { taskHandoffDiagnostics } from './task-handoff.mjs';
import { assertRequiredContributionAuthority } from './task-contribution-authority.mjs';
import { executorForTask, normalizeWorkflowExecutorConfig } from './workflow-executor-config.mjs';
import { dependencyIds } from './workflow-graph-validation.mjs';
import {
  activeTaskExecutionForTask,
  assertExecutionRevisionCurrent,
  assertIntegrationEvidence,
  bindingIsConsumable,
  byNewest,
  byOrder,
  clean,
  createRepositoryLinesInState,
  currentTaskExecutions,
  executionEvidence,
  latestExecutionForTask,
  normalizeRepositorySelection,
  pendingTaskExecution,
  queueCapacityAvailable,
  releaseRepositoryCapacity,
  repositoryLinesFor,
  requireTaskExecution,
  requireWorkflowExecution,
  requiresRepositoryLine,
  restoreLegacyRetryRepositoryLine,
  reserveRepositoryCapacity,
  taskExecutionsFor,
  taskOrder,
  workflowDefinitionSnapshot,
  appendExecutionEvent,
  workflowExecutionSnapshot as snapshot
} from './workflow-execution-support.mjs';
import { taskExecutionReadiness } from './workflow-execution-readiness.mjs';
import {
  ACTIVE_WORKFLOW_EXECUTION_STATUSES,
  TASK_EXECUTION_STATUSES,
  TERMINAL_TASK_EXECUTION_STATUSES
} from './workflow-execution-status.mjs';
import { failureEnvelope, parseFailureEnvelope } from '../../../packages/execution-protocol/src/index.mjs';
import { materializeOutcomeRequirementsInState } from './outcome-service.mjs';
import {
  isLegacyStrandedRetry,
  legacyPromotedExecution,
  retryInputExpectation,
  sanitizeLegacyExecutorConfig
} from './workflow-retry-compatibility.mjs';
import { requireWorkflowExecutionProtocols } from './workflow-execution-protocols.mjs';
export { integrationEvidenceFor } from './workflow-integration-evidence.mjs';
export { taskExecutionReadiness } from './workflow-execution-readiness.mjs';
export {
  appendExecutionEvent,
  activeTaskExecutionForTask,
  currentTaskExecutions,
  requireTaskExecution,
  requireWorkflowExecution
} from './workflow-execution-support.mjs';
export {
  ACTIVE_WORKFLOW_EXECUTION_STATUSES,
  TASK_EXECUTION_STATUSES,
  TERMINAL_TASK_EXECUTION_STATUSES
} from './workflow-execution-status.mjs';

export { projectWorkflowExecutionStateInState } from './workflow-execution-projection.mjs';
const TERMINAL = new Set(TERMINAL_TASK_EXECUTION_STATUSES);
const TRANSITIONS = Object.freeze({
  pending: new Set(['ready', 'cancelled', 'superseded']),
  ready: new Set(['queued', 'pending', 'cancelled', 'superseded']),
  queued: new Set(['running', 'pending', 'failed', 'cancelled', 'superseded']),
  running: new Set(['verifying', 'awaiting_human', 'failed', 'cancelled', 'superseded']),
  verifying: new Set(['awaiting_human', 'completed', 'failed', 'cancelled', 'superseded']),
  awaiting_human: new Set(['verifying', 'completed', 'failed', 'cancelled', 'superseded']),
  completed: new Set(['superseded']),
  failed: new Set(['superseded']),
  cancelled: new Set(['superseded']),
  superseded: new Set()
});
export function createWorkflowExecutionInState(state, workflowId, input = {}, actorId) {
  const workflow = state.workflows.find((item) => item.id === workflowId && !item.legacy_read_only);
  const project = state.projects.find((item) => item.id === workflow?.project_id && !item.deleted_at);
  if (!workflow || !project) throw new HttpError(404, { error: 'workflow_not_found' });
  if (workflow.planning_quality !== 'verified') throw new HttpError(409, { error: 'verified_workflow_required' });
  const v21Execution = Number(state.schema_version || 0) >= 21 || Boolean(workflow.outcome_contract);
  const protocols = v21Execution ? requireWorkflowExecutionProtocols(workflow) : null;
  const operationKey = clean(input.operation_key || input.idempotency_key, 128) || null;
  if (operationKey) {
    const existing = state.workflow_executions.find(
      (item) => item.workflow_id === workflow.id && item.operation_key === operationKey
    );
    if (existing)
      return {
        workflow_execution: existing,
        task_executions: taskExecutionsFor(state, existing.id),
        repository_lines: repositoryLinesFor(state, existing.id),
        idempotent: true
      };
  }
  const active = state.workflow_executions.find(
    (item) => item.workflow_id === workflow.id && ACTIVE_WORKFLOW_EXECUTION_STATUSES.includes(item.status)
  );
  if (active) throw new HttpError(409, { error: 'workflow_execution_active', workflow_execution_id: active.id });
  const workflowRevision = Number(workflow.workflow_revision || workflow.version || 1);
  if (input.expected_workflow_revision != null && Number(input.expected_workflow_revision) !== workflowRevision)
    throw new HttpError(409, {
      error: 'workflow_revision_mismatch',
      expected: input.expected_workflow_revision,
      actual: workflowRevision
    });
  const nodes = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id && !item.legacy_read_only);
  const workstreams = nodes.filter((item) => item.role === 'workstream');
  const excludedTaskIds = new Set(
    nodes
      .filter((item) => item.role === 'task' && item.execution_evidence_status === 'external_unverified')
      .map((item) => item.id)
  );
  const tasks = nodes.filter((item) => item.role === 'task' && !excludedTaskIds.has(item.id));
  if (!tasks.length) throw new HttpError(409, { error: 'workflow_tasks_required' });
  for (const task of tasks) {
    const invalid = dependencyIds(task).filter((taskId) => excludedTaskIds.has(taskId));
    if (invalid.length)
      throw new HttpError(409, {
        error: 'external_unverified_task_dependency_forbidden',
        task_id: task.id,
        dependency_task_ids: invalid
      });
  }
  const createdAt = now(),
    executionId = id('wex');
  const repositorySelection = normalizeRepositorySelection(
    state,
    project,
    workstreams,
    input.repositories || input.repository_selection || []
  );
  const definition = workflowDefinitionSnapshot(state, workflow, nodes);
  const workflowExecution = {
    id: executionId,
    project_id: project.id,
    workflow_id: workflow.id,
    workflow_revision: workflowRevision,
    status: 'running',
    repository_selection: repositorySelection,
    input_hash: hashString(
      JSON.stringify({
        definition,
        repositorySelection,
        outcome_contract_hash: protocols?.outcome_contract_hash || null,
        quality_rubric_hash: protocols?.quality_rubric_hash || null
      })
    ),
    executor_config: normalizeWorkflowExecutorConfig(input),
    operation_key: operationKey,
    frontier: [],
    waiting_reasons: [],
    ...(v21Execution
      ? {
          completion_status: 'pending',
          release_eligible: false,
          outcome_summary: {
            total: 0,
            pending: 0,
            satisfied: 0,
            unsatisfied: 0,
            waived: 0,
            error: 0,
            mandatory_gaps: 0
          },
          outcome_contract_hash: protocols.outcome_contract_hash,
          quality_rubric_hash: protocols.quality_rubric_hash,
          outcome_contract_source: protocols.contract.source,
          finalization_state: 'pending',
          finalized_at: null
        }
      : {}),
    created_by_user_id: actorId,
    started_at: createdAt,
    paused_at: null,
    completed_at: null,
    cancelled_at: null,
    created_at: createdAt,
    updated_at: createdAt
  };
  state.workflow_executions.push(workflowExecution);
  if (v21Execution) materializeOutcomeRequirementsInState(state, workflowExecution, workflow, createdAt);
  for (const task of tasks.sort(byOrder)) {
    const contract = state.node_contracts.find((item) => item.id === task.current_contract_id);
    if (!contract) throw new HttpError(409, { error: 'task_contract_missing', task_id: task.id });
    state.task_executions.push(pendingTaskExecution(workflowExecution, task, contract, actorId, createdAt));
  }
  createRepositoryLinesInState(state, workflowExecution, workstreams, repositorySelection);
  appendExecutionEvent(
    state,
    workflowExecution,
    null,
    'workflow.started',
    { workflow_revision: workflowRevision, input_hash: workflowExecution.input_hash },
    'user',
    actorId
  );
  const reconciliation = reconcileWorkflowExecutionInState(state, workflowExecution.id, {
    autoQueue: input.auto_queue !== false
  });
  return {
    workflow_execution: workflowExecution,
    task_executions: reconciliation.task_executions,
    repository_lines: repositoryLinesFor(state, executionId),
    idempotent: false
  };
}
export function reconcileWorkflowExecutionInState(state, workflowExecutionId, { autoQueue = true } = {}) {
  const workflowExecution = requireWorkflowExecution(state, workflowExecutionId);
  const executions = currentTaskExecutions(state, workflowExecution.id);
  if (!['running', 'paused'].includes(workflowExecution.status)) return snapshot(state, workflowExecution);
  assertExecutionRevisionCurrent(state, workflowExecution);
  const queuedThisPass = [];
  for (const execution of executions.sort((left, right) => taskOrder(state, left) - taskOrder(state, right))) {
    if (!['pending', 'ready'].includes(execution.status)) continue;
    const readiness = taskExecutionReadiness(state, execution);
    execution.readiness = readiness;
    if (!readiness.ready) {
      if (execution.status === 'ready')
        transitionTaskExecutionInState(state, execution, 'pending', { reason: 'readiness_changed' });
      continue;
    }
    if (execution.status === 'pending')
      transitionTaskExecutionInState(state, execution, 'ready', { reason: 'frontier_reconciled' });
    if (
      autoQueue &&
      workflowExecution.status === 'running' &&
      queueCapacityAvailable(state, execution, queuedThisPass)
    ) {
      transitionTaskExecutionInState(state, execution, 'queued', { reason: 'auto_dispatch' });
      execution.queued_at = now();
      queuedThisPass.push(execution);
      reserveRepositoryCapacity(state, execution);
    }
  }
  projectWorkflowExecutionStateInState(state, workflowExecution.id);
  const active = executions.filter((item) => !TERMINAL.has(item.status));
  if (!active.length && executions.every((item) => item.status === 'completed')) {
    if (workflowExecution.completion_status) {
      if (workflowExecution.finalization_state !== 'running') workflowExecution.finalization_state = 'pending';
      if (
        !state.execution_events.some(
          (item) => item.workflow_execution_id === workflowExecution.id && item.type === 'workflow.finalization_pending'
        )
      )
        appendExecutionEvent(state, workflowExecution, null, 'workflow.finalization_pending', {}, 'system', null);
    } else {
      workflowExecution.status = 'completed';
      workflowExecution.completed_at = now();
      workflowExecution.updated_at = now();
      appendExecutionEvent(state, workflowExecution, null, 'workflow.completed', {}, 'system', null);
    }
  } else if (!active.length && executions.some((item) => ['failed', 'cancelled'].includes(item.status))) {
    workflowExecution.status = executions.some((item) => item.status === 'cancelled') ? 'cancelled' : 'failed';
    workflowExecution.completed_at = now();
    workflowExecution.updated_at = now();
    if (workflowExecution.completion_status) {
      workflowExecution.completion_status = 'failed';
      workflowExecution.release_eligible = false;
      workflowExecution.finalization_state = 'completed';
    }
    appendExecutionEvent(
      state,
      workflowExecution,
      null,
      workflowExecution.status === 'cancelled' ? 'workflow.cancelled' : 'workflow.failed',
      {},
      'system',
      null
    );
  }
  const frontier = executions.filter((item) =>
    ['ready', 'queued', 'running', 'verifying', 'awaiting_human'].includes(item.status)
  );
  workflowExecution.frontier = frontier.map((item) => ({
    task_execution_id: item.id,
    task_id: item.task_id,
    status: item.status,
    executor: item.executor
  }));
  workflowExecution.waiting_reasons = executions
    .filter((item) => item.status === 'pending')
    .map((item) => ({ task_execution_id: item.id, task_id: item.task_id, reasons: item.readiness.reasons }));
  workflowExecution.updated_at = now();
  return snapshot(state, workflowExecution);
}
export function transitionTaskExecutionInState(state, executionOrId, nextStatus, data = {}) {
  const execution = typeof executionOrId === 'string' ? requireTaskExecution(state, executionOrId) : executionOrId;
  if (!TRANSITIONS[execution.status]?.has(nextStatus))
    throw new HttpError(409, { error: 'task_execution_transition_invalid', from: execution.status, to: nextStatus });
  const previous = execution.status;
  execution.status = nextStatus;
  execution.updated_at = now();
  if (nextStatus === 'running') execution.started_at ||= now();
  if (TERMINAL.has(nextStatus)) {
    execution.completed_at = now();
    execution.lease = null;
    execution.readiness = {
      ready: nextStatus === 'completed',
      reasons: [],
      checked_at: now(),
      handoff: taskHandoffDiagnostics(state, execution)
    };
    releaseRepositoryCapacity(state, execution);
  }
  appendExecutionEvent(
    state,
    state.workflow_executions.find((item) => item.id === execution.workflow_execution_id),
    execution,
    'task.status_changed',
    { from: previous, to: nextStatus, ...structuredClone(data) },
    'system',
    null
  );
  return execution;
}
export function issueTaskExecutionLeaseInState(
  state,
  taskExecutionId,
  { holder = 'executor', ttlMs = 15 * 60_000 } = {}
) {
  const execution = requireTaskExecution(state, taskExecutionId);
  const task = state.workflow_nodes.find((item) => item.id === execution.task_id),
    contract = state.node_contracts.find((item) => item.id === execution.contract_id);
  if (
    !task ||
    !contract ||
    Number(task.execution_revision || 1) !== execution.task_revision ||
    task.current_contract_id !== execution.contract_id ||
    Number(contract.version || 1) !== execution.contract_version
  )
    throw new HttpError(409, { error: 'task_execution_revision_superseded' });
  if (!['queued', 'running', 'verifying'].includes(execution.status))
    throw new HttpError(409, { error: 'task_execution_not_leasable', status: execution.status });
  if (execution.status === 'queued')
    transitionTaskExecutionInState(state, execution, 'running', { reason: 'lease_claimed' });
  const token = `aiws_lease_${randomUUID().replaceAll('-', '')}`,
    issuedAt = now();
  execution.lease = {
    token_hash: hashString(token),
    holder: clean(holder, 200),
    issued_at: issuedAt,
    expires_at: new Date(Date.now() + Math.min(Math.max(Number(ttlMs) || 900_000, 30_000), 3_600_000)).toISOString(),
    task_revision: execution.task_revision,
    contract_id: execution.contract_id,
    input_snapshot_hash: execution.input_snapshot_hash || null
  };
  execution.updated_at = now();
  return { task_execution: execution, lease_token: token };
}
export function assertTaskExecutionLease(
  state,
  { taskExecutionId, leaseToken, taskId = null, operation = 'write', allowAwaitingHuman = false }
) {
  const execution = requireTaskExecution(state, taskExecutionId),
    lease = execution.lease;
  if (!lease || !leaseToken || hashString(leaseToken) !== lease.token_hash)
    throw new HttpError(403, { error: 'task_execution_lease_invalid' });
  if (Date.parse(lease.expires_at) <= Date.now()) throw new HttpError(409, { error: 'task_execution_lease_expired' });
  if (taskId && execution.task_id !== taskId)
    throw new HttpError(409, { error: 'task_execution_lease_scope_mismatch' });
  const validStatuses = allowAwaitingHuman ? ['running', 'verifying', 'awaiting_human'] : ['running', 'verifying'];
  if (!validStatuses.includes(execution.status))
    throw new HttpError(409, { error: 'task_execution_lease_inactive', status: execution.status });
  const task = state.workflow_nodes.find((item) => item.id === execution.task_id);
  if (
    !task ||
    Number(task.execution_revision || 1) !== lease.task_revision ||
    task.current_contract_id !== lease.contract_id
  )
    throw new HttpError(409, { error: 'task_execution_lease_superseded' });
  return { execution, operation };
}
export function completeTaskExecutionInState(state, taskExecutionId, { evidence = {} } = {}) {
  const execution = requireTaskExecution(state, taskExecutionId),
    contract = state.node_contracts.find((item) => item.id === execution.contract_id);
  if (!['verifying', 'awaiting_human'].includes(execution.status))
    throw new HttpError(409, { error: 'task_execution_not_verifying', status: execution.status });
  const missing = (contract?.expected_outputs || []).filter(
    (slot) =>
      slot.required !== false &&
      !(execution.output_bindings || []).some((item) => item.key === slot.key && bindingIsConsumable(state, item))
  );
  if (missing.length)
    throw new HttpError(409, {
      error: 'task_execution_outputs_incomplete',
      output_keys: missing.map((item) => item.key)
    });
  assertRequiredContributionAuthority(execution);
  if (execution.executor === 'repository_integrate') assertIntegrationEvidence(state, execution, evidence);
  execution.evidence = executionEvidence(evidence || execution.evidence || {});
  transitionTaskExecutionInState(state, execution, 'completed', { reason: 'outputs_accepted' });
  execution.handoff_diagnostics = taskHandoffDiagnostics(state, execution);
  execution.readiness.handoff = execution.handoff_diagnostics;
  projectWorkflowExecutionStateInState(state, execution.workflow_execution_id);
  return execution;
}

export function failTaskExecutionInState(
  state,
  taskExecutionId,
  { errorCode, retryClass = 'deterministic', failure = null, stage = null } = {}
) {
  const execution = requireTaskExecution(state, taskExecutionId);
  if (!['queued', 'running', 'verifying', 'awaiting_human'].includes(execution.status))
    throw new HttpError(409, { error: 'task_execution_not_active', status: execution.status });
  execution.error_code = clean(errorCode, 200) || 'task_execution_failed';
  execution.retry_class = retryClass;
  execution.current_stage ||= stage || 'execute';
  execution.failure = failure
    ? parseFailureEnvelope(structuredClone(failure))
    : execution.failure?.code === execution.error_code
      ? execution.failure
      : failureEnvelope(
          { code: execution.error_code, message: execution.error_code, retryable: retryClass === 'transient' },
          {
            stage: execution.current_stage,
            category: execution.current_stage === 'verify' ? 'verifier' : 'runner',
            retryable: retryClass === 'transient'
          }
        );
  transitionTaskExecutionInState(state, execution, 'failed', {
    error_code: execution.error_code,
    retry_class: retryClass
  });
  projectWorkflowExecutionStateInState(state, execution.workflow_execution_id);
  return execution;
}

export function reopenTaskExecutionForStageReplayInState(state, taskExecutionId, stage, actorId) {
  const execution = requireTaskExecution(state, taskExecutionId);
  if (execution.status !== 'failed')
    throw new HttpError(409, { error: 'task_execution_stage_replay_status_invalid', status: execution.status });
  const task = state.workflow_nodes.find((item) => item.id === execution.task_id),
    workflowExecution = requireWorkflowExecution(state, execution.workflow_execution_id);
  if (!task) throw new HttpError(409, { error: 'task_execution_scope_missing' });
  reopenFailedWorkflowForRetry(state, workflowExecution, task, actorId);
  const previous = execution.status;
  execution.status = ['verify', 'attest', 'promote'].includes(stage) ? 'verifying' : 'running';
  execution.completed_at = null;
  execution.error_code = null;
  execution.retry_class = null;
  execution.failure = null;
  execution.current_stage = stage;
  execution.updated_at = now();
  appendExecutionEvent(
    state,
    state.workflow_executions.find((item) => item.id === execution.workflow_execution_id),
    execution,
    'task.stage_replay_started',
    { from: previous, to: execution.status, stage },
    'user',
    actorId
  );
  return execution;
}
export function retryTaskExecutionInState(state, taskExecutionId, actorId) {
  const previous = requireTaskExecution(state, taskExecutionId);
  if (previous.status === 'superseded' && actorId) {
    const existing = state.task_executions.find(
      (item) =>
        item.supersedes_id === previous.id &&
        ['pending', 'queued', 'running', 'verifying', 'awaiting_human'].includes(item.status)
    );
    if (existing) {
      restoreLegacyRetryRepositoryLine(state, previous, existing, actorId);
      return recoverLegacyStrandedRetry(state, previous, existing, actorId) || existing;
    }
  }
  if (previous.status !== 'failed')
    throw new HttpError(409, { error: 'task_execution_retry_status_invalid', status: previous.status });
  const attempts = state.task_executions.filter(
    (item) => item.workflow_execution_id === previous.workflow_execution_id && item.task_id === previous.task_id
  );
  if (previous.retry_class === 'transient' && attempts.length >= 2 && actorId == null)
    throw new HttpError(409, { error: 'task_execution_auto_retry_exhausted' });
  const task = state.workflow_nodes.find((item) => item.id === previous.task_id),
    contract = state.node_contracts.find((item) => item.id === task?.current_contract_id);
  if (
    !task ||
    !contract ||
    Number(task.execution_revision || 1) !== previous.task_revision ||
    contract.id !== previous.contract_id
  )
    throw new HttpError(409, { error: 'task_execution_revision_changed' });
  const workflowExecution = requireWorkflowExecution(state, previous.workflow_execution_id);
  reopenFailedWorkflowForRetry(state, workflowExecution, task, actorId);
  const expectedExecutor = executorForTask(task),
    retryInput =
      previous.executor === expectedExecutor ? retryInputExpectation(previous) : { hash: null, version: null };
  const created = {
    ...structuredClone(previous),
    id: id('tex'),
    attempt: Math.max(...attempts.map((item) => item.attempt)) + 1,
    executor: expectedExecutor,
    executor_reclassified_from: previous.executor !== expectedExecutor ? previous.executor : null,
    status: 'pending',
    readiness: { ready: false, reasons: [{ code: 'retry_pending' }] },
    context_snapshot: null,
    input_snapshot_hash: null,
    retry_input_snapshot_hash: retryInput.hash,
    retry_input_snapshot_hash_version: retryInput.version,
    output_bindings: [],
    consumed_inputs: [],
    input_dispositions: [],
    consumed_context_document_versions: [],
    context_dispositions: [],
    handoff_diagnostics: null,
    acceptance_results: [],
    evidence: {},
    error_code: null,
    retry_class: null,
    failure: null,
    current_stage: null,
    stage_checkpoint_ids: [],
    replay_count: 0,
    lease: null,
    supersedes_id: previous.id,
    queued_at: null,
    started_at: null,
    completed_at: null,
    created_at: now(),
    updated_at: now(),
    created_by_user_id: actorId
  };
  transitionTaskExecutionInState(state, previous, 'superseded', {
    reason: 'retry_created',
    next_task_execution_id: created.id
  });
  state.task_executions.push(created);
  restoreLegacyRetryRepositoryLine(state, previous, created, actorId);
  appendExecutionEvent(
    state,
    state.workflow_executions.find((item) => item.id === created.workflow_execution_id),
    created,
    'task.retried',
    { previous_task_execution_id: previous.id, attempt: created.attempt },
    'user',
    actorId
  );
  reconcileWorkflowExecutionInState(state, created.workflow_execution_id);
  return created;
}

function recoverLegacyStrandedRetry(state, previous, retry, actorId) {
  const workflow = state.workflow_executions.find((item) => item.id === retry.workflow_execution_id);
  if (!isLegacyStrandedRetry(state, previous, retry, workflow)) return null;
  failTaskExecutionInState(state, retry.id, {
    errorCode: 'legacy_runner_configuration_recovered',
    retryClass: 'deterministic'
  });
  sanitizeLegacyExecutorConfig(workflow);
  appendExecutionEvent(
    state,
    workflow,
    retry,
    'workflow.legacy_runner_recovered',
    { ignored_runner: 'history_promotion' },
    'user',
    actorId
  );
  return retryTaskExecutionInState(state, retry.id, actorId);
}

function reopenFailedWorkflowForRetry(state, workflowExecution, task, actorId) {
  if (workflowExecution.status !== 'failed') return [];
  if (!actorId) throw new HttpError(409, { error: 'workflow_execution_explicit_retry_required' });
  const active = state.workflow_executions.find(
    (item) =>
      item.id !== workflowExecution.id &&
      item.workflow_id === workflowExecution.workflow_id &&
      ACTIVE_WORKFLOW_EXECUTION_STATUSES.includes(item.status)
  );
  if (active) throw new HttpError(409, { error: 'workflow_execution_active', workflow_execution_id: active.id });
  assertExecutionRevisionCurrent(state, workflowExecution);
  sanitizeLegacyExecutorConfig(workflowExecution);
  const continuationTaskIds = enrollRetryContinuationTasks(state, workflowExecution, task, actorId);
  Object.assign(workflowExecution, {
    status: 'running',
    ...(workflowExecution.completion_status
      ? {
          completion_status: 'pending',
          release_eligible: false,
          finalization_state: 'pending',
          finalized_at: null
        }
      : {}),
    completed_at: null,
    cancelled_at: null,
    updated_at: now()
  });
  appendExecutionEvent(
    state,
    workflowExecution,
    null,
    'workflow.reopened',
    { retry_task_id: task.id, continuation_task_ids: continuationTaskIds },
    'user',
    actorId
  );
  return continuationTaskIds;
}

function enrollRetryContinuationTasks(state, workflowExecution, originTask, actorId) {
  const represented = new Set(
      state.task_executions
        .filter((item) => item.workflow_execution_id === workflowExecution.id)
        .map((item) => item.task_id)
    ),
    workstreamTasks = state.workflow_nodes
      .filter(
        (item) =>
          item.workflow_id === workflowExecution.workflow_id &&
          item.parent_node_id === originTask.parent_node_id &&
          item.role === 'task' &&
          !item.legacy_read_only
      )
      .sort(byOrder),
    descendants = new Set([originTask.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of workstreamTasks) {
      if (descendants.has(task.id) || !dependencyIds(task).some((taskId) => descendants.has(taskId))) continue;
      descendants.add(task.id);
      changed = true;
    }
  }
  const continuation = workstreamTasks.filter((item) => descendants.has(item.id) && !represented.has(item.id)),
    createdAt = now(),
    enrolled = [];
  for (const task of continuation) {
    if (task.execution_evidence_status !== 'external_unverified')
      throw new HttpError(409, { error: 'task_execution_continuation_scope_invalid', task_id: task.id });
    const contract = state.node_contracts.find((item) => item.id === task.current_contract_id);
    if (!contract) throw new HttpError(409, { error: 'task_contract_missing', task_id: task.id });
    task.execution_evidence_status = 'managed';
    task.updated_at = createdAt;
    const execution = pendingTaskExecution(workflowExecution, task, contract, actorId, createdAt);
    state.task_executions.push(execution);
    enrolled.push(task.id);
  }
  return enrolled;
}

export function pauseWorkflowExecutionInState(state, workflowExecutionId, actorId) {
  const execution = requireWorkflowExecution(state, workflowExecutionId);
  if (execution.status !== 'running')
    throw new HttpError(409, { error: 'workflow_execution_not_running', status: execution.status });
  execution.status = 'paused';
  execution.paused_at = now();
  execution.updated_at = now();
  appendExecutionEvent(state, execution, null, 'workflow.paused', {}, 'user', actorId);
  reconcileWorkflowExecutionInState(state, execution.id, { autoQueue: false });
  return execution;
}
export function resumeWorkflowExecutionInState(state, workflowExecutionId, actorId) {
  const execution = requireWorkflowExecution(state, workflowExecutionId);
  if (execution.status !== 'paused')
    throw new HttpError(409, { error: 'workflow_execution_not_paused', status: execution.status });
  execution.status = 'running';
  execution.paused_at = null;
  execution.updated_at = now();
  appendExecutionEvent(state, execution, null, 'workflow.resumed', {}, 'user', actorId);
  reconcileWorkflowExecutionInState(state, execution.id);
  return execution;
}
export function cancelWorkflowExecutionInState(state, workflowExecutionId, actorId) {
  const execution = requireWorkflowExecution(state, workflowExecutionId);
  if (!ACTIVE_WORKFLOW_EXECUTION_STATUSES.includes(execution.status))
    throw new HttpError(409, { error: 'workflow_execution_not_active', status: execution.status });
  for (const task of currentTaskExecutions(state, execution.id).filter((item) => !TERMINAL.has(item.status)))
    transitionTaskExecutionInState(state, task, 'cancelled', { reason: 'workflow_cancelled' });
  execution.status = 'cancelled';
  if (execution.completion_status) {
    execution.completion_status = 'failed';
    execution.release_eligible = false;
    execution.finalization_state = 'completed';
  }
  execution.cancelled_at = now();
  execution.updated_at = now();
  for (const line of repositoryLinesFor(state, execution.id).filter(
    (item) => !['merged', 'failed'].includes(item.status)
  )) {
    line.status = 'cancelled';
    line.updated_at = now();
  }
  appendExecutionEvent(state, execution, null, 'workflow.cancelled', {}, 'user', actorId);
  projectWorkflowExecutionStateInState(state, execution.id);
  return execution;
}
