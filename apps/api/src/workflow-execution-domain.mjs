import { randomUUID } from 'node:crypto';
import { hashString, id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { projectWorkflowExecutionStateInState } from './workflow-execution-projection.mjs';
import { inspectWorkstreamDependencyHandoff, selectTaskOutputBindings } from './task-execution-context.mjs';
import { taskHandoffDiagnostics } from './task-handoff.mjs';
import { assertRequiredContributionAuthority } from './task-contribution-authority.mjs';
import { repositoryBranchSlug } from './workflow-branch-ref.mjs';
import { normalizeWorkflowExecutorConfig } from './workflow-executor-config.mjs';
import {
  isLegacyStrandedRetry,
  legacyPromotedExecution,
  restoreLegacyRetryCompatibility,
  retryInputExpectation,
  sanitizeLegacyExecutorConfig
} from './workflow-retry-compatibility.mjs';
export { integrationEvidenceFor } from './workflow-integration-evidence.mjs';

export { projectWorkflowExecutionStateInState } from './workflow-execution-projection.mjs';
export const TASK_EXECUTION_STATUSES = Object.freeze([
  'pending',
  'ready',
  'queued',
  'running',
  'verifying',
  'awaiting_human',
  'completed',
  'failed',
  'cancelled',
  'superseded'
]);
export const TERMINAL_TASK_EXECUTION_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'superseded']);
export const ACTIVE_WORKFLOW_EXECUTION_STATUSES = Object.freeze(['running', 'paused']);
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
    input_hash: hashString(JSON.stringify({ definition, repositorySelection })),
    executor_config: normalizeWorkflowExecutorConfig(input),
    operation_key: operationKey,
    frontier: [],
    waiting_reasons: [],
    created_by_user_id: actorId,
    started_at: createdAt,
    paused_at: null,
    completed_at: null,
    cancelled_at: null,
    created_at: createdAt,
    updated_at: createdAt
  };
  state.workflow_executions.push(workflowExecution);
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
    workflowExecution.status = 'completed';
    workflowExecution.completed_at = now();
    workflowExecution.updated_at = now();
    appendExecutionEvent(state, workflowExecution, null, 'workflow.completed', {}, 'system', null);
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
export function taskExecutionReadiness(state, execution) {
  const workflowExecution = state.workflow_executions.find((item) => item.id === execution.workflow_execution_id),
    task = state.workflow_nodes.find((item) => item.id === execution.task_id),
    reasons = [];
  if (!workflowExecution || !task) return { ready: false, reasons: [{ code: 'execution_scope_missing' }] };
  if (workflowExecution.status === 'paused') reasons.push({ code: 'workflow_paused' });
  if (Number(task.execution_revision || 1) !== execution.task_revision)
    reasons.push({
      code: 'task_revision_superseded',
      expected: execution.task_revision,
      actual: Number(task.execution_revision || 1)
    });
  if (task.current_contract_id !== execution.contract_id)
    reasons.push({ code: 'contract_superseded', expected: execution.contract_id, actual: task.current_contract_id });
  for (const dependencyId of dependencyIds(task)) {
    const dependency = latestExecutionForTask(state, execution.workflow_execution_id, dependencyId);
    if (!dependency || dependency.status !== 'completed')
      reasons.push({
        code: 'task_dependency_waiting',
        dependency_task_id: dependencyId,
        status: dependency?.status || 'missing'
      });
    else if (!requiredOutputsAccepted(state, dependency))
      reasons.push({ code: 'task_dependency_outputs_unaccepted', dependency_task_id: dependencyId });
  }
  const workstream = state.workflow_nodes.find((item) => item.id === execution.workstream_id);
  for (const dependencyWorkstreamId of dependencyIds(workstream)) {
    const handoff = inspectWorkstreamDependencyHandoff(state, {
      projectId: execution.project_id,
      workflowId: execution.workflow_id,
      workflowExecutionId: execution.workflow_execution_id,
      workstreamId: dependencyWorkstreamId,
      strict: true,
      receiptOnly: true
    });
    if (!handoff.ready)
      reasons.push({
        code: 'workstream_dependency_waiting',
        dependency_workstream_id: dependencyWorkstreamId,
        detail_code: handoff.reason.code
      });
  }
  const contract = state.node_contracts.find((item) => item.id === execution.contract_id);
  for (const slot of contract?.expected_inputs || []) {
    if (slot.required === false) continue;
    if (slot.source === 'dependency') {
      const dependencyTaskId = slot.ref_id || dependencyIds(task)[0],
        dependency = latestExecutionForTask(state, execution.workflow_execution_id, dependencyTaskId),
        dependencyTask = state.workflow_nodes.find((item) => item.id === dependencyTaskId),
        bindings = selectTaskOutputBindings(state, dependencyTask, dependency, slot.selector);
      if (!bindings.length) reasons.push({ code: 'required_input_missing', slot_key: slot.key });
      else
        for (const binding of bindings)
          if (!bindingIsConsumable(state, binding))
            reasons.push({ code: 'input_asset_unverified', slot_key: slot.key, version_id: binding.version_id });
    }
    if (slot.source === 'workstream_dependency') {
      const handoff = inspectWorkstreamDependencyHandoff(state, {
        projectId: execution.project_id,
        workflowId: execution.workflow_id,
        workflowExecutionId: execution.workflow_execution_id,
        workstreamId: slot.ref_id,
        selector: slot.selector || 'required_outputs',
        strict: true
      });
      if (!handoff.ready)
        reasons.push({ code: 'workstream_input_missing', slot_key: slot.key, detail_code: handoff.reason.code });
    }
  }
  if (requiresRepositoryLine(execution)) {
    const line = lineForExecution(state, execution);
    if (!line) reasons.push({ code: 'repository_line_missing' });
    else if (!['active', 'integrating'].includes(line.status))
      reasons.push({ code: 'repository_line_not_active', status: line.status });
    else if (!line.checkout_path || !line.head_sha)
      reasons.push({ code: 'repository_line_provisioning', repository_line_id: line.id });
  }
  if (execution.executor === 'repository_integrate') {
    const siblings = currentTaskExecutions(state, execution.workflow_execution_id).filter(
      (item) => item.workstream_id === execution.workstream_id && item.id !== execution.id
    );
    const incomplete = siblings.filter((item) => item.status !== 'completed');
    if (incomplete.length)
      reasons.push({ code: 'workstream_tasks_incomplete', task_execution_ids: incomplete.map((item) => item.id) });
  }
  return {
    ready: reasons.length === 0,
    reasons,
    checked_at: now(),
    handoff: taskHandoffDiagnostics(state, execution)
  };
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

export function failTaskExecutionInState(state, taskExecutionId, { errorCode, retryClass = 'deterministic' } = {}) {
  const execution = requireTaskExecution(state, taskExecutionId);
  if (!['queued', 'running', 'verifying', 'awaiting_human'].includes(execution.status))
    throw new HttpError(409, { error: 'task_execution_not_active', status: execution.status });
  execution.error_code = clean(errorCode, 200) || 'task_execution_failed';
  execution.retry_class = retryClass;
  transitionTaskExecutionInState(state, execution, 'failed', {
    error_code: execution.error_code,
    retry_class: retryClass
  });
  projectWorkflowExecutionStateInState(state, execution.workflow_execution_id);
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
  const retryInput = retryInputExpectation(previous);
  const created = {
    ...structuredClone(previous),
    id: id('tex'),
    attempt: Math.max(...attempts.map((item) => item.attempt)) + 1,
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

function restoreLegacyRetryRepositoryLine(state, previous, retry, actorId) {
  const restored = restoreLegacyRetryCompatibility(state, previous, retry);
  if (!restored) return;
  appendExecutionEvent(
    state,
    state.workflow_executions.find((item) => item.id === previous.workflow_execution_id),
    retry,
    'repository_line.retry_head_restored',
    {
      repository_line_id: restored.line.id,
      previous_head_sha: restored.previous_head_sha,
      expected_head_sha: restored.expected_head_sha
    },
    'user',
    actorId
  );
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

function pendingTaskExecution(workflowExecution, task, contract, actorId, createdAt) {
  return {
    id: id('tex'),
    workflow_execution_id: workflowExecution.id,
    project_id: workflowExecution.project_id,
    workflow_id: workflowExecution.workflow_id,
    workstream_id: task.parent_node_id,
    task_id: task.id,
    task_revision: Number(task.execution_revision || 1),
    contract_id: contract.id,
    contract_version: Number(contract.version || 1),
    attempt: 1,
    executor: executorForTask(task),
    status: 'pending',
    readiness: { ready: false, reasons: [{ code: 'reconcile_pending' }] },
    context_snapshot: null,
    input_snapshot_hash: null,
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
    lease: null,
    supersedes_id: null,
    queued_at: null,
    started_at: null,
    completed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    created_by_user_id: actorId
  };
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
export function appendExecutionEvent(
  state,
  workflowExecution,
  taskExecution,
  type,
  data = {},
  actorType = 'system',
  actorId = null
) {
  if (!workflowExecution) throw new HttpError(404, { error: 'workflow_execution_not_found' });
  const sequence =
    state.execution_events
      .filter((item) => item.workflow_execution_id === workflowExecution.id)
      .reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1;
  const event = {
    id: id('exe'),
    workflow_execution_id: workflowExecution.id,
    task_execution_id: taskExecution?.id || null,
    project_id: workflowExecution.project_id,
    sequence,
    type,
    actor_type: actorType,
    actor_id: actorId,
    data: structuredClone(data || {}),
    created_at: now()
  };
  state.execution_events.push(event);
  return event;
}
export function activeTaskExecutionForTask(state, taskId) {
  return (
    state.task_executions
      .filter(
        (item) =>
          item.task_id === taskId &&
          !TERMINAL.has(item.status) &&
          ACTIVE_WORKFLOW_EXECUTION_STATUSES.includes(
            state.workflow_executions.find((execution) => execution.id === item.workflow_execution_id)?.status
          )
      )
      .sort(byNewest)[0] || null
  );
}
export function currentTaskExecutions(state, workflowExecutionId) {
  const grouped = new Map();
  for (const item of state.task_executions
    .filter((entry) => entry.workflow_execution_id === workflowExecutionId)
    .sort((a, b) => a.attempt - b.attempt))
    grouped.set(item.task_id, item);
  return [...grouped.values()];
}
export function requireWorkflowExecution(state, idValue) {
  const item = state.workflow_executions.find((entry) => entry.id === idValue);
  if (!item) throw new HttpError(404, { error: 'workflow_execution_not_found' });
  return item;
}
export function requireTaskExecution(state, idValue) {
  const item = state.task_executions.find((entry) => entry.id === idValue);
  if (!item) throw new HttpError(404, { error: 'task_execution_not_found' });
  return item;
}

function createRepositoryLinesInState(state, workflowExecution, workstreams, selections) {
  for (const selection of selections) {
    const workstream = workstreams.find((item) => item.id === selection.workstream_id);
    if (!workstream) continue;
    state.repository_lines.push({
      id: id('rln'),
      workflow_execution_id: workflowExecution.id,
      project_id: workflowExecution.project_id,
      workflow_id: workflowExecution.workflow_id,
      workstream_id: workstream.id,
      connection_id: selection.connection_id,
      canonical_repository_id: selection.canonical_repository_id || null,
      base_ref: selection.base_ref,
      base_sha: selection.base_sha || null,
      branch: `aiws/${repositoryBranchSlug(workstream)}-${workflowExecution.id.slice(-8)}`,
      head_sha: selection.base_sha || null,
      checkout_path: null,
      status: 'active',
      active_writer_execution_id: null,
      pull_request_intent_id: null,
      pr_number: null,
      merged_sha: null,
      created_at: now(),
      updated_at: now()
    });
  }
}
function normalizeRepositorySelection(state, project, workstreams, source) {
  const rows = Array.isArray(source)
    ? source
    : Object.entries(source || {}).map(([workstream_id, value]) => ({
        workstream_id,
        ...(typeof value === 'string' ? { connection_id: value } : value)
      }));
  return rows.map((item) => {
    const workstream = workstreams.find((entry) => entry.id === item.workstream_id),
      connection = state.repository_connections.find(
        (entry) =>
          entry.id === item.connection_id && entry.project_id === project.id && entry.sync_status !== 'disconnected'
      );
    if (!workstream)
      throw new HttpError(400, { error: 'repository_selection_workstream_invalid', workstream_id: item.workstream_id });
    if (!connection)
      throw new HttpError(400, { error: 'repository_selection_connection_invalid', connection_id: item.connection_id });
    const workspace = state.repository_workspaces.find(
      (entry) =>
        entry.connection_id === connection.id &&
        entry.project_id === project.id &&
        entry.status === 'active' &&
        !entry.stale
    );
    const canonical = state.canonical_repositories.find(
      (entry) => String(entry.repository_id) === String(connection.repository_id)
    );
    return {
      workstream_id: workstream.id,
      connection_id: connection.id,
      canonical_repository_id: canonical?.id || null,
      base_ref: safeRef(item.base_ref || connection.default_branch || 'main'),
      base_sha: item.base_sha || workspace?.current_sha || workspace?.fixed_sha || null
    };
  });
}
function workflowDefinitionSnapshot(state, workflow, nodes) {
  return {
    workflow_id: workflow.id,
    workflow_revision: Number(workflow.workflow_revision || workflow.version || 1),
    nodes: nodes.sort(byOrder).map((node) => ({
      id: node.id,
      role: node.role,
      parent_node_id: node.parent_node_id || null,
      execution_revision: Number(node.execution_revision || 1),
      execution_evidence_status: node.execution_evidence_status || 'managed',
      dependencies: dependencyIds(node),
      current_contract_id: node.current_contract_id,
      contract_version: state.node_contracts.find((item) => item.id === node.current_contract_id)?.version || null
    }))
  };
}
function executorForTask(task) {
  if (task.execution_mode === 'manual' || task.task_kind === 'manual') return 'manual';
  if (task.task_kind === 'code') return 'repository_change';
  if (task.task_kind === 'test') return 'repository_verify';
  if (['deploy', 'integration'].includes(task.task_kind)) return 'repository_integrate';
  return 'assist';
}
function queueCapacityAvailable(state, execution) {
  const active = currentTaskExecutions(state, execution.workflow_execution_id).filter(
    (item) => ['queued', 'running', 'verifying'].includes(item.status) && item.id !== execution.id
  );
  if (execution.executor === 'assist') return active.filter((item) => item.executor === 'assist').length < 2;
  const line = lineForExecution(state, execution);
  if (!line) return !requiresRepositoryLine(execution);
  if (execution.executor === 'repository_change')
    return (
      !line.active_writer_execution_id &&
      !active.some((item) => item.workstream_id === execution.workstream_id && item.executor === 'repository_change')
    );
  if (execution.executor === 'repository_verify')
    return (
      active.filter((item) => item.workstream_id === execution.workstream_id && item.executor === 'repository_verify')
        .length < 2
    );
  if (execution.executor === 'repository_integrate')
    return !active.some(
      (item) => item.workstream_id === execution.workstream_id && item.executor !== 'repository_integrate'
    );
  return true;
}
function reserveRepositoryCapacity(state, execution) {
  if (execution.executor !== 'repository_change') return;
  const line = lineForExecution(state, execution);
  if (line) {
    line.active_writer_execution_id = execution.id;
    line.updated_at = now();
  }
}
function releaseRepositoryCapacity(state, execution) {
  const line = lineForExecution(state, execution);
  if (line?.active_writer_execution_id === execution.id) {
    line.active_writer_execution_id = null;
    line.updated_at = now();
  }
}
function requiredOutputsAccepted(state, execution) {
  const contract = state.node_contracts.find((item) => item.id === execution.contract_id);
  return (contract?.expected_outputs || [])
    .filter((item) => item.required !== false)
    .every((slot) =>
      (execution.output_bindings || []).some(
        (binding) => binding.key === slot.key && bindingIsConsumable(state, binding)
      )
    );
}
function bindingIsConsumable(state, binding) {
  const asset = state.assets.find(
      (item) =>
        item.id === binding.asset_id && item.current_version_id === binding.version_id && item.status === 'confirmed'
    ),
    version = state.asset_versions.find(
      (item) =>
        item.id === binding.version_id &&
        item.asset_id === asset?.id &&
        item.verification_status === 'verified' &&
        item.immutable === true
    ),
    attestation = state.asset_attestations.find(
      (item) =>
        item.asset_version_id === version?.id &&
        item.decision === 'accepted' &&
        (item.confirmation_policy !== 'system_evidence' || item.attestor_type === 'trusted_verifier')
    );
  return Boolean(asset && version && attestation);
}
function assertIntegrationEvidence(state, execution, evidence) {
  const pullRequest = evidence.pull_request || evidence.pr || {};
  if (
    pullRequest.merged !== true ||
    !pullRequest.merged_sha ||
    pullRequest.head_sha !== pullRequest.expected_head_sha ||
    pullRequest.base_ref !== pullRequest.expected_base_ref
  )
    throw new HttpError(409, { error: 'integration_pull_request_not_verified' });
  const approvals = Array.isArray(pullRequest.approvals) ? pullRequest.approvals : [];
  if (approvals.length < 2) throw new HttpError(409, { error: 'integration_two_approvals_required' });
  const checks = Array.isArray(pullRequest.checks) ? pullRequest.checks : [];
  if (checks.length) {
    if (checks.some((item) => !['success', 'passed', 'completed'].includes(item.status || item.conclusion)))
      throw new HttpError(409, { error: 'integration_checks_failed' });
  } else {
    const siblings = currentTaskExecutions(state, execution.workflow_execution_id).filter(
      (item) => item.workstream_id === execution.workstream_id && item.id !== execution.id
    );
    const internal = siblings
      .flatMap((item) => item.output_bindings || [])
      .some((binding) => /TestReport|TestEvidence/i.test(binding.asset_type) && bindingIsConsumable(state, binding));
    if (evidence.checks_policy !== 'internal_test_report' || !internal)
      throw new HttpError(409, { error: 'integration_checks_required' });
  }
}
function assertExecutionRevisionCurrent(state, execution) {
  const workflow = state.workflows.find((item) => item.id === execution.workflow_id);
  if (!workflow || Number(workflow.workflow_revision || workflow.version || 1) !== execution.workflow_revision)
    throw new HttpError(409, { error: 'workflow_execution_revision_superseded' });
}
function latestExecutionForTask(state, workflowExecutionId, taskId) {
  return (
    state.task_executions
      .filter((item) => item.workflow_execution_id === workflowExecutionId && item.task_id === taskId)
      .sort((a, b) => b.attempt - a.attempt)[0] || null
  );
}
function lineForExecution(state, execution) {
  return state.repository_lines.find(
    (item) =>
      item.workflow_execution_id === execution.workflow_execution_id && item.workstream_id === execution.workstream_id
  );
}
function requiresRepositoryLine(execution) {
  return ['repository_change', 'repository_verify', 'repository_integrate'].includes(execution.executor);
}
function repositoryLinesFor(state, workflowExecutionId) {
  return state.repository_lines.filter((item) => item.workflow_execution_id === workflowExecutionId);
}
function taskExecutionsFor(state, workflowExecutionId) {
  return state.task_executions.filter((item) => item.workflow_execution_id === workflowExecutionId);
}
function snapshot(state, workflowExecution) {
  return {
    workflow_execution: workflowExecution,
    task_executions: currentTaskExecutions(state, workflowExecution.id),
    repository_lines: repositoryLinesFor(state, workflowExecution.id),
    events: state.execution_events.filter((item) => item.workflow_execution_id === workflowExecution.id)
  };
}
function dependencyIds(node) {
  return [
    ...new Set(
      (node?.dependencies || []).map((item) => (typeof item === 'string' ? item : item.node_id)).filter(Boolean)
    )
  ];
}
function taskOrder(state, execution) {
  return Number(state.workflow_nodes.find((item) => item.id === execution.task_id)?.order_index || 0);
}
function byOrder(left, right) {
  return (
    Number(left.order_index || 0) - Number(right.order_index || 0) || String(left.id).localeCompare(String(right.id))
  );
}
function byNewest(left, right) {
  return String(right.updated_at || right.created_at || '').localeCompare(
    String(left.updated_at || left.created_at || '')
  );
}
function safeRef(value) {
  const ref = clean(value, 240);
  if (!/^[A-Za-z0-9._/-]{1,240}$/.test(ref) || ref.includes('..'))
    throw new HttpError(400, { error: 'repository_ref_invalid' });
  return ref;
}
function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
function executionEvidence(value) {
  const result = structuredClone(value || {});
  delete result.repository_payload;
  delete result.raw_payload;
  return result;
}
