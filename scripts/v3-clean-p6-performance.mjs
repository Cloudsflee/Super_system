import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { close, open, prepare, waitOperation } from '../tests/p6/helpers.mjs';

const tasks = Array.from({ length: 100 }, (_, index) => ({
  id: `task_${String(index).padStart(3, '0')}`, mode: 'read', depends_on: [],
  input_paths: ['README.md'], output_paths: [], check_ids: [], resource_profile: index % 2 ? 'light' : 'standard'
}));
const state = await open({ config: { runtimeBuild: 'v3-clean-p6-performance' } });

try {
  const fixture = await prepare(state, 'performance', tasks);
  const planning = [];
  const project = state.runtime.db.get('SELECT revision FROM projects WHERE id=?', [fixture.project.id]);
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await state.runtime.execution.create(fixture.project.id, {
      repository_workspace_id: fixture.workspace.id, context_pack_id: fixture.pack.id,
      runner_profile_id: fixture.profile.id, tasks, expected_revision: Number(project.revision),
      idempotency_key: `p6-performance-plan-${index}`
    }, state.principal);
    planning.push(performance.now() - started);
  }

  const started = await state.runtime.execution.start(fixture.execution.id, {
    expected_revision: fixture.execution.revision, idempotency_key: 'p6-performance-start'
  }, state.principal);
  const operation = await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId, 30_000);
  assert.equal(operation.status, 'succeeded');
  const completed = state.runtime.execution.get(fixture.execution.id, state.principal);
  const attempts = state.runtime.execution.attemptsFor(completed.id, {}, state.principal).attempts;
  assert.equal(attempts.length, 100);

  const detailSamples = sample(30, () => state.runtime.execution.attemptsFor(completed.id, {}, state.principal));
  const now = new Date().toISOString(); const aggregateId = 'p6_performance_event_replay';
  for (let index = 1; index <= 1000; index += 1) {
    state.runtime.db.withTransaction((tx) => state.runtime.events.appendAggregateInTransaction(tx, {
      aggregateType: 'p6_performance', aggregateId, revision: index,
      actorId: state.principal.actorId, projectId: fixture.project.id,
      type: index === 1000 ? 'p6_performance.completed' : 'p6_performance.progress',
      data: { index }, payload: { index }, now
    }));
  }
  const replaySamples = sample(20, () => state.runtime.events.replay({
    actorId: state.principal.actorId, projectId: fixture.project.id,
    aggregateType: 'p6_performance', aggregateId, cursor: 0, limit: 1000
  }));

  const checkpoint = state.runtime.execution.checkpointsFor(completed.id, {}, state.principal).checkpoints.find((item) => item.stage === 'deliver');
  assert.ok(checkpoint);
  const checkpointValidation = [];
  for (let index = 0; index < 20; index += 1) {
    const validationStarted = performance.now();
    await assert.rejects(() => state.runtime.execution.replayStage(completed.id, 'deliver', {
      generation: completed.generation, checkpoint_token: checkpoint.checkpoint_token,
      workspace_hash: checkpoint.workspace_sha256, pins_hash: checkpoint.pins_sha256,
      expected_revision: completed.revision - 1, idempotency_key: `p6-performance-replay-validation-${index}`
    }, state.principal), (error) => error.code === 'revision_conflict');
    checkpointValidation.push(performance.now() - validationStarted);
  }

  const metrics = {
    event_replay_1000_p95_ms: round(p95(replaySamples)),
    dag_planning_100_tasks_p95_ms: round(p95(planning)),
    execution_detail_100_attempts_p95_ms: round(p95(detailSamples)),
    checkpoint_replay_validation_p95_ms: round(p95(checkpointValidation)),
    event_count: 1000, task_count: 100, attempt_count: attempts.length,
    checkpoint_count: state.runtime.execution.checkpointsFor(completed.id, {}, state.principal).checkpoints.length
  };
  const thresholds = {
    event_replay_1000_p95_ms: 200,
    dag_planning_100_tasks_p95_ms: 150,
    execution_detail_100_attempts_p95_ms: 200,
    checkpoint_replay_validation_p95_ms: 500
  };
  const failures = Object.entries(thresholds).filter(([name, maximum]) => metrics[name] > maximum).map(([name, maximum]) => `${name}>${maximum}`);
  process.stdout.write(`${JSON.stringify({
    schema_version: 'aiws.v3-clean.p6-performance.v1', status: failures.length ? 'failed' : 'passed',
    provisional: false, metrics, thresholds, failures
  }, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
} finally { await close(state); }

function sample(count, callback) {
  const values = [];
  for (let index = 0; index < count; index += 1) { const started = performance.now(); callback(); values.push(performance.now() - started); }
  return values;
}
function p95(values) { const ordered = [...values].sort((left, right) => left - right); return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0; }
function round(value) { return Math.round(value * 100) / 100; }
