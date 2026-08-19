import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  createCleanRuntime,
  openCleanDatabase,
  CLEAN_MIGRATION_REGISTRY,
  CLEAN_P2_TABLE_OWNERS,
  registryParity,
  validateCleanOwnership,
  VaultAdapter
} from '../../apps/api/src/clean/index.mjs';
import { createCleanHttpHandler } from '../../apps/api/src/clean/http.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p2-'));
  const config = {
    runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
    databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'),
    receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'),
    cursorSecret: 'p2-cursor-secret', sessionSecret: 'p2-session-secret',
    vaultMasterKey: 'p2-vault-master-key', runtimeBuild: 'p2-test', maxBodyBytes: 100000
  };
  return { root, config };
}

function persistedDatabaseBytes(file) {
  return [file, `${file}-wal`, `${file}-shm`]
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => fs.readFileSync(candidate));
}

async function setup(runtime) {
  const result = await runtime.identity.setupComplete({ display_name: 'Owner', team_name: 'Default Team', idempotency_key: 'setup-complete-1' });
  return { result, principal: runtime.identity.authenticateProof(result.session.proof) };
}

test('migration registry applies 001 then 002 and upgrades a P1 volume without rewriting baseline', () => {
  assert.deepEqual(CLEAN_MIGRATION_REGISTRY.slice(0, 2).map((migration) => migration.id), ['001-clean-baseline', '002-identity-acl']);
  const f = fixture();
  let db = openCleanDatabase(f.config.databaseFile, { targetVersion: 1, receiptRoot: f.config.receiptRoot });
  const baseline = db.get('SELECT checksum,snapshot_sha256 FROM schema_migrations WHERE version=1');
  db.close();
  db = openCleanDatabase(f.config.databaseFile, { targetVersion: 2, receiptRoot: f.config.receiptRoot });
  assert.equal(db.integrity().user_version, 2);
  assert.deepEqual(db.get('SELECT checksum,snapshot_sha256 FROM schema_migrations WHERE version=1'), baseline);
  assert.equal(db.get('SELECT count(*) AS count FROM schema_migrations').count, 2);
  assert.deepEqual(Object.keys(CLEAN_P2_TABLE_OWNERS).sort(), db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name));
  db.close();
});

test('002 DDL, ledger, receipt and commit faults roll back atomically', () => {
  for (const failAt of ['migration_002_ddl', 'migration_002_ledger', 'migration_002_receipt', 'migration_002_commit']) {
    const f = fixture();
    const baseline = openCleanDatabase(f.config.databaseFile, { targetVersion: 1 });
    baseline.close();
    assert.throws(() => openCleanDatabase(f.config.databaseFile, { targetVersion: 2, failAt }), (error) => error.code === 'not_ready' && error.details.migration_id === '002-identity-acl');
    const raw = new DatabaseSync(f.config.databaseFile, { readOnly: true });
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(raw.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
    assert.equal(raw.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='teams'").get().count, 0);
    raw.close();
  }
});

test('setup atomically creates user, team, owner membership and a keyed-hash session', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const { result, principal } = await setup(runtime);
  assert.equal(principal.subjectActorId, result.actor.id);
  assert.equal(result.membership.role, 'owner');
  assert.match(result.session.proof, /^[A-Za-z0-9_-]{43}$/);
  const session = runtime.db.get('SELECT proof_hash FROM sessions WHERE id=?', [result.session.id]);
  assert.match(session.proof_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(session.proof_hash, result.session.proof);
  assert.equal(persistedDatabaseBytes(f.config.databaseFile).some((bytes) => bytes.includes(Buffer.from(result.session.proof))), false);
  const replay = await runtime.identity.setupComplete({ display_name: 'Owner', team_name: 'Default Team', idempotency_key: 'setup-complete-1' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.session.proof, undefined);
  await assert.rejects(() => runtime.identity.setupComplete({ display_name: 'Other', team_name: 'Other', idempotency_key: 'setup-complete-2' }), (error) => error.code === 'state_conflict');
  assert.equal(runtime.db.integrity().semantic.valid, true);
  runtime.close();
});

test('actor switch keeps the subject and only targets a managed service actor', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const { result, principal } = await setup(runtime);
  const service = await runtime.identity.createActor({ kind: 'service', display_name: 'Build service', idempotency_key: 'actor-create-1' }, principal);
  await runtime.identity.grantMembership(result.team.id, { actor_id: service.actor.id, role: 'member', idempotency_key: 'member-grant-1' }, principal);
  const switched = await runtime.identity.actorSwitch({ sessionId: result.session.id, targetActorId: service.actor.id, principal, expectedRevision: 1, idempotencyKey: 'actor-switch-1' });
  assert.equal(switched.subject_actor_id, principal.subjectActorId);
  assert.equal(switched.effective_actor_id, service.actor.id);
  const next = runtime.identity.authenticateProof(result.session.proof);
  assert.equal(next.subjectActorId, principal.subjectActorId);
  assert.equal(next.actorId, service.actor.id);
  const restored = await runtime.identity.actorSwitch({ sessionId: result.session.id, targetActorId: principal.subjectActorId, principal: next, expectedRevision: 2, idempotencyKey: 'actor-switch-2' });
  assert.equal(restored.effective_actor_id, principal.subjectActorId);
  const now = new Date().toISOString();
  runtime.db.run(`INSERT INTO actors(id,kind,display_name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
    VALUES('actor_other_user','user','Other user','active','{}',?,1,?,?,?,?)`, ['44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', now, now, principal.actorId, principal.actorId]);
  const restoredPrincipal = runtime.identity.authenticateProof(result.session.proof);
  assert.throws(() => runtime.identity.actorSwitch({ sessionId: result.session.id, targetActorId: 'actor_other_user', principal: restoredPrincipal, expectedRevision: 3, idempotencyKey: 'actor-switch-3' }), (error) => error.code === 'permission_denied');
  runtime.close();
});

test('project role ceiling, explicit deny and exchange narrowing share one predicate', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config, projectScopeResolver: (id) => id === 'project_a' });
  const { principal } = await setup(runtime);
  await runtime.identity.grantProjectMembership('project_a', { actor_id: principal.actorId, role: 'owner', idempotency_key: 'project-owner-1' }, principal);
  assert.equal(runtime.authorization.authorize(principal, 'write', 'project_a', {}).allowed, true);
  await runtime.identity.setAclEntry('project_a', { principal_actor_id: principal.actorId, resource: '*', action: 'write', effect: 'deny', idempotency_key: 'acl-deny-1' }, principal);
  const denied = runtime.authorization.authorize(principal, 'write', 'project_a', {});
  assert.equal(denied.allowed, false);
  assert.match(denied.message, /explicit ACL deny/);
  assert.equal(runtime.authorization.authorize(principal, 'write', 'project_b', {}).code, 'project_denied');
  runtime.db.run(`INSERT INTO exchange_grants(id,source_project_id,target_project_id,grantee_actor_id,scope_json,status,expires_at,revision,created_at,updated_at) VALUES('grant_1','source','project_a',?,'{"actions":["read"]}','active',NULL,1,?,?)`, [principal.actorId, new Date().toISOString(), new Date().toISOString()]);
  assert.equal(runtime.authorization.authorize(principal, 'approve', 'project_a', {}).allowed, false);
  runtime.close();
});

test('credential rebind stores AES-GCM ciphertext only and profile probe uses fake contract', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const { principal } = await setup(runtime);
  const created = await runtime.identity.createCredential({ provider: 'codex', external_ref: 'opaque-import-ref', idempotency_key: 'credential-create-1' }, principal);
  assert.equal(created.credential.status, 'rebind_required');
  const proof = 'p2-provider-proof-sentinel-123456';
  const rebound = await runtime.identity.rebindCredential(created.credential.id, { proof, expected_revision: 1, idempotency_key: 'credential-bind-1' }, principal);
  assert.equal(rebound.status, 'succeeded');
  const row = runtime.db.get('SELECT status,external_ref,revision FROM credential_refs WHERE id=?', [created.credential.id]);
  assert.deepEqual({ status: row.status, revision: row.revision }, { status: 'active', revision: 3 });
  assert.match(row.external_ref, /^vault:/);
  const rotated = await runtime.identity.rotateCredential(created.credential.id, { proof: `${proof}-rotated`, expected_revision: 3, idempotency_key: 'credential-rotate-1' }, principal);
  assert.equal(rotated.status, 'succeeded');
  assert.equal(runtime.db.get('SELECT command_id FROM operations WHERE id=?', [rotated.operation_id]).command_id, 'credential.rotate');
  const rotatedRow = runtime.db.get('SELECT external_ref,revision FROM credential_refs WHERE id=?', [created.credential.id]);
  assert.equal(rotatedRow.revision, 5);
  assert.equal(fs.existsSync(path.join(f.config.vaultRoot, `${row.external_ref.slice(6)}.vault`)), false);
  const rotatedVault = path.join(f.config.vaultRoot, `${rotatedRow.external_ref.slice(6)}.vault`);
  assert.equal(fs.readFileSync(rotatedVault).includes(Buffer.from(`${proof}-rotated`)), false);
  assert.equal(persistedDatabaseBytes(f.config.databaseFile).some((bytes) => bytes.includes(Buffer.from(proof))), false);
  const profile = await runtime.identity.createProfile({ provider: 'codex', label: 'Default', credential_ref_id: created.credential.id, idempotency_key: 'profile-create-1' }, principal);
  const probe = await runtime.identity.probeProfile(profile.profile.id, { expected_revision: 1, idempotency_key: 'profile-probe-1' }, principal);
  assert.equal(probe.status, 'succeeded');
  assert.equal(runtime.db.get('SELECT status FROM provider_profiles WHERE id=?', [profile.profile.id]).status, 'available');
  const persisted = runtime.db.query('SELECT data_json AS value FROM events UNION ALL SELECT data_json FROM audit_events UNION ALL SELECT payload_json FROM receipt_manifests').map((item) => item.value).join('\n');
  assert.equal(persisted.includes(proof), false);
  runtime.close();
});

test('Vault adapter uses authenticated atomic files and rejects a tampered entry', () => {
  const f = fixture();
  const vault = new VaultAdapter({ root: f.config.vaultRoot, masterKey: f.config.vaultMasterKey });
  const value = 'vault-fixture-proof-123456';
  const ref = vault.put('entry.v1', value).external_ref;
  assert.equal(vault.read(ref).toString(), value);
  const file = path.join(f.config.vaultRoot, 'entry.v1.vault');
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(file, bytes);
  assert.throws(() => vault.read(ref), (error) => error.code === 'vault_decrypt_failed');
  assert.deepEqual(fs.readdirSync(f.config.vaultRoot).filter((name) => name.endsWith('.tmp')), []);
});

test('HTTP requires a session, ignores spoof headers and returns proof only as a strict cookie', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/v2/account`, { headers: { 'x-actor-id': 'actor_system_bootstrap', 'x-scopes': '*' } });
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/v2/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'http-setup-1', 'x-expected-revision': '0' }, body: JSON.stringify({ display_name: 'HTTP Owner', team_name: 'HTTP Team' }) });
    assert.equal(response.status, 201);
    assert.match(response.headers.get('etag'), /^rev-1-sha256:[a-f0-9]{64}$/);
    const cookieHeader = response.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Strict/);
    const body = await response.text();
    assert.equal(body.includes('session_proof'), false);
    const setupEnvelope = JSON.parse(body);
    assert.match(setupEnvelope.data.operation.audit_reference, /^audit_/);
    assert.equal(runtime.db.get('SELECT count(*) AS count FROM audit_events WHERE id=?', [setupEnvelope.data.operation.audit_reference]).count, 1);
    const cookie = cookieHeader.split(';')[0];
    const proof = decodeURIComponent(cookie.split('=')[1]);
    response = await fetch(`${base}/api/v2/account`, { headers: { authorization: `Bearer ${proof}`, 'x-session-proof': proof } });
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/v2/actors`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'http-actor-1', 'x-expected-revision': '0' }, body: JSON.stringify({ kind: 'service', display_name: 'HTTP Service', unexpected: true }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'unknown_field');
    response = await fetch(`${base}/api/v2/account`, { headers: { cookie, 'x-actor-id': 'actor_system_bootstrap', 'x-scopes': 'admin' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.account.kind, 'user');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
  }
});

test('P2 registry, REST/MCP/Web metadata and ownership remain bidirectional', () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  assert.equal(registryParity(runtime.registry).valid, true);
  const tables = runtime.db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((row) => row.name);
  assert.equal(validateCleanOwnership({ tables, registry: runtime.registry }).valid, true);
  assert.equal(runtime.registry.entries.every((entry) => entry.path.startsWith('/api/v2/')), true);
  runtime.close();
});
