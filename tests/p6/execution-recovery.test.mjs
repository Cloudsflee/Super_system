import assert from 'node:assert/strict';
import test from 'node:test';
import { DeterministicRunnerAdapter } from '../../apps/api/src/clean/runner-adapters.mjs';
import { close, open, prepare, waitOperation } from './helpers.mjs';

test('pause waits for a runner boundary and resume completes without duplicate attempts', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = new DeterministicRunnerAdapter({ execute: async () => { await gate; return { status: 'succeeded', exit_code: 0, stdout: Buffer.from('paused boundary\n') }; } });
  const state = await open({ adapter });
  try {
    const fixture = await prepare(state, 'pause-resume');
    const started = await state.runtime.execution.start(fixture.execution.id, { expected_revision: fixture.execution.revision, idempotency_key: 'p6-pause-start' }, state.principal);
    await waitUntil(() => state.runtime.db.get("SELECT * FROM task_attempts WHERE execution_id=? AND status IN ('leased','running')", [fixture.execution.id]));
    const running = state.runtime.execution.get(fixture.execution.id, state.principal);
    await state.runtime.execution.pause(running.id, { expected_revision: running.revision, idempotency_key: 'p6-pause-request' }, state.principal);
    release();
    const paused = await waitUntil(() => { const value = state.runtime.execution.get(running.id, state.principal); return value.status === 'paused' ? value : null; });
    const resumed = await state.runtime.execution.resume(paused.id, { expected_revision: paused.revision, idempotency_key: 'p6-pause-resume' }, state.principal);
    assert.equal((await waitOperation(state.runtime, resumed.operation.operation_id, state.principal.actorId)).status, 'succeeded');
    assert.equal(state.runtime.execution.get(paused.id, state.principal).status, 'completed');
    assert.equal(state.runtime.execution.attemptsFor(paused.id, {}, state.principal).attempts.length, 1);
    assert.equal(state.runtime.db.get("SELECT count(*) AS count FROM operations WHERE command_id='execution.start' AND status='paused'").count, 0);
  } finally { release?.(); await close(state); }
});

test('review approval resumes the paused stage operation and preserves one checkpoint', async () => {
  const state = await open();
  try {
    const base = await prepare(state, 'approval'); const project = state.runtime.db.get('SELECT * FROM projects WHERE id=?', [base.project.id]);
    const created = await state.runtime.execution.create(project.id, {
      repository_workspace_id: base.workspace.id, context_pack_id: base.pack.id, runner_profile_id: base.profile.id,
      tasks: [{ id: 'reviewed', mode: 'read', depends_on: [], input_paths: ['README.md'], output_paths: [] }], requires_approval: true,
      expected_revision: project.revision, idempotency_key: 'p6-approval-gated-execution'
    }, state.principal);
    const started = await state.runtime.execution.start(created.execution.id, { expected_revision: created.execution.revision, idempotency_key: 'p6-approval-start' }, state.principal);
    const waiting = await waitUntil(() => { const value = state.runtime.execution.get(created.execution.id, state.principal); return value.status === 'awaiting_approval' ? value : null; });
    const approval = state.runtime.db.query("SELECT * FROM runtime_approvals WHERE project_id=? AND action='execution.review'", [project.id]).find((row) => JSON.parse(row.request_json).execution_id === waiting.id);
    assert.ok(approval);
    await state.runtime.assist.decideApproval(approval.id, { decision: 'approved', expected_revision: approval.revision, idempotency_key: 'p6-approval-decision' }, state.principal);
    const resumed = await state.runtime.execution.resume(waiting.id, { expected_revision: waiting.revision, idempotency_key: 'p6-approval-resume' }, state.principal);
    assert.equal((await waitOperation(state.runtime, resumed.operation.operation_id, state.principal.actorId)).status, 'succeeded');
    assert.equal(state.runtime.execution.get(waiting.id, state.principal).status, 'completed');
    assert.equal(state.runtime.db.get("SELECT count(*) AS count FROM execution_stage_checkpoints WHERE execution_id=? AND stage='review'", [waiting.id]).count, 1);
    assert.equal(state.runtime.db.get("SELECT count(*) AS count FROM operations o JOIN execution_stage_checkpoints c ON c.operation_id=o.id WHERE c.execution_id=? AND o.status='paused'", [waiting.id]).count, 0);
    assert.equal(state.runtime.operations.get(started.operation.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');
  } finally { await close(state); }
});

test('cancelled runner attempts use operation cancellation acknowledgement', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = await open({ adapter: new DeterministicRunnerAdapter({ execute: async () => { await gate; return { status: 'succeeded', exit_code: 0 }; } }) });
  try {
    const fixture = await prepare(state, 'cancel');
    const started = await state.runtime.execution.start(fixture.execution.id, { expected_revision: fixture.execution.revision, idempotency_key: 'p6-cancel-start' }, state.principal);
    await waitUntil(() => state.runtime.db.get("SELECT * FROM task_attempts WHERE execution_id=? AND status IN ('leased','running')", [fixture.execution.id]));
    const current = state.runtime.execution.get(fixture.execution.id, state.principal);
    await state.runtime.execution.cancel(current.id, { expected_revision: current.revision, idempotency_key: 'p6-cancel-control' }, state.principal);
    release();
    const attempt = await waitUntil(() => state.runtime.db.get("SELECT * FROM task_attempts WHERE execution_id=? AND status='cancelled'", [current.id]));
    const operation = await waitUntil(() => { const value = state.runtime.operations.get(attempt.operation_id, { actorId: state.principal.actorId }); return value.status === 'cancelled' ? value : null; });
    assert.equal(operation.cancellation_requested, true);
    assert.equal((await waitUntil(() => { const value = state.runtime.operations.get(started.operation.operation_id, { actorId: state.principal.actorId }); return value.status === 'cancelled' ? value : null; })).status, 'cancelled');
    assert.equal(state.runtime.execution.get(current.id, state.principal).status, 'cancelled');
  } finally { release?.(); await close(state); }
});

test('replan and successful later-stage replay retain lineage and effective receipts', async () => {
  const state = await open();
  try {
    const fixture = await prepare(state, 'lineage');
    const started = await state.runtime.execution.start(fixture.execution.id, { expected_revision: fixture.execution.revision, idempotency_key: 'p6-lineage-start' }, state.principal);
    await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId);
    const completed = state.runtime.execution.get(fixture.execution.id, state.principal);
    const replanned = await state.runtime.execution.replan(completed.id, { expected_revision: completed.revision, tasks: completed.plan.tasks, idempotency_key: 'p6-lineage-replan' }, state.principal);
    assert.equal(replanned.execution.parent_execution_id, completed.id);
    assert.equal(replanned.execution.replanned_from_stage, 'deliver');
    assert.equal(replanned.execution.status, 'draft');

    const source = state.runtime.execution.checkpointsFor(completed.id, {}, state.principal).checkpoints.find((item) => item.stage === 'deliver');
    const replayed = await state.runtime.execution.replayStage(completed.id, 'deliver', {
      generation: completed.generation, checkpoint_token: source.checkpoint_token,
      workspace_hash: source.workspace_sha256, pins_hash: source.pins_sha256,
      expected_revision: completed.revision, idempotency_key: 'p6-lineage-replay'
    }, state.principal);
    assert.equal((await waitOperation(state.runtime, replayed.operation.operation_id, state.principal.actorId)).status, 'succeeded');
    const final = state.runtime.execution.get(completed.id, state.principal); assert.equal(final.generation, 2); assert.equal(final.status, 'completed');
    assert.equal(final.handoff_manifest.receipts.length, 1);
    const replayCheckpoint = state.runtime.execution.checkpointsFor(final.id, {}, state.principal).checkpoints.find((item) => item.generation === 2 && item.stage === 'deliver');
    assert.equal(replayCheckpoint.prior_checkpoint_sha256, source.checkpoint_sha256);
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM runner_receipts').count, 1);
  } finally { await close(state); }
});

test('restart reconciliation commits a terminal runner receipt before resuming the run stage', async () => {
  const state = await open();
  try {
    const fixture = await prepare(state, 'restart-terminal'); const service = state.runtime.execution; const schedule = service.schedule.bind(service); service.schedule = () => {};
    const started = await service.start(fixture.execution.id, { expected_revision: fixture.execution.revision, idempotency_key: 'p6-restart-terminal-start' }, state.principal);
    let top = state.runtime.operations.get(started.operation.operation_id); top = await state.runtime.operations.start(top.id, { expectedRevision: top.revision, actorId: top.actor_id, projectId: top.project_id });
    let execution = state.runtime.db.get('SELECT * FROM executions WHERE id=?', [fixture.execution.id]);
    for (const [stage, index] of [['prepare', 0], ['context', 1]]) { const boundary = await service.beginStage(execution, stage, index, top.id, state.principal); const outcome = await service.runStage(stage, execution.id, state.principal); await service.completeStage(execution.id, stage, boundary.operation_id, outcome, state.principal.actorId); execution = state.runtime.db.get('SELECT * FROM executions WHERE id=?', [execution.id]); }
    await service.beginStage(execution, 'run', 2, top.id, state.principal); execution = state.runtime.db.get('SELECT * FROM executions WHERE id=?', [execution.id]); const task = JSON.parse(execution.plan_json).tasks[0]; const attempt = await service.startAttempt(execution.id, task, 1, state.principal);
    const result = await state.runtime.runner.runSignedJob(attempt.signed, attempt.profile, { workspacePath: attempt.taskWorkspace, onSubmitted: (job) => service.leaseAttempt(attempt.attempt.id, job, state.principal.actorId), onStatus: (job) => service.markAttemptRunning(attempt.attempt.id, job, state.principal.actorId) });
    assert.equal(result.status, 'succeeded'); assert.equal(state.runtime.db.get('SELECT status FROM task_attempts WHERE id=?', [attempt.attempt.id]).status, 'running');
    service.schedule = schedule; assert.ok(await service.recoverPending());
    assert.equal((await waitOperation(state.runtime, top.id, state.principal.actorId)).status, 'succeeded');
    assert.equal(service.get(execution.id, state.principal).status, 'completed'); assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM runner_receipts').count, 1);
  } finally { await close(state); }
});

test('restart reconciliation pauses unknown external jobs and their stage and parent operations', async () => {
  const state = await open();
  try {
    const fixture = await prepare(state, 'restart-unknown'); const service = state.runtime.execution; service.schedule = () => {};
    const started = await service.start(fixture.execution.id, { expected_revision: fixture.execution.revision, idempotency_key: 'p6-restart-unknown-start' }, state.principal);
    let top = state.runtime.operations.get(started.operation.operation_id); top = await state.runtime.operations.start(top.id, { expectedRevision: top.revision, actorId: top.actor_id, projectId: top.project_id });
    let execution = state.runtime.db.get('SELECT * FROM executions WHERE id=?', [fixture.execution.id]); const boundary = await service.beginStage(execution, 'run', 2, top.id, state.principal); execution = state.runtime.db.get('SELECT * FROM executions WHERE id=?', [execution.id]); const task = JSON.parse(execution.plan_json).tasks[0]; const attempt = await service.startAttempt(execution.id, task, 1, state.principal); await service.leaseAttempt(attempt.attempt.id, { job_id: 'runner_job_missing' }, state.principal.actorId); await service.markAttemptRunning(attempt.attempt.id, { job_id: 'runner_job_missing' }, state.principal.actorId);
    assert.ok(await service.recoverPending());
    assert.equal(service.get(execution.id, state.principal).status, 'paused');
    assert.equal(state.runtime.db.get('SELECT status FROM task_attempts WHERE id=?', [attempt.attempt.id]).status, 'external_result_unknown');
    assert.equal(state.runtime.operations.get(top.id, { actorId: state.principal.actorId }).status, 'paused');
    assert.equal(state.runtime.operations.get(boundary.operation_id, { actorId: state.principal.actorId }).status, 'paused');
  } finally { await close(state); }
});

async function waitUntil(read, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await read(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('wait_until_timeout');
}
