import { HttpError } from './http.mjs';
import { activeTaskExecutionForTask, assertTaskExecutionLease } from './workflow-execution-domain.mjs';

export function assertControlledTaskWrite(state, taskId, input = {}, operation = 'write') {
  const task = state.workflow_nodes.find((item) => item.id === taskId && item.role === 'task'),
    workflow = state.workflows.find((item) => item.id === task?.workflow_id);
  if (!task || !workflow || workflow.planning_quality !== 'verified')
    return { controlled: false, task_execution: null };
  const active = activeTaskExecutionForTask(state, task.id);
  const workflowExecution = state.workflow_executions.find(
    (item) => item.workflow_id === workflow.id && ['running', 'paused'].includes(item.status)
  );
  if (!workflowExecution)
    throw new HttpError(409, { error: 'workflow_execution_required', workflow_id: workflow.id, task_id: task.id });
  if (!active)
    throw new HttpError(409, {
      error: 'active_task_execution_required',
      workflow_execution_id: workflowExecution.id,
      task_id: task.id
    });
  if (input.task_execution_id !== active.id)
    throw new HttpError(409, { error: 'task_execution_binding_required', expected_task_execution_id: active.id });
  const checked = assertTaskExecutionLease(state, {
    taskExecutionId: active.id,
    leaseToken: input.lease_token,
    taskId: task.id,
    operation
  });
  return { controlled: true, task_execution: checked.execution, workflow_execution: workflowExecution };
}

export function assertControlledProjectWrite(state, { projectId, taskExecutionId, leaseToken, operation = 'write' }) {
  const activeWorkflow = state.workflow_executions.find(
    (item) => item.project_id === projectId && ['running', 'paused'].includes(item.status)
  );
  if (!activeWorkflow) {
    const verifiedWorkflow = state.workflows.find(
      (item) => item.project_id === projectId && item.planning_quality === 'verified' && item.status !== 'archived'
    );
    if (verifiedWorkflow)
      throw new HttpError(409, { error: 'workflow_execution_required', workflow_id: verifiedWorkflow.id });
    return { controlled: false };
  }
  const execution = state.task_executions.find(
    (item) => item.id === taskExecutionId && item.workflow_execution_id === activeWorkflow.id
  );
  if (!execution)
    throw new HttpError(409, { error: 'task_execution_binding_required', workflow_execution_id: activeWorkflow.id });
  return {
    controlled: true,
    ...assertTaskExecutionLease(state, { taskExecutionId: execution.id, leaseToken, operation })
  };
}
