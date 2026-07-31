import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.AIWS_TEST_PORT || 4586);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v12-codex-'));
const child = spawn(process.execPath, ['apps/api/server.mjs'], {
  env: {
    ...process.env,
    AIWS_PORT: String(port),
    AIWS_HOME: home,
    AIWS_TEST_DISABLE_CONTEXT_PROJECTOR: '1',
    NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
let stateApi;
child.stdout.on('data', (chunk) => {
  serverLog += chunk;
});
child.stderr.on('data', (chunk) => {
  serverLog += chunk;
});

await waitForServer();
try {
  process.env.AIWS_HOME = home;
  process.env.NODE_ENV = 'test';
  stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();

  await api('/setup/mode', 'PUT', { mode: 'byo' });
  assert.equal((await api('/setup/status')).steps.codex.ready, false);
  await api('/setup/complete', 'POST', {}, 409, 'setup_incomplete');
  await api('/codex/docker/build', 'POST', { adapter: 'test' });
  await api('/codex/auth/device/start', 'POST', { adapter: 'test' });
  assert.equal((await api('/codex/status')).authenticated, true);
  assert.equal((await api('/codex/cc-switch/status')).status, 'not_synced');
  const officialBeforeCcSwitch = await api(
    '/codex/profiles',
    'POST',
    {
      name: 'Official before cc-switch',
      provider: 'openai',
      model: 'gpt-official',
      reasoning: 'high',
      timeout_ms: 1000,
      mounts: []
    },
    201
  );
  await api('/codex/probe', 'POST', { adapter: 'test', profile_id: officialBeforeCcSwitch.id });
  const officialWithoutCc = (await api('/setup/status')).steps.codex;
  assert.equal(officialWithoutCc.checks.cc_switch_ready, true);
  assert.equal(officialWithoutCc.checks.profile_valid, true);
  assert.equal(officialWithoutCc.ready, true);
  await api('/codex/auth/reset', 'POST', {});
  await api(
    '/codex/auth/api-key',
    'POST',
    { provider: 'openrouter', api_key: 'sk-unit-third-party-key' },
    400,
    'base_url_required'
  );
  await api(
    '/codex/auth/api-key',
    'POST',
    { provider: 'openrouter', api_key: 'sk-unit-third-party-key', base_url: 'file:///invalid', wire_api: 'responses' },
    400,
    'invalid_base_url'
  );
  await api(
    '/codex/auth/api-key',
    'POST',
    {
      provider: 'openrouter',
      api_key: 'sk-unit-third-party-key',
      base_url: 'https://openrouter.ai/api/v1',
      wire_api: 'chat'
    },
    400,
    'unsupported_wire_api'
  );
  await api('/codex/auth/api-key', 'POST', {
    provider: 'openrouter',
    api_key: 'sk-unit-third-party-key',
    base_url: 'https://openrouter.ai/api/v1',
    wire_api: 'responses'
  });
  assert.deepEqual((await api('/codex/status')).auth, {
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    wire_api: 'responses',
    auth_mode: 'api_key'
  });
  await stateApi.readState();
  await stateApi.mutate((state) => {
    state.integration_statuses.find((item) => item.key === 'codex_auth').base_url = null;
  });
  await api('/codex/auth/api-key', 'POST', {
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    wire_api: 'responses'
  });
  assert.equal((await api('/codex/status')).auth.base_url, 'https://openrouter.ai/api/v1');

  for (const body of [
    { reasoning: 'not valid' },
    { timeout_ms: 1 },
    { web_search: 'yes' },
    { mounts: [path.dirname(home)] },
    { mcp_servers: [{ name: 'unsafe', command: 'powershell', args: [] }] }
  ])
    await api(
      '/codex/profiles',
      'POST',
      {
        name: 'Invalid',
        provider: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        wire_api: 'responses',
        model: 'provider/model',
        reasoning: 'high',
        timeout_ms: 1000,
        mounts: [],
        ...body
      },
      400,
      'invalid_codex_profile'
    );
  await api(
    '/codex/profiles',
    'POST',
    {
      name: 'Missing URL',
      provider: 'openrouter',
      model: 'provider/model',
      reasoning: 'high',
      timeout_ms: 1000,
      mounts: []
    },
    400,
    'invalid_codex_profile'
  );

  const third = await api(
    '/codex/profiles',
    'POST',
    {
      name: 'Third Party',
      provider: 'openrouter',
      provider_name: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      wire_api: 'responses',
      model: 'provider/model',
      reasoning: 'medium',
      web_search: true,
      timeout_ms: 1000,
      mounts: [],
      mcp_servers: [{ name: 'local', command: 'node', args: ['server.mjs'] }]
    },
    201
  );
  assert.equal(third.cc_switch_status, 'not_required');
  assert.equal(third.cc_switch_mode, 'native');
  assert.match(
    fs.readFileSync(third.config_file, 'utf8'),
    /\[model_providers\.openrouter\][\s\S]*base_url = "https:\/\/openrouter\.ai\/api\/v1"[\s\S]*env_key = "OPENAI_API_KEY"/
  );
  assert.match(fs.readFileSync(third.config_file, 'utf8'), /web_search = "live"/);
  await api('/codex/probe', 'POST', { adapter: 'test', profile_id: third.id });
  assert.equal((await api('/setup/status')).steps.codex.checks.profile_valid, true);
  const ccSwitch = await api('/codex/cc-switch/sync', 'POST', { adapter: 'test' });
  assert.equal(ccSwitch.status, 'synced');
  assert.equal(ccSwitch.bridge.ready, true);
  assert.equal(
    ccSwitch.providers.some((item) => item.profile_id === third.id && item.sync_status === 'not_required'),
    true
  );
  assert.equal(
    (await api('/codex/profiles')).some((item) => item.kind === 'cc_switch'),
    false
  );
  const legacyMissingUrl = {
    ...third,
    id: 'legacy-missing-url',
    name: 'Legacy missing URL',
    base_url: null,
    status: 'configuration_required',
    is_active: false,
    cc_switch_status: 'pending',
    cc_switch_synced_at: null,
    cc_switch_bridge_revision: null,
    cc_switch_source_commit: null
  };
  await stateApi.readState();
  await stateApi.mutate((state) => {
    state.codex_profiles.push(legacyMissingUrl);
  });
  assert.equal((await api('/codex/cc-switch/sync', 'POST', { adapter: 'test' })).status, 'synced');
  const repairedBinding = await api(`/codex/profiles/${legacyMissingUrl.id}`, 'PUT', {
    base_url: 'https://openrouter.ai/api/v1'
  });
  assert.equal(repairedBinding.cc_switch_status, 'not_required');
  assert.equal((await api('/codex/cc-switch/status')).status, 'synced');
  await api(`/codex/profiles/${legacyMissingUrl.id}`, 'DELETE', {});
  await api(
    '/codex/cc-switch/import',
    'POST',
    { provider: 'openrouter', model: 'provider/model' },
    400,
    'cc_switch_catalog_entry_required'
  );
  await api(
    '/codex/cc-switch/import',
    'POST',
    {
      source: 'cc_switch_catalog',
      entry: {
        provider: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        model: 'provider/model',
        api_key: 'must-not-enter-state'
      }
    },
    400,
    'cc_switch_catalog_must_not_contain_secret'
  );
  await api(
    '/codex/cc-switch/import',
    'POST',
    {
      source: 'cc_switch_catalog',
      entry: {
        provider: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        model: 'provider/model',
        mcp_servers: [{ args: ['hidden'] }]
      }
    },
    400,
    'cc_switch_catalog_runtime_fields_not_allowed'
  );
  const failedProbe = await api(
    '/codex/probe',
    'POST',
    {
      adapter: 'test',
      profile_id: third.id,
      test_result: {
        ok: false,
        process: { ok: false, code: 1, stderr: 'failed to connect to dockerDesktopLinuxEngine sk-probe-sentinel' }
      }
    },
    409,
    'codex_probe_docker_unavailable'
  );
  assert.equal(failedProbe.phase, 'runtime');
  assert.match(failedProbe.message, /Docker/);
  assert.match(failedProbe.action, /Docker Desktop/);
  assert.deepEqual(
    failedProbe.probe.checks.map((item) => `${item.phase}:${item.status}`),
    [
      'configuration:passed',
      'runtime:failed',
      'binding:pending',
      'transport:pending',
      'protocol:pending',
      'model:pending',
      'inference:pending'
    ]
  );
  assert.doesNotMatch(JSON.stringify(failedProbe), /probe-sentinel|stderr/);
  const persistedProbeState = await stateApi.readState();
  assert.doesNotMatch(
    JSON.stringify(persistedProbeState.integration_statuses.filter((item) => item.key === 'codex_probe')),
    /probe-sentinel|stderr/
  );
  assert.equal((await api('/setup/status')).steps.codex.checks.profile_valid, true);
  await api('/codex/probe', 'POST', { adapter: 'test', profile_id: third.id });
  assert.equal((await api('/setup/status')).steps.codex.ready, true);

  await api('/codex/auth/api-key', 'POST', { provider: 'openai', api_key: 'sk-unit-official-key' });
  const official = await api(
    '/codex/profiles',
    'POST',
    { name: 'Official', provider: 'openai', model: 'gpt-test', reasoning: 'high', timeout_ms: 2000, mounts: [] },
    201
  );
  let profiles = await api('/codex/profiles');
  assert.equal(
    profiles.some((item) => item.id === official.id),
    true
  );
  await api(`/codex/profiles/${official.id}`, 'PUT', { reasoning: 'low', timeout_ms: 3000 });
  assert.equal((await api('/setup/status')).steps.codex.checks.probe_ok, false);
  await api('/codex/probe', 'POST', { adapter: 'test', profile_id: official.id });
  await api(`/codex/profiles/${third.id}`, 'DELETE', {});
  await api(`/codex/profiles/${official.id}`, 'DELETE', {}, 409, 'active_profile_cannot_be_deleted');

  await configureGithub();
  assert.equal((await api('/setup/complete', 'POST', {})).complete, true);
  await api(
    '/codex/profiles',
    'POST',
    { name: 'Unconfirmed', provider: 'openai', model: 'gpt-alt', reasoning: 'high', timeout_ms: 1000, mounts: [] },
    409,
    'configuration_confirmation_required'
  );
  const alternate = await api(
    '/codex/profiles',
    'POST',
    {
      name: 'Alternate',
      provider: 'openai',
      model: 'gpt-alt',
      reasoning: 'high',
      timeout_ms: 1000,
      mounts: [],
      confirmed: true
    },
    201
  );
  await api('/codex/profiles/probe-missing', 'PUT', {}, 404, 'profile_not_found');
  await api(`/codex/profiles/${alternate.id}/propose-apply`, 'POST', {}, 409, 'profile_probe_required');
  await api('/codex/probe', 'POST', { adapter: 'test', profile_id: alternate.id });
  const proposal = await api(`/codex/profiles/${alternate.id}/propose-apply`, 'POST', {}, 201);
  await api(`/change-proposals/${proposal.id}/approve`, 'POST', {});
  await api(`/change-proposals/${proposal.id}/apply`, 'POST', {});
  profiles = await api('/codex/profiles');
  assert.equal(profiles.find((item) => item.id === alternate.id).is_active, true);
  await api(`/codex/profiles/${alternate.id}`, 'PUT', { reasoning: 'medium' }, 409, 'profile_change_proposal_required');
  await stateApi.readState();
  await stateApi.mutate((state) => {
    state.codex_profiles.find((item) => item.id === alternate.id).status = 'configuration_required';
  });
  const repaired = await api(`/codex/profiles/${alternate.id}`, 'PUT', { reasoning: 'medium' });
  assert.equal(repaired.status, 'validated');
  assert.equal((await api('/setup/status')).completed_at, null);
  console.log('v1.2 Codex profile integration tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await stateApi?.checkpointAndCloseState().catch(() => undefined);
  fs.rmSync(home, { recursive: true, force: true });
}

async function configureGithub() {
  await api('/github/app-config/manual', 'POST', {
    adapter: 'test',
    app_id: '101',
    client_id: 'Iv1.codex',
    client_secret: 'client',
    private_key: 'private',
    webhook_secret: 'hook'
  });
  const device = await api('/github/device/start', 'POST', { adapter: 'test' });
  await api('/github/device/poll', 'POST', { adapter: 'test', request_id: device.request_id });
  await api('/github/installations/start', 'POST', { adapter: 'test' });
  await api('/github/installations/9001/repositories', 'PUT', { repository_ids: ['7001'] });
}
async function api(route, method = 'GET', body, status = 200, error) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}\n${serverLog.slice(-6000)}`);
  if (error) assert.equal(data.error, error);
  return data;
}
async function waitForServer() {
  for (let index = 0; index < 100; index++) {
    try {
      if ((await api('/health')).status === 'ok') return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('server did not start');
}
