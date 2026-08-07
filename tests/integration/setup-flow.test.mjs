import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CredentialVault } from '../../apps/api/src/credential-vault.mjs';
import { fixture, mutate, request } from './helpers.mjs';

test('workspace Vault, Codex profiles, and setup readiness use metadata-only APIs', async () => {
  const env = await fixture();
  const firstSecret = 'setup-fixture-secret-value-one';
  const rotatedSecret = 'setup-fixture-secret-value-two';
  try {
    const initial = await request(env.base, '/api/v1/setup');
    assert.equal(initial.response.status, 200);
    assert.equal(initial.json.owner.id, 'usr_local_owner');
    assert.equal(initial.json.status, 'blocked');
    assert.equal(initial.json.checks.codex_profile, false);

    const badTtl = await mutate(env.base, '/api/v1/sessions', { ttl_seconds: 10 }, 'setup-session-bad');
    assert.equal(badTtl.response.status, 422);
    const session = await mutate(env.base, '/api/v1/sessions', { ttl_seconds: 3600 }, 'setup-session');
    assert.equal(session.response.status, 201);
    assert.match(session.json.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(JSON.stringify(session.json).includes(session.json.token), true);
    const sessions = await request(env.base, '/api/v1/sessions');
    assert.equal(sessions.json[0].id, session.json.id);
    assert.equal(sessions.json[0].token_hash, undefined);
    const revokedSession = await mutate(env.base, `/api/v1/sessions/${session.json.id}/revoke`, {}, 'setup-session-revoke');
    assert.equal(revokedSession.response.status, 201);
    assert.ok(revokedSession.json.revoked_at);

    const invalidProvider = await mutate(env.base, '/api/v1/credentials', { provider: 'invalid', label: 'bad', secret: firstSecret }, 'setup-invalid-provider');
    assert.equal(invalidProvider.response.status, 422);
    assert.equal(invalidProvider.json.error.code, 'invalid_input');

    const created = await mutate(env.base, '/api/v1/credentials', { provider: 'codex', label: 'Primary', secret: firstSecret }, 'setup-credential');
    assert.equal(created.response.status, 201);
    assert.equal(created.json.provider, 'codex');
    assert.equal(created.json.status, 'active');
    assert.equal(created.json.vault_backed, true);
    assert.equal(JSON.stringify(created.json).includes(firstSecret), false);

    const replay = await mutate(env.base, '/api/v1/credentials', { provider: 'codex', label: 'Primary', secret: firstSecret }, 'setup-credential');
    assert.equal(replay.response.status, 201);
    assert.deepEqual(replay.json, created.json);

    const vault = new CredentialVault(env.home);
    assert.equal(vault.exists(created.json.id), true);
    assert.equal(vault.get(created.json.id), firstSecret);
    assert.throws(() => vault.pathFor('../outside'), /credential_reference_invalid/);

    const vaultFile = path.join(env.home, 'vault', `${created.json.id}.vault`);
    assert.equal(fs.readFileSync(vaultFile, 'utf8').includes(firstSecret), false);
    const persisted = [
      path.join(env.home, 'data', 'state.sqlite'),
      path.join(env.home, 'data', 'state.sqlite-wal'),
      path.join(env.home, 'data', 'state.sqlite-shm')
    ].filter(fs.existsSync).map((file) => fs.readFileSync(file)).reduce((all, item) => Buffer.concat([all, item]), Buffer.alloc(0));
    assert.equal(persisted.includes(Buffer.from(firstSecret)), false);

    const insecureProfile = await mutate(env.base, '/api/v1/profiles/codex', {
      label: 'Bad endpoint', provider: 'custom', model: 'fixture-model', base_url: 'http://example.test/v1',
      wire_api: 'responses', reasoning: 'high', timeout_ms: 30000, credential_ref: created.json.id
    }, 'setup-profile-insecure');
    assert.equal(insecureProfile.response.status, 422);
    assert.equal(insecureProfile.json.error.code, 'invalid_input');

    const profile = await mutate(env.base, '/api/v1/profiles/codex', {
      label: 'Primary profile', provider: 'custom', model: 'fixture-model', base_url: 'http://127.0.0.1:4010/v1',
      wire_api: 'responses', reasoning: 'high', timeout_ms: 30000, credential_ref: created.json.id
    }, 'setup-profile');
    assert.equal(profile.response.status, 201);
    assert.equal(profile.json.revision, 1);
    assert.equal(profile.json.credential_ref, created.json.id);

    const stale = await mutate(env.base, `/api/v1/profiles/codex/${profile.json.id}`, {
      expected_revision: 2, label: 'Stale profile', model: 'fixture-model'
    }, 'setup-profile-stale', 'PATCH');
    assert.equal(stale.response.status, 409);
    assert.equal(stale.json.error.code, 'revision_conflict');

    const updated = await mutate(env.base, `/api/v1/profiles/codex/${profile.json.id}`, {
      expected_revision: 1, label: 'Updated profile', provider: 'custom', model: 'fixture-model-v2',
      base_url: 'https://api.example.test/v1', wire_api: 'chat', reasoning: 'medium', timeout_ms: 45000,
      credential_ref: created.json.id
    }, 'setup-profile-update', 'PATCH');
    assert.equal(updated.response.status, 201);
    assert.equal(updated.json.revision, 2);
    assert.equal(updated.json.status, 'unprobed');

    const rotated = await mutate(env.base, `/api/v1/credentials/${created.json.id}/rotate`, { secret: rotatedSecret }, 'setup-rotate');
    assert.equal(rotated.response.status, 201);
    assert.equal(vault.get(created.json.id), rotatedSecret);
    assert.equal(fs.readFileSync(vaultFile, 'utf8').includes(rotatedSecret), false);

    const setupWithProfile = await request(env.base, '/api/v1/setup');
    assert.equal(setupWithProfile.json.checks.codex_profile, true);
    assert.equal(setupWithProfile.json.status, 'blocked');

    const revoked = await mutate(env.base, `/api/v1/credentials/${created.json.id}/revoke`, {}, 'setup-revoke');
    assert.equal(revoked.response.status, 201);
    assert.equal(revoked.json.status, 'revoked');
    assert.equal(vault.exists(created.json.id), false);
    const profiles = await request(env.base, '/api/v1/profiles/codex');
    assert.equal(profiles.json[0].status, 'revoked');

    const inUse = await mutate(env.base, `/api/v1/credentials/${created.json.id}`, {}, 'setup-delete-in-use', 'DELETE');
    assert.equal(inUse.response.status, 409);
    assert.equal(inUse.json.error.code, 'credential_in_use');

    const disposable = await mutate(env.base, '/api/v1/credentials', { provider: 'github', label: 'Disposable', secret: 'github-disposable-secret' }, 'setup-disposable');
    const deleted = await mutate(env.base, `/api/v1/credentials/${disposable.json.id}`, {}, 'setup-delete', 'DELETE');
    assert.equal(deleted.response.status, 201);
    assert.deepEqual(deleted.json, { id: disposable.json.id, deleted: true });
    assert.equal(vault.exists(disposable.json.id), false);

    const privateKey = await mutate(env.base, '/api/v1/credentials', { provider: 'github', label: 'App private key', secret: 'github-private-key-fixture' }, 'setup-github-private');
    const webhookSecret = await mutate(env.base, '/api/v1/credentials', { provider: 'github', label: 'Webhook secret', secret: 'github-webhook-fixture' }, 'setup-github-webhook');
    const badApp = await mutate(env.base, '/api/v1/github/apps', { label: 'Bad app', app_id: 'not-number', client_id: 'client', private_key_ref: privateKey.json.id, webhook_secret_ref: webhookSecret.json.id }, 'setup-github-bad');
    assert.equal(badApp.response.status, 422);
    const app = await mutate(env.base, '/api/v1/github/apps', { label: 'Workspace App', app_id: '12345', client_id: 'Iv1.fixture', private_key_ref: privateKey.json.id, webhook_secret_ref: webhookSecret.json.id }, 'setup-github-app');
    assert.equal(app.response.status, 201);
    assert.equal(app.json.status, 'active');
    const installation = await mutate(env.base, `/api/v1/github/apps/${app.json.id}/installations`, { installation_id: '67890', account_login: 'fixture-org', permissions: { contents: 'write', pull_requests: 'write' } }, 'setup-github-installation');
    assert.equal(installation.response.status, 201);
    assert.equal(installation.json.account_login, 'fixture-org');
    const duplicateInstallation = await mutate(env.base, `/api/v1/github/apps/${app.json.id}/installations`, { installation_id: '67890', account_login: 'fixture-org' }, 'setup-github-installation-duplicate');
    assert.equal(duplicateInstallation.response.status, 409);
    const apps = await request(env.base, '/api/v1/github/apps');
    assert.equal(apps.json[0].installations[0].installation_id, '67890');

    const tools = await mutate(env.base, '/api/v1/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 'setup-mcp-list');
    assert.equal(tools.response.status, 200);
    assert.equal(tools.json.result.tools.some((tool) => tool.name.startsWith('credential.')), false);
    const privateCall = await mutate(env.base, '/api/v1/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'credential.create', arguments: { provider: 'codex', label: 'No MCP', secret: firstSecret } } }, 'setup-mcp-private');
    assert.equal(privateCall.response.status, 404);
    assert.equal(privateCall.json.error.code, 'unknown_command');

    const audit = await request(env.base, '/api/v1/audit?limit=100');
    assert.equal(JSON.stringify(audit.json).includes(firstSecret), false);
    assert.equal(JSON.stringify(audit.json).includes(rotatedSecret), false);
    assert.ok(audit.json.some((entry) => entry.action === 'credential.rotated'));
    assert.ok(audit.json.some((entry) => entry.action === 'codex_profile.updated'));
  } finally {
    await env.close();
  }
});

test('Vault rejects empty values and invalid encrypted payloads', () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.ai-workspace', 'vault-test-'));
  const vault = new CredentialVault(root);
  assert.throws(() => vault.put('cred_empty', ''), /credential_secret_invalid/);
  vault.put('cred_corrupt', 'temporary-secret');
  fs.writeFileSync(path.join(root, 'vault', 'cred_corrupt.vault'), '{"version":2}', 'utf8');
  assert.throws(() => vault.get('cred_corrupt'), /credential_secret_invalid/);
  vault.remove('cred_corrupt');
  assert.equal(vault.exists('cred_corrupt'), false);
  fs.rmSync(root, { recursive: true, force: true });
});
