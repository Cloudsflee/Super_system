import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';
import { close, open, prepare, waitOperation } from '../tests/p7/helpers.mjs';

await emitProbe('aiws.v3-clean.p7-quality-outcome-probe.v1', async () => {
  const state = await open({ config: { runtimeBuild: 'v3-clean-p7-quality-outcome-probe' } });
  let step = 'prepare';
  try {
    const fixture = await prepare(state, 'quality-outcome-probe');
    step = 'capture';
    const captured = await state.runtime.evidence.capture({
      project_id: fixture.project.id, execution_id: fixture.execution.id, logical_name: 'probe-result.json',
      asset_kind: 'execution_output', source_type: 'manual', source_ref: 'probe:quality-outcome',
      media_type: 'application/json', content_base64: Buffer.from('{"passed":true}').toString('base64'),
      expected_revision: 0, idempotency_key: 'p7-quality-outcome-probe-asset'
    }, state.principal);
    const started = await state.runtime.quality.start(fixture.execution.id, {
      asset_ids: [captured.asset.id], rubric: { dimensions: [{ key: 'correctness', weight: 70 }, { key: 'evidence', weight: 30 }] },
      threshold: 80, expected_revision: fixture.execution.revision, idempotency_key: 'p7-quality-outcome-probe-start'
    }, state.principal);
    step = 'quality-complete';
    if ((await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId)).status !== 'succeeded') throw Object.assign(new Error('quality_probe_failed'), { code: 'quality_probe_failed' });
    const review = state.runtime.quality.get(started.quality_review.id, state.principal).quality_review;
    step = 'decision';
    const decision = await state.runtime.quality.decision(review.id, {
      decision: 'approved', dimensions: [{ key: 'correctness', score: 92, reasoning: 'deterministic checks pass' }, { key: 'evidence', score: 88, reasoning: 'CAS hashes verified' }],
      reasoning: 'human decision bound to exact report and inputs', report_sha256: review.report_sha256,
      input_sha256: review.input_sha256, rubric_sha256: review.rubric_sha256,
      expected_revision: review.revision, idempotency_key: 'p7-quality-outcome-probe-decision'
    }, state.principal);

    const requirements = [];
    step = 'requirements';
    state.runtime.outcomeEvaluation.close();
    for (const [key, rubric] of [
      ['evidence', { evaluator: 'evidence_count', minimum: 1 }],
      ['tests', { evaluator: 'test_pass', check_id: 'missing-probe-check' }],
      ['digest', { evaluator: 'digest_match', expected_sha256: 'f'.repeat(64), digest_type: 'workspace' }],
      ['human', { evaluator: 'human_score', minimum: 80 }]
    ]) requirements.push((await state.runtime.project.createOutcomeRequirement(fixture.project.id, { requirement_key: `probe-${key}`, rubric, workflow_revision: 1, idempotency_key: `p7-quality-outcome-probe-${key}` }, state.principal)).requirement);
    const execution = state.runtime.execution.get(fixture.execution.id, state.principal);
    step = 'evaluate';
    const evaluated = await state.runtime.outcomeEvaluation.evaluate(execution.id, { expected_revision: execution.revision, idempotency_key: 'p7-quality-outcome-probe-evaluate' }, state.principal);
    if ((await waitOperation(state.runtime, evaluated.operation.operation_id, state.principal.actorId)).status !== 'succeeded') throw Object.assign(new Error('outcome_probe_failed'), { code: 'outcome_probe_failed' });
    await waitFor(() => state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation.requirement_count === 4);
    const blocked = state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation;
    step = 'waiver';
    const waiver = await state.runtime.outcomeEvaluation.createWaiver(execution.id, { reason: 'probe verifies bounded waiver generation', expected_revision: execution.revision, idempotency_key: 'p7-quality-outcome-probe-waiver' }, state.principal);
    await waitFor(() => state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation?.status === 'waived' && state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation.generation > blocked.generation);
    const waived = state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation;
    if (waived.status !== 'waived' || waived.generation <= blocked.generation) throw Object.assign(new Error('outcome_waiver_generation_failed'), { code: 'outcome_waiver_generation_failed' });
    step = 'revoke';
    await state.runtime.outcomeEvaluation.revokeWaiver(waiver.waiver.id, { reason: 'probe restores deterministic evaluation', expected_revision: 1, idempotency_key: 'p7-quality-outcome-probe-revoke' }, state.principal);
    await waitFor(() => state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation?.status === 'blocked' && state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation.generation > waived.generation);
    const revoked = state.runtime.outcomeEvaluation.get(execution.id, state.principal).evaluation;
    if (revoked.status !== 'blocked' || revoked.generation <= waived.generation) throw Object.assign(new Error('outcome_revoke_generation_failed'), { code: 'outcome_revoke_generation_failed' });
    step = 'receipt';
    const projected = state.runtime.db.get('SELECT count(*) AS count FROM quality_review_events').count;
    const generic = state.runtime.db.get("SELECT count(*) AS count FROM events WHERE aggregate_type='quality_review'").count;
    if (projected !== generic || decision.quality_review.human_review.weighted_score !== 90.8) throw Object.assign(new Error('quality_projection_mismatch'), { code: 'quality_projection_mismatch' });
    return {
      quality_status: decision.quality_review.status, weighted_score: decision.quality_review.human_review.weighted_score,
      report_sha256: review.report_sha256, decision_sha256: decision.quality_review.human_review.decision_sha256,
      quality_event_projection: { generic, projected, one_to_one: projected === generic },
      evaluators: blocked.evaluation.results.map((item) => item.evaluator).sort(),
      generations: { blocked: blocked.generation, waived: waived.generation, revoked: revoked.generation },
      terminal_statuses: { blocked: blocked.status, waived: waived.status, revoked: revoked.status },
      requirement_count: requirements.length
    };
  } catch (error) {
    error.code = `quality_outcome_${step}_${String(error?.code || error?.name || 'failed')}`;
    throw error;
  } finally { await close(state); }
});

async function waitFor(predicate, timeout = 5000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw Object.assign(new Error('quality_outcome_probe_timeout'), { code: 'quality_outcome_probe_timeout' }); }
