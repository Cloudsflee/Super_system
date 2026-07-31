import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { repositoryBranchSlug } from './workflow-branch-ref.mjs';
import { dependencyIds } from './workflow-graph-validation.mjs';
import { executorForTask } from './workflow-executor-config.mjs';
import { restoreLegacyRetryCompatibility } from './workflow-retry-compatibility.mjs';
import { ACTIVE_WORKFLOW_EXECUTION_STATUSES, TERMINAL_TASK_EXECUTION_STATUSES } from './workflow-execution-status.mjs';

const TERMINAL_TASK_STATUSES = new Set(TERMINAL_TASK_EXECUTION_STATUSES);
const ACTIVE_WORKFLOW_STATUSES = new Set(ACTIVE_WORKFLOW_EXECUTION_STATUSES);

export function activeTaskExecutionForTask(state, taskId) {
  return (
    state.task_executions
      .filter(
        (item) =>
          item.task_id === taskId &&
          !TERMINAL_TASK_STATUSES.has(item.status) &&
          ACTIVE_WORKFLOW_STATUSES.has(
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

export function createRepositoryLinesInState(state, workflowExecution, workstreams, selections) {
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

export function normalizeRepositorySelection(state, project, workstreams, source) {
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

export function workflowDefinitionSnapshot(state, workflow, nodes) {
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

export function queueCapacityAvailable(state, execution) {
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

export function reserveRepositoryCapacity(state, execution) {
  if (execution.executor !== 'repository_change') return;
  const line = lineForExecution(state, execution);
  if (line) {
    line.active_writer_execution_id = execution.id;
    line.updated_at = now();
  }
}

export function releaseRepositoryCapacity(state, execution) {
  const line = lineForExecution(state, execution);
  if (line?.active_writer_execution_id === execution.id) {
    line.active_writer_execution_id = null;
    line.updated_at = now();
  }
}

export function requiredOutputsAccepted(state, execution) {
  const contract = state.node_contracts.find((item) => item.id === execution.contract_id);
  return (contract?.expected_outputs || [])
    .filter((item) => item.required !== false)
    .every((slot) =>
      (execution.output_bindings || []).some(
        (binding) => binding.key === slot.key && bindingIsConsumable(state, binding)
      )
    );
}

export function bindingIsConsumable(state, binding) {
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

export function assertIntegrationEvidence(state, execution, evidence) {
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

export function assertExecutionRevisionCurrent(state, execution) {
  const workflow = state.workflows.find((item) => item.id === execution.workflow_id);
  if (!workflow || Number(workflow.workflow_revision || workflow.version || 1) !== execution.workflow_revision)
    throw new HttpError(409, { error: 'workflow_execution_revision_superseded' });
}

export function latestExecutionForTask(state, workflowExecutionId, taskId) {
  return (
    state.task_executions
      .filter((item) => item.workflow_execution_id === workflowExecutionId && item.task_id === taskId)
      .sort((a, b) => b.attempt - a.attempt)[0] || null
  );
}

export function lineForExecution(state, execution) {
  return state.repository_lines.find(
    (item) =>
      item.workflow_execution_id === execution.workflow_execution_id && item.workstream_id === execution.workstream_id
  );
}

export function repositoryLinesFor(state, workflowExecutionId) {
  return state.repository_lines.filter((item) => item.workflow_execution_id === workflowExecutionId);
}

export function taskExecutionsFor(state, workflowExecutionId) {
  return state.task_executions.filter((item) => item.workflow_execution_id === workflowExecutionId);
}

export function workflowExecutionSnapshot(state, workflowExecution) {
  return {
    workflow_execution: workflowExecution,
    task_executions: currentTaskExecutions(state, workflowExecution.id),
    repository_lines: repositoryLinesFor(state, workflowExecution.id),
    events: state.execution_events.filter((item) => item.workflow_execution_id === workflowExecution.id)
  };
}

export function taskOrder(state, execution) {
  return Number(state.workflow_nodes.find((item) => item.id === execution.task_id)?.order_index || 0);
}

export function byOrder(left, right) {
  return (
    Number(left.order_index || 0) - Number(right.order_index || 0) || String(left.id).localeCompare(String(right.id))
  );
}

export function byNewest(left, right) {
  return String(right.updated_at || right.created_at || '').localeCompare(
    String(left.updated_at || left.created_at || '')
  );
}

export function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

export function executionEvidence(value) {
  const result = structuredClone(value || {});
  delete result.repository_payload;
  delete result.raw_payload;
  return result;
}

export function pendingTaskExecution(workflowExecution, task, contract, actorId, createdAt) {
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
    failure: null,
    current_stage: null,
    stage_checkpoint_ids: [],
    replay_count: 0,
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

export function restoreLegacyRetryRepositoryLine(state, previous, retry, actorId) {
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

export function requiresRepositoryLine(execution) {
  return ['repository_change', 'repository_verify', 'repository_integrate'].includes(execution.executor);
}

function safeRef(value) {
  const ref = clean(value, 240);
  if (!/^[A-Za-z0-9._/-]{1,240}$/.test(ref) || ref.includes('..'))
    throw new HttpError(400, { error: 'repository_ref_invalid' });
  return ref;
}
