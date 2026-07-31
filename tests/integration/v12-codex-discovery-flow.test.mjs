import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const port = Number(process.env.AIWS_TEST_PORT || 4592),
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-discovery-flow-'));
const home = path.join(root, 'aiws'),
  ccDir = path.join(root, 'cc-switch'),
  codexDir = path.join(root, 'codex'),
  userCodexDir = path.join(root, '.codex');
fs.mkdirSync(ccDir);
fs.mkdirSync(codexDir);
fs.mkdirSync(userCodexDir);
const ccSecret = 'cc-integration-secret-sentinel',
  rotatedSecret = 'cc-rotated-secret-sentinel',
  directSecret = 'direct-integration-secret-sentinel',
  manualSecret = 'manual-integration-secret-sentinel';
const oauthAccess = 'oauth-integration-access-sentinel',
  oauthRefresh = 'oauth-integration-refresh-sentinel',
  oauthId = 'oauth-integration-id-sentinel';
seedDatabase(path.join(ccDir, 'cc-switch.db'), 'cc/model-v1');
fs.writeFileSync(
  path.join(codexDir, 'config.toml'),
  providerToml('direct', 'https://direct.integration/v1', 'direct/model'),
  'utf8'
);
fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: directSecret }), 'utf8');
fs.writeFileSync(
  path.join(userCodexDir, 'config.toml'),
  'model="gpt-5.1-codex"\nmodel_reasoning_effort="high"\n',
  'utf8'
);
fs.writeFileSync(
  path.join(userCodexDir, 'auth.json'),
  JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: oauthAccess, refresh_token: oauthRefresh, id_token: oauthId }
  }),
  'utf8'
);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'apps/api/server.mjs'], {
  env: {
    ...process.env,
    AIWS_PORT: String(port),
    AIWS_HOME: home,
    AIWS_TEST_DISABLE_CONTEXT_PROJECTOR: '1',
    NODE_ENV: 'test',
    AIWS_HOST_CODEX_HOME: codexDir,
    CODEX_HOME: '',
    CC_SWITCH_CONFIG_DIR: ccDir,
    HOME: root,
    USERPROFILE: root
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
let stateApi;
child.stdout.on('data', (chunk) => {
  log += chunk;
});
child.stderr.on('data', (chunk) => {
  log += chunk;
});

await waitForServer();
try {
  let discovery = await api('/codex/discovery');
  assert.equal(discovery.sources[0].type, 'cc_switch');
  assert.equal(discovery.sources[0].status, 'available');
  const publicJson = JSON.stringify(discovery);
  for (const forbidden of [
    ccSecret,
    rotatedSecret,
    directSecret,
    oauthAccess,
    oauthRefresh,
    oauthId,
    ccDir,
    codexDir,
    userCodexDir
  ])
    assert.equal(publicJson.includes(forbidden), false, forbidden);
  let ccProvider = discovery.sources[0].providers.find((item) => item.importable && item.has_credential);
  const manualProvider = discovery.sources[0].providers.find((item) => item.importable && !item.has_credential);
  await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: ccProvider.discovery_id, source_revision: ccProvider.source_revision },
    409,
    'discovery_import_confirmation_required'
  );
  await api(
    '/codex/discovery/import',
    'POST',
    {
      discovery_id: ccProvider.discovery_id,
      source_revision: ccProvider.source_revision,
      confirmed: true,
      api_key: 'override'
    },
    400,
    'discovered_credential_override_not_allowed'
  );
  updateDatabase(path.join(ccDir, 'cc-switch.db'), 'cc/model-v2');
  await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: ccProvider.discovery_id, source_revision: ccProvider.source_revision, confirmed: true },
    409,
    'discovery_source_stale'
  );
  discovery = await api('/codex/discovery');
  ccProvider = discovery.sources[0].providers.find((item) => item.importable && item.has_credential);
  rotateDatabaseCredential(path.join(ccDir, 'cc-switch.db'), rotatedSecret);
  await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: ccProvider.discovery_id, source_revision: ccProvider.source_revision, confirmed: true },
    409,
    'discovery_source_stale'
  );
  discovery = await api('/codex/discovery');
  ccProvider = discovery.sources[0].providers.find((item) => item.importable && item.has_credential);
  const importedCc = await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: ccProvider.discovery_id, source_revision: ccProvider.source_revision, confirmed: true },
    201
  );
  assert.equal(importedCc.source.type, 'cc_switch');
  assert.equal(importedCc.profile.is_active, true);
  assert.equal(importedCc.profile.discovery_source.source_provider_id, ccProvider.discovery_id);
  assert.equal((await api('/setup/status')).steps.codex.checks.profile_valid, true);
  const ccConfig = fs.readFileSync(importedCc.profile.config_file, 'utf8');
  assert.match(ccConfig, /base_url = "https:\/\/cc\.integration\/v1"/);
  assert.equal(ccConfig.includes(ccSecret), false);
  await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: manualProvider.discovery_id, source_revision: discovery.sources[0].revision, confirmed: true },
    400,
    'api_key_required'
  );
  const importedManual = await api(
    '/codex/discovery/import',
    'POST',
    {
      discovery_id: manualProvider.discovery_id,
      source_revision: discovery.sources[0].revision,
      confirmed: true,
      api_key: manualSecret
    },
    201
  );
  assert.equal(importedManual.authenticated, true);

  discovery = await api('/codex/discovery');
  const direct = discovery.sources.find((item) => item.path_hint === '$AIWS_HOST_CODEX_HOME/config.toml').providers[0];
  const importedDirect = await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: direct.discovery_id, source_revision: direct.source_revision, confirmed: true },
    201
  );
  assert.equal(importedDirect.source.type, 'codex_home');
  const official = discovery.sources.find((item) => item.path_hint === '~/.codex/config.toml').providers[0];
  assert.equal(official.credential_kind, 'oauth_bundle');
  assert.equal(official.has_credential, true);
  const importedOfficial = await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: official.discovery_id, source_revision: official.source_revision, confirmed: true },
    201
  );
  assert.equal(importedOfficial.profile.provider, 'openai');
  assert.equal((await api('/codex/status')).auth.auth_mode, 'local_codex');
  const managedAuthFile = path.join(importedOfficial.profile.codex_home, 'auth.json');
  assert.equal(fs.existsSync(managedAuthFile), true);
  assert.equal(JSON.parse(fs.readFileSync(managedAuthFile, 'utf8')).tokens.refresh_token, oauthRefresh);
  assert.equal(fs.readFileSync(importedOfficial.profile.config_file, 'utf8').includes(oauthAccess), false);
  const stateFiles = ['state.json', 'state-v22.sqlite', 'state-v22.sqlite-wal']
    .map((name) => path.join(home, 'data', name))
    .filter(fs.existsSync)
    .map((file) => fs.readFileSync(file));
  for (const forbidden of [ccSecret, rotatedSecret, directSecret, manualSecret, oauthAccess, oauthRefresh, oauthId])
    assert.equal(
      stateFiles.some((contents) => contents.includes(Buffer.from(forbidden))),
      false
    );
  process.env.AIWS_HOME = home;
  process.env.NODE_ENV = 'test';
  stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();
  await stateApi.mutate((state) => {
    const timestamp = new Date().toISOString();
    state.setup_states = [{ id: 'setup_owner', mode: 'byo', completed_at: timestamp, updated_at: timestamp }];
  });
  await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: direct.discovery_id, source_revision: direct.source_revision, confirmed: true },
    409,
    'discovery_reconfiguration_required'
  );
  const reconfigured = await api(
    '/codex/discovery/import',
    'POST',
    { discovery_id: direct.discovery_id, source_revision: direct.source_revision, confirmed: true, reconfigure: true },
    201
  );
  assert.equal(reconfigured.reconfiguration_started, true);
  assert.equal(fs.existsSync(managedAuthFile), false);
  await api('/codex/auth/device/not-found/cancel', 'POST', {}, 404, 'codex_auth_request_not_found');
  for (const forbidden of [ccSecret, rotatedSecret, directSecret, manualSecret, oauthAccess, oauthRefresh, oauthId])
    assert.equal(log.includes(forbidden), false);
  console.log('V1.2 Codex discovery integration tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await stateApi?.checkpointAndCloseState().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

function seedDatabase(file, model) {
  const db = new DatabaseSync(file);
  db.exec(
    'PRAGMA user_version=11; CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, category TEXT, meta TEXT, is_current INTEGER, sort_index INTEGER, PRIMARY KEY(id, app_type));'
  );
  const insert = db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(
    'cc',
    'codex',
    'CC',
    JSON.stringify({
      auth: { OPENAI_API_KEY: ccSecret },
      config: providerToml('cc', 'https://cc.integration/v1', model)
    }),
    'custom',
    '{"apiFormat":"openai_responses"}',
    1,
    1
  );
  insert.run(
    'manual',
    'codex',
    'Manual',
    JSON.stringify({ auth: {}, config: providerToml('manual', 'https://manual.integration/v1', 'manual/model') }),
    'custom',
    '{}',
    0,
    2
  );
  db.close();
}
function updateDatabase(file, model) {
  const db = new DatabaseSync(file);
  db.prepare('UPDATE providers SET settings_config=? WHERE id=? AND app_type=?').run(
    JSON.stringify({
      auth: { OPENAI_API_KEY: ccSecret },
      config: providerToml('cc', 'https://cc.integration/v1', model)
    }),
    'cc',
    'codex'
  );
  db.close();
}
function rotateDatabaseCredential(file, credential) {
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT settings_config FROM providers WHERE id=? AND app_type=?').get('cc', 'codex');
  const settings = JSON.parse(row.settings_config);
  settings.auth.OPENAI_API_KEY = credential;
  db.prepare('UPDATE providers SET settings_config=? WHERE id=? AND app_type=?').run(
    JSON.stringify(settings),
    'cc',
    'codex'
  );
  db.close();
}
function providerToml(provider, baseUrl, model) {
  return `model_provider="${provider}"\nmodel="${model}"\n[model_providers.${provider}]\nname="${provider}"\nbase_url="${baseUrl}"\nwire_api="responses"\nrequires_openai_auth=true\n`;
}
async function api(route, method = 'GET', body, status = 200, error) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`);
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
