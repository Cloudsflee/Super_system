import { HttpError, makeRoute, send } from '../http.mjs';
import { provisionWorkflowRepositoryLines } from '../repository-line-service.mjs';
import { mutate, owner, readState } from '../state.mjs';
import { approveTaskExecution, retryTaskExecution, submitTaskExecutionOutputs } from '../task-execution-service.mjs';
import { scheduleWorkflowExecution } from '../workflow-dispatcher.mjs';
import {
  cancelWorkflowExecutionInState,
  createWorkflowExecutionInState,
  pauseWorkflowExecutionInState,
  reconcileWorkflowExecutionInState,
  requireTaskExecution,
  requireWorkflowExecution,
  resumeWorkflowExecutionInState,
  taskExecutionReadiness
} from '../workflow-execution-domain.mjs';

export const workflowExecutionV110Routes = [
  makeRoute('POST', '/workflows/:id/executions', startWorkflowExecution),
  makeRoute('GET', '/workflows/:id/executions', listWorkflowExecutions),
  makeRoute('GET', '/workflow-executions/:id', getWorkflowExecution),
  makeRoute('GET', '/workflow-executions/:id/events', getWorkflowExecutionEvents),
  makeRoute('POST', '/workflow-executions/:id/pause', pauseWorkflowExecution),
  makeRoute('POST', '/workflow-executions/:id/resume', resumeWorkflowExecution),
  makeRoute('POST', '/workflow-executions/:id/cancel', cancelWorkflowExecution),
  makeRoute('GET', '/tasks/:id/readiness', getTaskReadiness),
  makeRoute('GET', '/task-executions/:id', getTaskExecution),
  makeRoute('GET', '/task-executions/:id/readiness', getTaskExecutionReadiness),
  makeRoute('POST', '/task-executions/:id/retry', retryTask),
  makeRoute('POST', '/task-executions/:id/manual-submit', manualSubmit),
  makeRoute('POST', '/task-executions/:id/human-approve', humanApprove)
];

async function startWorkflowExecution({ req, res, params, body }) {
  const operationKey = String(
    body.operation_key || body.idempotency_key || req.headers?.['x-idempotency-key'] || ''
  ).trim();
  const result = await mutate((state) =>
    createWorkflowExecutionInState(
      state,
      params.id,
      { ...body, operation_key: operationKey || null, auto_queue: true },
      owner(state).id
    )
  );
  if (!result.idempotent && result.repository_lines.length) {
    setImmediate(() =>
      provisionWorkflowRepositoryLines(result.workflow_execution.id)
        .then(() => scheduleWorkflowExecution(result.workflow_execution.id))
        .catch((error) => console.error('repository line provisioning failed', error.message))
    );
  } else scheduleWorkflowExecution(result.workflow_execution.id);
  return send(res, result.idempotent ? 200 : 202, executionHandle(result));
}

async function listWorkflowExecutions({ res, params, query }) {
  const state = await readState(),
    workflow = state.workflows.find((item) => item.id === params.id);
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  const items = state.workflow_executions
    .filter((item) => item.workflow_id === workflow.id && (!query.status || item.status === query.status))
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  const current = items.find((item) => ['running', 'paused'].includes(item.status)) || items[0] || null;
  return send(res, 200, { items, current: current ? workflowSnapshot(state, current) : null });
}

async function getWorkflowExecution({ res, params }) {
  const state = await readState(),
    execution = requireWorkflowExecution(state, params.id);
  return send(res, 200, workflowSnapshot(state, execution));
}

async function getWorkflowExecutionEvents({ req, res, params, query }) {
  const after = Math.max(0, Number(query.after || req.headers['last-event-id'] || 0) || 0);
  if (query.format === 'json') {
    const state = await readState(),
      execution = requireWorkflowExecution(state, params.id);
    return send(res, 200, {
      execution,
      events: state.execution_events.filter(
        (item) => item.workflow_execution_id === execution.id && item.sequence > after
      ),
      terminal: ['completed', 'failed', 'cancelled'].includes(execution.status)
    });
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  let cursor = after,
    closed = false,
    timer;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  };
  req.on?.('close', close);
  const poll = async () => {
    if (closed) return;
    try {
      const state = await readState(),
        execution = requireWorkflowExecution(state, params.id),
        events = state.execution_events.filter(
          (item) => item.workflow_execution_id === execution.id && item.sequence > cursor
        );
      for (const event of events) {
        cursor = event.sequence;
        res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (['completed', 'failed', 'cancelled'].includes(execution.status)) {
        res.write(`event: snapshot\ndata: ${JSON.stringify(workflowSnapshot(state, execution))}\n\n`);
        return close();
      }
      timer = setTimeout(poll, 500);
      timer.unref?.();
    } catch (error) {
      res.write(
        `event: error\ndata: ${JSON.stringify(error.payload || { error: 'workflow_execution_events_failed' })}\n\n`
      );
      close();
    }
  };
  await poll();
}

async function pauseWorkflowExecution({ res, params }) {
  const result = await mutate((state) => pauseWorkflowExecutionInState(state, params.id, owner(state).id));
  return send(res, 200, result);
}
async function resumeWorkflowExecution({ res, params }) {
  const result = await mutate((state) => {
    const execution = resumeWorkflowExecutionInState(state, params.id, owner(state).id);
    return workflowSnapshot(state, execution);
  });
  scheduleWorkflowExecution(params.id);
  return send(res, 200, result);
}
async function cancelWorkflowExecution({ res, params }) {
  const result = await mutate((state) => cancelWorkflowExecutionInState(state, params.id, owner(state).id));
  return send(res, 202, result);
}

async function getTaskReadiness({ res, params }) {
  const state = await readState(),
    task = state.workflow_nodes.find((item) => item.id === params.id && item.role === 'task');
  if (!task) throw new HttpError(404, { error: 'task_not_found' });
  const executions = state.task_executions
      .filter((item) => item.task_id === task.id)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.attempt - a.attempt),
    current = executions[0] || null;
  return send(res, 200, {
    task_id: task.id,
    workflow_execution_id: current?.workflow_execution_id || null,
    task_execution_id: current?.id || null,
    status: current?.status || 'not_started',
    attempt: current?.attempt || 0,
    readiness: current?.readiness || { ready: false, reasons: [{ code: 'workflow_execution_not_started' }] }
  });
}
async function getTaskExecution({ res, params }) {
  const state = await readState(),
    execution = requireTaskExecution(state, params.id);
  return send(res, 200, taskSnapshot(state, execution));
}
async function getTaskExecutionReadiness({ res, params }) {
  return send(res, 200, await taskExecutionReadiness(params.id));
}
async function retryTask({ res, params }) {
  const state = await readState(),
    actor = owner(state);
  const execution = await retryTaskExecution(params.id, actor.id);
  scheduleWorkflowExecution(execution.workflow_execution_id);
  return send(res, 202, { operation: execution, task_execution: execution });
}

async function manualSubmit({ res, params, body }) {
  if (body.output_bindings || body.acceptance_results)
    throw new HttpError(400, { error: 'client_output_binding_forbidden' });
  const snapshot = await readState(),
    execution = requireTaskExecution(snapshot, params.id);
  if (!['manual', 'assist'].includes(execution.executor))
    throw new HttpError(409, { error: 'manual_submit_executor_invalid', executor: execution.executor });
  const actor = owner(snapshot),
    result = await submitTaskExecutionOutputs(params.id, { outputs: body.outputs, actorId: actor.id, manual: true });
  scheduleWorkflowExecution(execution.workflow_execution_id);
  return send(res, 200, result);
}

async function humanApprove({ res, params, body }) {
  if (body.output_bindings || body.acceptance_results)
    throw new HttpError(400, { error: 'client_output_binding_forbidden' });
  const snapshot = await readState(),
    actor = owner(snapshot);
  const result = await approveTaskExecution(params.id, {
    decision: body.decision,
    expectedVersions: body.expected_versions,
    summary: body.summary,
    actorId: actor.id
  });
  scheduleWorkflowExecution(result.task_execution.workflow_execution_id);
  return send(res, 200, result);
}

function workflowSnapshot(state, execution) {
  return {
    workflow_execution: execution,
    task_executions: state.task_executions.filter((item) => item.workflow_execution_id === execution.id),
    repository_lines: state.repository_lines.filter((item) => item.workflow_execution_id === execution.id),
    frontier: execution.frontier || [],
    waiting_reasons: execution.waiting_reasons || []
  };
}
function taskSnapshot(state, execution) {
  const task = state.workflow_nodes.find((item) => item.id === execution.task_id),
    contract = state.node_contracts.find((item) => item.id === execution.contract_id),
    workflowExecution = state.workflow_executions.find((item) => item.id === execution.workflow_execution_id),
    intent = state.pull_request_intents.find((item) => item.id === execution.integration?.pull_request_intent_id),
    bindings = new Map((execution.output_bindings || []).map((item) => [item.asset_id, item]));
  const outputs = state.assets
    .filter((item) => item.task_execution_id === execution.id)
    .map((asset) => {
      const binding = bindings.get(asset.id),
        version = state.asset_versions.find((item) => item.id === (binding?.version_id || asset.current_version_id));
      return {
        ...(binding || {
          key: asset.output_key,
          asset_id: asset.id,
          version_id: version?.id,
          asset_type: asset.asset_type,
          content_sha256: version?.content_sha256,
          repository_sha: version?.repository_sha || null,
          confirmation_policy: asset.confirmation_policy
        }),
        bound: Boolean(binding),
        asset,
        version,
        attestation: state.asset_attestations.find((item) => item.id === binding?.attestation_id) || null
      };
    });
  return {
    task_execution: execution,
    workflow_execution: workflowExecution,
    task,
    contract,
    inputs: execution.context_snapshot?.inputs || [],
    asset_mounts: execution.context_snapshot?.asset_mounts || [],
    pull_request_intent: intent || null,
    outputs
  };
}
function executionHandle(result) {
  const execution = result.workflow_execution;
  return {
    operation: execution,
    ...result,
    events_url: `/workflow-executions/${execution.id}/events`,
    pause_url: `/workflow-executions/${execution.id}/pause`,
    resume_url: `/workflow-executions/${execution.id}/resume`,
    cancel_url: `/workflow-executions/${execution.id}/cancel`
  };
}
