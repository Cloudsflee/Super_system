import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v23-performance-'));
process.env.AIWS_HOME = path.join(root, 'home');
process.env.NODE_ENV = 'test';

const { ensureRuntime, readState, writeState } = await import('../../apps/api/src/state.mjs'),
  { closeStateStore } = await import('../../apps/api/src/state-store.mjs'),
  { createAssetRecord, createImmutableAssetVersion } = await import('../../apps/api/src/asset-cas.mjs'),
  { pendingTaskExecution } = await import('../../apps/api/src/workflow-execution-support.mjs'),
  { defaultQualityReviewRubric, qualityReviewRubricHash } =
    await import('../../apps/api/src/quality-review-rubric.mjs'),
  { buildQualityReviewAdvice } = await import('../../apps/api/src/quality-review-service-model.mjs'),
  { startQualityReview, getQualityReview, setQualityReviewModelRunner } =
    await import('../../apps/api/src/quality-review-service.mjs');

try {
  const fixture = await seedFixture(),
    modelResult = () => completedAdvice(fixture.rubric),
    histogram = monitorEventLoopDelay({ resolution: 5 });
  setQualityReviewModelRunner(async () => {
    await delay(350);
    return modelResult();
  });

  histogram.enable();
  await delay(20);
  const startedAt = performance.now(),
    started = await startQualityReview(
      fixture.execution.id,
      { operation_key: 'performance-start-operation' },
      fixture.owner.id
    ),
    startDurationMs = performance.now() - startedAt;
  assert.equal(started.idempotent, false);
  assert.ok(startDurationMs < 200, `Quality Review start took ${startDurationMs.toFixed(2)}ms`);

  const parserTasks = Array.from({ length: 8 }, (_, index) =>
      parseInWorker({
        files: [
          {
            path: `concurrent-${index}.md`,
            media_type: 'text/markdown',
            bytes: Buffer.from(`# Concurrent ${index}\n${'content line\n'.repeat(6_000)}`)
          }
        ],
        max_direct_images: 20,
        max_normalized_text_chars: 240_000
      })
    ),
    adviceTasks = Array.from({ length: 12 }, (_, index) =>
      buildQualityReviewAdvice({
        state: { codex_profiles: [], integration_statuses: [] },
        run: { id: `model-${index}`, reviewer_profile_snapshot: null },
        execution: { id: `execution-${index}` },
        rubric: fixture.rubric,
        parsed: [{ anchors: [], normalized_text: 'fixture', review_images: [] }],
        modelRunner: async () => {
          await delay(40);
          return modelResult();
        }
      })
    );
  const results = await Promise.all([...parserTasks, ...adviceTasks]);
  assert.ok(results.slice(0, parserTasks.length).every((item) => item.ok === true));
  assert.ok(results.slice(parserTasks.length).every((item) => item.status === 'completed'));
  await waitForStatus(started.run.id, ['awaiting_human', 'failed']);
  await delay(20);
  histogram.disable();
  const p95Ms = histogram.percentile(95) / 1e6;
  assert.ok(p95Ms <= 50, `event-loop lag p95 ${p95Ms.toFixed(2)}ms exceeded 50ms`);
  console.log(
    `V2.3 performance passed: start ${startDurationMs.toFixed(2)}ms, event-loop lag p95 ${p95Ms.toFixed(2)}ms`
  );
} finally {
  setQualityReviewModelRunner(null);
  await closeStateStore().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

async function seedFixture() {
  await ensureRuntime();
  const state = await readState(),
    owner = state.users[0],
    rubric = defaultQualityReviewRubric(),
    project = { id: 'performance-project', title: 'Performance', status: 'active', owner_user_id: owner.id },
    workflow = {
      id: 'performance-workflow',
      project_id: project.id,
      title: 'Performance workflow',
      status: 'active',
      version: 1,
      workflow_revision: 1,
      quality_review_policy: {
        enabled: true,
        mandatory: true,
        strategy: 'v23_default',
        rubric,
        rubric_hash: qualityReviewRubricHash(rubric)
      }
    },
    task = {
      id: 'performance-task',
      workflow_id: workflow.id,
      role: 'task',
      title: 'Content',
      task_kind: 'content',
      required: true,
      parent_node_id: null,
      execution_revision: 1,
      output_slots: [{ key: 'main', required: true }]
    },
    execution = {
      id: 'performance-execution',
      project_id: project.id,
      workflow_id: workflow.id,
      workflow_revision: 1,
      input_hash: 'a'.repeat(64),
      status: 'completed'
    },
    taskExecution = pendingTaskExecution(
      execution,
      task,
      { id: 'performance-contract', version: 1 },
      owner.id,
      new Date().toISOString()
    ),
    asset = createAssetRecord({
      projectId: project.id,
      taskId: task.id,
      taskExecutionId: taskExecution.id,
      assetType: 'document',
      title: 'Content',
      outputKey: 'main',
      actorId: owner.id
    });
  taskExecution.status = 'completed';
  taskExecution.evidence = { evidence_refs: [] };
  state.projects.push(project);
  state.workflows.push(workflow);
  state.workflow_nodes.push(task);
  state.workflow_executions.push(execution);
  state.task_executions.push(taskExecution);
  state.assets.push(asset);
  const version = await createImmutableAssetVersion(state, {
    asset,
    payload: { payload_kind: 'text', media_type: 'text/plain', content: 'Performance fixture', files: [] },
    actorId: owner.id
  });
  taskExecution.output_bindings.push({ key: 'main', version_id: version.id });
  await writeState(state);
  return { owner, rubric, execution };
}

function completedAdvice(rubric) {
  return {
    schema_version: 'aiws.quality_review_advice.v1',
    reviewer: { profile_id: null, provider: null, model: null, attempt: 1 },
    status: 'completed',
    dimensions: rubric.dimensions
      .filter((item) => item.enabled)
      .map((item) => ({
        criterion_id: item.id,
        recommendation: 90,
        rationale: 'Concurrent injected model result',
        evidence_anchors: [],
        limitations: []
      })),
    limitations: [],
    generated_at: new Date().toISOString()
  };
}

function parseInWorker(input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../apps/api/src/quality-review-parser-worker.mjs', import.meta.url));
    let settled = false;
    const finish = async (error, message) => {
      if (settled) return;
      settled = true;
      worker.removeAllListeners();
      await worker.terminate().catch(() => undefined);
      if (error) reject(error);
      else resolve(message);
    };
    worker.once('message', (message) => void finish(null, message));
    worker.once('error', (error) => void finish(error));
    worker.postMessage(input);
  });
}

async function waitForStatus(runId, statuses) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await getQualityReview(runId);
    if (statuses.includes(snapshot.run.status)) return snapshot;
    await delay(20);
  }
  throw new Error('quality_review_performance_run_timeout');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
