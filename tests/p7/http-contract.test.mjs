import assert from 'node:assert/strict';
import test from 'node:test';
import { close, closeServer, listen, open, prepare, waitOperation } from './helpers.mjs';

test('P7 HTTP exposes Evidence, Parser, Quality and Outcome through strict v2 receipts', async () => {
  const state = await open();
  const network = await listen(state.runtime);
  try {
    const fixture = await prepare(state, 'http');
    const bytes = Buffer.from('{"http":true}');
    const captured = await json(await fetch(`${network.base}/api/v2/projects/${fixture.project.id}/assets`, {
      method: 'POST',
      headers: mutationHeaders(state.proof, 'p7-http-capture', 0),
      body: JSON.stringify({
        execution_id: fixture.execution.id,
        logical_name: 'http-result.json',
        asset_kind: 'execution_output',
        source_type: 'manual',
        source_ref: 'fixture:http-result',
        media_type: 'application/json',
        content_base64: bytes.toString('base64')
      })
    }));
    assert.equal(captured.response.status, 201, JSON.stringify(captured.body));
    const asset = captured.body.data.asset;

    const listed = await json(await fetch(`${network.base}/api/v2/projects/${fixture.project.id}/assets`, { headers: sessionHeaders(state.proof) }));
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.data.assets.some((item) => item.id === asset.id));
    const versions = await json(await fetch(`${network.base}/api/v2/assets/${asset.id}/versions`, { headers: sessionHeaders(state.proof) }));
    assert.equal(versions.body.data.versions.length, 1);
    const content = await fetch(`${network.base}/api/v2/assets/${asset.id}/versions/${asset.current_version_id}/content`, { headers: sessionHeaders(state.proof) });
    assert.equal(content.status, 200);
    assert.equal(content.headers.get('content-type'), 'application/json');
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);

    const parse = await json(await fetch(`${network.base}/api/v2/assets/${asset.id}/versions/${asset.current_version_id}/parse`, {
      method: 'POST', headers: mutationHeaders(state.proof, 'p7-http-parse', asset.revision), body: JSON.stringify({ format_key: 'json' })
    }));
    assert.equal(parse.response.status, 202, JSON.stringify(parse.body));
    assert.equal((await waitOperation(state.runtime, parse.body.data.operation_id, state.principal.actorId)).status, 'succeeded');
    const parserRun = state.runtime.db.get('SELECT id FROM parser_runs WHERE source_asset_version_id=? ORDER BY created_at DESC LIMIT 1', [asset.current_version_id]);
    const parsed = await json(await fetch(`${network.base}/api/v2/parser-runs/${parserRun.id}`, { headers: sessionHeaders(state.proof) }));
    assert.equal(parsed.body.data.parser_run.status, 'parsed');

    const quality = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/quality-reviews`, {
      method: 'POST', headers: mutationHeaders(state.proof, 'p7-http-quality', fixture.execution.revision),
      body: JSON.stringify({ asset_ids: [asset.id], rubric: { dimensions: [{ key: 'correctness', weight: 100 }] }, threshold: 80 })
    }));
    assert.equal(quality.response.status, 202, JSON.stringify(quality.body));
    assert.equal((await waitOperation(state.runtime, quality.body.data.operation_id, state.principal.actorId)).status, 'succeeded');
    const qualityList = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/quality-reviews`, { headers: sessionHeaders(state.proof) }));
    const review = qualityList.body.data.quality_reviews[0];
    assert.equal(review.status, 'awaiting_human');
    const decision = await json(await fetch(`${network.base}/api/v2/quality-reviews/${review.id}/decision`, {
      method: 'POST', headers: mutationHeaders(state.proof, 'p7-http-decision', review.revision),
      body: JSON.stringify({ decision: 'approved', dimensions: [{ key: 'correctness', score: 90, reasoning: 'verified output' }], reasoning: 'reviewed against pinned hashes', report_sha256: review.report_sha256, input_sha256: review.input_sha256, rubric_sha256: review.rubric_sha256 })
    }));
    assert.equal(decision.response.status, 200, JSON.stringify(decision.body));
    assert.equal(decision.body.data.quality_review.human_review.weighted_score, 90);

    await state.runtime.project.createOutcomeRequirement(fixture.project.id, { requirement_key: 'http-evidence', rubric: { evaluator: 'evidence_count', minimum: 1 }, workflow_revision: 1, idempotency_key: 'p7-http-requirement' }, state.principal);
    const execution = state.runtime.execution.get(fixture.execution.id, state.principal);
    const evaluation = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/outcome/evaluate`, {
      method: 'POST', headers: mutationHeaders(state.proof, 'p7-http-outcome', execution.revision), body: '{}'
    }));
    assert.equal(evaluation.response.status, 202, JSON.stringify(evaluation.body));
    assert.equal((await waitOperation(state.runtime, evaluation.body.data.operation_id, state.principal.actorId)).status, 'succeeded');
    const outcome = await json(await fetch(`${network.base}/api/v2/executions/${fixture.execution.id}/outcome`, { headers: sessionHeaders(state.proof) }));
    assert.equal(outcome.body.data.evaluation.status, 'passed');

    assert.equal((await fetch(`${network.base}/api/v2/projects/${fixture.project.id}/assets`)).status, 401);
    assert.equal((await fetch(`${network.base}/api/v1/projects/${fixture.project.id}/assets`)).status, 410);
    const unknown = await json(await fetch(`${network.base}/api/v2/assets/${asset.id}?unexpected=1`, { headers: sessionHeaders(state.proof) }));
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.error.code, 'unknown_field');
  } finally {
    await closeServer(network.server);
    await close(state);
  }
});

function sessionHeaders(proof) { return { cookie: `aiws_session=${proof}`, accept: 'application/json' }; }
function mutationHeaders(proof, key, revision) { return { ...sessionHeaders(proof), 'content-type': 'application/json', 'Idempotency-Key': key, 'X-Expected-Revision': String(revision) }; }
async function json(response) { return { response, body: await response.json() }; }
