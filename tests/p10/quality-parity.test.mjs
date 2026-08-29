import assert from 'node:assert/strict';
import test from 'node:test';
import { prepare as prepareP8 } from '../p8/helpers.mjs';
import { DEFAULT_QUALITY_RUBRIC, DeterministicQualityAdviceAdapter } from '../../apps/api/src/clean/quality-service.mjs';
import { close, open, waitOperation } from './helpers.mjs';

async function reviewerProfile(state, suffix = 'quality') {
  const credential = await state.runtime.identity.createCredential({ provider: 'codex', external_ref: `${suffix}-reviewer`, idempotency_key: `p10-${suffix}-credential` }, state.principal);
  await state.runtime.identity.rebindCredential(credential.credential.id, { proof: `${suffix}-quality-proof-123456789`, expected_revision: 1, idempotency_key: `p10-${suffix}-rebind` }, state.principal);
  const profile = await state.runtime.identity.createProfile({ provider: 'codex', label: `Reviewer ${suffix}`, credential_ref_id: credential.credential.id, config: { model: 'fixture-reviewer' }, idempotency_key: `p10-${suffix}-profile` }, state.principal);
  await state.runtime.identity.probeProfile(profile.profile.id, { expected_revision: 1, idempotency_key: `p10-${suffix}-probe` }, state.principal);
  return state.runtime.db.get('SELECT * FROM provider_profiles WHERE id=?', [profile.profile.id]);
}

function scores(rubric, base = 90) {
  return rubric.dimensions.filter((item) => item.enabled).map((item, index) => ({ key: item.key, score: base - index, reasoning: `${item.key} was reviewed independently.` }));
}

async function awaitReview(state, operationId) {
  try { await waitOperation(state.runtime, operationId, state.principal.actorId, 15_000); }
  catch (error) {
    const operation = state.runtime.operations.get(operationId, { actorId: state.principal.actorId });
    const review = state.runtime.db.get('SELECT * FROM quality_review_runs WHERE operation_id=?', [operationId]);
    throw new Error(`${error.message}:${JSON.stringify({ operation_status: operation.status, operation_revision: operation.revision, review_status: review?.status, review_revision: review?.revision, active: [...state.runtime.quality.active] })}`);
  }
  const operation = state.runtime.operations.get(operationId, { actorId: state.principal.actorId });
  return state.runtime.quality.get(operation.result.quality_review_id, state.principal).quality_review;
}

test('Quality policy, readiness, selections, closed advice, human scoring, supersession, and stale history are separate', async () => {
  const adviceAdapter = new DeterministicQualityAdviceAdapter({ advice: {
    schema_version: 'quality.advice.v1', summary: 'Advisory only.',
    dimensions: [{ key: 'coverage', rationale: 'Check all acceptance assets.', suggested_score: 87 }],
    cautions: ['Do not copy advice into the human form.']
  } });
  const state = await open({ qualityAdviceAdapter: adviceAdapter });
  try {
    const prepared = await prepareP8(state, 'quality-parity');
    const profile = await reviewerProfile(state, 'quality-parity');
    const execution = state.runtime.execution.get(prepared.execution.id, state.principal);
    const policy = await state.runtime.quality.updatePolicy(execution.workflow_id, { rubric: DEFAULT_QUALITY_RUBRIC, threshold: 82, reviewer_profile_id: profile.id, expected_revision: 0, idempotency_key: 'p10-quality-policy' }, state.principal);
    assert.deepEqual(policy.policy.rubric.dimensions.map((item) => item.key), ['coverage','accuracy','depth','consistency','clarity']);

    const excluded = await state.runtime.evidence.capture({ project_id: prepared.project.id, execution_id: execution.id, logical_name: 'excluded-note.txt', asset_kind: 'execution_output', source_type: 'manual', source_ref: 'fixture:excluded', media_type: 'text/plain', content_base64: Buffer.from('excluded by reviewer').toString('base64'), expected_revision: 0, idempotency_key: 'p10-quality-excluded-asset' }, state.principal);
    const readiness = await state.runtime.quality.prepare(execution.id, {}, state.principal);
    assert.equal(readiness.readiness.ready, true);
    assert.equal(readiness.readiness.checks.reviewer, 'ready');
    const includedId = prepared.asset.id;
    const selections = [
      { asset_id: includedId, disposition: 'included' },
      { asset_id: excluded.asset.id, disposition: 'excluded', exclusion_reason: 'Supporting note is outside acceptance scope.' }
    ];
    const started = await state.runtime.quality.start(execution.id, { asset_ids: [includedId], asset_selections: selections, expected_revision: execution.revision, idempotency_key: 'p10-quality-start' }, state.principal);
    const review = await awaitReview(state, started.operation.operation_id);
    assert.equal(review.status, 'awaiting_human');
    assert.equal(review.selections.find((item) => item.disposition === 'excluded').exclusion_reason, 'Supporting note is outside acceptance scope.');
    assert.equal(review.advice.status, 'valid');
    assert.equal(review.advice.advice.dimensions[0].suggested_score, 87);
    assert.equal(review.human_review, null);
    await assert.rejects(state.runtime.quality.start(execution.id, { asset_ids: [includedId], expected_revision: execution.revision, idempotency_key: 'p10-quality-second-active' }, state.principal), (error) => error.code === 'quality_review_active');

    const decided = await state.runtime.quality.decision(review.id, { decision: 'approved', dimensions: scores(review.rubric), reasoning: 'Human review completed without prefilled values.', report_sha256: review.report_sha256, input_sha256: review.input_sha256, rubric_sha256: review.rubric_sha256, expected_revision: review.revision, idempotency_key: 'p10-quality-decision' }, state.principal);
    assert.equal(decided.quality_review.human_review.dimensions.length, 5);
    assert.equal(decided.quality_review.human_review.dimensions[0].score, 90);

    const secondStart = await state.runtime.quality.start(execution.id, { asset_ids: [includedId], expected_revision: execution.revision, idempotency_key: 'p10-quality-generation-2' }, state.principal);
    const secondReview = await awaitReview(state, secondStart.operation.operation_id);
    const secondDecision = await state.runtime.quality.decision(secondReview.id, { decision: 'approved', dimensions: scores(secondReview.rubric, 95), reasoning: 'A newer current review.', report_sha256: secondReview.report_sha256, input_sha256: secondReview.input_sha256, rubric_sha256: secondReview.rubric_sha256, expected_revision: secondReview.revision, idempotency_key: 'p10-quality-generation-2-decision' }, state.principal);
    assert.equal(secondDecision.quality_review.supersedes_quality_review_id, review.id);
    assert.deepEqual(state.runtime.db.get('SELECT status,superseded_by_quality_review_id FROM quality_review_runs WHERE id=?', [review.id]), { status: 'completed', superseded_by_quality_review_id: secondReview.id });

    await state.runtime.quality.updatePolicy(execution.workflow_id, { rubric: DEFAULT_QUALITY_RUBRIC, threshold: 90, reviewer_profile_id: profile.id, expected_revision: 1, idempotency_key: 'p10-quality-policy-2' }, state.principal);
    await state.runtime.quality.prepare(execution.id, {}, state.principal);
    const stale = state.runtime.quality.get(secondReview.id, state.principal).quality_review;
    assert.equal(stale.status, 'stale');
    assert.ok(stale.stale_at);
    assert.equal(state.runtime.db.get("SELECT count(*) AS n FROM quality_review_runs WHERE execution_id=? AND status='completed' AND id NOT IN (SELECT supersedes_quality_review_id FROM quality_review_runs WHERE supersedes_quality_review_id IS NOT NULL)", [execution.id]).n, 0);
  } finally { await close(state); }
});

test('invalid or unavailable Quality advice never blocks the human review state', async () => {
  for (const status of ['invalid','unavailable']) {
    const state = await open({ qualityAdviceAdapter: new DeterministicQualityAdviceAdapter({ status }) });
    try {
      const prepared = await prepareP8(state, `advice-${status}`);
      const profile = await reviewerProfile(state, `advice-${status}`);
      const execution = state.runtime.execution.get(prepared.execution.id, state.principal);
      await state.runtime.quality.updatePolicy(execution.workflow_id, { rubric: DEFAULT_QUALITY_RUBRIC, reviewer_profile_id: profile.id, expected_revision: 0, idempotency_key: `p10-${status}-policy` }, state.principal);
      const started = await state.runtime.quality.start(execution.id, { asset_ids: [prepared.asset.id], expected_revision: execution.revision, idempotency_key: `p10-${status}-start` }, state.principal);
      const review = await awaitReview(state, started.operation.operation_id);
      assert.equal(review.status, 'awaiting_human');
      assert.equal(review.advice.status, status);
      assert.equal(review.human_review, null);
    } finally { await close(state); }
  }
});

test('default Quality policy restores all five dimensions without a configured reviewer', async () => {
  const state = await open();
  try {
    const prepared = await prepareP8(state, 'quality-default');
    const execution = state.runtime.execution.get(prepared.execution.id, state.principal);
    const started = await state.runtime.quality.start(execution.id, { asset_ids: [prepared.asset.id], expected_revision: execution.revision, idempotency_key: 'p10-quality-default-start' }, state.principal);
    const review = await awaitReview(state, started.operation.operation_id);
    assert.deepEqual(review.rubric.dimensions.map((item) => item.key), ['coverage','accuracy','depth','consistency','clarity']);
    assert.equal(review.advice.status, 'unavailable');
    assert.equal(review.status, 'awaiting_human');
  } finally { await close(state); }
});
