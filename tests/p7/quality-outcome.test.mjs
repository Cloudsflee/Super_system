import assert from 'node:assert/strict';
import test from 'node:test';
import { close, open, prepare, waitOperation } from './helpers.mjs';

test('Quality report, complete human scoring and Outcome replay share pinned hashes', async () => {
  const state = await open();
  try {
    const base = await prepare(state, 'quality-outcome');
    const captured = await state.runtime.evidence.capture({ project_id: base.project.id, execution_id: base.execution.id, logical_name: 'result.json', asset_kind: 'execution_output', source_type: 'manual', source_ref: 'fixture:quality-result', media_type: 'application/json', content_base64: Buffer.from('{"passed":true}').toString('base64'), expected_revision: 0, idempotency_key: 'p7-quality-asset-key' }, state.principal);
    const started = await state.runtime.quality.start(base.execution.id, { asset_ids: [captured.asset.id], rubric: { dimensions: [{ key: 'correctness', weight: 60 }, { key: 'evidence', weight: 40 }] }, threshold: 80, expected_revision: base.execution.revision, idempotency_key: 'p7-quality-start-key' }, state.principal);
    assert.equal((await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId)).status, 'succeeded');
    const review = state.runtime.quality.get(started.quality_review.id, state.principal).quality_review;
    assert.equal(review.status, 'awaiting_human');
    assert.throws(() => state.runtime.quality.decision(review.id, { decision: 'approved', dimensions: [{ key: 'correctness', score: 90, reasoning: 'complete' }], reasoning: 'incomplete scoring', report_sha256: review.report_sha256, input_sha256: review.input_sha256, rubric_sha256: review.rubric_sha256, expected_revision: review.revision, idempotency_key: 'p7-quality-incomplete' }, state.principal), (error) => error.code === 'quality_decision_invalid');
    const decided = await state.runtime.quality.decision(review.id, { decision: 'approved', dimensions: [{ key: 'correctness', score: 90, reasoning: 'checks pass' }, { key: 'evidence', score: 85, reasoning: 'hashes verified' }], reasoning: 'reviewed against exact report and input hashes', report_sha256: review.report_sha256, input_sha256: review.input_sha256, rubric_sha256: review.rubric_sha256, expected_revision: review.revision, idempotency_key: 'p7-quality-decision-key' }, state.principal);
    assert.equal(decided.quality_review.status, 'completed');
    assert.equal(decided.quality_review.human_review.weighted_score, 88);
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM quality_review_events').count, state.runtime.db.get("SELECT count(*) AS count FROM events WHERE aggregate_type='quality_review'").count);

    await state.runtime.project.createOutcomeRequirement(base.project.id, { requirement_key: 'evidence-present', rubric: { evaluator: 'evidence_count', minimum: 1 }, workflow_revision: 1, idempotency_key: 'p7-outcome-requirement-key' }, state.principal);
    await state.runtime.project.createOutcomeRequirement(base.project.id, { requirement_key: 'human-score', rubric: { evaluator: 'human_score', minimum: 80 }, workflow_revision: 1, idempotency_key: 'p7-outcome-human-key' }, state.principal);
    const execution = state.runtime.execution.get(base.execution.id, state.principal);
    const evaluating = await state.runtime.outcomeEvaluation.evaluate(execution.id, { expected_revision: execution.revision, idempotency_key: 'p7-outcome-evaluate-key' }, state.principal);
    assert.equal((await waitOperation(state.runtime, evaluating.operation.operation_id, state.principal.actorId)).status, 'succeeded');
    const outcome = state.runtime.outcomeEvaluation.get(execution.id, state.principal);
    assert.equal(outcome.evaluation.status, 'passed');
    assert.equal(outcome.evaluation.requirement_count, 2);
    assert.equal(outcome.evaluation.passed_count, 2);
    await state.runtime.project.createOutcomeRequirement(base.project.id, { requirement_key: 'automatic-generation', rubric: { evaluator: 'evidence_count', minimum: 1 }, workflow_revision: 1, idempotency_key: 'p7-outcome-auto-generation-key' }, state.principal);
    await waitFor(() => state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation.generation > outcome.evaluation.generation);
    const regenerated = state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation;
    assert.equal(regenerated.requirement_count, 3);
    assert.equal(regenerated.status, 'passed');
    assert.throws(() => state.runtime.db.run("UPDATE outcome_evaluations SET status='blocked'"), /immutable_outcome_evaluation/);
  } finally { await close(state); }
});

async function waitFor(predicate, timeout = 3000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('p7_outcome_wait_timeout'); }

test('Outcome waiver and revocation are immutable generations bound to approval proof', async () => {
  const state = await open();
  try {
    const base = await prepare(state, 'outcome-waiver');
    const requirement = await state.runtime.project.createOutcomeRequirement(base.project.id, { requirement_key: 'missing-test', rubric: { evaluator: 'test_pass', check_id: 'missing' }, workflow_revision: 1, idempotency_key: 'p7-waiver-requirement-key' }, state.principal);
    const execution = state.runtime.execution.get(base.execution.id, state.principal);
    const grant = await state.runtime.outcomeEvaluation.createWaiver(execution.id, { requirement_id: requirement.requirement.id, reason: 'accepted gap for this fixture', expected_revision: execution.revision, idempotency_key: 'p7-waiver-grant-key' }, state.principal);
    assert.equal(grant.waiver.action, 'grant');
    await waitFor(() => state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation?.status === 'waived');
    const waivedGeneration = state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation.generation;
    const revoke = await state.runtime.outcomeEvaluation.revokeWaiver(grant.waiver.id, { reason: 'gap must be evaluated again', expected_revision: 1, idempotency_key: 'p7-waiver-revoke-key' }, state.principal);
    assert.equal(revoke.waiver.action, 'revoke');
    assert.equal(revoke.waiver.revokes_waiver_id, grant.waiver.id);
    await waitFor(() => state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation?.status === 'blocked' && state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation.generation > waivedGeneration);
    assert.throws(() => state.runtime.db.run("UPDATE outcome_waivers SET reason='changed'"), /immutable_outcome_waiver/);
  } finally { await close(state); }
});
