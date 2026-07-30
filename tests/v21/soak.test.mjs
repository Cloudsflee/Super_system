import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  ContextProjectorCoordinator,
  claimContextProjectionJobsInState
} from '../../apps/api/src/context-projector-coordinator.mjs';
import {
  beginExecutionStageInState,
  completeExecutionStageInState
} from '../../apps/api/src/execution-stage-service.mjs';
import { emptyState } from '../../apps/api/src/state.mjs';
import { contextHash, ensureContextCollections } from '../../packages/system-context/src/index.mjs';

const taskCount = 64,
  renderCount = 96,
  stages = ['preflight', 'execute', 'collect', 'verify', 'attest', 'promote', 'finalize'],
  state = checkpointFixture(taskCount),
  backlog = projectionBacklog(250),
  coordinator = new ContextProjectorCoordinator({ intervalMs: 250, batchSize: 25, leaseMs: 30_000 }),
  rssBefore = process.memoryUsage().rss,
  cpuBefore = process.cpuUsage(),
  started = performance.now(),
  lag = sampleEventLoopLag(10);

try {
  const renderJobs = Array.from({ length: renderCount }, (_, index) =>
      coordinator.request('render', {
        node: contextNode(`render-${index}`),
        record: { id: `render-${index}`, status: 'ready', summary: `Rendered ${index}` },
        edges: [],
        relatedNodes: []
      })
    ),
    checkpointJobs = state.task_executions.map((taskExecution) => checkpointTask(taskExecution)),
    claimJobs = claimAllProjectionJobs(backlog);
  const [rendered, , claimed] = await Promise.all([Promise.all(renderJobs), Promise.all(checkpointJobs), claimJobs]);
  assert.equal(rendered.length, renderCount);
  assert.equal(
    rendered.every((item) => /Rendered|render-/i.test(item.markdown)),
    true
  );
  assert.equal(claimed, 250);
} finally {
  await coordinator.stop();
}

await new Promise((resolve) => setTimeout(resolve, 30));
const lagSamples = lag.stop(),
  durationMs = performance.now() - started,
  lagP95 = percentile(lagSamples, 0.95),
  rssAfter = process.memoryUsage().rss,
  cpu = process.cpuUsage(cpuBefore),
  checkpoints = state.execution_stage_checkpoints.length,
  queueAges = backlog.context_projection_jobs.map((item) => Math.max(0, Date.now() - Date.parse(item.created_at))),
  queueAgeP95 = percentile(queueAges, 0.95),
  throughput = (checkpoints * 1000) / durationMs;

assert.equal(checkpoints, taskCount * stages.length);
assert.equal(
  state.task_executions.every((item) => item.stage_checkpoint_ids.length === stages.length),
  true
);
assert.ok(lagP95 <= 50, `event-loop lag p95 ${lagP95.toFixed(2)}ms exceeds 50ms`);
assert.ok(durationMs <= 30_000, `concurrent projector/checkpoint run timed out after ${durationMs.toFixed(2)}ms`);

console.log(
  `V2.1 concurrent checkpoint/projector soak passed ` +
    `(duration=${durationMs.toFixed(2)}ms, checkpoints=${checkpoints}, throughput=${throughput.toFixed(2)}/s, ` +
    `event-loop lag p95=${lagP95.toFixed(2)}ms, queue age p95=${queueAgeP95.toFixed(2)}ms, ` +
    `RSS before=${rssBefore}, RSS after=${rssAfter}, CPU user=${cpu.user}us, CPU system=${cpu.system}us; ` +
    `RSS samples are observational and do not infer a leak)`
);

async function checkpointTask(taskExecution) {
  for (const stage of stages) {
    await new Promise((resolve) => setImmediate(resolve));
    const token = beginExecutionStageInState(state, {
      workflowExecutionId: taskExecution.workflow_execution_id,
      taskExecutionId: taskExecution.id,
      stage,
      input: { stage, task_execution_id: taskExecution.id }
    });
    completeExecutionStageInState(state, token, { output: { passed: true, stage } });
  }
}

async function claimAllProjectionJobs(value) {
  let claimed = 0,
    tick = 0;
  while (claimed < value.context_projection_jobs.length) {
    await new Promise((resolve) => setImmediate(resolve));
    const batch = claimContextProjectionJobsInState(value, {
      holder: 'soak-projector',
      batchSize: 25,
      leaseMs: 30_000,
      timestamp: new Date(Date.now() + tick).toISOString()
    });
    claimed += batch.node_ids.length;
    for (const job of value.context_projection_jobs.filter(
      (item) => item.status === 'running' && item.lease?.holder === 'soak-projector'
    )) {
      job.status = 'completed';
      job.completed_at = new Date().toISOString();
      job.lease = null;
    }
    tick += 1;
  }
  return claimed;
}

function checkpointFixture(count) {
  const value = emptyState();
  value.schema_version = 21;
  value.workflow_executions.push({
    id: 'wex-soak',
    project_id: 'project-soak',
    workflow_id: 'workflow-soak',
    status: 'running',
    input_hash: '1'.repeat(64),
    executor_config: { runner_image_digest: 'sha256:soak' }
  });
  for (let index = 0; index < count; index += 1)
    value.task_executions.push({
      id: `tex-soak-${index}`,
      workflow_execution_id: 'wex-soak',
      project_id: 'project-soak',
      workflow_id: 'workflow-soak',
      task_id: `task-soak-${index}`,
      contract_id: `contract-soak-${index}`,
      contract_version: 1,
      executor: 'assist',
      status: 'running',
      input_snapshot_hash: contextHash(`input:${index}`),
      context_snapshot: {},
      stage_checkpoint_ids: [],
      replay_count: 0,
      created_at: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:00:00.000Z'
    });
  return value;
}

function projectionBacklog(count) {
  const value = ensureContextCollections({});
  for (let index = 0; index < count; index += 1)
    value.context_projection_jobs.push({
      id: `job-soak-${index}`,
      node_id: `node-soak-${index}`,
      expected_source_hash: contextHash(index),
      status: 'pending',
      attempts: 0,
      lease: null,
      created_at: new Date(Date.now() - 60_000 + index).toISOString(),
      updated_at: new Date(Date.now() - 60_000 + index).toISOString()
    });
  return value;
}

function contextNode(id) {
  return {
    id,
    uri: `aiws://context/nodes/${id}`,
    kind: 'record',
    source_collection: 'fixtures',
    source_id: id,
    project_id: 'project-soak',
    parent_id: null,
    title: id,
    deterministic_summary: id,
    status: 'active',
    sensitivity: 'internal',
    authority: 'authoritative',
    freshness: { status: 'current' },
    required_scopes: ['context:read', 'project:read'],
    source_hash: contextHash({ id }),
    sort: { type_order: 120, order_index: 0, stable_id: id }
  };
}

function sampleEventLoopLag(intervalMs) {
  const samples = [];
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const current = performance.now();
    samples.push(Math.max(0, current - expected));
    expected = current + intervalMs;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return samples.length ? samples : [0];
    }
  };
}

function percentile(values, value) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * value) - 1)];
}
