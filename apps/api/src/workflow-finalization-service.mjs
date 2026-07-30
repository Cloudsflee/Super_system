import { now } from '../../../packages/shared/index.mjs';
import { collectProjectionFailures } from './context-projection.mjs';
import { ensureContextProjection } from './context-service.mjs';
import {
  beginExecutionStageInState,
  completeExecutionStageInState,
  failExecutionStageInState
} from './execution-stage-service.mjs';
import { finalizeWorkflowOutcomesInState, evaluateWorkflowOutcomesInState } from './outcome-service.mjs';
import { mutate, readState } from './state.mjs';
import { appendExecutionEvent } from './workflow-execution-domain.mjs';

const finalizers = new Map();

export function scheduleWorkflowFinalization(workflowExecutionId, options = {}) {
  if (!workflowExecutionId || finalizers.has(workflowExecutionId)) return finalizers.get(workflowExecutionId) || null;
  const pending = new Promise((resolve) => setImmediate(resolve))
    .then(() => finalizeWorkflowExecution(workflowExecutionId, options))
    .finally(() => finalizers.delete(workflowExecutionId));
  finalizers.set(workflowExecutionId, pending);
  return pending;
}

export async function finalizeWorkflowExecution(
  workflowExecutionId,
  { forceContext = false, replayToken = null } = {}
) {
  const initial = await readState(),
    execution = initial.workflow_executions.find((item) => item.id === workflowExecutionId);
  if (!execution || !execution.completion_status || execution.status !== 'running') return null;
  const tasks = currentTasks(initial, execution.id);
  if (!tasks.length || tasks.some((item) => item.status !== 'completed')) return null;

  await mutate((state) => {
    const current = state.workflow_executions.find((item) => item.id === workflowExecutionId);
    if (!current || current.status !== 'running') return null;
    current.finalization_state = 'evaluating';
    current.updated_at = now();
    evaluateWorkflowOutcomesInState(state, current.id);
    return current;
  });

  let projection;
  try {
    projection = await ensureContextProjection({ projectId: execution.project_id, force: forceContext });
    const projected = await readState(),
      failures = collectProjectionFailures(projected, { projectId: execution.project_id });
    if (failures.length) {
      const error = new Error('context_projection_unavailable');
      error.code = 'context_projection_unavailable';
      error.retryable = failures.some((item) => Number(item.job?.attempts || 0) < 3);
      error.details = {
        failures: failures.map((item) => ({ node_id: item.node_id, attempts: item.job?.attempts || 0 }))
      };
      throw error;
    }
  } catch (error) {
    return mutate((state) => {
      const current = state.workflow_executions.find((item) => item.id === workflowExecutionId);
      if (!current || current.status !== 'running') return null;
      const lastTask = lastCurrentTask(state, current.id),
        token =
          replayToken ||
          beginExecutionStageInState(state, {
            workflowExecutionId: current.id,
            taskExecutionId: lastTask?.id || null,
            stage: 'finalize',
            input: { outcome_contract_hash: current.outcome_contract_hash, project_id: current.project_id }
          });
      const checkpoint = failExecutionStageInState(state, token, error, {
        category: 'context',
        retryable: error?.retryable === true,
        details: error?.details || {}
      });
      current.finalization_state = 'failed';
      current.finalization_attempts = Number(current.finalization_attempts || 0) + 1;
      current.finalization_failure = checkpoint.failure;
      current.updated_at = now();
      appendExecutionEvent(
        state,
        current,
        lastTask,
        'workflow.finalization_failed',
        { checkpoint_id: checkpoint.id, error_code: checkpoint.failure.code },
        'system',
        null
      );
      return { workflow_execution: current, projection, checkpoint };
    });
  }

  return mutate((state) => {
    const current = state.workflow_executions.find((item) => item.id === workflowExecutionId);
    if (!current || current.status !== 'running') return null;
    const lastTask = lastCurrentTask(state, current.id),
      token =
        replayToken ||
        beginExecutionStageInState(state, {
          workflowExecutionId: current.id,
          taskExecutionId: lastTask?.id || null,
          stage: 'finalize',
          input: { outcome_contract_hash: current.outcome_contract_hash, project_id: current.project_id }
        }),
      result = finalizeWorkflowOutcomesInState(state, current.id),
      checkpoint = completeExecutionStageInState(state, token, {
        output: {
          completion_status: current.completion_status,
          release_eligible: current.release_eligible,
          outcome_summary: current.outcome_summary
        }
      });
    current.finalization_failure = null;
    appendExecutionEvent(
      state,
      current,
      lastTask,
      'workflow.completed',
      {
        completion_status: current.completion_status,
        release_eligible: current.release_eligible,
        checkpoint_id: checkpoint.id
      },
      'system',
      null
    );
    return { ...result, projection, checkpoint };
  });
}

function currentTasks(state, workflowExecutionId) {
  const candidates = state.task_executions.filter((item) => item.workflow_execution_id === workflowExecutionId),
    superseded = new Set(candidates.map((item) => item.supersedes_id).filter(Boolean));
  return candidates.filter((item) => item.status !== 'superseded' && !superseded.has(item.id));
}

function lastCurrentTask(state, workflowExecutionId) {
  return (
    currentTasks(state, workflowExecutionId).sort((left, right) =>
      String(right.completed_at || right.updated_at).localeCompare(String(left.completed_at || left.updated_at))
    )[0] || null
  );
}
