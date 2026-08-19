import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createCleanRuntime,
  FakeProviderAdapter,
  sha256Hex
} from '../../apps/api/src/clean/index.mjs';
import { createCleanHttpHandler } from '../../apps/api/src/clean/http.mjs';

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p2-security-'));
  const config = {
    runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: root,
    databaseFile: path.join(root, 'data', 'state.sqlite'), casRoot: path.join(root, 'cas'),
    receiptRoot: path.join(root, 'receipts'), vaultRoot: path.join(root, 'vault'),
    cursorSecret: 'p2-security-cursor-secret', sessionSecret: 'p2-security-session-secret',
    vaultMasterKey: 'p2-security-vault-master-key', runtimeBuild: 'p2-security', maxBodyBytes: 100000,
    ...overrides
  };
  return { root, config };
}

async function setup(runtime, key = 'security-setup-1') {
  await runtime.recovery;
  const result = await runtime.identity.setupComplete({ display_name: 'Owner', team_name: 'Owner Team', idempotency_key: key });
  return { result, principal: runtime.identity.authenticateProof(result.session.proof), cookie: `aiws_session=${result.session.proof}` };
}

function insertTenant(runtime, suffix) {
  const now = new Date().toISOString();
  const actorId = `actor_user_${suffix}`;
  const teamId = `team_${suffix}`;
  const membershipId = `membership_${suffix}`;
  runtime.db.run(`INSERT INTO actors(id,kind,display_name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
    VALUES(?,'user',?,'active','{}',?,1,?,?,?,?)`, [actorId, `User ${suffix}`, sha256Hex('{}'), now, now, runtime.metadata.bootstrap_actor_id, runtime.metadata.bootstrap_actor_id]);
  runtime.db.run(`INSERT INTO teams(id,name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
    VALUES(?,?,'active','{}',?,1,?,?,?,?)`, [teamId, `Team ${suffix}`, sha256Hex('{}'), now, now, actorId, actorId]);
  runtime.db.run(`INSERT INTO team_memberships(id,team_id,actor_id,role,status,revision,invited_by_actor_id,accepted_by_actor_id,created_at,updated_at)
    VALUES(?,?,?,'owner','active',1,?,?,?,?)`, [membershipId, teamId, actorId, actorId, actorId, now, now]);
  return {
    actorId, teamId, membershipId,
    principal: { actorId, effectiveActorId: actorId, subjectActorId: actorId, sessionId: `session_${suffix}`, scopes: ['*'], kind: 'user' }
  };
}

async function listen(runtime) {
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('actor and team administration cannot cross tenant or revive terminal memberships', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const { principal } = await setup(runtime);
  const other = insertTenant(runtime, 'other');
  const service = await runtime.identity.createActor({ kind: 'service', display_name: 'Other service', idempotency_key: 'other-actor-create-1' }, other.principal);
  await runtime.identity.grantMembership(other.teamId, { actor_id: service.actor.id, role: 'member', idempotency_key: 'other-member-grant-1' }, other.principal);

  assert.equal(runtime.identity.actors(principal).some((actor) => actor.id === service.actor.id), false);
  assert.throws(() => runtime.identity.setActorStatus(service.actor.id, 'suspended', { expected_revision: 1, idempotency_key: 'cross-team-suspend-1' }, principal), (error) => error.code === 'permission_denied');
  await assert.rejects(() => runtime.identity.setMembershipStatus(other.membershipId, 'suspended', { expected_revision: 1, idempotency_key: 'last-owner-suspend-1' }, other.principal), (error) => error.code === 'state_conflict');

  const ownService = await runtime.identity.createActor({ kind: 'service', display_name: 'Terminal service', idempotency_key: 'terminal-actor-create-1' }, principal);
  const granted = await runtime.identity.grantMembership((await runtime.identity.teams(principal))[0].id, { actor_id: ownService.actor.id, role: 'member', idempotency_key: 'terminal-member-grant-1' }, principal);
  await runtime.identity.setMembershipStatus(granted.membership.id, 'revoked', { expected_revision: 1, idempotency_key: 'terminal-member-revoke-1' }, principal);
  await assert.rejects(() => runtime.identity.grantMembership(granted.membership.team_id, { actor_id: ownService.actor.id, role: 'member', idempotency_key: 'terminal-member-regrant-1' }, principal), (error) => error.code === 'state_conflict');
  runtime.close();
});

test('project resolver, policy head, invitation membership and project boundaries are enforced', async () => {
  const f = fixture();
  const projects = new Set(['project_a', 'project_b']);
  const runtime = createCleanRuntime({ config: f.config, projectScopeResolver: (id) => projects.has(id) });
  const { principal } = await setup(runtime);
  await assert.rejects(async () => {
    const noResolver = createCleanRuntime({ config: fixture().config });
    try {
      const owner = await setup(noResolver, 'no-resolver-setup-1');
      await noResolver.identity.grantProjectMembership('missing_project', { actor_id: owner.principal.actorId, role: 'owner', idempotency_key: 'no-resolver-owner-1' }, owner.principal);
    } finally { noResolver.close(); }
  }, (error) => error.code === 'project_denied');

  const ownerA = await runtime.identity.grantProjectMembership('project_a', { actor_id: principal.actorId, role: 'owner', idempotency_key: 'project-a-owner-1' }, principal);
  await runtime.identity.grantProjectMembership('project_b', { actor_id: principal.actorId, role: 'owner', idempotency_key: 'project-b-owner-1' }, principal);
  const firstAcl = await runtime.identity.setAclEntry('project_a', { id: 'acl_project_a', principal_actor_id: principal.actorId, resource: '*', action: 'read', effect: 'allow', expected_revision: 0, idempotency_key: 'acl-a-read-1' }, principal);
  const secondAcl = await runtime.identity.setAclEntry('project_a', { principal_actor_id: principal.actorId, resource: '*', action: 'write', effect: 'allow', expected_revision: 1, idempotency_key: 'acl-a-write-1' }, principal);
  assert.deepEqual([firstAcl.entry.policy_revision, secondAcl.entry.policy_revision], [1, 2]);
  assert.equal(runtime.db.get("SELECT current_revision FROM aggregate_heads WHERE aggregate_type='project_policy' AND aggregate_id='project_a'").current_revision, 2);
  await assert.rejects(() => runtime.identity.setAclEntry('project_a', { principal_actor_id: principal.actorId, resource: 'stale', action: 'read', effect: 'allow', expected_revision: 1, idempotency_key: 'acl-a-stale-1' }, principal), (error) => error.code === 'revision_conflict' && error.details.actual_revision === 2);
  const updatedAcl = await runtime.identity.setAclEntry('project_a', { id: 'acl_project_a', principal_actor_id: principal.actorId, resource: 'document', action: 'read', effect: 'deny', expected_revision: 1, idempotency_key: 'acl-a-update-1' }, principal);
  assert.deepEqual({ revision: updatedAcl.entry.revision, policy_revision: updatedAcl.entry.policy_revision }, { revision: 2, policy_revision: 3 });
  assert.equal(runtime.db.get("SELECT current_revision FROM aggregate_heads WHERE aggregate_type='project_policy' AND aggregate_id='project_a'").current_revision, 3);
  await assert.rejects(() => runtime.identity.setAclEntry('project_b', { id: 'acl_project_a', principal_actor_id: principal.actorId, resource: '*', action: 'read', effect: 'deny', expected_revision: 1, idempotency_key: 'acl-cross-project-1' }, principal), (error) => error.code === 'permission_denied');
  await assert.rejects(() => runtime.identity.setProjectMembershipStatus('project_a', ownerA.membership.id, 'revoked', { expected_revision: 1, idempotency_key: 'last-project-owner-1' }, principal), (error) => error.code === 'state_conflict');

  const invitee = insertTenant(runtime, 'invitee');
  const invitation = await runtime.identity.createProjectInvitation('project_a', { invitee_actor_id: invitee.actorId, role: 'viewer', idempotency_key: 'project-invite-1' }, principal);
  const accepted = await runtime.identity.acceptProjectInvitation('project_a', invitation.invitation.id, { expected_revision: 1, idempotency_key: 'project-invite-accept-1' }, invitee.principal);
  assert.equal(accepted.invitation.status, 'accepted');
  const membership = runtime.db.get('SELECT id,revision FROM project_memberships WHERE project_id=? AND actor_id=?', ['project_a', invitee.actorId]);
  assert.equal(runtime.db.get("SELECT current_revision FROM aggregate_heads WHERE aggregate_type='project_membership' AND aggregate_id=?", [membership.id]).current_revision, 1);
  runtime.close();
});

test('session expiry and revoke remain effective after restart with the injected clock', async () => {
  let now = '2026-08-19T00:00:00.000Z';
  const f = fixture();
  let runtime = createCleanRuntime({ config: f.config, now: () => now });
  let owner = await setup(runtime);
  const shortSession = await runtime.identity.createSession({ subjectActorId: owner.principal.actorId, actorId: owner.principal.actorId, ttlSeconds: 300, idempotencyKey: 'short-session-1', expectedRevision: 1 });
  now = '2026-08-19T00:05:01.000Z';
  assert.throws(() => runtime.identity.authenticateProof(shortSession.proof), (error) => error.code === 'session_expired');
  runtime.close();

  const f2 = fixture();
  now = '2026-08-19T01:00:00.000Z';
  runtime = createCleanRuntime({ config: f2.config, now: () => now });
  owner = await setup(runtime, 'revoke-setup-1');
  await runtime.identity.revokeSession(owner.result.session.id, { actorId: owner.principal.actorId, expectedRevision: 1, idempotencyKey: 'session-revoke-1' });
  const proof = owner.result.session.proof;
  runtime.close();
  runtime = createCleanRuntime({ config: f2.config, now: () => now });
  await runtime.recovery;
  assert.throws(() => runtime.identity.authenticateProof(proof), (error) => error.code === 'session_revoked');
  runtime.close();
});

test('provider failure is terminal and retryable, and a later probe can succeed', async () => {
  const f = fixture();
  const adapter = new FakeProviderAdapter({ provider: 'codex', failureCode: 'provider_unavailable' });
  const runtime = createCleanRuntime({ config: f.config, providerAdapters: { codex: adapter } });
  const { principal } = await setup(runtime);
  const created = await runtime.identity.createProfile({ provider: 'codex', label: 'Probe target', idempotency_key: 'failed-profile-create-1' }, principal);
  const failed = await runtime.identity.probeProfile(created.profile.id, { expected_revision: 1, idempotency_key: 'failed-profile-probe-1' }, principal);
  assert.deepEqual({ status: failed.status, error_code: failed.error_code, retryable: failed.retryable }, { status: 'failed', error_code: 'provider_unavailable', retryable: true });
  assert.deepEqual(runtime.db.get('SELECT status,revision FROM provider_profiles WHERE id=?', [created.profile.id]), { status: 'unavailable', revision: 3 });
  adapter.failureCode = null;
  const retried = await runtime.identity.probeProfile(created.profile.id, { expected_revision: 3, idempotency_key: 'failed-profile-probe-2' }, principal);
  assert.equal(retried.status, 'succeeded');
  assert.deepEqual(runtime.db.get('SELECT status,revision FROM provider_profiles WHERE id=?', [created.profile.id]), { status: 'available', revision: 5 });
  runtime.close();
});

test('restart recovery marks an externally unknown pending probe failed without guessing success', async () => {
  const f = fixture();
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const adapter = { probe: async () => { entered(); await releasePromise; return { available: true, adapter: 'delayed-fixture' }; } };
  const runtime1 = createCleanRuntime({ config: f.config, providerAdapters: { codex: adapter } });
  const { principal } = await setup(runtime1);
  const created = await runtime1.identity.createProfile({ provider: 'codex', label: 'Delayed probe', idempotency_key: 'delayed-profile-create-1' }, principal);
  const pendingProbe = runtime1.identity.probeProfile(created.profile.id, { expected_revision: 1, idempotency_key: 'delayed-profile-probe-1' }, principal);
  await enteredPromise;
  assert.deepEqual(runtime1.db.get('SELECT status,revision FROM provider_profiles WHERE id=?', [created.profile.id]), { status: 'probing', revision: 2 });

  const runtime2 = createCleanRuntime({ config: f.config });
  await runtime2.recovery;
  assert.deepEqual(runtime2.db.get('SELECT status,revision FROM provider_profiles WHERE id=?', [created.profile.id]), { status: 'unavailable', revision: 3 });
  const operation = runtime2.db.get("SELECT status,error_code FROM operations WHERE command_id='profile.probe' AND resource_id=?", [created.profile.id]);
  assert.deepEqual(operation, { status: 'failed', error_code: 'external_result_unknown' });
  release();
  assert.equal((await pendingProbe).status, 'failed');
  runtime2.close();
  runtime1.close();
});

test('concurrent credential idempotency creates one operation and one encrypted entry', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const { principal } = await setup(runtime);
  const created = await runtime.identity.createCredential({ provider: 'github', external_ref: 'imported-ref', idempotency_key: 'concurrent-credential-create-1' }, principal);
  const input = { proof: 'concurrent-provider-proof-123456', expected_revision: 1, idempotency_key: 'concurrent-rebind-key' };
  const [first, second] = await Promise.all([
    runtime.identity.rebindCredential(created.credential.id, input, principal),
    runtime.identity.rebindCredential(created.credential.id, input, principal)
  ]);
  assert.equal(first.operation_id, second.operation_id);
  assert.equal(runtime.db.get("SELECT count(*) AS count FROM operations WHERE command_id='credential.rebind' AND resource_id=?", [created.credential.id]).count, 1);
  assert.equal(runtime.vault.entries().length, 1);
  runtime.close();
});

test('service delegation requires a Vault proof, same-team target, and credential scopes', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config });
  const { result, principal, cookie } = await setup(runtime, 'delegation-setup-1');
  const service = await runtime.identity.createActor({ kind: 'service', display_name: 'Delegated service', idempotency_key: 'delegation-service-1' }, principal);
  await runtime.identity.grantMembership(result.team.id, { actor_id: service.actor.id, role: 'member', idempotency_key: 'delegation-member-1' }, principal);
  const credential = await runtime.identity.createCredential({ provider: 'mcp', external_ref: 'delegation-import-ref', scope: { scopes: ['project:read'] }, idempotency_key: 'delegation-credential-1' }, principal);
  const proof = 'delegation-proof-opaque-value-123456';
  await runtime.identity.rebindCredential(credential.credential.id, { proof, expected_revision: 1, idempotency_key: 'delegation-rebind-1' }, principal);

  assert.throws(() => runtime.identity.principalFromRequest({ headers: { cookie, 'x-actor-id': service.actor.id } }), (error) => error.code === 'permission_denied');
  assert.throws(() => runtime.identity.principalFromRequest({ headers: { cookie, 'x-actor-id': service.actor.id, 'x-service-credential': 'wrong-proof-123456' } }), (error) => error.code === 'authentication_required');

  const other = insertTenant(runtime, 'delegation-other');
  const otherService = await runtime.identity.createActor({ kind: 'service', display_name: 'Other service', idempotency_key: 'delegation-other-service-1' }, other.principal);
  await runtime.identity.grantMembership(other.teamId, { actor_id: otherService.actor.id, role: 'member', idempotency_key: 'delegation-other-member-1' }, other.principal);
  assert.throws(() => runtime.identity.principalFromRequest({ headers: { cookie, 'x-actor-id': otherService.actor.id, 'x-service-credential': proof } }), (error) => error.code === 'permission_denied');
  assert.throws(() => runtime.identity.principalFromRequest({ headers: { cookie, 'x-actor-id': other.actorId, 'x-service-credential': proof } }), (error) => error.code === 'permission_denied');

  const delegated = runtime.identity.principalFromRequest({ headers: { cookie, 'x-actor-id': service.actor.id, 'x-credential-proof': proof, 'x-scopes': '*' } });
  assert.equal(delegated.effectiveActorId, service.actor.id);
  assert.equal(delegated.delegatedByActorId, principal.subjectActorId);
  assert.deepEqual(delegated.scopes, ['project:read']);
  runtime.close();
});

test('operation JSON and SSE endpoints reauthorize project access after membership revoke', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config, projectScopeResolver: (id) => id === 'project_a' });
  const { result, principal, cookie } = await setup(runtime);
  const owner = await runtime.identity.grantProjectMembership('project_a', { actor_id: principal.actorId, role: 'owner', idempotency_key: 'stream-owner-1' }, principal);
  const service = await runtime.identity.createActor({ kind: 'service', display_name: 'Second owner', idempotency_key: 'stream-service-create-1' }, principal);
  await runtime.identity.grantMembership(result.team.id, { actor_id: service.actor.id, role: 'member', idempotency_key: 'stream-team-member-1' }, principal);
  await runtime.identity.grantProjectMembership('project_a', { actor_id: service.actor.id, role: 'owner', idempotency_key: 'stream-owner-2' }, principal);
  const operation = await runtime.operations.create({ actorId: principal.actorId, commandId: 'fixture.project.run', idempotencyKey: 'stream-operation-1', request: {}, resourceType: 'fixture', resourceId: 'fixture_1', projectId: 'project_a' });
  const { server, base } = await listen(runtime);
  try {
    assert.equal((await fetch(`${base}/api/v2/operations/${operation.operation_id}`, { headers: { cookie } })).status, 200);
    await runtime.identity.setProjectMembershipStatus('project_a', owner.membership.id, 'revoked', { expected_revision: 1, idempotency_key: 'stream-owner-revoke-1' }, principal);
    assert.equal((await fetch(`${base}/api/v2/operations/${operation.operation_id}`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/v2/operations/${operation.operation_id}/events?format=json`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/v2/operations/${operation.operation_id}/events`, { headers: { cookie, accept: 'text/event-stream' } })).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
  }
});
