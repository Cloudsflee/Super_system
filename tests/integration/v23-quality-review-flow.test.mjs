import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fixtureRoot = path.join(process.cwd(), '.v23-quality-review-flow-fixture');
process.env.AIWS_HOME = path.join(fixtureRoot, 'home');
process.env.NODE_ENV = 'production';

const stateApi = await import('../../apps/api/src/state.mjs'),
  { ensureRuntime, readState, writeState, mutate } = stateApi,
  { closeStateStore } = await import('../../apps/api/src/state-store.mjs'),
  { createAssetRecord, createImmutableAssetVersion } = await import('../../apps/api/src/asset-cas.mjs'),
  { pendingTaskExecution } = await import('../../apps/api/src/workflow-execution-support.mjs'),
  { defaultQualityReviewRubric, qualityReviewRubricHash } =
    await import('../../apps/api/src/quality-review-rubric.mjs'),
  {
    startQualityReview,
    getQualityReview,
    getQualityReviewEvents,
    listQualityReviews,
    cancelQualityReview,
    decideQualityReview,
    shutdownQualityReviews,
    setQualityReviewModelRunner
  } = await import('../../apps/api/src/quality-review-service.mjs');

fs.rmSync(fixtureRoot, { recursive: true, force: true });
try {
  await ensureRuntime();
  const state = await readState(),
    owner = state.users[0],
    project = { id: 'qrr-flow-project', title: 'QRR flow', status: 'active', owner_user_id: owner.id },
    rubric = defaultQualityReviewRubric(),
    workflow = {
      id: 'qrr-flow-workflow',
      project_id: project.id,
      title: 'QRR flow workflow',
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
      id: 'qrr-flow-task',
      workflow_id: workflow.id,
      role: 'task',
      title: '内容输出',
      task_kind: 'content',
      required: true,
      parent_node_id: null,
      execution_revision: 1,
      output_slots: [{ key: 'main', required: true }]
    },
    execution = {
      id: 'qrr-flow-execution',
      project_id: project.id,
      workflow_id: workflow.id,
      workflow_revision: 1,
      input_hash: 'a'.repeat(64),
      status: 'completed',
      quality_review_rubric_hash: qualityReviewRubricHash(rubric),
      quality_review_policy_snapshot: {
        enabled: true,
        mandatory: true,
        strategy: 'v23_default',
        rubric,
        rubric_hash: qualityReviewRubricHash(rubric)
      }
    },
    historicalExecution = {
      ...execution,
      id: 'qrr-flow-historical-execution',
      quality_review_rubric_hash: null,
      quality_review_policy_snapshot: null
    },
    taskExecution = pendingTaskExecution(
      execution,
      task,
      { id: 'qrr-flow-contract', version: 1 },
      owner.id,
      new Date().toISOString()
    ),
    asset = createAssetRecord({
      projectId: project.id,
      taskId: task.id,
      taskExecutionId: taskExecution.id,
      assetType: 'document',
      title: '内容输出',
      outputKey: 'main',
      actorId: owner.id
    });
  taskExecution.status = 'completed';
  taskExecution.evidence = { evidence_refs: [] };
  state.projects.push(project);
  state.workflows.push(workflow);
  state.workflow_nodes.push(task);
  state.workflow_executions.push(execution, historicalExecution);
  state.task_executions.push(taskExecution);
  state.assets.push(asset);
  const version = await createImmutableAssetVersion(state, {
    asset,
    payload: {
      payload_kind: 'text',
      media_type: 'text/plain',
      content: '目标覆盖充分。事实有证据。',
      files: []
    },
    actorId: owner.id
  });
  taskExecution.output_bindings.push({ key: 'main', version_id: version.id });
  await writeState(state);

  await assert.rejects(
    () => startQualityReview(historicalExecution.id, { operation_key: 'historical-policy-change' }, owner.id),
    (error) => error.status === 409 && error.payload?.error === 'quality_review_not_enabled'
  );

  setQualityReviewModelRunner(() => ({
    schema_version: 'aiws.quality_review_advice.v1',
    reviewer: { profile_id: null, provider: null, model: null, attempt: 1 },
    status: 'completed',
    dimensions: [
      { criterion_id: 'unknown', recommendation: 100, rationale: 'invalid', evidence_anchors: [], limitations: [] }
    ],
    limitations: [],
    generated_at: new Date().toISOString()
  }));
  const started = await startQualityReview(execution.id, { operation_key: 'qrr-flow-operation' }, owner.id);
  let snapshot = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    snapshot = await getQualityReview(started.run.id);
    if (['awaiting_human', 'failed'].includes(snapshot.run.status)) break;
  }
  assert.equal(snapshot?.run.status, 'awaiting_human');
  assert.equal(snapshot.report.advice.status, 'invalid');
  assert.ok(snapshot.report.advice.dimensions.every((item) => item.recommendation === null));
  assert.ok(snapshot.report.limitations.some((item) => item.includes('Advice invalid')));
  assert.equal(snapshot.run.decision_id, null);
  assert.deepEqual(
    snapshot.report.deterministic_checks
      .map((item) => item.id)
      .filter((id) => ['rubric_identity', 'rubric_weights', 'rubric_scope', 'outcome_threshold'].includes(id)),
    ['rubric_identity', 'rubric_weights', 'rubric_scope', 'outcome_threshold']
  );

  await assert.rejects(
    () =>
      decideQualityReview(
        started.run.id,
        {
          expected_report_sha256: '0'.repeat(64),
          expected_input_snapshot_hash: snapshot.run.input_snapshot_hash,
          dimension_scores: rubric.dimensions.map((dimension) => ({
            criterion_id: dimension.id,
            score: 100,
            reason: '不会写入的过期报告裁决'
          })),
          reason: '过期报告不得提交。'
        },
        owner.id
      ),
    (error) => error.status === 409 && error.payload?.error === 'quality_review_report_stale'
  );

  const decision = await decideQualityReview(
    started.run.id,
    {
      expected_report_sha256: snapshot.run.report_sha256,
      expected_input_snapshot_hash: snapshot.run.input_snapshot_hash,
      dimension_scores: rubric.dimensions.map((dimension) => ({
        criterion_id: dimension.id,
        score: 100,
        reason: '人工逐维度核验通过'
      })),
      reason: '人工完成独立最终评分。'
    },
    owner.id
  );
  assert.equal(decision.run.status, 'completed');
  assert.equal(decision.run.decision, 'pass');
  assert.equal(decision.run.score, 100);

  const pendingReplacement = await startQualityReview(
    execution.id,
    { operation_key: 'qrr-flow-pending-replacement' },
    owner.id
  );
  const pendingSnapshot = await waitForReview(pendingReplacement.run.id, ['awaiting_human', 'failed']);
  assert.equal(pendingSnapshot.run.status, 'awaiting_human');
  assert.equal((await listQualityReviews(execution.id)).current.id, started.run.id);
  await cancelQualityReview(pendingReplacement.run.id, owner.id);
  assert.equal((await listQualityReviews(execution.id)).current.id, started.run.id);

  let transientAttempts = 0;
  setQualityReviewModelRunner(() => {
    transientAttempts += 1;
    if (transientAttempts === 1) {
      const error = new Error('temporary reviewer outage');
      error.retryable = true;
      throw error;
    }
    return completedAdvice(rubric);
  });
  const lowReplacement = await startQualityReview(
      execution.id,
      { operation_key: 'qrr-flow-low-replacement' },
      owner.id
    ),
    lowSnapshot = await waitForReview(lowReplacement.run.id, ['awaiting_human', 'failed']);
  assert.equal(lowSnapshot.run.status, 'awaiting_human');
  assert.equal(lowSnapshot.report.advice.status, 'completed');
  assert.equal(transientAttempts, 2);
  assert.equal((await listQualityReviews(execution.id)).current.id, started.run.id);
  const lowDecision = await decideQualityReview(
    lowReplacement.run.id,
    {
      expected_report_sha256: lowSnapshot.run.report_sha256,
      expected_input_snapshot_hash: lowSnapshot.run.input_snapshot_hash,
      dimension_scores: rubric.dimensions.map((dimension) => ({
        criterion_id: dimension.id,
        score: 20,
        reason: '人工核验发现必须修改的问题'
      })),
      reason: '当前交付未达到发布阈值。'
    },
    owner.id
  );
  assert.equal(lowDecision.run.decision, 'changes_required');
  assert.equal(lowDecision.run.score, 20);
  const afterLow = await listQualityReviews(execution.id);
  assert.equal(afterLow.current.id, lowReplacement.run.id);
  assert.equal(afterLow.items.find((item) => item.id === started.run.id).superseded_by_run_id, lowReplacement.run.id);

  setQualityReviewModelRunner(() => completedAdvice(rubric));
  const cancellable = await startQualityReview(execution.id, { operation_key: 'qrr-flow-cancellable' }, owner.id);
  await assert.rejects(
    () => startQualityReview(execution.id, { operation_key: 'qrr-flow-conflicting' }, owner.id),
    (error) => error.status === 409 && error.payload?.error === 'quality_review_active'
  );
  const sameActive = await startQualityReview(execution.id, { operation_key: 'qrr-flow-cancellable' }, owner.id);
  assert.equal(sameActive.idempotent, true);
  assert.equal(sameActive.run.id, cancellable.run.id);
  await cancelQualityReview(cancellable.run.id, owner.id);
  assert.equal((await listQualityReviews(execution.id)).current.id, lowReplacement.run.id);

  const allEvents = await getQualityReviewEvents(lowReplacement.run.id, 0),
    cursor = allEvents.events[Math.max(0, allEvents.events.length - 2)]?.sequence || 0,
    resumedEvents = await getQualityReviewEvents(lowReplacement.run.id, cursor);
  assert.ok(resumedEvents.events.every((item) => item.sequence > cursor));
  assert.equal(resumedEvents.next_cursor, allEvents.next_cursor);

  const beforeRollback = (await readState()).workflow_executions.find((item) => item.id === execution.id).input_hash;
  await assert.rejects(
    () =>
      mutate((draft) => {
        draft.workflow_executions.find((item) => item.id === execution.id).input_hash = 'f'.repeat(64);
        throw new Error('injected transaction rollback');
      }),
    /injected transaction rollback/
  );
  assert.equal(
    (await readState()).workflow_executions.find((item) => item.id === execution.id).input_hash,
    beforeRollback
  );

  const tamperedReview = await readState();
  tamperedReview.human_reviews.find((item) => item.id === decision.run.decision_id).reason = 'tampered';
  await assert.rejects(
    () => writeState(tamperedReview),
    (error) => error.code === 'quality_review_human_review_immutable_record_changed'
  );

  const idempotent = await startQualityReview(execution.id, { operation_key: 'qrr-flow-operation' }, owner.id);
  assert.equal(idempotent.idempotent, true);
  assert.equal(idempotent.run.id, started.run.id);

  await mutate((draft) => {
    draft.workflow_executions.find((item) => item.id === execution.id).input_hash = 'b'.repeat(64);
  });
  const stale = await getQualityReview(started.run.id);
  assert.equal(stale.run.stale, true);

  const tampered = await readState();
  tampered.quality_review_runs.find((item) => item.id === started.run.id).operation_key = 'tampered-operation';
  await assert.rejects(
    () => writeState(tampered),
    (error) => error.code === 'quality_review_run_snapshot_changed'
  );

  setQualityReviewModelRunner(() => new Promise(() => undefined));
  const draining = await startQualityReview(execution.id, { operation_key: 'qrr-flow-draining' }, owner.id);
  await waitForReview(draining.run.id, ['reviewing', 'failed']);
  await shutdownQualityReviews();
  const drained = await getQualityReview(draining.run.id);
  assert.equal(drained.run.status, 'failed');
  assert.equal(drained.run.error_code, 'service_draining');
  assert.equal(drained.run.retryable, true);
  assert.equal(fs.existsSync(path.join(process.env.AIWS_HOME, 'quality-review-tmp')), false);
  console.log(
    'V2.3 Quality Review lifecycle, retry, cancellation, supersede, cursor, rollback, draining and stale tests passed'
  );
} finally {
  setQualityReviewModelRunner(null);
  await closeStateStore().catch(() => undefined);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

async function waitForReview(runId, statuses) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await getQualityReview(runId);
    if (statuses.includes(value.run.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`quality_review_wait_timeout:${runId}`);
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
        rationale: '模型建议仅供人工独立核验。',
        evidence_anchors: [],
        limitations: []
      })),
    limitations: [],
    generated_at: new Date().toISOString()
  };
}
