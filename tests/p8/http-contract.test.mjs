import assert from 'node:assert/strict';
import test from 'node:test';
import { CLEAN_V2_SCHEMAS } from '@aiws/contracts/clean-v2';
import { close, closeServer, listen, open } from './helpers.mjs';

test('P8 HTTP uses the shared dispatcher with closed route-specific contracts', async () => {
  const state = await open();
  const network = await listen(state.runtime);
  try {
    const operations = await json(await fetch(`${network.base}/api/v2/operations`, { headers: sessionHeaders(state.proof) }));
    assert.equal(operations.response.status, 200, JSON.stringify(operations.body));
    assert.ok(Array.isArray(operations.body.data.operations));

    const imports = await json(await fetch(`${network.base}/api/v2/imports`, { headers: sessionHeaders(state.proof) }));
    assert.equal(imports.response.status, 200, JSON.stringify(imports.body));
    assert.deepEqual(imports.body.data.imports, []);

    const gc = await json(await fetch(`${network.base}/api/v2/cas/gc/plan`, {
      method: 'POST', headers: mutationHeaders(state.proof, 'p8-http-gc-plan', 0), body: JSON.stringify({ limit: 10 })
    }));
    assert.equal(gc.response.status, 200, JSON.stringify(gc.body));
    assert.equal(gc.body.data.plan.count, 0);
    assert.match(gc.body.data.plan.plan_sha256, /^[a-f0-9]{64}$/);

    const unknownBody = await json(await fetch(`${network.base}/api/v2/cas/gc/plan`, {
      method: 'POST', headers: mutationHeaders(state.proof, 'p8-http-gc-unknown', 0), body: JSON.stringify({ unexpected: true })
    }));
    assert.equal(unknownBody.response.status, 400);
    assert.equal(unknownBody.body.error.code, 'unknown_field');

    const unknownQuery = await json(await fetch(`${network.base}/api/v2/operations?unexpected=1`, { headers: sessionHeaders(state.proof) }));
    assert.equal(unknownQuery.response.status, 400);
    assert.equal(unknownQuery.body.error.code, 'unknown_field');
    assert.equal((await fetch(`${network.base}/api/v2/operations`)).status, 401);

    const rawWebhook = await json(await fetch(`${network.base}/api/v2/webhooks/github`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'missing' }, body: JSON.stringify({ delivery_id: 'missing' })
    }));
    assert.equal(rawWebhook.response.status, 404);
    assert.equal(rawWebhook.body.error.code, 'delivery_not_found');
  } finally {
    await closeServer(network.server);
    await close(state);
  }
});

test('P8 registry, REST, MCP and Gateway publish the same closed command schemas', async () => {
  const state = await open();
  try {
    const entries = state.runtime.registry.entries.filter((entry) => entry.phase === 'p8');
    assert.ok(entries.length >= 25);
    assert.equal(Object.hasOwn(CLEAN_V2_SCHEMAS, 'p8.query.v2'), false);
    assert.equal(Object.hasOwn(CLEAN_V2_SCHEMAS, 'p8.mutation.v2'), false);
    for (const entry of entries) {
      assert.equal(CLEAN_V2_SCHEMAS[entry.input_schema].additionalProperties, false, entry.command_id);
      assert.equal(CLEAN_V2_SCHEMAS[entry.output_schema].additionalProperties, false, entry.command_id);
      const web = state.runtime.registry.web().find((item) => item.command_id === entry.command_id);
      const mcp = state.runtime.registry.mcp().find((item) => item.command_id === entry.command_id);
      assert.equal(web.input_schema, entry.input_schema);
      assert.equal(web.output_schema, entry.output_schema);
      assert.equal(mcp.input_schema, entry.input_schema);
      assert.equal(mcp.output_schema, entry.output_schema);
    }
    const exposed = new Set(state.runtime.dispatcher.tools().map((tool) => tool.command_id));
    assert.equal(exposed.has('delivery.policy.list'), true);
    assert.equal(exposed.has('delivery.intent.create'), true);
    assert.equal(exposed.has('github.webhook.receive'), false);
    assert.equal(exposed.has('deployment.verify'), false);
  } finally { await close(state); }
});

function sessionHeaders(proof) { return { cookie: `aiws_session=${proof}`, accept: 'application/json' }; }
function mutationHeaders(proof, key, revision) { return { ...sessionHeaders(proof), 'content-type': 'application/json', 'Idempotency-Key': key, 'X-Expected-Revision': String(revision) }; }
async function json(response) { return { response, body: await response.json() }; }
