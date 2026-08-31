import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { PlatformError } from '../../apps/api/src/clean/platform-error.mjs';
import { loadCleanConfig } from '../../apps/api/src/clean/config.mjs';
import { DeterministicGitHubAdapter } from '../../apps/api/src/clean/p8/github-adapter.mjs';
import { close, closeServer, listen, open, waitOperation } from './helpers.mjs';

test('loopback same-origin session recovery returns a persistent strict cookie and audits the real owner', async () => {
  const state = await open();
  const serverState = await listen(state.runtime);
  try {
    const headers = { origin: serverState.base, 'content-type': 'application/json', 'idempotency-key': 'post-close-session-1' };
    let response = await fetch(`${serverState.base}/api/v2/setup/session`, { method: 'POST', headers, body: JSON.stringify({ idempotency_key: 'post-close-session-1' }) });
    assert.equal(response.status, 201);
    const cookieHeader = response.headers.get('set-cookie');
    assert.match(cookieHeader, /Max-Age=2592000/);
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Strict/);
    const body = await response.text();
    assert.equal(/proof|token|secret/i.test(body), false);
    const cookie = cookieHeader.split(';')[0];
    response = await fetch(`${serverState.base}/api/v2/account`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.account.id, state.principal.actorId);
    assert.equal(state.runtime.db.get("SELECT count(*) AS count FROM operations WHERE command_id='session.create'").count, 1);

    response = await fetch(`${serverState.base}/api/v2/setup/session`, {
      method: 'POST',
      headers: { ...headers, origin: 'http://localhost:9', 'idempotency-key': 'post-close-session-2' },
      body: JSON.stringify({ idempotency_key: 'post-close-session-2' })
    });
    assert.equal(response.status, 403);
    response = await fetch(`${serverState.base}/api/v2/setup/session`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'post-close-session-3' },
      body: JSON.stringify({ idempotency_key: 'post-close-session-3' })
    });
    assert.equal(response.status, 403);
  } finally {
    await closeServer(serverState.server);
    await close(state);
  }
});

test('session recovery can replace an expired or revoked browser proof without changing account scope', async () => {
  const state = await open();
  const serverState = await listen(state.runtime);
  try {
    const headers = { origin: serverState.base, 'content-type': 'application/json' };
    let response = await fetch(`${serverState.base}/api/v2/account`, { headers: { cookie: 'aiws_session=expired-fixture' } });
    assert.equal(response.status, 401);
    response = await fetch(`${serverState.base}/api/v2/setup/session`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'post-close-recovery-expired' }, body: JSON.stringify({ idempotency_key: 'post-close-recovery-expired' }) });
    assert.equal(response.status, 201);
    const recovered = await response.json();
    const recoveredCookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal(recovered.data.session.subject_actor_id, state.principal.actorId);
    response = await fetch(`${serverState.base}/api/v2/account`, { headers: { cookie: recoveredCookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.account.id, state.principal.actorId);
    const session = recovered.data.session;
    await state.runtime.identity.revokeSession(session.id, { actorId: state.principal.actorId, expectedRevision: session.revision, idempotencyKey: 'post-close-recovery-revoke' });
    response = await fetch(`${serverState.base}/api/v2/setup/session`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'post-close-recovery-revoked' }, body: JSON.stringify({ idempotency_key: 'post-close-recovery-revoked' }) });
    assert.equal(response.status, 201);
    const replacement = await response.json();
    assert.equal(replacement.data.session.subject_actor_id, state.principal.actorId);
    assert.notEqual(replacement.data.session.id, session.id);
  } finally {
    await closeServer(serverState.server);
    await close(state);
  }
});

test('Codex host discovery is prioritized, HMAC-bound, stale-safe, path-free, and imports both config and API-key auth through Vault', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-post-close-codex-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const third = path.join(root, 'third');
  for (const directory of [first, second, third]) fs.mkdirSync(directory, { recursive: true });
  const secret = 'post-close-api-key-value-123456789';
  fs.writeFileSync(path.join(first, 'config.toml'), 'model = "gpt-fixture"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"\n', 'utf8');
  fs.writeFileSync(path.join(first, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }), 'utf8');
  fs.writeFileSync(path.join(second, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }), 'utf8');
  fs.writeFileSync(path.join(third, 'config.toml'), 'model = "fallback"\n', 'utf8');
  const state = await open({ config: {
    providerDiscoverySecret: 'post-close-discovery-hmac-key',
    codexDiscoveryRoots: [
      { hint: 'AIWS_HOST_CODEX_HOME', path: first, priority: 1 },
      { hint: 'CODEX_HOME', path: second, priority: 2 },
      { hint: '~/.codex', path: third, priority: 3 }
    ]
  } });
  try {
    let discovered = state.runtime.localSetup.discoverCodex({}, state.principal);
    assert.deepEqual(discovered.sources.map((source) => source.source_hint), ['AIWS_HOST_CODEX_HOME', 'CODEX_HOME', '~/.codex']);
    assert.deepEqual(discovered.sources.map((source) => source.priority), [1, 2, 3]);
    const serialized = JSON.stringify(discovered);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(root), false);
    assert.match(discovered.sources[0].id, /^codex_source_[a-f0-9]{24}$/);
    assert.match(discovered.sources[0].source_revision, /^[a-f0-9]{64}$/);
    assert.equal(discovered.sources[0].records[0].auth_type, 'api_key');
    assert.equal(discovered.sources[1].records[0].auth_type, 'chatgpt');
    assert.equal(discovered.sources[1].records[0].credential_available, true);
    assert.equal(discovered.sources[2].records[0].auth_type, 'none');

    const stale = discovered.sources[0];
    fs.appendFileSync(path.join(first, 'config.toml'), 'service_tier = "priority"\n');
    await assert.rejects(() => state.runtime.localSetup.importCodex({
      source_id: stale.id, source_revision: stale.source_revision, record_id: stale.records[0].id,
      confirmed: true, idempotency_key: 'post-close-stale-import', expected_revision: 0
    }, state.principal), (error) => error.code === 'discovery_source_stale');

    discovered = state.runtime.localSetup.discoverCodex({}, state.principal);
    const current = discovered.sources[0];
    const imported = await state.runtime.localSetup.importCodex({
      source_id: current.id, source_revision: current.source_revision, record_id: current.records[0].id,
      confirmed: true, label: 'Host Codex', profile_label: 'Host Codex', idempotency_key: 'post-close-host-import', expected_revision: 0
    }, state.principal);
    assert.equal(imported.credential.status, 'active');
    assert.equal(imported.profile.status, 'available');
    assert.equal(imported.probe.status, 'succeeded');
    assert.equal(JSON.stringify(imported).includes(secret), false);
    assert.equal(state.runtime.vault.read(imported.credential.external_ref).toString('utf8'), secret);
  } finally {
    await close(state);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex discovery rejects oversized and symlinked files and directs keyring-only auth to Device Login', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-post-close-bounds-'));
  const oversized = path.join(root, 'oversized');
  const keyring = path.join(root, 'keyring');
  const linked = path.join(root, 'linked');
  for (const directory of [oversized, keyring, linked]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(oversized, 'config.toml'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  fs.writeFileSync(path.join(keyring, 'config.toml'), 'model = "fixture"\n', 'utf8');
  fs.writeFileSync(path.join(keyring, 'auth.json'), JSON.stringify({ auth_mode: 'keyring' }), 'utf8');
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ OPENAI_API_KEY: 'linked-secret-value' }), 'utf8');
  try { fs.symlinkSync(outside, path.join(linked, 'auth.json'), 'file'); }
  catch (error) { t.diagnostic(`symlink fixture unavailable: ${error.code}`); }
  const state = await open({ config: { providerDiscoverySecret: 'bounds-key', codexDiscoveryRoots: [
    { hint: 'AIWS_HOST_CODEX_HOME', path: oversized, priority: 1 },
    { hint: 'CODEX_HOME', path: keyring, priority: 2 },
    { hint: '~/.codex', path: linked, priority: 3 }
  ] } });
  try {
    const discovered = state.runtime.localSetup.discoverCodex({}, state.principal);
    assert.equal(discovered.sources[0].status, 'invalid');
    assert.equal(discovered.sources[1].records[0].auth_type, 'keyring_only');
    if (fs.existsSync(path.join(linked, 'auth.json'))) assert.equal(discovered.sources[2].status, 'invalid');
    const source = discovered.sources[1];
    await assert.rejects(() => state.runtime.localSetup.importCodex({
      source_id: source.id, source_revision: source.source_revision, record_id: source.records[0].id,
      confirmed: true, idempotency_key: 'post-close-keyring-import', expected_revision: 0
    }, state.principal), (error) => error.code === 'device_login_required');
    const fallback = await state.runtime.localSetup.importCodex({
      source_id: source.id, source_revision: source.source_revision, record_id: source.records[0].id,
      api_key: 'post-close-keyring-fallback-123456789', confirmed: true,
      idempotency_key: 'post-close-keyring-fallback', expected_revision: 0
    }, state.principal);
    assert.equal(fallback.auth_type, 'api_key');
    assert.equal(JSON.stringify(fallback).includes('post-close-keyring-fallback-123456789'), false);
  } finally {
    await close(state);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex discovery HTTP keeps availability metadata, binds API keys, and stays path-free', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-post-close-http-'));
  fs.writeFileSync(path.join(root, 'config.toml'), 'model = "http-fixture"\n', 'utf8');
  const secret = 'post-close-http-api-key-123456789';
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }), 'utf8');
  const state = await open({ config: { codexDiscoveryRoots: [{ hint: 'AIWS_HOST_CODEX_HOME', path: root, priority: 1 }] } });
  const serverState = await listen(state.runtime);
  try {
    const baseHeaders = { origin: serverState.base, cookie: `aiws_session=${state.proof}` };
    let response = await fetch(`${serverState.base}/api/v2/provider-discovery/codex`, { headers: baseHeaders });
    assert.equal(response.status, 200);
    const discovered = await response.json();
    const source = discovered.data.sources[0];
    const record = source.records[0];
    assert.equal(record.credential_available, true);
    assert.equal(JSON.stringify(discovered).includes(secret), false);
    assert.equal(JSON.stringify(discovered).includes(root), false);
    response = await fetch(`${serverState.base}/api/v2/provider-discovery/codex/import`, {
      method: 'POST',
      headers: { ...baseHeaders, 'content-type': 'application/json', 'idempotency-key': 'post-close-http-import' },
      body: JSON.stringify({ source_id: source.id, source_revision: source.source_revision, record_id: record.id, confirmed: true })
    });
    assert.equal(response.status, 201);
    const imported = await response.json();
    assert.equal(imported.data.auth_type, 'api_key');
    assert.equal(JSON.stringify(imported).includes(secret), false);
  } finally {
    await closeServer(serverState.server);
    await close(state);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Device Login publishes only structured status, binds a ChatGPT bundle, probes it, and removes the isolated home', async () => {
  const bundle = { auth_mode: 'chatgpt', tokens: { access_token: 'access-value-123456', refresh_token: 'refresh-value-123456' } };
  const state = await open({ runtime: { deviceLoginRunner: async ({ home, onEvent }) => {
    onEvent({ status: 'waiting_for_user', verification_url: 'https://auth.example.invalid/device', user_code: 'ABCD-EFGH' });
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(bundle), { encoding: 'utf8', mode: 0o600 });
  } } });
  try {
    const started = await state.runtime.localSetup.startDeviceLogin({
      label: 'ChatGPT', profile_label: 'ChatGPT Codex', model: 'gpt-fixture',
      idempotency_key: 'post-close-device-start', expected_revision: 0
    }, state.principal);
    const terminal = await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId);
    assert.equal(terminal.status, 'succeeded');
    const status = state.runtime.localSetup.deviceLogin(started.login.id, state.principal);
    assert.equal(status.login.status, 'completed');
    assert.equal(status.login.verification_uri, null);
    assert.equal(status.login.user_code, null);
    assert.equal(status.login.error_code, null);
    assert.equal(JSON.stringify(status).includes('access-value'), false);
    const credential = state.runtime.identity.credentials(state.principal).find((item) => item.id === status.login.credential_id);
    assert.deepEqual(JSON.parse(state.runtime.vault.read(credential.external_ref).toString('utf8')), bundle);
    const deviceRoot = state.runtime.localSetup.deviceRoot;
    assert.deepEqual(fs.existsSync(deviceRoot) ? fs.readdirSync(deviceRoot) : [], []);
  } finally {
    await close(state);
  }
});

test('Device Login cancellation and restart recovery terminate through the shared operation ledger', async () => {
  const state = await open({ runtime: { deviceLoginRunner: ({ signal, onEvent }) => new Promise((resolve, reject) => {
    onEvent({ status: 'waiting_for_user', verification_url: 'https://auth.example.invalid/device', user_code: 'WXYZ-1234' });
    signal.addEventListener('abort', () => reject(new PlatformError('operation_cancelled', 'cancelled', {}, 409)), { once: true });
  }) } });
  try {
    const started = await state.runtime.localSetup.startDeviceLogin({ idempotency_key: 'post-close-device-cancel', expected_revision: 0 }, state.principal);
    let operation = state.runtime.operations.get(started.operation.operation_id, { actorId: state.principal.actorId });
    for (let attempt = 0; attempt < 100 && operation.status !== 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      operation = state.runtime.operations.get(started.operation.operation_id, { actorId: state.principal.actorId });
    }
    const cancelled = await state.runtime.localSetup.cancelDeviceLogin(started.login.id, {
      expected_revision: operation.revision, idempotency_key: 'post-close-device-cancel-ack'
    }, state.principal);
    assert.equal(cancelled.login.status, 'cancelled');
    assert.equal(cancelled.operation.cancellation_requested, true);
    assert.equal(cancelled.operation.status, 'running');
    assert.equal((await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId)).status, 'cancelled');

    const interrupted = await state.runtime.operations.create({
      actorId: state.principal.actorId, commandId: 'provider.codex.device_login.start', kind: 'provider.codex.device_login',
      idempotencyKey: 'post-close-device-interrupted', request: {}, resourceType: 'provider_device_login', resourceId: 'codex_login_interrupted_fixture'
    });
    assert.equal(await state.runtime.localSetup.recover(), 1);
    const recovered = state.runtime.operations.get(interrupted.operation_id, { actorId: state.principal.actorId });
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error_code, 'device_login_interrupted');
  } finally {
    await close(state);
  }
});

test('GitHub setup restores the bundled V2.3 public App identity and completes hosted installation through Vault, Probe, and repository discovery', async () => {
  const loaded = loadCleanConfig({ AIWS_CLEAN_HOME: path.join(os.tmpdir(), 'aiws-github-public-config') });
  assert.equal(loaded.githubApp.appId, '4255971');
  assert.equal(loaded.githubApp.clientId, 'Iv23linPGJnCQqsUeYk4');
  assert.equal(loaded.githubApp.slug, 'supersystem-czl');

  const privateKey = githubPrivateKey();
  const state = await open({ config: { githubApp: githubFixtureConfig({ privateKey }) } });
  try {
    const discovered = state.runtime.githubSetup.discover({}, state.principal);
    assert.deepEqual(discovered.app, {
      name: 'Supersystem-czl', app_id: '4255971', client_id: 'Iv23linPGJnCQqsUeYk4', slug: 'supersystem-czl'
    });
    assert.equal(discovered.server_managed, true);
    assert.equal(discovered.status, 'installation_required');
    const started = await state.runtime.githubSetup.installation({
      action: 'start', callback_origin: 'http://127.0.0.1:5175', return_path: 'setup',
      idempotency_key: 'post-close-github-hosted-start', expected_revision: 0
    }, state.principal);
    assert.equal(started.status, 'installation_required');
    assert.match(started.installation_url, /^https:\/\/github\.com\/apps\/supersystem-czl\/installations\/new\?state=/);
    assert.equal(JSON.stringify(started).includes('PRIVATE KEY'), false);

    const completed = await state.runtime.githubSetup.installation({
      action: 'complete', installation_id: '9001', state: started.state,
      idempotency_key: 'post-close-github-hosted-complete', expected_revision: 0
    }, state.principal);
    assert.equal(completed.status, 'connected');
    assert.equal(completed.profile.status, 'available');
    assert.equal(completed.repositories.length, 1);
    assert.equal(JSON.stringify(completed).includes('PRIVATE KEY'), false);
    const credential = state.runtime.identity.credentials(state.principal).find((item) => item.provider === 'github');
    const bundle = JSON.parse(state.runtime.vault.read(credential.external_ref).toString('utf8'));
    assert.equal(bundle.app_id, '4255971');
    assert.equal(bundle.installation_id, '9001');
    assert.equal(bundle.private_key, privateKey.trim());
  } finally {
    await close(state);
  }
});

test('GitHub Manifest callback binds returned secrets server-side, is replayable without a second conversion, and leaks no credential material', async () => {
  const privateKey = githubPrivateKey();
  const secrets = {
    client: 'github-client-secret-regression-value',
    webhook: 'github-webhook-secret-regression-value'
  };
  let conversions = 0;
  const state = await open({
    config: { githubApp: githubFixtureConfig() },
    runtime: {
      githubSetupFetch: async (url, options) => {
        conversions += 1;
        assert.match(String(url), /\/app-manifests\/manifest-code-fixture\/conversions$/);
        assert.equal(options.method, 'POST');
        return new Response(JSON.stringify({
          id: 4255971,
          name: 'Supersystem-czl',
          slug: 'supersystem-czl',
          client_id: 'Iv23linPGJnCQqsUeYk4',
          client_secret: secrets.client,
          webhook_secret: secrets.webhook,
          pem: privateKey
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
    }
  });
  try {
    const started = await state.runtime.githubSetup.manifest({
      action: 'start', callback_origin: 'http://127.0.0.1:5175', return_path: 'setup',
      idempotency_key: 'post-close-github-manifest-start', expected_revision: 0
    }, state.principal);
    assert.equal(started.status, 'authorization_required');
    assert.equal(started.manifest.redirect_url, 'http://127.0.0.1:5175/?github_callback=manifest#/setup');
    const converted = await state.runtime.githubSetup.manifest({
      action: 'callback', code: 'manifest-code-fixture', state: started.state,
      idempotency_key: 'post-close-github-manifest-callback', expected_revision: 0
    }, state.principal);
    assert.equal(converted.status, 'installation_required');
    const serialized = JSON.stringify(converted);
    for (const secret of [privateKey, secrets.client, secrets.webhook]) assert.equal(serialized.includes(secret), false);
    const replayed = await state.runtime.githubSetup.manifest({
      action: 'callback', code: 'manifest-code-fixture', state: started.state,
      idempotency_key: 'post-close-github-manifest-replay', expected_revision: 0
    }, state.principal);
    assert.equal(replayed.profile.id, converted.profile.id);
    assert.equal(conversions, 1);
    const credential = state.runtime.identity.credentials(state.principal).find((item) => item.provider === 'github');
    const stored = JSON.parse(state.runtime.vault.read(credential.external_ref).toString('utf8'));
    assert.equal(stored.client_secret, secrets.client);
    assert.equal(stored.webhook_secret, secrets.webhook);
    assert.equal(stored.private_key, privateKey.trim());

    const [payload, signature] = started.state.split('.');
    const tampered = `${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    await assert.rejects(() => state.runtime.githubSetup.manifest({
      action: 'callback', code: 'manifest-code-fixture', state: tampered,
      idempotency_key: 'post-close-github-manifest-tamper', expected_revision: 0
    }, state.principal), (error) => error.code === 'github_state_invalid');
  } finally {
    await close(state);
  }
});

test('GitHub setup automatically binds a unique existing App installation before opening GitHub', async () => {
  const privateKey = githubPrivateKey();
  const github = new DeterministicGitHubAdapter({
    installations: [{ id: '9001', account: { id: '1', login: 'fixture-owner', type: 'User' }, suspended_at: null }]
  });
  const state = await open({ config: { githubApp: githubFixtureConfig({ privateKey }) }, githubAdapter: github });
  try {
    const started = await state.runtime.githubSetup.installation({
      action: 'start', callback_origin: 'http://127.0.0.1:5175', return_path: 'setup',
      idempotency_key: 'post-close-github-existing-installation', expected_revision: 0
    }, state.principal);
    assert.equal(started.status, 'connected');
    assert.equal(started.installation_url, null);
    assert.equal(started.profile.status, 'available');
    assert.equal(started.repositories.length, 1);
    assert.deepEqual(github.calls.map((item) => item.action), ['list_installations', 'list']);
  } finally {
    await close(state);
  }
});

test('GitHub setup HTTP contracts expose public metadata and callback receipts without secrets or host paths', async () => {
  const privateKey = githubPrivateKey();
  const state = await open({ config: { githubApp: githubFixtureConfig({ privateKey }) } });
  const serverState = await listen(state.runtime);
  try {
    const headers = { origin: serverState.base, cookie: `aiws_session=${state.proof}` };
    let response = await fetch(`${serverState.base}/api/v2/provider-discovery/github`, { headers });
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.data.app.app_id, '4255971');
    assert.equal(body.data.server_managed, true);
    assert.deepEqual(body.meta.redactions, []);

    response = await fetch(`${serverState.base}/api/v2/provider-auth/github/installations`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'post-close-github-http-start' },
      body: JSON.stringify({ action: 'start', callback_origin: serverState.base, return_path: 'settings' })
    });
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.data.status, 'installation_required');
    assert.equal(body.data.profile.status, 'unprobed');
    const text = JSON.stringify(body);
    assert.equal(text.includes(privateKey), false);
    assert.equal(text.includes(state.root), false);
  } finally {
    await closeServer(serverState.server);
    await close(state);
  }
});

test('GitHub hosted private-key discovery rejects symlinks without exposing the configured path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-github-key-path-'));
  const source = path.join(root, 'source.pem');
  const linked = path.join(root, 'linked.pem');
  fs.writeFileSync(source, githubPrivateKey(), { encoding: 'utf8', mode: 0o600 });
  try { fs.symlinkSync(source, linked, 'file'); }
  catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    t.skip(`symlink fixture unavailable: ${error.code}`);
    return;
  }
  const state = await open({ config: { githubApp: githubFixtureConfig({ privateKeyPath: linked }) } });
  try {
    const discovered = state.runtime.githubSetup.discover({}, state.principal);
    assert.equal(JSON.stringify(discovered).includes(root), false);
    await assert.rejects(() => state.runtime.githubSetup.installation({
      action: 'start', callback_origin: 'http://127.0.0.1:5175', return_path: 'setup',
      idempotency_key: 'post-close-github-symlink-start', expected_revision: 0
    }, state.principal), (error) => error.code === 'github_private_key_invalid');
  } finally {
    await close(state);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function githubPrivateKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function githubFixtureConfig(overrides = {}) {
  return {
    appId: '4255971', clientId: 'Iv23linPGJnCQqsUeYk4', slug: 'supersystem-czl', name: 'Supersystem-czl',
    privateKey: '', privateKeyPath: null, clientSecret: '', webhookSecret: '', apiBaseUrl: 'https://api.github.com', webOrigin: null,
    ...overrides
  };
}
