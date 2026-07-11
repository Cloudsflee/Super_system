import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-discovery-unit-'));
const ccDir = path.join(root, 'cc-switch'), codexDir = path.join(root, 'codex-home');
fs.mkdirSync(ccDir); fs.mkdirSync(codexDir);
const ccSecret = 'cc-unit-secret-value', directSecret = 'direct-unit-secret-value', embeddedSecret = 'embedded-unit-secret-value';
const oauthAccess = 'oauth-unit-access-sentinel', oauthRefresh = 'oauth-unit-refresh-sentinel', oauthId = 'oauth-unit-id-sentinel';
process.env.CC_SWITCH_CONFIG_DIR = ccDir;
process.env.CODEX_HOME = codexDir;

try {
  seedDatabase(path.join(ccDir, 'cc-switch.db'));
  fs.writeFileSync(path.join(codexDir, 'config.toml'), directToml('direct/model'), 'utf8');
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: directSecret }), 'utf8');
  const { discoverLocalCodex, resolveDiscoveryImport } = await import('../../apps/api/src/codex-discovery-service.mjs');
  const { authJsonInfo, publicProviderFromToml } = await import('../../apps/api/src/codex-discovery-utils.mjs');

  const discovered = await discoverLocalCodex();
  assert.equal(discovered.sources[0].type, 'cc_switch');
  assert.equal(discovered.sources[0].status, 'available');
  assert.equal(discovered.sources[1].type, 'codex_home');
  const serialized = JSON.stringify(discovered);
  for (const forbidden of [ccSecret, directSecret, embeddedSecret, ccDir, codexDir, 'raw-project-path-marker']) assert.equal(serialized.includes(forbidden), false, forbidden);
  const ccProvider = discovered.sources[0].providers.find((item) => item.importable && item.has_credential);
  const directProvider = discovered.sources[1].providers[0];
  assert.equal(Boolean(ccProvider?.discovery_id), true);
  assert.equal(directProvider.base_url, 'https://direct.example/v1');
  assert.equal(directProvider.has_credential, true);
  const ccResolved = await resolveDiscoveryImport({ discoveryId: ccProvider.discovery_id, sourceRevision: ccProvider.source_revision });
  assert.equal(ccResolved.credential, ccSecret);
  assert.equal(ccResolved.source.source_provider_id, ccProvider.discovery_id);
  const directResolved = await resolveDiscoveryImport({ discoveryId: directProvider.discovery_id, sourceRevision: directProvider.source_revision });
  assert.equal(directResolved.credential, directSecret);

  fs.writeFileSync(path.join(codexDir, 'config.toml'), directToml('direct/model-v2'), 'utf8');
  await assert.rejects(() => resolveDiscoveryImport({ discoveryId: directProvider.discovery_id, sourceRevision: directProvider.source_revision }), (error) => error.code === 'discovery_source_stale');
  fs.writeFileSync(path.join(codexDir, 'config.toml'), officialToml(), 'utf8');
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: oauthAccess, refresh_token: oauthRefresh, id_token: oauthId } }), 'utf8');
  const oauthDiscovery = await discoverLocalCodex();
  const oauthProvider = oauthDiscovery.sources.find((item) => item.path_hint === '$CODEX_HOME/config.toml').providers[0];
  assert.equal(oauthProvider.provider, 'openai');
  assert.equal(oauthProvider.has_credential, true);
  assert.equal(oauthProvider.credential_kind, 'oauth_bundle');
  assert.equal(oauthProvider.importable, true);
  for (const forbidden of [oauthAccess, oauthRefresh, oauthId]) assert.equal(JSON.stringify(oauthDiscovery).includes(forbidden), false);
  const oauthResolved = await resolveDiscoveryImport({ discoveryId: oauthProvider.discovery_id, sourceRevision: oauthProvider.source_revision });
  assert.equal(oauthResolved.credential, '');
  assert.equal(JSON.parse(oauthResolved.auth_bundle).tokens.access_token, oauthAccess);
  process.env.AIWS_HOST_CODEX_HOME = codexDir;
  process.env.AIWS_HOST_CC_SWITCH_CONFIG_DIR = ccDir;
  const mounted = await discoverLocalCodex();
  assert.equal(mounted.sources[0].path_hint, '$AIWS_HOST_CC_SWITCH_CONFIG_DIR/cc-switch.db');
  assert.equal(mounted.sources.find((item) => item.type === 'codex_home').path_hint, '$AIWS_HOST_CODEX_HOME/config.toml');
  delete process.env.AIWS_HOST_CODEX_HOME;
  delete process.env.AIWS_HOST_CC_SWITCH_CONFIG_DIR;
  const sensitive = publicProviderFromToml('model_provider="custom"\nmodel="m"\n[model_providers.custom]\nbase_url="https://relay.example/v1/api_key/abcdefghijklmnopqrstuvwxyz0123456789"\nwire_api="responses"');
  assert.equal(sensitive.descriptor.base_url, null);
  assert.ok(sensitive.descriptor.issues.includes('sensitive_base_url_rejected'));
  const officialRelay = publicProviderFromToml('model_provider="openai"\nmodel="gpt"\n[model_providers.openai]\nbase_url="https://relay.example/v1"\nwire_api="responses"');
  assert.equal(officialRelay.descriptor.importable, false);
  assert.ok(officialRelay.descriptor.issues.includes('official_provider_custom_base_url_mismatch'));
  const oauth = authJsonInfo(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'never-return' } }));
  assert.equal(oauth.oauth, true); assert.equal(oauth.credential, '');
  assert.equal(authJsonInfo(JSON.stringify({ tokens: {} })).oauth, false);
  const codexLink = path.join(root, 'codex-link'), ccLink = path.join(root, 'cc-link');
  try {
    fs.symlinkSync(codexDir, codexLink, 'junction'); fs.symlinkSync(ccDir, ccLink, 'junction');
    process.env.CODEX_HOME = codexLink; process.env.CC_SWITCH_CONFIG_DIR = ccLink;
    const linked = await discoverLocalCodex();
    assert.equal(linked.sources.find((item) => item.path_hint === '$CODEX_HOME/config.toml').status, 'unavailable');
    assert.equal(linked.sources[0].status, 'unavailable');
  } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  console.log('Codex local discovery unit tests passed');
} finally {
  delete process.env.CC_SWITCH_CONFIG_DIR; delete process.env.CODEX_HOME;
  delete process.env.AIWS_HOST_CODEX_HOME; delete process.env.AIWS_HOST_CC_SWITCH_CONFIG_DIR;
  fs.rmSync(root, { recursive: true, force: true });
}

function seedDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=11; CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, category TEXT, meta TEXT, is_current INTEGER, sort_index INTEGER, PRIMARY KEY(id, app_type));');
  const insert = db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('relay', 'codex', 'Relay', JSON.stringify({ auth: { OPENAI_API_KEY: ccSecret }, config: ccToml('relay/model') }), 'custom', JSON.stringify({ apiFormat: 'openai_responses' }), 1, 1);
  insert.run('manual', 'codex', 'Manual', JSON.stringify({ auth: {}, config: ccToml('manual/model', '') }), 'custom', '{}', 0, 2);
  db.close();
}
function ccToml(model, token = embeddedSecret) { return `model_provider="relay"\nmodel="${model}"\n[model_providers.relay]\nname="Relay"\nbase_url="https://relay.example/v1"\nwire_api="responses"\nrequires_openai_auth=true\nexperimental_bearer_token="${token}"\n[projects.'raw-project-path-marker']\ntrust_level="trusted"\n`; }
function directToml(model) { return `model_provider="direct"\nmodel="${model}"\n[model_providers.direct]\nname="Direct"\nbase_url="https://direct.example/v1"\nwire_api="responses"\nrequires_openai_auth=true\n`; }
function officialToml() { return 'model="gpt-5.1-codex"\nmodel_reasoning_effort="high"\n'; }
