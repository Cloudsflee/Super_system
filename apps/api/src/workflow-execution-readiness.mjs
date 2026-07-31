import { now } from '../../../packages/shared/index.mjs';
import { inspectWorkstreamDependencyHandoff, selectTaskOutputBindings } from './task-execution-context.mjs';
import { taskHandoffDiagnostics } from './task-handoff.mjs';
import { dependencyIds, workflowNodeDependsOn } from './workflow-graph-validation.mjs';
import {
  bindingIsConsumable,
  currentTaskExecutions,
  latestExecutionForTask,
  lineForExecution,
  requiresRepositoryLine,
  requiredOutputsAccepted
} from './workflow-execution-support.mjs';

export function taskExecutionReadiness(state, execution) {
  const workflowExecution = state.workflow_executions.find((item) => item.id === execution.workflow_execution_id),
    task = state.workflow_nodes.find((item) => item.id === execution.task_id),
    reasons = [];
  if (!workflowExecution || !task) return { ready: false, reasons: [{ code: 'execution_scope_missing' }] };

  addExecutionScopeReasons(workflowExecution, task, execution, reasons);
  addTaskDependencyReasons(state, task, execution, reasons);
  addWorkstreamDependencyReasons(state, execution, reasons);
  addContractInputReasons(state, task, execution, reasons);
  addRepositoryReasons(state, execution, reasons);
  addIntegrationReasons(state, execution, reasons);
  return {
    ready: reasons.length === 0,
    reasons,
    checked_at: now(),
    handoff: taskHandoffDiagnostics(state, execution)
  };
}

function addExecutionScopeReasons(workflowExecution, task, execution, reasons) {
  if (workflowExecution.status === 'paused') reasons.push({ code: 'workflow_paused' });
  if (Number(task.execution_revision || 1) !== execution.task_revision)
    reasons.push({
      code: 'task_revision_superseded',
      expected: execution.task_revision,
      actual: Number(task.execution_revision || 1)
    });
  if (task.current_contract_id !== execution.contract_id)
    reasons.push({ code: 'contract_superseded', expected: execution.contract_id, actual: task.current_contract_id });
}

function addTaskDependencyReasons(state, task, execution, reasons) {
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
}

function addWorkstreamDependencyReasons(state, execution, reasons) {
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
}

function addContractInputReasons(state, task, execution, reasons) {
  const contract = state.node_contracts.find((item) => item.id === execution.contract_id);
  for (const slot of contract?.expected_inputs || []) {
    if (slot.required === false) continue;
    if (slot.source === 'dependency') addTaskInputReasons(state, task, execution, slot, reasons);
    if (slot.source === 'workstream_dependency') addWorkstreamInputReasons(state, execution, slot, reasons);
  }
}

function addTaskInputReasons(state, task, execution, slot, reasons) {
  const dependencyTaskId = slot.ref_id || dependencyIds(task)[0],
    dependency = latestExecutionForTask(state, execution.workflow_execution_id, dependencyTaskId),
    dependencyTask = state.workflow_nodes.find((item) => item.id === dependencyTaskId),
    bindings = selectTaskOutputBindings(state, dependencyTask, dependency, slot.selector);
  if (!bindings.length) {
    reasons.push({ code: 'required_input_missing', slot_key: slot.key });
    return;
  }
  for (const binding of bindings)
    if (!bindingIsConsumable(state, binding))
      reasons.push({ code: 'input_asset_unverified', slot_key: slot.key, version_id: binding.version_id });
}

function addWorkstreamInputReasons(state, execution, slot, reasons) {
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

function addRepositoryReasons(state, execution, reasons) {
  if (!requiresRepositoryLine(execution)) return;
  const line = lineForExecution(state, execution);
  if (!line) reasons.push({ code: 'repository_line_missing' });
  else if (!['active', 'integrating'].includes(line.status))
    reasons.push({ code: 'repository_line_not_active', status: line.status });
  else if (!line.checkout_path || !line.head_sha)
    reasons.push({ code: 'repository_line_provisioning', repository_line_id: line.id });
}

function addIntegrationReasons(state, execution, reasons) {
  if (execution.executor !== 'repository_integrate') return;
  const siblings = currentTaskExecutions(state, execution.workflow_execution_id).filter(
      (item) => item.workstream_id === execution.workstream_id && item.id !== execution.id
    ),
    incomplete = siblings.filter(
      (item) =>
        item.status !== 'completed' && !workflowNodeDependsOn(state.workflow_nodes, item.task_id, execution.task_id)
    );
  if (incomplete.length)
    reasons.push({ code: 'workstream_tasks_incomplete', task_execution_ids: incomplete.map((item) => item.id) });
}
