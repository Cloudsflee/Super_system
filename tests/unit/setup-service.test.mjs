import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../../apps/api/src/database.mjs';
import { hashJson } from '../../apps/api/src/crypto.mjs';
import { IdentityService } from '../../apps/api/src/modules/identity/service.mjs';
import { SetupService } from '../../apps/api/src/modules/setup/service.mjs';
import { SecretRegistry } from '../../apps/api/src/secret-registry.mjs';

async function fixture({ clock } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r2-setup-'));
  const db = await openDatabase(path.join(home, 'state.sqlite'));
  const identity = new IdentityService({ db });
  await identity.initialize();
  const config = { home, runnerDigest: `sha256:${'a'.repeat(64)}`, codexCredential: null, githubCredential: null };
  const setup = new SetupService({ db, config, identity, secrets: new SecretRegistry(), runtimeId: 'runtime-a', ...(clock ? { clock } : {}) });
  await setup.initialize();
  return { home, db, identity, config, setup, async close() { await db.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

test('setup completion binds all eight checks to current provider snapshots across restart', async () => {
  const env = await fixture();
  try {
    const initial = await env.setup.setupState();
    assert.equal(initial.status, 'blocked');
    assert.deepEqual(Object.keys(initial.checks), [
      'owner', 'active_codex_credential', 'active_codex_profile', 'current_codex_probe',
      'verified_github_app', 'active_github_installation', 'repository_permissions', 'current_github_probe'
    ]);

    const codex = await env.setup.createCredential({ kind: 'codex_api_key', label: 'Codex', secret: 'codex-secret-fixture-1234' });
    const profile = await env.setup.createCodexProfile({
      label: 'Primary', provider: 'openai', model: 'fixture-model', base_url: '', wire_api: 'responses',
      reasoning: 'medium', timeout_ms: 30000, credential_ref: codex.id
    });
    await env.setup.recordCodexProbe(profile.id, profile.revision, {
      status: 'available', checks: ['configuration', 'runtime', 'binding', 'transport', 'protocol', 'model', 'inference'].map((phase) => ({ phase, status: 'passed' }))
    });

    const privateKey = await env.setup.createCredential({ kind: 'github_app_private_key', label: 'App key', secret: 'private-key-fixture-1234' });
    const webhook = await env.setup.createCredential({ kind: 'github_webhook_secret', label: 'Webhook', secret: 'webhook-secret-fixture-1234' });
    const app = await env.setup.createGithubApp({
      label: 'Workspace App', app_id: '12345', client_id: 'Iv1.fixture',
      private_key_ref: privateKey.id, webhook_secret_ref: webhook.id
    });
    await env.setup.createGithubInstallation(app.id, {
      expected_revision: app.revision,
      installation_id: '67890',
      account_login: 'fixture-org',
      permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' },
      repositories: [{ id: '9001', full_name: 'fixture-org/repository', selected: true }]
    });
    const appAfterFirstInstallation = await env.setup.repository.githubApp(app.id);
    await env.setup.createGithubInstallation(app.id, {
      expected_revision: appAfterFirstInstallation.revision,
      installation_id: '67891',
      account_login: 'fixture-org-secondary',
      permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' },
      repositories: [{ id: '9002', full_name: 'fixture-org/secondary', selected: true }]
    });
    const appAfterInstallation = await env.setup.repository.githubApp(app.id);
    await env.setup.recordGithubProbe(app.id, appAfterInstallation.revision, { status: 'available', slug: 'workspace-app' });

    const ready = await env.setup.setupState();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.complete, false);
    assert.ok(Object.values(ready.checks).every(Boolean));
    await assert.rejects(() => env.setup.assertReady('project.create'), (error) => {
      assert.equal(error.code, 'setup_not_ready');
      assert.deepEqual(error.details.blockers, ['setup_incomplete']);
      return true;
    });
    const completed = await env.setup.completeSetup({ expected_revision: ready.revision });
    assert.equal(completed.complete, true);
    assert.ok(completed.completed_at);
    assert.equal((await env.setup.assertReady('project.create')).complete, true);

    const restarted = new SetupService({
      db: env.db, config: env.config, identity: env.identity, secrets: new SecretRegistry(), runtimeId: 'runtime-b'
    });
    await restarted.initialize();
    const stale = await restarted.setupState();
    assert.equal(stale.complete, false);
    assert.equal(stale.completed_at, completed.completed_at);
    assert.equal(stale.checks.current_codex_probe, false);
    assert.equal(stale.checks.current_github_probe, false);

    const restartedProfile = await restarted.repository.codexProfile(profile.id);
    await restarted.recordCodexProbe(profile.id, restartedProfile.revision, { status: 'available', checks: [] });
    const restartedApp = await restarted.repository.githubApp(app.id);
    await restarted.recordGithubProbe(app.id, restartedApp.revision, { status: 'available', slug: 'workspace-app' });
    const restored = await restarted.setupState();
    assert.equal(restored.status, 'ready');
    assert.equal(restored.complete, true);

    const rotated = await restarted.rotateCredential(codex.id, {
      expected_revision: codex.revision,
      secret: 'codex-secret-rotated-5678'
    });
    assert.equal(rotated.secret_version, 2);
    const rotatedSnapshot = await restarted.activeProfileSnapshot();
    assert.equal(rotatedSnapshot.credential_revision, 2);
    assert.equal(rotatedSnapshot.config_hash, hashJson({
      label: 'Primary', provider: 'openai', model: 'fixture-model', base_url: '', wire_api: 'responses',
      reasoning: 'medium', timeout_ms: 30000, credential_ref: codex.id, credential_revision: 2
    }));
    await Promise.resolve();
    const invalidated = await restarted.setupState();
    assert.equal(invalidated.complete, false);
    assert.equal(invalidated.completed_at, null);
    assert.equal(invalidated.checks.current_codex_probe, false);

    const nextDigest = `sha256:${'b'.repeat(64)}`;
    const rebound = new SetupService({
      db: env.db,
      config: { ...env.config, runnerDigest: nextDigest },
      identity: env.identity,
      secrets: new SecretRegistry(),
      runtimeId: 'runtime-c'
    });
    await rebound.initialize();
    const reboundSnapshot = await rebound.activeProfileSnapshot();
    assert.equal(reboundSnapshot.runner_digest, nextDigest);
    const reboundProfile = await rebound.repository.codexProfile(profile.id);
    await rebound.recordCodexProbe(profile.id, reboundProfile.revision, { status: 'available', checks: [] });
    assert.equal((await rebound.repository.codexProfile(profile.id)).runner_digest, nextDigest);
  } finally { await env.close(); }
});

test('credential revision and read-only origin rules protect Vault lifecycle', async () => {
  const env = await fixture();
  try {
    const credential = await env.setup.createCredential({ kind: 'codex_api_key', label: 'Primary', secret: 'credential-fixture-1234' });
    await assert.rejects(() => env.setup.rotateCredential(credential.id, { expected_revision: 2, secret: 'credential-next-5678' }), (error) => error.code === 'revision_conflict');
    assert.equal(await env.setup.credentialSecret(credential.id), 'credential-fixture-1234');
    const revoked = await env.setup.revokeCredential(credential.id, { expected_revision: 1 });
    assert.equal(revoked.status, 'revoked');
    await assert.rejects(() => env.setup.credentialSecret(credential.id), (error) => error.code === 'credential_unavailable');
  } finally { await env.close(); }
});

test('GitHub snapshots combine each installation cache independently', async () => {
  const service = Object.create(SetupService.prototype);
  service.repository = {
    githubInstallations: async () => [
      { id: 'ghi_stored', repositories: [{ github_id: 'legacy-ignored' }] },
      { id: 'ghi_legacy', repositories: [{ github_id: 'legacy-kept' }] }
    ],
    githubRepositories: async (installationId) => installationId === 'ghi_stored'
      ? [{ github_id: 'stored-kept' }]
      : []
  };

  const bundle = await service.githubBundle('gha_fixture');
  assert.deepEqual(bundle.repositories.map((row) => row.github_id), ['stored-kept', 'legacy-kept']);
});

test('credential expiry removes ciphertext and interrupted revocation is cleaned as orphaned', async () => {
  let timestamp = '2026-08-11T00:00:00.000Z';
  const env = await fixture({ clock: () => timestamp });
  try {
    const expiring = await env.setup.createCredential({
      kind: 'codex_api_key', label: 'Expiring', secret: 'expiring-credential-fixture-1234',
      expires_at: '2026-08-11T00:05:00.000Z'
    });
    const expiringRef = (await env.setup.repository.credential(expiring.id)).secret_ref;
    assert.equal(env.setup.vault.entries().includes(expiringRef.slice('vault:'.length)), true);

    timestamp = '2026-08-11T00:06:00.000Z';
    assert.deepEqual(await env.setup.expireCredentials(), [expiring.id]);
    await Promise.resolve();
    assert.equal((await env.setup.repository.credential(expiring.id)).status, 'expired');
    assert.equal(env.setup.vault.entries().includes(expiringRef.slice('vault:'.length)), false);
    await assert.rejects(() => env.setup.rotateCredential(expiring.id, {
      expected_revision: 2, secret: 'replacement-credential-fixture-5678'
    }), (error) => error.code === 'credential_state_invalid');

    const revoked = await env.setup.createCredential({
      kind: 'codex_api_key', label: 'Interrupted revoke', secret: 'revoked-credential-fixture-1234'
    });
    const revokedRef = (await env.setup.repository.credential(revoked.id)).secret_ref;
    await env.setup.repository.revokeCredential({
      id: revoked.id, expectedRevision: revoked.revision, timestamp, actor: 'usr_local_owner'
    });
    assert.equal(env.setup.vault.entries().includes(revokedRef.slice('vault:'.length)), true);
    assert.deepEqual(await env.setup.cleanupOrphanedSecrets(), [revokedRef.slice('vault:'.length)]);
    assert.equal(env.setup.vault.entries().includes(revokedRef.slice('vault:'.length)), false);
  } finally { await env.close(); }
});
