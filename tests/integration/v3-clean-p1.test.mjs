import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { createCleanHttpHandler } from '../../apps/api/src/clean/http.mjs';

function cleanConfig(root) {
  return { runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root, databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'), receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'), cursorSecret: 'integration-cursor', sessionSecret: 'integration-session-secret', vaultMasterKey: 'integration-vault-master-key', runtimeBuild: 'integration', maxBodyBytes: 100000 };
}

async function provision(runtime, key) {
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'Integration owner', team_name: 'Integration team', idempotency_key: key });
  return { setup, principal: runtime.identity.authenticateProof(setup.session.proof), cookie: `aiws_session=${setup.session.proof}` };
}

test('clean restart preserves terminal operation and SSE/JSON replay parity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-integration-'));
  const config = cleanConfig(root);
  let runtime = createCleanRuntime({ config });
  const owner = await provision(runtime, 'integration-restart-setup-1');
  const created = await runtime.operations.create({ actorId: owner.principal.actorId, commandId: 'integration.run', idempotencyKey: 'integration-create-1', request: { fixture: true }, resourceType: 'probe', resourceId: 'probe_1' });
  const queued = await runtime.operations.queue(created.operation_id, { expectedRevision: created.revision });
  const running = await runtime.operations.start(created.operation_id, { expectedRevision: queued.revision });
  await runtime.operations.succeed(created.operation_id, { expectedRevision: running.revision, result: { verified: true } });
  runtime.close();

  runtime = createCleanRuntime({ config });
  await runtime.recovery;
  runtime.identity.authenticateProof(owner.setup.session.proof);
  assert.equal(runtime.operations.get(created.operation_id).status, 'succeeded');
  assert.equal(runtime.db.get('select count(*) as count from schema_migrations').count, 2);
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => { Promise.resolve(handler(request, response)).catch((error) => response.end(String(error))); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jsonResponse = await fetch(`${base}/api/v2/operations/${created.operation_id}/events?format=json`, { headers: { cookie: owner.cookie } });
  const json = await jsonResponse.json();
  const sseResponse = await fetch(`${base}/api/v2/operations/${created.operation_id}/events`, { headers: { cookie: owner.cookie, accept: 'text/event-stream' } });
  const sseText = await sseResponse.text();
  const sseEvents = sseText.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(sseEvents.map((event) => event.id), json.data.events.map((event) => event.id));
  assert.equal(json.data.terminal, true);
  const resumeAfter = json.data.events[1].sequence;
  const resumed = await fetch(`${base}/api/v2/operations/${created.operation_id}/events`, { headers: { cookie: owner.cookie, accept: 'text/event-stream', 'Last-Event-ID': String(resumeAfter) } });
  const resumedEvents = (await resumed.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(resumedEvents.map((event) => event.sequence), json.data.events.slice(2).map((event) => event.sequence));
  await new Promise((resolve) => server.close(resolve));
  runtime.close();
});

test('clean boundary validates readiness, aggregate CAS, cursors, and live SSE heartbeat', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-boundary-'));
  const runtime = createCleanRuntime({ config: cleanConfig(root) });
  const owner = await provision(runtime, 'integration-boundary-setup-1');
  const actorId = owner.principal.actorId;

  const first = await runtime.platform.mutateAggregate({
    actorId,
    commandId: 'integration.aggregate',
    idempotencyKey: 'aggregate-key-1',
    aggregateType: 'probe',
    aggregateId: 'probe_aggregate_1',
    request: { state: 'created' },
    payload: { state: 'created' },
    result: { state: 'created' },
    eventType: 'probe.created'
  });
  const replayed = await runtime.platform.mutateAggregate({
    actorId,
    commandId: 'integration.aggregate',
    idempotencyKey: 'aggregate-key-1',
    aggregateType: 'probe',
    aggregateId: 'probe_aggregate_1',
    request: { state: 'created' },
    payload: { state: 'created' },
    result: { state: 'created' },
    eventType: 'probe.created'
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.event_id, first.event_id);
  const linkedOperation = await runtime.operations.create({ actorId, commandId: 'integration.aggregate-link', idempotencyKey: 'aggregate-link-1', request: {}, resourceType: 'probe', resourceId: 'probe_aggregate_1' });
  const linked = await runtime.platform.mutateAggregate({
    actorId,
    commandId: 'integration.aggregate.linked',
    idempotencyKey: 'aggregate-linked-1',
    aggregateType: 'probe',
    aggregateId: 'probe_aggregate_1',
    expectedRevision: 1,
    operationId: linkedOperation.operation_id,
    request: { state: 'linked' },
    payload: { state: 'linked' }
  });
  assert.equal(linked.revision, 2);
  assert.equal(runtime.db.get("select count(*) as count from operation_links where operation_id=? and relation='target'", [linkedOperation.operation_id]).count, 1);
  await assert.rejects(() => runtime.platform.mutateAggregate({
    actorId,
    commandId: 'integration.aggregate',
    idempotencyKey: 'aggregate-key-1',
    aggregateType: 'probe',
    aggregateId: 'probe_aggregate_1',
    request: { state: 'changed' },
    payload: { state: 'changed' }
  }), (error) => error.code === 'idempotency_conflict');
  await assert.rejects(() => runtime.platform.mutateAggregate({
    actorId,
    commandId: 'integration.aggregate.next',
    idempotencyKey: 'aggregate-key-2',
    aggregateType: 'probe',
    aggregateId: 'probe_aggregate_1',
    expectedRevision: 1,
    payload: { state: 'stale' }
  }), (error) => error.code === 'revision_conflict');

  const replay = runtime.events.replay({ actorId, aggregateType: 'probe', aggregateId: 'probe_aggregate_1', consumerId: 'integration-consumer' });
  assert.equal(replay.events.length, 2);
  assert.equal(replay.cursor.revision, 1);
  const advanced = runtime.events.ackCursor({ actorId, consumerId: 'integration-consumer', stream: 'probe:probe_aggregate_1', cursor: replay.next_cursor, query: { operation_id: null, aggregate_type: 'probe', aggregate_id: 'probe_aggregate_1' }, expectedRevision: 1 });
  assert.equal(advanced.revision, 2);
  assert.throws(() => runtime.events.ackCursor({ actorId, consumerId: 'integration-consumer', stream: 'probe:probe_aggregate_1', cursor: '0', expectedRevision: 2 }), (error) => error.code === 'cursor_regression');

  const operation = await runtime.operations.create({ actorId, commandId: 'integration.live', idempotencyKey: 'live-operation-1', request: {}, resourceType: 'probe', resourceId: 'probe_live' });
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => { Promise.resolve(handler(request, response)).catch((error) => response.end(String(error))); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await fetch(`${base}/livez`)).json()).data.status, 'live');
    assert.equal((await (await fetch(`${base}/readyz`)).json()).data.status, 'ready');
    const missing = await fetch(`${base}/api/v2/unknown`, { headers: { cookie: owner.cookie } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'not_found');
    const invalidCursor = await fetch(`${base}/api/v2/operations/${operation.operation_id}/events?cursor=bad`, { headers: { cookie: owner.cookie } });
    assert.equal(invalidCursor.status, 400);
    assert.equal((await invalidCursor.json()).error.code, 'cursor_invalid');
    const controller = new AbortController();
    const liveSse = await fetch(`${base}/api/v2/operations/${operation.operation_id}/events`, { headers: { cookie: owner.cookie, accept: 'text/event-stream' }, signal: controller.signal });
    const reader = liveSse.body.getReader();
    let liveText = '';
    for (let index = 0; index < 3 && !liveText.includes(': heartbeat'); index += 1) {
      const frame = await reader.read();
      liveText += new TextDecoder().decode(frame.value || new Uint8Array());
    }
    assert.match(liveText, /: heartbeat/);
    controller.abort();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
  }
});

test('CAS manifest drift keeps probes alive but blocks readiness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-cas-ready-'));
  const config = cleanConfig(root);
  let runtime = createCleanRuntime({ config });
  runtime.close();
  const manifestFile = path.join(config.casRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.manifest_sha256 = '0'.repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  runtime = createCleanRuntime({ config });
  assert.equal(runtime.ready, false);
  assert.equal(runtime.readinessReason, 'cas_manifest_mismatch');
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => Promise.resolve(handler(request, response)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/livez`)).status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).error.code, 'not_ready');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
  }
});

test('non-terminal SSE follows committed events and closes on terminal state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-live-sse-'));
  const runtime = createCleanRuntime({ config: cleanConfig(root) });
  const owner = await provision(runtime, 'integration-stream-setup-1');
  const operation = await runtime.operations.create({ actorId: owner.principal.actorId, commandId: 'integration.stream', idempotencyKey: 'integration-stream-1', request: {}, resourceType: 'probe', resourceId: 'probe_stream' });
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => { Promise.resolve(handler(request, response)).catch((error) => response.end(String(error))); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/v2/operations/${operation.operation_id}/events`, { headers: { cookie: owner.cookie, accept: 'text/event-stream' } });
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes(': heartbeat')) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value || new Uint8Array());
    }
    const queued = await runtime.operations.queue(operation.operation_id, { expectedRevision: operation.revision });
    const running = await runtime.operations.start(operation.operation_id, { expectedRevision: queued.revision });
    await runtime.operations.succeed(operation.operation_id, { expectedRevision: running.revision, result: { streamed: true } });
    while (true) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value || new Uint8Array());
      if (chunk.done) break;
    }
    const streamed = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const replay = runtime.events.replay({ operationId: operation.operation_id });
    assert.deepEqual(streamed.map((event) => event.id), replay.events.map((event) => event.id));
    assert.deepEqual(streamed.map((event) => event.sequence), [...streamed.map((event) => event.sequence)].sort((left, right) => left - right));
    assert.equal(streamed.at(-1).type, 'operation.succeeded');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
  }
});
