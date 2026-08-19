import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { createCleanHttpHandler } from '../../apps/api/src/clean/http.mjs';

test('clean boundary rejects stale metadata and removes restricted values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-security-'));
  const config = { runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root, databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'), receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'), cursorSecret: 'security-cursor', sessionSecret: 'security-session-secret', vaultMasterKey: 'security-vault-master-key', runtimeBuild: 'security', maxBodyBytes: 100000 };
  const runtime = createCleanRuntime({ config, projectScopeResolver: (id) => ['project_a', 'project_b'].includes(id) });
  await runtime.recovery;
  const setup = await runtime.identity.setupComplete({ display_name: 'Security owner', team_name: 'Security team', idempotency_key: 'security-setup-1' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  const cookie = `aiws_session=${setup.session.proof}`;
  await runtime.identity.grantProjectMembership('project_a', { actor_id: principal.actorId, role: 'owner', idempotency_key: 'security-project-owner-1' }, principal);
  const operation = await runtime.operations.create({ actorId: principal.actorId, commandId: 'security.run', idempotencyKey: 'security-create-1', request: { fixture: true }, resourceType: 'probe', resourceId: 'probe_1' });
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => { Promise.resolve(handler(request, response)).catch((error) => response.end(String(error))); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const missingKey = await fetch(`${base}/api/v2/operations/${operation.operation_id}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-expected-revision': '1' }, body: '{}' });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, 'idempotency_required');
  const unknown = await fetch(`${base}/api/v2/operations/${operation.operation_id}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'security-cancel-1', 'x-expected-revision': '1' }, body: '{"unexpected":true}' });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'unknown_field');
  const mismatchedHeaders = await fetch(`${base}/api/v2/operations/${operation.operation_id}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'security-cancel-headers', 'x-expected-revision': '1', 'if-match': 'rev-2-sha256:fixture' }, body: '{}' });
  assert.equal(mismatchedHeaders.status, 400);
  assert.equal((await mismatchedHeaders.json()).error.code, 'invalid_request');
  const invalidBody = await fetch(`${base}/api/v2/operations/${operation.operation_id}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'security-cancel-body', 'x-expected-revision': '1' }, body: '{"reason":{"nested":true}}' });
  assert.equal(invalidBody.status, 400);
  assert.equal((await invalidBody.json()).error.code, 'schema_invalid');
  const mismatchedCursor = await fetch(`${base}/api/v2/operations/${operation.operation_id}/events?cursor=1`, { headers: { cookie, 'last-event-id': '2' } });
  assert.equal(mismatchedCursor.status, 400);
  assert.equal((await mismatchedCursor.json()).error.code, 'invalid_request');
  const excessiveLimit = await fetch(`${base}/api/v2/operations/${operation.operation_id}/events?limit=501`, { headers: { cookie } });
  assert.equal(excessiveLimit.status, 400);
  assert.equal((await excessiveLimit.json()).error.code, 'schema_invalid');
  assert.equal(runtime.operations.get(operation.operation_id).revision, 1);
  const retired = await fetch(`${base}/api/v1/operations/${operation.operation_id}`);
  assert.equal(retired.status, 410);
  assert.equal((await retired.json()).error.code, 'route_retired');

  const scoped = await runtime.operations.create({ actorId: principal.actorId, commandId: 'security.scoped', idempotencyKey: 'security-scoped-1', request: {}, projectId: 'project_b', resourceType: 'probe', resourceId: 'probe_scoped' });
  const wrongProject = await fetch(`${base}/api/v2/operations/${scoped.operation_id}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'security-scoped-cancel', 'x-expected-revision': '1', 'x-project-id': 'project_a' }, body: '{}' });
  assert.equal(wrongProject.status, 403);
  assert.equal((await wrongProject.json()).error.code, 'permission_denied');

  const queued = await runtime.operations.queue(operation.operation_id, { expectedRevision: operation.revision });
  const running = await runtime.operations.start(operation.operation_id, { expectedRevision: queued.revision });
  const secret = 'security-token-sentinel-123456';
  const terminal = await runtime.operations.succeed(operation.operation_id, { expectedRevision: running.revision, result: { token: secret, output: 'bounded' } });
  assert.equal(terminal.result.token, '[redacted]');
  const persisted = runtime.db.get('select result_json from operations where id=?', [operation.operation_id]).result_json;
  assert.equal(persisted.includes(secret), false);
  assert.throws(() => runtime.cas.put('content', { metadata: { path: 'C:\\Users\\fixture\\secret.txt' } }), (error) => error.code === 'redaction_blocked');
  assert.ok(runtime.db.get("select count(*) as count from receipt_manifests where kind in ('event.redaction','cas.redaction')").count >= 2);
  const drift = await fetch(`${base}/api/v2/operations/${operation.operation_id}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'security-stale-1', 'x-expected-revision': String(terminal.revision - 1) }, body: '{}' });
  assert.equal(drift.status, 409);
  assert.equal((await drift.json()).error.code, 'state_conflict');

  await new Promise((resolve) => server.close(resolve));
  runtime.close();
});
