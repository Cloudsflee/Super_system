import fsp from 'node:fs/promises';

import { HttpError } from './http.mjs';
import { STATE_FILE } from './config.mjs';
import { prepareRepositoryIntegration } from './repository-integration-service.mjs';
import { provisionWorkflowRepositoryLines } from './repository-line-service.mjs';
import { mutate, readState } from './state.mjs';
import {
  claimTaskExecution,
  prepareTaskExecutionInState,
  submitTaskExecutionOutputs
} from './task-execution-service.mjs';
import {
  appendExecutionEvent,
  failTaskExecutionInState,
  reconcileWorkflowExecutionInState,
  requireTaskExecution,
  retryTaskExecutionInState,
  transitionTaskExecutionInState
} from './workflow-execution-domain.mjs';

const pumps = new Map();
let sweepTimer = null;
let lastSweepMtimeMs = null;

export function startWorkflowDispatcher({ intervalMs = 1_000 } = {}) {
  if (sweepTimer) return () => stopWorkflowDispatcher();
  void scheduleAllActiveWorkflowExecutions();
  sweepTimer = setInterval(() => void scheduleAllActiveWorkflowExecutions(), Math.max(250, intervalMs));
  sweepTimer.unref?.();
  return () => stopWorkflowDispatcher();
}

export function stopWorkflowDispatcher() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  lastSweepMtimeMs = null;
}

export function scheduleWorkflowExecution(workflowExecutionId) {
  if (!workflowExecutionId || pumps.has(workflowExecutionId)) return pumps.get(workflowExecutionId) || null;
  const promise = new Promise((resolve) => setImmediate(resolve))
    .then(() => dispatchWorkflowExecution(workflowExecutionId))
    .catch((error) => {
      console.error('workflow dispatch failed', error?.payload?.error || error?.code || error?.message || error);
      return null;
    })
    .finally(() => pumps.delete(workflowExecutionId));
  pumps.set(workflowExecutionId, promise);
  return promise;
}

export async function dispatchWorkflowExecution(workflowExecutionId) {
  await provisionMissingLines(workflowExecutionId);
  await resumeMergedIntegrations(workflowExecutionId);
  for (let pass = 0; pass < 1_000; pass += 1) {
    const queued = await mutate((state) => {
      const workflow = state.workflow_executions.find((item) => item.id === workflowExecutionId);
      if (!workflow || workflow.status !== 'running') return [];
      reconcileWorkflowExecutionInState(state, workflow.id);
      return state.task_executions
        .filter((item) => item.workflow_execution_id === workflow.id && item.status === 'queued')
        .map((item) => item.id);
    });
    if (!queued.length) return;
    await Promise.all(queued.map((taskExecutionId) => executeQueuedTask(taskExecutionId)));
  }
  throw new HttpError(500, { error: 'workflow_dispatch_pass_limit_exceeded' });
}

async function executeQueuedTask(taskExecutionId) {
  try {
    const state = await readState(),
      execution = requireTaskExecution(state, taskExecutionId);
    if (execution.status !== 'queued') return;
    if (execution.executor === 'manual') return await prepareManualCheckpoint(execution.id);
    if (execution.executor === 'repository_verify') return await runRepositoryVerification(execution.id);
    if (execution.executor === 'repository_integrate') return await prepareRepositoryIntegration(execution.id);
    if (['assist', 'repository_change'].includes(execution.executor)) return await runNodeExecutor(state, execution);
    throw new HttpError(409, { error: 'task_executor_unsupported', executor: execution.executor });
  } catch (error) {
    try {
      await recordDispatchFailure(taskExecutionId, error);
    } catch (recordError) {
      console.error(
        'workflow dispatch failure recording failed',
        recordError?.payload?.error || recordError?.code || recordError?.message || recordError
      );
    }
  }
}

async function runNodeExecutor(state, execution) {
  const workflow = state.workflow_executions.find((item) => item.id === execution.workflow_execution_id);
  const claim = await claimTaskExecution(execution.id, { holder: `dispatcher:${execution.executor}` });
  const { executeNodeRun } = await import('./routes/runs.mjs');
  const options = workflow?.executor_config || {},
    runner = ['codex_docker', 'codex'].includes(options.runner) ? options.runner : null;
  return executeNodeRun(execution.task_id, {
    task_execution_id: execution.id,
    lease_token: claim.lease_token,
    ...(runner ? { runner } : {}),
    ...(options.adapter === 'test'
      ? { adapter: 'test', test_summary: options.test_summary, test_changes: options.test_changes }
      : {})
  });
}

async function runRepositoryVerification(taskExecutionId) {
  const claim = await claimTaskExecution(taskExecutionId, { holder: 'dispatcher:repository_verify' });
  const execution = claim.task_execution,
    state = await readState();
  const contract = state.node_contracts.find((item) => item.id === execution.contract_id),
    consumed = inputVersions(execution);
  const outputs = (contract?.expected_outputs || []).map((slot) => ({
    output_key: slot.key,
    asset_type: slot.asset_type,
    title: `${slot.key} verification`,
    summary: 'AIWS deterministic repository verification.',
    payload: { payload_kind: 'test_report', media_type: 'application/json', content: {} },
    evidence_refs: [],
    consumed_input_versions: consumed
  }));
  return submitTaskExecutionOutputs(execution.id, {
    outputs,
    leaseToken: claim.lease_token,
    verifierId: 'repository_verify_verifier'
  });
}

async function prepareManualCheckpoint(taskExecutionId) {
  return mutate(async (state) => {
    const execution = requireTaskExecution(state, taskExecutionId);
    if (execution.status !== 'queued') return execution;
    await prepareTaskExecutionInState(state, execution.id);
    transitionTaskExecutionInState(state, execution, 'running', { reason: 'manual_checkpoint_prepared' });
    execution.readiness = { ready: false, reasons: [{ code: 'manual_input_required' }] };
    transitionTaskExecutionInState(state, execution, 'awaiting_human', { reason: 'manual_input_required' });
    appendExecutionEvent(
      state,
      state.workflow_executions.find((item) => item.id === execution.workflow_execution_id),
      execution,
      'task.manual_checkpoint',
      {},
      'system',
      null
    );
    reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
    return execution;
  });
}

async function recordDispatchFailure(taskExecutionId, error) {
  return mutate((state) => {
    const execution = state.task_executions.find((item) => item.id === taskExecutionId);
    if (!execution) return null;
    const workflow = state.workflow_executions.find((item) => item.id === execution.workflow_execution_id);
    const errorCode = error?.payload?.error || error?.code || error?.message || 'task_dispatch_failed';
    const retryClass = transientError(errorCode, error) ? 'transient' : 'deterministic';
    if (['queued', 'running', 'verifying', 'awaiting_human'].includes(execution.status))
      failTaskExecutionInState(state, execution.id, { errorCode, retryClass });
    else if (execution.status !== 'failed') return execution;
    else if (execution.retry_class !== 'transient' && retryClass !== 'transient') {
      reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
      return execution;
    }
    const attempts = state.task_executions.filter(
      (item) => item.workflow_execution_id === execution.workflow_execution_id && item.task_id === execution.task_id
    );
    if (retryClass === 'transient' && attempts.length < 2 && workflow?.status === 'running')
      retryTaskExecutionInState(state, execution.id, null);
    else reconcileWorkflowExecutionInState(state, execution.workflow_execution_id);
    return execution;
  });
}

async function provisionMissingLines(workflowExecutionId) {
  const state = await readState(),
    lines = state.repository_lines.filter(
      (item) => item.workflow_execution_id === workflowExecutionId && item.status === 'active' && !item.checkout_path
    );
  if (lines.length) await provisionWorkflowRepositoryLines(workflowExecutionId);
}

async function resumeMergedIntegrations(workflowExecutionId) {
  const state = await readState();
  const pending = state.task_executions.filter(
    (item) =>
      item.workflow_execution_id === workflowExecutionId &&
      item.executor === 'repository_integrate' &&
      item.status === 'awaiting_human'
  );
  for (const execution of pending) {
    const intent = state.pull_request_intents.find(
      (item) => item.id === execution.integration?.pull_request_intent_id && item.status === 'merged'
    );
    if (!intent) continue;
    const { advanceRepositoryIntegration } = await import('./repository-integration-service.mjs');
    await advanceRepositoryIntegration(
      intent.id,
      'merge_pr',
      { merge_commit_sha: intent.merge_commit_sha, checks_status: intent.checks_status, checks: intent.checks || [] },
      intent.merged_by_user_id
    ).catch(() => undefined);
  }
}

async function scheduleAllActiveWorkflowExecutions() {
  const metadata = await fsp.stat(STATE_FILE).catch(() => null);
  if (!metadata || metadata.mtimeMs === lastSweepMtimeMs) return;
  lastSweepMtimeMs = metadata.mtimeMs;
  const state = await readState().catch(() => null);
  for (const item of state?.workflow_executions || [])
    if (item.status === 'running') scheduleWorkflowExecution(item.id);
}

function inputVersions(execution) {
  return [
    ...new Set(
      (execution.context_snapshot?.inputs || [])
        .flatMap((item) => item.asset_versions || [])
        .map((item) => item.version_id)
    )
  ];
}
function transientError(code, error) {
  return (
    error?.retryable === true ||
    error?.payload?.retryable === true ||
    /timeout|timed_out|network|connection|temporar|service_restarted|container_start|fetch_failed|github_.*(?:read|request|list)_failed/i.test(
      String(code)
    )
  );
}
