import { now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';

export function projectWorkflowExecutionStateInState(state, workflowExecutionId) {
  const workflowExecution = state.workflow_executions.find((item) => item.id === workflowExecutionId);
  if (!workflowExecution) throw new HttpError(404, { error: 'workflow_execution_not_found' });
  const current = currentTaskExecutions(state, workflowExecutionId);
  const byTask = new Map(current.map((item) => [item.task_id, item]));
  for (const task of state.workflow_nodes.filter(
    (item) => item.workflow_id === workflowExecution.workflow_id && item.role === 'task'
  )) {
    const execution = byTask.get(task.id);
    if (!execution) continue;
    task.status = projectionStatus(execution.status);
    task.current_task_execution_id = execution.id;
    task.current_attempt = execution.attempt;
    task.waiting_reasons = execution.readiness?.reasons || [];
    task.updated_at = now();
  }
  for (const workstream of state.workflow_nodes.filter(
    (item) => item.workflow_id === workflowExecution.workflow_id && item.role === 'workstream'
  )) {
    const items = current.filter((item) => item.workstream_id === workstream.id);
    const requiredIds = new Set(
      state.workflow_nodes
        .filter((item) => item.parent_node_id === workstream.id && item.required !== false)
        .map((item) => item.id)
    );
    const required = items.filter((item) => requiredIds.has(item.task_id));
    workstream.status = workstreamStatus(workstream, required);
    workstream.current_workflow_execution_id = workflowExecution.id;
    workstream.updated_at = now();
  }
  return current;
}

function currentTaskExecutions(state, workflowExecutionId) {
  const grouped = new Map();
  for (const item of state.task_executions
    .filter((entry) => entry.workflow_execution_id === workflowExecutionId)
    .sort((a, b) => a.attempt - b.attempt))
    grouped.set(item.task_id, item);
  return [...grouped.values()];
}

function projectionStatus(status) {
  return (
    {
      pending: 'blocked',
      ready: 'ready',
      queued: 'ready',
      running: 'running',
      verifying: 'running',
      awaiting_human: 'needs_review',
      completed: 'completed',
      failed: 'blocked',
      cancelled: 'blocked',
      superseded: 'blocked'
    }[status] || 'blocked'
  );
}

function workstreamStatus(workstream, required) {
  const authoritative = authoritativeWorkstreamStatus(workstream);
  if (authoritative) return authoritative;
  if (required.length && required.every((item) => item.status === 'completed')) return 'ready_for_submission';
  if (required.some((item) => ['running', 'verifying', 'awaiting_human', 'completed'].includes(item.status)))
    return 'running';
  if (required.some((item) => item.status === 'failed')) return 'blocked';
  return 'ready';
}

export function authoritativeWorkstreamStatus(workstream) {
  if (workstream.status === 'needs_review' || workstream.status === 'completed') return workstream.status;
  if (workstream.review?.decision === 'reject' && workstream.status === 'blocked') return 'blocked';
  if (!workstream.latest_submission_id || !workstream.reviewed_at) return null;
  if (workstream.review?.decision === 'approve') return 'completed';
  if (workstream.review?.decision === 'reject') return 'blocked';
  return null;
}
