import { now } from '../../../packages/shared/index.mjs';

export function recoverInterruptedRuntimeWork(state, changes) {
  const handlers = [
    () => recoverTerminalSessions(state),
    () => recoverNodeRuns(state),
    () => recoverImportJobs(state),
    () => recoverWorkflowGenerations(state),
    () => recoverDeliveries(state),
    () => recoverAssistSessions(state),
    () => recoverRuntimeInputs(state)
  ];
  for (const handler of handlers) if (handler()) changes.value = true;
}

function recoverTerminalSessions(state) {
  let changed = false;
  for (const session of state.terminal_sessions.filter((item) =>
    ['starting', 'running', 'connected'].includes(item.status)
  )) {
    Object.assign(session, { status: 'interrupted', interrupted_reason: 'service_restarted', updated_at: now() });
    changed = true;
  }
  return changed;
}

function recoverNodeRuns(state) {
  let changed = false;
  for (const run of state.node_runs.filter((item) => ['queued', 'running'].includes(item.status))) {
    Object.assign(run, {
      status: 'failed',
      error_code: 'service_restarted',
      summary: run.summary || 'NodeRun interrupted by service restart.',
      completed_at: now(),
      updated_at: now()
    });
    const node = state.workflow_nodes.find((item) => item.id === run.node_id);
    if (node) Object.assign(node, { status: 'blocked', updated_at: now() });
    changed = true;
  }
  return changed;
}

function recoverImportJobs(state) {
  const jobs = state.import_jobs.filter((item) =>
    ['queued', 'starting', 'running', 'processing', 'staging', 'stopping'].includes(item.status)
  );
  for (const job of jobs) Object.assign(job, { status: 'failed', error_code: 'service_restarted', updated_at: now() });
  return jobs.length > 0;
}

function recoverWorkflowGenerations(state) {
  let changed = false;
  for (const generation of state.workflow_generations.filter((item) => ['queued', 'running'].includes(item.status))) {
    Object.assign(generation, {
      status: 'failed',
      phase: 'failed',
      error_code: 'service_restarted',
      retryable: true,
      completed_at: now(),
      updated_at: now()
    });
    const draft = state.workflow_drafts.find(
      (item) => item.id === generation.draft_id && item.generation_id === generation.id
    );
    if (draft) {
      draft.generation_status = 'failed';
      draft.updated_at = now();
    }
    changed = true;
  }
  return changed;
}

function recoverDeliveries(state) {
  let changed = false;
  for (const delivery of state.deliveries.filter((item) => ['queued', 'running'].includes(item.status))) {
    Object.assign(delivery, {
      status: 'failed',
      phase: 'failed',
      error_code: 'service_restarted',
      retryable: true,
      completed_at: now(),
      updated_at: now()
    });
    const target = state.repository_targets.find((item) => item.id === delivery.repository_target_id);
    if (target) target.status = 'ready';
    changed = true;
  }
  return changed;
}

function recoverAssistSessions(state) {
  let changed = false;
  for (const session of state.assist_sessions.filter((item) => item.version !== 3 && item.status === 'running')) {
    Object.assign(session, { status: 'failed', error: 'service_restarted', updated_at: now() });
    changed = true;
  }
  return changed;
}

function recoverRuntimeInputs(state) {
  let changed = false;
  for (const input of state.runtime_user_inputs.filter((item) => item.status === 'pending')) {
    Object.assign(input, {
      status: 'cancelled',
      cancelled_reason: 'service_restarted',
      cancelled_at: now(),
      updated_at: now()
    });
    const turn = state.assist_turns.find((item) => item.id === input.turn_id);
    if (turn && ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(turn.status))
      Object.assign(turn, {
        status: 'interrupted',
        error_code: 'service_restarted',
        completed_at: now(),
        updated_at: now()
      });
    changed = true;
  }
  return changed;
}
