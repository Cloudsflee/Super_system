import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  canonicalJson,
  canonicalHash,
  sha256Hex,
  RedactionPolicy,
  RedactionError,
  openCleanDatabase,
  initializeCleanDatabase,
  CleanNotReadyError,
  CasStore,
  EventService,
  OperationService,
  encodeCursor,
  decodeCursor,
  CursorError,
  createCleanRuntime,
  createCleanHttpHandler,
  loadCleanConfig,
  ReceiptService,
  createCleanCommandRegistry,
  registryParity,
  validateCleanOwnership,
  CLEAN_TABLE_OWNERS
} from '../../apps/api/src/clean/index.mjs';
import { createApp as createCleanApp } from '../../apps/api/clean-server.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p1-'));
  const databaseFile = path.join(root, 'data', 'state.sqlite');
  const casRoot = path.join(root, 'cas');
  const receiptRoot = path.join(root, 'receipts');
  const config = { runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root, databaseFile, casRoot, receiptRoot, vaultRoot: path.join(root, 'vault'), cursorSecret: 'p1-test-secret', sessionSecret: 'p1-test-session-secret', vaultMasterKey: 'p1-test-vault-master-key', runtimeBuild: 'p1-test', maxBodyBytes: 100000 };
  return { root, config, databaseFile, casRoot, receiptRoot };
}

test('canonical JSON and SHA-256 are stable', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(canonicalHash({ a: 1 }), `sha256:${sha256Hex('{"a":1}')}`);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /canonical_number_invalid/);
  assert.throws(() => canonicalJson({ value: 1n }), /canonical_bigint_invalid/);
  assert.throws(() => loadCleanConfig({ AIWS_CLEAN_MAX_BODY: 'not-a-number' }), /clean_max_body_invalid/);
});

test('clean baseline is idempotent and has one bootstrap actor', () => {
  const f = fixture();
  const first = openCleanDatabase(f.databaseFile, { receiptRoot: f.receiptRoot, runtimeBuild: 'test' });
  const baseline = first.metadata;
  assert.equal(first.integrity().journal_mode, 'wal');
  assert.equal(first.integrity().user_version, 1);
  assert.deepEqual(first.query("select name from sqlite_schema where type='table' and name not like 'sqlite_%' order by name").map((row) => row.name), [
    'actors', 'aggregate_heads', 'aggregate_revisions', 'audit_events', 'cas_objects', 'event_cursors', 'events', 'idempotency_keys', 'operation_links', 'operations', 'receipt_manifests', 'schema_meta', 'schema_migrations'
  ]);
  first.close();
  const second = openCleanDatabase(f.databaseFile, { receiptRoot: f.receiptRoot, runtimeBuild: 'test' });
  assert.equal(second.metadata.schema_sha256, baseline.schema_sha256);
  assert.equal(second.get('select count(*) as count from actors').count, 1);
  assert.equal(second.get('select count(*) as count from schema_migrations').count, 1);
  second.close();
});

test('historical schema is held for importer and emits a receipt', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.databaseFile), { recursive: true });
  const old = new DatabaseSync(f.databaseFile);
  old.exec("create table old_state(id text primary key); insert into old_state values ('fixture')");
  old.close();
  assert.throws(() => openCleanDatabase(f.databaseFile, { receiptRoot: f.receiptRoot }), (error) => {
    assert.ok(error instanceof CleanNotReadyError);
    assert.equal(error.details.importer_command, 'import.inspect');
    assert.equal(error.details.reason, 'historical_schema');
    return true;
  });
  const receipts = fs.readdirSync(f.receiptRoot).filter((name) => name.startsWith('importer-request-'));
  assert.equal(receipts.length, 1);
});

test('nonzero user_version without a clean family is held for importer', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.databaseFile), { recursive: true });
  const old = new DatabaseSync(f.databaseFile);
  old.exec('PRAGMA user_version = 6');
  old.close();
  assert.throws(() => openCleanDatabase(f.databaseFile, { receiptRoot: f.receiptRoot }), (error) => error.code === 'not_ready' && error.details.reason === 'historical_schema');
  assert.equal(fs.readdirSync(f.receiptRoot).filter((name) => name.startsWith('importer-request-')).length, 1);
});

test('baseline DDL and ledger faults roll back as one transaction', () => {
  for (const failAt of ['ddl', 'metadata', 'ledger', 'commit']) {
    const f = fixture();
    assert.throws(() => openCleanDatabase(f.databaseFile, { receiptRoot: f.receiptRoot, failAt }), (error) => error.code === 'not_ready' && error.details.reason === 'migration_failed');
    assert.equal(fs.existsSync(f.databaseFile), true);
    const db = new DatabaseSync(f.databaseFile, { readOnly: true });
    assert.deepEqual(db.prepare("select name from sqlite_schema where type='table' and name not like 'sqlite_%'").all(), []);
    db.close();
    const recovered = openCleanDatabase(f.databaseFile, { receiptRoot: f.receiptRoot });
    assert.equal(recovered.metadata.user_version, 1);
    recovered.close();
  }
});

test('operation transitions atomically update head, revision, event and audit', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const events = new EventService({ db, cursorSecret: 'p1-test-secret' });
  const operations = new OperationService({ db, events });
  const created = await operations.create({ commandId: 'probe.run', idempotencyKey: 'operation-key-1', request: { input: 'x' }, resourceType: 'probe', resourceId: 'probe_1' });
  const queued = await operations.queue(created.operation_id, { expectedRevision: created.revision });
  const running = await operations.start(created.operation_id, { expectedRevision: queued.revision });
  const succeeded = await operations.succeed(created.operation_id, { expectedRevision: running.revision, result: { value: 1 } });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(db.get("select current_revision from aggregate_heads where aggregate_type='operation' and aggregate_id=?", [created.operation_id]).current_revision, 4);
  assert.equal(db.get('select count(*) as count from events where operation_id=?', [created.operation_id]).count, 4);
  assert.equal(db.get('select count(*) as count from audit_events where operation_id=?', [created.operation_id]).count, 4);
  await assert.rejects(() => operations.start(created.operation_id, { expectedRevision: succeeded.revision }), (error) => error.code === 'state_conflict');
  assert.equal(db.get('select status from operations where id=?', [created.operation_id]).status, 'succeeded');
  db.close();
});

test('operation state machine requires queued before running', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const operations = new OperationService({ db });
  const created = await operations.create({ commandId: 'probe.state-machine', idempotencyKey: 'state-machine-1', request: {}, resourceType: 'probe', resourceId: 'probe_1' });
  await assert.rejects(() => operations.start(created.operation_id, { expectedRevision: created.revision }), (error) => error.code === 'state_conflict');
  assert.equal(operations.get(created.operation_id).status, 'accepted');
  db.close();
});

test('startup rejects a tampered aggregate head semantic hash', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const operations = new OperationService({ db });
  await operations.create({ commandId: 'probe.semantic', idempotencyKey: 'semantic-head-1', request: {}, resourceType: 'probe', resourceId: 'probe_1' });
  db.close();
  const raw = new DatabaseSync(f.databaseFile);
  raw.prepare("UPDATE aggregate_heads SET current_hash=? WHERE aggregate_type='operation' AND aggregate_id LIKE 'op_%'").run('0'.repeat(64));
  raw.close();
  assert.throws(() => initializeCleanDatabase({ file: f.databaseFile }), (error) => error.code === 'not_ready' && error.details.reason === 'semantic_integrity_failed');
});

test('checksum drift leaves the process live but not ready', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  db.close();
  const raw = new DatabaseSync(f.databaseFile);
  raw.exec('DROP TRIGGER immutable_schema_migrations_update');
  raw.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('0'.repeat(64));
  raw.close();
  assert.throws(() => initializeCleanDatabase({ file: f.databaseFile }), (error) => error.code === 'not_ready' && error.details.reason === 'checksum_drift');
  const app = createCleanApp({ config: f.config });
  assert.equal(app.ready, false);
  assert.equal(app.readinessReason, 'checksum_drift');
  app.close();
});

test('concurrent duplicate idempotency requests produce one operation', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const operations = new OperationService({ db });
  const input = { commandId: 'probe.concurrent', idempotencyKey: 'same-key-1', request: { n: 1 }, resourceType: 'probe', resourceId: 'probe_1' };
  const results = await Promise.all([operations.create(input), operations.create(input), operations.create(input)]);
  assert.equal(new Set(results.map((result) => result.operation_id)).size, 1);
  assert.equal(db.get('select count(*) as count from operations').count, 1);
  db.close();
});

test('expired idempotency keys can be reused after retention', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const operations = new OperationService({ db });
  const first = await operations.create({ commandId: 'probe.expiry', idempotencyKey: 'expiry-key-1', request: { attempt: 1 }, expiresAt: '2000-01-01T00:00:00.000Z', resourceType: 'probe', resourceId: 'probe_1' });
  const second = await operations.create({ commandId: 'probe.expiry', idempotencyKey: 'expiry-key-1', request: { attempt: 2 }, resourceType: 'probe', resourceId: 'probe_2' });
  assert.notEqual(first.operation_id, second.operation_id);
  assert.equal(db.get('select count(*) as count from operations').count, 2);
  db.close();
});

test('expired aggregate idempotency keys are replaced before replay', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const base = {
    commandId: 'probe.aggregate-expiry',
    idempotencyKey: 'aggregate-expiry-key',
    aggregateType: 'probe',
    aggregateId: 'probe_expiry'
  };
  await runtime.platform.mutateAggregate({ ...base, request: { attempt: 1 }, payload: { attempt: 1 }, expiresAt: '2000-01-01T00:00:00.000Z' });
  const second = await runtime.platform.mutateAggregate({ ...base, request: { attempt: 2 }, payload: { attempt: 2 } });
  const replayed = await runtime.platform.mutateAggregate({ ...base, request: { attempt: 2 }, payload: { attempt: 2 } });
  assert.equal(second.revision, 2);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.revision, 2);
  assert.equal(runtime.db.get('select count(*) as count from idempotency_keys where command_id=?', [base.commandId]).count, 1);
  runtime.close();
});

test('operation executor emits durable progress before terminal success', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const operations = new OperationService({ db });
  const created = await operations.create({ commandId: 'probe.executor', idempotencyKey: 'executor-key-1', request: {}, resourceType: 'probe', resourceId: 'probe_1' });
  const terminal = await operations.run(created.operation_id, async ({ emit }) => {
    await emit('operation.progress', { percent: 50 });
    return { value: 'done' };
  });
  assert.equal(terminal.status, 'succeeded');
  const replay = operations.eventsFor(created.operation_id);
  assert.deepEqual(replay.events.map((event) => event.type), ['operation.accepted', 'operation.queued', 'operation.running', 'operation.progress', 'operation.succeeded']);
  assert.equal(replay.events[2].aggregate.revision, replay.events[3].aggregate.revision);
  db.close();
});

test('cancel is accepted once and the worker writes the terminal event', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const operations = new OperationService({ db });
  const created = await operations.create({ commandId: 'probe.cancel-worker', idempotencyKey: 'cancel-worker-create', request: {}, resourceType: 'probe', resourceId: 'probe_1' });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const run = operations.run(created.operation_id, async ({ signal, ensureActive }) => {
    signalStarted();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    ensureActive();
  });
  await started;
  const running = operations.get(created.operation_id);
  const request = { operation_id: created.operation_id, reason: 'fixture' };
  const accepted = await operations.cancel(created.operation_id, { expectedRevision: running.revision, idempotencyKey: 'cancel-worker-command', requestHash: sha256Hex(canonicalJson(request)), reason: 'fixture' });
  assert.equal(accepted.status, 'running');
  assert.equal(accepted.cancellation_requested, true);
  const replayed = await operations.cancel(created.operation_id, { expectedRevision: running.revision, idempotencyKey: 'cancel-worker-command', requestHash: sha256Hex(canonicalJson(request)), reason: 'fixture' });
  assert.equal(replayed.replayed, true);
  const terminal = await run;
  assert.equal(terminal.status, 'cancelled');
  assert.deepEqual(operations.eventsFor(created.operation_id).events.slice(-2).map((event) => event.type), ['operation.cancel_requested', 'operation.cancelled']);
  db.close();
});

test('retry creates a linked operation without rewriting the failed receipt', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const operations = new OperationService({ db });
  let prior = await operations.create({ commandId: 'probe.retry', idempotencyKey: 'retry-create-1', request: {}, resourceType: 'probe', resourceId: 'probe_1' });
  prior = await operations.queue(prior.operation_id, { expectedRevision: prior.revision });
  prior = await operations.start(prior.operation_id, { expectedRevision: prior.revision });
  prior = await operations.fail(prior.operation_id, { expectedRevision: prior.revision, errorCode: 'adapter_failed' });
  const retried = await operations.retry(prior.operation_id, { idempotencyKey: 'retry-second-1', request: { attempt: 2 } });
  assert.notEqual(retried.operation_id, prior.operation_id);
  assert.equal(operations.get(prior.operation_id).status, 'failed');
  assert.deepEqual(db.query("select relation,aggregate_id from operation_links where operation_id=? and relation='retry_of'", [retried.operation_id]), [{ relation: 'retry_of', aggregate_id: prior.operation_id }]);
  assert.equal(operations.links(retried.operation_id).some((link) => link.relation === 'retry_of'), true);
  assert.equal(operations.getReceipt(prior.operation_id).status, 'failed');
  db.close();
});

test('cursor scope, expiry and redaction are enforced', () => {
  const token = encodeCursor({ actorId: 'actor_system_bootstrap', projectId: 'project_1', stream: 'events', sequence: 4, query: { operation_id: 'op_1' }, expiresAt: '2099-01-01T00:00:00.000Z', secret: 'secret' });
  assert.equal(decodeCursor(token, { actorId: 'actor_system_bootstrap', projectId: 'project_1', stream: 'events', query: { operation_id: 'op_1' }, secret: 'secret' }).sequence, 4);
  assert.throws(() => decodeCursor(token, { actorId: 'other', projectId: 'project_1', stream: 'events', query: { operation_id: 'op_1' }, secret: 'secret' }), (error) => error instanceof CursorError && error.code === 'cursor_scope_mismatch');
  const expired = encodeCursor({ actorId: 'actor_system_bootstrap', stream: 'events', sequence: 1, expiresAt: '2000-01-01T00:00:00.000Z', secret: 'secret' });
  assert.throws(() => decodeCursor(expired, { actorId: 'actor_system_bootstrap', stream: 'events', query: {}, secret: 'secret' }), (error) => error.code === 'cursor_expired');
  const policy = new RedactionPolicy();
  const redacted = policy.redactObject({ authorization: 'Bearer token-secret-1234', path: 'C:\\Users\\fixture\\file.txt', prompt: 'private prompt body', parser_output: 'raw parser text' });
  assert.equal(redacted.authorization, '[redacted]');
  assert.equal(redacted.prompt, '[redacted]');
  assert.equal(redacted.parser_output, '[redacted]');
  const publicUris = policy.redact({ poll_uri: '/api/v2/operations/op_1', live_uri: '/livez', host_path: '/home/fixture/state.sqlite' });
  assert.equal(publicUris.value.poll_uri, '/api/v2/operations/op_1');
  assert.equal(publicUris.value.live_uri, '/livez');
  assert.equal(publicUris.value.host_path, '[redacted-path]');
  assert.throws(() => policy.assertSafe({ token: 'sentinel-token-1234' }), RedactionError);
});

test('event replay authorization and durable cursor expiry are stable', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const deniedEvents = new EventService({ db, authorize: () => false });
  await deniedEvents.append({ aggregateType: 'probe', aggregateId: 'probe_1', aggregateRevision: 1, type: 'probe.created', data: {} });
  assert.throws(() => deniedEvents.replay({ actorId: 'actor_system_bootstrap', aggregateType: 'probe', aggregateId: 'probe_1' }), (error) => error.code === 'permission_denied' && error.status === 403);
  const events = new EventService({ db });
  const expired = events.ackCursor({ actorId: 'actor_system_bootstrap', consumerId: 'expired-consumer', stream: 'probe', cursor: '0', expiresAt: '2000-01-01T00:00:00.000Z', now: '1999-01-01T00:00:00.000Z' });
  assert.equal(expired.revision, 1);
  assert.throws(() => events.ackCursor({ actorId: 'actor_system_bootstrap', consumerId: 'expired-consumer', stream: 'probe', cursor: '1', expectedRevision: 1, now: '2001-01-01T00:00:00.000Z' }), (error) => error.code === 'cursor_expired');
  assert.throws(() => encodeCursor({ actorId: 'actor_system_bootstrap', stream: 'probe', sequence: -1 }), (error) => error.code === 'cursor_invalid');
  db.close();
});

test('1000-event replay is complete, ordered, and duplicate-free', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const events = new EventService({ db, cursorSecret: 'p1-thousand-events' });
  await db.withTransaction((tx) => {
    for (let index = 1; index <= 1000; index += 1) {
      events.appendInTransaction(tx, { aggregateType: 'probe_stream', aggregateId: 'probe_1000', aggregateRevision: 1, allowSameRevision: index > 1, type: 'probe.progress', data: { index } });
    }
  });
  const first = events.replay({ actorId: 'actor_system_bootstrap', aggregateType: 'probe_stream', aggregateId: 'probe_1000', limit: 500 });
  const second = events.replay({ actorId: 'actor_system_bootstrap', aggregateType: 'probe_stream', aggregateId: 'probe_1000', cursor: first.next_cursor, limit: 500 });
  const rows = [...first.events, ...second.events];
  assert.equal(rows.length, 1000);
  assert.equal(new Set(rows.map((event) => event.id)).size, 1000);
  assert.deepEqual(rows.map((event) => event.sequence), Array.from({ length: 1000 }, (_, index) => index + 1));
  db.close();
});

test('CAS promotion and tamper verification use content hashes', () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const cas = new CasStore({ root: f.casRoot, db });
  const object = cas.putCanonical({ b: 2, a: 1 }, { mediaType: 'application/json' });
  assert.equal(object.hash, sha256Hex('{"a":1,"b":2}'));
  assert.equal(cas.read(object.hash).toString(), '{"a":1,"b":2}');
  assert.equal(cas.put('/api/v2/operations/op_1', { mediaType: 'text/plain' }).byte_length, 23);
  const manifest = cas.createManifest();
  assert.equal(cas.verifyManifest(manifest).valid, true);
  fs.writeFileSync(path.join(f.casRoot, object.relative_key.replace('/', path.sep)), 'tampered');
  assert.throws(() => cas.verifyManifest(manifest), (error) => error.code === 'cas_tamper');
  db.close();
});

test('download receipts bind actor, project, hash, expiry, and single use', () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const object = runtime.cas.put('receipt-fixture', { mediaType: 'text/plain' });
  const issued = runtime.receipts.issue({ actorId: runtime.metadata.bootstrap_actor_id, projectId: 'project_1', casSha256: object.hash, mediaType: 'text/plain' });
  const consumed = runtime.receipts.consume(issued.receipt_id, { actorId: runtime.metadata.bootstrap_actor_id, projectId: 'project_1', casSha256: object.hash });
  assert.equal(consumed.consumed, true);
  assert.throws(() => runtime.receipts.consume(issued.receipt_id, { actorId: runtime.metadata.bootstrap_actor_id, projectId: 'project_1', casSha256: object.hash }), (error) => error.code === 'receipt_expired');
  runtime.close();
  const restarted = createCleanRuntime({ config: f.config });
  assert.throws(() => restarted.receipts.consume(issued.receipt_id, { actorId: restarted.metadata.bootstrap_actor_id, projectId: 'project_1', casSha256: object.hash }), (error) => error.code === 'receipt_expired');
  restarted.close();
});

test('download receipt expiry uses the injected platform clock', () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const object = runtime.cas.put('clocked-receipt', { mediaType: 'text/plain' });
  let now = '2026-08-19T00:00:00.000Z';
  const receipts = new ReceiptService({ platform: runtime.platform, clock: () => now });
  const issued = receipts.issue({ actorId: runtime.metadata.bootstrap_actor_id, casSha256: object.hash, ttlMs: 1000 });
  now = '2026-08-19T00:00:02.000Z';
  assert.throws(() => receipts.consume(issued.receipt_id, { actorId: runtime.metadata.bootstrap_actor_id, casSha256: object.hash }), (error) => error.code === 'receipt_expired');
  runtime.close();
});

test('API v2 probes, retired route, replay and cancel use one envelope', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'HTTP owner', team_name: 'HTTP team', idempotency_key: 'p1-http-setup-1' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  const cookie = `aiws_session=${setup.session.proof}`;
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const operation = await runtime.operations.create({ actorId: principal.actorId, commandId: 'probe.http', idempotencyKey: 'http-key-1', request: { ok: true }, resourceType: 'probe', resourceId: 'probe_1' });
  const server = http.createServer((request, response) => { Promise.resolve(handler(request, response)).catch((error) => response.end(String(error))); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const live = await fetch(`${base}/livez`);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).meta.api_version, '2');
  const retired = await fetch(`${base}/api/v1/operations/${operation.operation_id}`);
  assert.equal(retired.status, 410);
  assert.equal((await retired.json()).error.code, 'route_retired');
  const replay = await fetch(`${base}/api/v2/operations/${operation.operation_id}/events?format=json`, { headers: { cookie } });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.events.length, 1);
  const operationResponse = await fetch(`${base}/api/v2/operations/${operation.operation_id}`, { headers: { cookie } });
  const operationEnvelope = await operationResponse.json();
  assert.equal(operationEnvelope.data.poll_uri, `/api/v2/operations/${operation.operation_id}`);
  assert.deepEqual(operationEnvelope.meta.redactions, []);
  const unknownQuery = await fetch(`${base}/api/v2/operations/${operation.operation_id}?unknown=true`, { headers: { cookie } });
  assert.equal(unknownQuery.status, 400);
  assert.equal((await unknownQuery.json()).error.code, 'unknown_field');
  const invalidFormat = await fetch(`${base}/api/v2/operations/${operation.operation_id}/events?format=xml`, { headers: { cookie } });
  assert.equal(invalidFormat.status, 400);
  assert.equal((await invalidFormat.json()).error.code, 'schema_invalid');
  const cancelHeaders = { cookie, 'content-type': 'application/json', 'Idempotency-Key': 'http-cancel-1', 'X-Expected-Revision': String(operation.revision) };
  const cancel = await fetch(`${base}/api/v2/operations/${operation.operation_id}/cancel`, { method: 'POST', headers: cancelHeaders, body: JSON.stringify({ idempotency_key: 'http-cancel-1', expected_revision: operation.revision }) });
  assert.equal(cancel.status, 202);
  const accepted = await cancel.json();
  assert.equal(accepted.data.status, 'accepted');
  assert.equal(accepted.data.cancellation_requested, true);
  const repeated = await fetch(`${base}/api/v2/operations/${operation.operation_id}/cancel`, { method: 'POST', headers: cancelHeaders, body: '{}' });
  assert.equal(repeated.status, 202);
  assert.equal((await repeated.json()).data.replayed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.operations.get(operation.operation_id).status, 'cancelled');
  assert.deepEqual(runtime.events.replay({ operationId: operation.operation_id }).events.slice(-2).map((event) => event.type), ['operation.cancel_requested', 'operation.cancelled']);
  await new Promise((resolve) => server.close(resolve));
  runtime.close();
});

test('registry metadata, ownership, and transaction callback contract are enforced', async () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const registry = createCleanCommandRegistry();
  assert.equal(registryParity(registry).valid, true);
  const tables = db.query("select name from sqlite_schema where type='table' and name not like 'sqlite_%'").map((row) => row.name);
  assert.equal(validateCleanOwnership({ tables, registry }).valid, true);
  assert.deepEqual(Object.keys(CLEAN_TABLE_OWNERS).sort(), tables.sort());
  await assert.rejects(() => db.withTransaction(() => Promise.resolve('leak')), (error) => error.code === 'transaction_callback_async');
  assert.equal(db.get('select count(*) as count from operations').count, 0);
  db.close();
});

test('CAS content scanner blocks secrets and missing manifests never self-heal', () => {
  const f = fixture();
  const db = openCleanDatabase(f.databaseFile);
  const cas = new CasStore({ root: f.casRoot, db });
  assert.throws(() => cas.put('Bearer secret-token-12345678'), (error) => error.code === 'redaction_blocked');
  assert.throws(() => cas.putCanonical({ prompt: 'fixture' }, { rejectSensitive: false }), (error) => error.code === 'redaction_blocked');
  assert.equal(db.get("select count(*) as count from receipt_manifests where kind='cas.redaction'").count, 2);
  const object = cas.put('manifest-object');
  fs.rmSync(path.join(f.casRoot, 'manifest.json'));
  assert.throws(() => cas.verifyManifest(), (error) => error.code === 'cas_manifest_missing');
  assert.ok(object.hash);
  db.close();
});

test('expired cursors return a scope-bound restart cursor', () => {
  const token = encodeCursor({ actorId: 'actor_system_bootstrap', projectId: 'project_1', stream: 'events', sequence: 9, query: { operation_id: 'op_1' }, expiresAt: '2000-01-01T00:00:00.000Z', secret: 'restart-secret' });
  assert.throws(() => decodeCursor(token, { actorId: 'actor_system_bootstrap', projectId: 'project_1', stream: 'events', query: { operation_id: 'op_1' }, secret: 'restart-secret', now: '2001-01-01T00:00:00.000Z' }), (error) => {
    assert.equal(error.code, 'cursor_expired');
    assert.ok(error.details.restart_cursor);
    assert.equal(decodeCursor(error.details.restart_cursor, { actorId: 'actor_system_bootstrap', projectId: 'project_1', stream: 'events', query: { operation_id: 'op_1' }, secret: 'restart-secret', now: '2001-01-01T00:00:00.000Z' }).sequence, 0);
    return true;
  });
});

test('process-level startup failure remains probeable and blocks API v2', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-not-ready-'));
  const databaseFile = path.join(root, 'data', 'state.sqlite');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  fs.writeFileSync(databaseFile, 'not a sqlite database');
  const app = createCleanApp({ config: { ...fixture().config, home: root, databaseFile, casRoot: path.join(root, 'cas'), receiptRoot: path.join(root, 'receipts'), port: 0 } });
  const server = http.createServer((request, response) => Promise.resolve(app.handler(request, response)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/livez`)).status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).error.code, 'not_ready');
    const business = await fetch(`${base}/api/v2/operations/op_missing`);
    assert.equal(business.status, 503);
    assert.equal((await business.json()).error.code, 'not_ready');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  }
});
