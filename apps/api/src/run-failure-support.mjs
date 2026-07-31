import { RunnerStatus, now } from '../../../packages/shared/index.mjs';
import { beginExecutionStageInState, failExecutionStageInState } from './execution-stage-service.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner } from './state.mjs';
import { failTaskExecutionInState, reconcileWorkflowExecutionInState } from './workflow-execution-domain.mjs';

export async function failNodeRun(runId, error, stageToken = null) {
  return mutate((state) => failNodeRunInState(state, runId, error, stageToken));
}

export function controlledRunnerResultError(result, controlled = true) {
  if (!controlled) return null;
  if (!controlledResultSchema(result?.schema_version))
    return new HttpError(409, { error: 'slot_aware_runner_output_required', retryable: false });
  if (result.status === RunnerStatus.Succeeded) return null;
  const process = result?._codex_process || {};
  const retryable = process.retryable === true;
  const code = process.failure_code || 'task_runner_result_unsuccessful';
  const error = new HttpError(retryable ? 503 : 409, { error: code, runner_status: result.status, retryable });
  error.code = code;
  error.retryable = retryable;
  return error;
}

function failNodeRunInState(state, runId, error, stageToken) {
  const run = state.node_runs.find((item) => item.id === runId);
  if (!run || run.status === RunnerStatus.Cancelled) return run;
  const diagnosticsPersisted = Boolean(run.raw_output_file_ref_id);
  const alreadyFailed = run.status === RunnerStatus.Failed;
  markNodeRunFailed(state, run, error);
  const taskExecution = state.task_executions.find((item) => item.id === run.task_execution_id);
  const checkpoint = taskExecutionCheckpoint(state, taskExecution, run, error, stageToken);
  failControlledTaskExecution(state, taskExecution, run, error, checkpoint);
  if (!diagnosticsPersisted && !alreadyFailed) traceNodeRunFailure(state, run);
  return run;
}

function controlledResultSchema(schemaVersion) {
  return ['aiws.task_runner_result.v2', 'aiws.task_runner_result.v3', 'aiws.task_runner_result.v4'].includes(
    schemaVersion
  );
}

function markNodeRunFailed(state, run, error) {
  Object.assign(run, {
    status: RunnerStatus.Failed,
    error_code: error?.payload?.error || error?.code || 'node_run_failed',
    completed_at: now(),
    updated_at: now()
  });
  if (!run.summary) run.summary = String(error.message || error);
  const node = state.workflow_nodes.find((item) => item.id === run.node_id);
  if (node) node.status = 'blocked';
}

function taskExecutionCheckpoint(state, taskExecution, run, error, stageToken) {
  if (!taskExecution || Number(state.schema_version || 0) < 21) return null;
  const token =
    stageToken ||
    beginExecutionStageInState(state, {
      workflowExecutionId: taskExecution.workflow_execution_id,
      taskExecutionId: taskExecution.id,
      stage: taskExecution.current_stage || 'execute',
      input: { node_run_id: run.id }
    });
  const duplicate = matchingFailedCheckpoint(state, taskExecution.id, token);
  return (
    duplicate ||
    failExecutionStageInState(state, token, error, {
      category: stageFailureCategory(token.stage),
      retryable: error?.retryable === true
    })
  );
}

function matchingFailedCheckpoint(state, taskExecutionId, token) {
  return state.execution_stage_checkpoints.find(
    (item) =>
      item.task_execution_id === taskExecutionId &&
      item.stage === token.stage &&
      item.status === 'failed' &&
      item.input_hash === token.input_hash
  );
}

function stageFailureCategory(stage) {
  if (stage === 'verify') return 'verifier';
  return stage === 'collect' ? 'integrity' : 'runner';
}

function failControlledTaskExecution(state, taskExecution, run, error, checkpoint) {
  if (!taskExecution || !['queued', 'running', 'verifying', 'awaiting_human'].includes(taskExecution.status)) return;
  failTaskExecutionInState(state, taskExecution.id, {
    errorCode: run.error_code,
    retryClass: error?.retryable ? 'transient' : 'deterministic',
    failure: checkpoint?.failure || null,
    stage: checkpoint?.stage || taskExecution.current_stage || 'execute'
  });
  reconcileWorkflowExecutionInState(state, taskExecution.workflow_execution_id);
}

function traceNodeRunFailure(state, run) {
  addTrace(
    state,
    'runner.failed',
    {
      project_id: run.project_id,
      workspace_id: run.workspace_id,
      node_id: run.node_id,
      run_id: run.id,
      summary: `Runner 启动失败：${run.summary}`
    },
    owner(state).id
  );
}
