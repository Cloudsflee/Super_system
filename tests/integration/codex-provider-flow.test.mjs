import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixture, mutate, request, eventually } from './helpers.mjs';

test('Codex Device Auth returns a durable operation and claims an encrypted OAuth bundle', async () => {
  const env = await fixture();
  try {
    const started = await mutate(env.base, '/api/v1/integrations/codex/device-auth', { label: 'Fixture device' }, 'device-start');
    assert.equal(started.response.status, 202);
    assert.match(started.json.operation_id, /^op_/);
    assert.match(started.json.resource_id, /^cred_/);
    const operation = await eventually(
      async () => (await request(env.base, `/api/v1/operations/${started.json.operation_id}`)).json,
      (value) => ['completed', 'failed', 'cancelled'].includes(value.status),
      4000
    );
    assert.equal(operation.status, 'completed', JSON.stringify(operation));
    assert.equal(operation.result.status, 'active');
    const credentials = await request(env.base, '/api/v1/credentials');
    const credential = credentials.json.find((item) => item.id === started.json.resource_id);
    assert.equal(credential.kind, 'codex_oauth_bundle');
    assert.equal(credential.origin, 'device_auth');
    assert.equal(JSON.stringify(operation).includes('fixture-device-access-token'), false);
  } finally { await env.close(); }
});

test('Codex Device Auth cancellation leaves no active credential', async () => {
  const env = await fixture();
  const brokerClient = env.app.domain.codexService.broker;
  const originalStatus = brokerClient.codexDeviceAuthStatus.bind(brokerClient);
  // Keep this cancellation case at the user-input boundary instead of racing
  // the mock's automatic 25ms completion; the preceding case covers claiming.
  brokerClient.codexDeviceAuthStatus = async (id) => {
    const status = await originalStatus(id);
    return { ...status, status: ['completed', 'claimed'].includes(status.status) ? 'waiting_for_user' : status.status };
  };
  try {
    const started = await mutate(env.base, '/api/v1/integrations/codex/device-auth', { label: 'Cancel device', timeout_ms: 60000 }, 'device-cancel-start');
    const current = await request(env.base, `/api/v1/operations/${started.json.operation_id}`);
    const cancelled = await mutate(env.base, `/api/v1/operations/${started.json.operation_id}/cancel`, { expected_revision: current.json.revision }, 'device-cancel');
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.json.status, 'cancelled');
    const credential = await eventually(async () => (await request(env.base, '/api/v1/credentials')).json.find((item) => item.id === started.json.resource_id), (value) => value?.status === 'revoked', 4000);
    assert.equal(credential?.status, 'revoked');
  } finally { await env.close(); }
});

test('Codex discovery hides source paths and rejects stale imports', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-codex-discovery-'));
  const secret = 'codex-discovery-secret-value';
  fs.writeFileSync(path.join(root, 'config.toml'), 'model = "fixture-model"\nmodel_provider = "openai"\n', 'utf8');
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }), 'utf8');
  const env = await fixture({ config: { codexDiscoveryRoots: [{ type: 'codex_home', path: root, display_name: 'Fixture Codex' }] } });
  try {
    const started = await mutate(env.base, '/api/v1/integrations/codex/discovery', {}, 'discovery-start');
    assert.equal(started.response.status, 202);
    const operation = await eventually(
      async () => (await request(env.base, `/api/v1/operations/${started.json.operation_id}`)).json,
      (value) => ['completed', 'failed'].includes(value.status),
      4000
    );
    assert.equal(operation.status, 'completed', JSON.stringify(operation));
    const source = operation.result.sources[0];
    assert.equal(source.status, 'available');
    assert.equal(JSON.stringify(operation).includes(root), false);
    assert.equal(JSON.stringify(operation).includes(secret), false);
    assert.equal(source.records[0].credential_available, true);

    fs.appendFileSync(path.join(root, 'config.toml'), 'reasoning = "high"\n', 'utf8');
    const stale = await mutate(env.base, '/api/v1/integrations/codex/discovery/import', {
      confirmed: true,
      source_id: source.id,
      source_revision: source.source_revision,
      record_id: source.records[0].id
    }, 'discovery-stale');
    assert.equal(stale.response.status, 409);
    assert.equal(stale.json.error.code, 'discovery_source_stale');

    const refreshedStart = await mutate(env.base, '/api/v1/integrations/codex/discovery', {}, 'discovery-refresh');
    const refreshedOperation = await eventually(
      async () => (await request(env.base, `/api/v1/operations/${refreshedStart.json.operation_id}`)).json,
      (value) => value.status === 'completed',
      4000
    );
    const refreshed = refreshedOperation.result.sources[0];
    const imported = await mutate(env.base, '/api/v1/integrations/codex/discovery/import', {
      confirmed: true,
      source_id: refreshed.id,
      source_revision: refreshed.source_revision,
      record_id: refreshed.records[0].id,
      activate: true
    }, 'discovery-import');
    assert.equal(imported.response.status, 201, JSON.stringify(imported.json));
    assert.equal(imported.json.credential.origin, 'discovery');
    assert.equal(imported.json.profile.model, 'fixture-model');
    assert.equal(JSON.stringify(imported.json).includes(secret), false);
  } finally {
    await env.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex Probe returns the fixed seven-stage sanitized result', async () => {
  const env = await fixture();
  try {
    const credential = await mutate(env.base, '/api/v1/credentials', {
      kind: 'codex_api_key', label: 'Probe key', secret: 'codex-probe-secret-value'
    }, 'probe-credential');
    const profile = await mutate(env.base, '/api/v1/profiles/codex', {
      label: 'Probe profile', provider: 'openai', model: 'gpt-5.5', base_url: '',
      wire_api: 'responses', reasoning: 'medium', timeout_ms: 30000,
      credential_ref: credential.json.id
    }, 'probe-profile');
    const started = await mutate(env.base, '/api/v1/integrations/codex/probe', {
      profile_id: profile.json.id,
      expected_revision: profile.json.revision,
      force: true
    }, 'probe-start');
    assert.equal(started.response.status, 202, JSON.stringify(started.json));
    const operation = await eventually(
      async () => (await request(env.base, `/api/v1/operations/${started.json.operation_id}`)).json,
      (value) => ['completed', 'failed'].includes(value.status),
      4000
    );
    assert.equal(operation.status, 'completed', JSON.stringify(operation));
    assert.deepEqual(operation.result.checks.map((item) => item.phase), [
      'configuration', 'runtime', 'binding', 'transport', 'protocol', 'model', 'inference'
    ]);
    assert.equal(operation.result.status, 'unavailable');
    assert.equal(operation.result.checks[3].status, 'failed');
    assert.equal(JSON.stringify(operation).includes('codex-probe-secret-value'), false);
  } finally { await env.close(); }
});
