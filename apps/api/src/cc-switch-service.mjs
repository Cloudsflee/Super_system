import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AIWS_HOME, ROOT } from './config.mjs';
import { command } from './http.mjs';
import { resolveCodexInvocation } from '../../../packages/runner-adapters/src/codex-command.mjs';
import { addTrace, mutate, owner, readState } from './state.mjs';
import { codexProviderKey, isThirdPartyProvider, normalizeProviderBaseUrl, profileConfigToml, writeProfileConfig } from './codex-service.mjs';
import { now } from '../../../packages/shared/index.mjs';

export const ccSwitchSources = [
  { name: 'cc-switch-desktop', repo: 'https://github.com/farion1231/cc-switch.git' },
  { name: 'cc-switch-cli', repo: 'https://github.com/SaladDay/cc-switch-cli.git' }
];

export { resolveCodexInvocation as resolveCodexParserInvocation };

const BRIDGE_REVISION = 2;

export async function ccSwitchStatus() {
  const state = await readState();
  const stored = state.integration_statuses.find((item) => item.key === 'cc_switch');
  return statusResponse(state, stored || { key: 'cc_switch', status: 'not_synced', local_path: basePath(), sources: ccSwitchSources, updated_at: null });
}

// A checkout is not readiness: config conformance and provider bindings must pass too.
export async function syncCcSwitch({ adapted = false } = {}) {
  const baseDir = basePath();
  await fsp.mkdir(baseDir, { recursive: true });
  const sources = [];
  for (const source of ccSwitchSources) sources.push(adapted ? { ...source, status: 'synced', local_path: path.join(baseDir, source.name), commit: 'test-adapter' } : syncSource(baseDir, source));
  const sourceReady = sources.every((item) => item.status === 'synced' && item.commit);
  const conformance = await validateBridgeConformance({ adapted });
  const capabilityReady = sourceReady && conformance.ok;

  return mutate(async (state) => {
    const actor = owner(state);
    // Remove the old non-runnable Profiles that represented source checkouts.
    state.codex_profiles = state.codex_profiles.filter((item) => item.kind !== 'cc_switch');
    const syncedAt = capabilityReady ? now() : null;
    const status = upsert(state, {
      status: capabilityReady ? 'synced' : 'degraded', local_path: baseDir, sources,
      bridge: {
        ready: capabilityReady,
        revision: BRIDGE_REVISION,
        mode: 'profile_scoped',
        implementation: 'cc-switch-config-bridge',
        capabilities: ['provider_endpoint', 'api_format', 'profile_scoped_switch'],
        conformance
      },
      synced_at: syncedAt,
      updated_at: now()
    });

    const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
    const managedProfiles = state.codex_profiles.filter((item) => item.cc_switch_mode === 'managed');
    if (capabilityReady) {
      for (const profile of managedProfiles) {
        const previousBinding = [profile.cc_switch_status, profile.cc_switch_bridge_revision, profile.cc_switch_source_commit].join(':');
        Object.assign(profile, ccSwitchBinding(profile, status), { updated_at: now() });
        if (previousBinding !== [profile.cc_switch_status, profile.cc_switch_bridge_revision, profile.cc_switch_source_commit].join(':')) for (const probe of state.integration_statuses.filter((item) => item.key === 'codex_probe' && item.profile_id === profile.id)) probe.status = 'stale';
        if (normalizeProviderBaseUrl(profile.base_url)) await writeProfileConfig(profile, auth?.home);
      }
      await writeBridgeCatalog(state, status);
    } else {
      for (const profile of managedProfiles) {
        Object.assign(profile, { cc_switch_required: true, cc_switch_synced_at: null, cc_switch_status: 'pending' });
      }
    }
    const thirdPartyProfiles = state.codex_profiles.filter((item) => isThirdPartyProvider(item.provider));
    const bindingErrors = managedProfiles.filter((item) => item.cc_switch_status !== 'synced').map((item) => ({ profile_id: item.id, reason: normalizeProviderBaseUrl(item.base_url) ? 'binding_pending' : 'base_url_required' }));
    const bindingsReady = bindingErrors.length === 0;
    const ready = capabilityReady && bindingsReady;
    Object.assign(status, { status: ready ? 'synced' : 'degraded', synced_at: ready ? syncedAt : null, provider_count: thirdPartyProfiles.length });
    Object.assign(status.bridge, { bindings_ready: bindingsReady, binding_errors: bindingErrors });
    addTrace(state, ready ? 'integration.synced' : 'integration.degraded', { summary: `cc-switch bridge 同步：${status.status}`, data: { sources, bridge: status.bridge, provider_count: status.provider_count } }, actor.id);
    return statusResponse(state, status);
  });
}
export function ccSwitchBinding(profile, status) {
  const required = profile?.cc_switch_mode === 'managed';
  const sourceCommit = status?.sources?.find((item) => item.name === 'cc-switch-cli')?.commit;
  const ready = required && Boolean(normalizeProviderBaseUrl(profile?.base_url)) && status?.bridge?.ready === true && status?.bridge?.conformance?.ok === true && Boolean(sourceCommit);
  return {
    cc_switch_mode: required ? 'managed' : 'native',
    cc_switch_required: required,
    cc_switch_provider_id: required ? codexProviderKey(profile.provider) : null,
    cc_switch_status: required ? (ready ? 'synced' : 'pending') : 'not_required',
    cc_switch_synced_at: ready ? (status.synced_at || status.updated_at || now()) : null,
    cc_switch_bridge_revision: ready ? Number(status.bridge.revision || BRIDGE_REVISION) : null,
    cc_switch_source_commit: ready ? sourceCommit : null
  };
}

export function ccSwitchProfileReady(state, profile) {
  if (profile?.cc_switch_mode !== 'managed') return !isThirdPartyProvider(profile?.provider) || Boolean(normalizeProviderBaseUrl(profile.base_url));
  const discovered = state.integration_statuses.find((item) => item.key === 'codex_discovery_binding' && item.profile_id === profile.id);
  if (profile.discovery_source && discovered) return Boolean(discovered.status === 'synced' && discovered.source_id === profile.discovery_source.source_id && discovered.source_provider_id === profile.discovery_source.source_provider_id && discovered.source_type === profile.discovery_source.type && discovered.source_revision === profile.discovery_source.revision && profile.cc_switch_status === 'synced' && profile.cc_switch_discovery_revision === discovered.source_revision);
  const status = state.integration_statuses.find((item) => item.key === 'cc_switch');
  const sourceCommit = status?.sources?.find((item) => item.name === 'cc-switch-cli')?.commit;
  return Boolean(
    normalizeProviderBaseUrl(profile.base_url)
    && status?.status === 'synced'
    && status?.bridge?.ready === true
    && profile.cc_switch_required === true
    && profile.cc_switch_status === 'synced'
    && profile.cc_switch_synced_at
    && Number(profile.cc_switch_bridge_revision) === Number(status.bridge.revision)
    && sourceCommit
    && profile.cc_switch_source_commit === sourceCommit
  );
}

export async function publishCcSwitchCatalog(state) {
  const status = state.integration_statuses.find((item) => item.key === 'cc_switch');
  const sourceCommit = status?.sources?.find((item) => item.name === 'cc-switch-cli')?.commit;
  if (!status?.bridge?.ready || status.bridge.conformance?.ok !== true || !sourceCommit) {
    if (status) { status.status = 'degraded'; status.synced_at = null; status.updated_at = now(); }
    return status || null;
  }
  const profiles = state.codex_profiles.filter((item) => item.cc_switch_mode === 'managed');
  const bindingErrors = profiles.filter((item) => item.cc_switch_status !== 'synced').map((item) => ({ profile_id: item.id, reason: normalizeProviderBaseUrl(item.base_url) ? 'binding_pending' : 'base_url_required' }));
  Object.assign(status, { provider_count: profiles.length, status: bindingErrors.length ? 'degraded' : 'synced', updated_at: now() });
  Object.assign(status.bridge, { bindings_ready: bindingErrors.length === 0, binding_errors: bindingErrors });
  if (bindingErrors.length) status.synced_at = null;
  else status.synced_at ||= now();
  await writeBridgeCatalog(state, status);
  return status;
}

function syncSource(baseDir, source) {
  const target = path.join(baseDir, source.name);
  let result;
  if (!fs.existsSync(target)) result = command('git', ['clone', '--depth', '1', source.repo, target], ROOT, 60000);
  else if (command('git', ['rev-parse', '--is-inside-work-tree'], target, 5000).ok) result = command('git', ['pull', '--ff-only'], target, 60000);
  else return { ...source, status: 'degraded', local_path: target, error: 'local_path_not_git_repository' };
  if (!result.ok) return { ...source, status: 'degraded', local_path: target, error: result.stderr || result.error };
  const commit = command('git', ['rev-parse', 'HEAD'], target, 10000);
  return { ...source, status: commit.ok ? 'synced' : 'degraded', local_path: target, commit: commit.stdout.trim(), error: commit.ok ? null : commit.stderr || commit.error };
}

export async function validateBridgeConformance({ adapted = false, commandRunner = command, platform = process.platform, exists = fs.existsSync, nodeExecutable = process.execPath } = {}) {
  const canary = {
    provider: 'cc-switch-canary', provider_name: 'CC Switch Canary', model: 'canary/model',
    base_url: 'https://relay.invalid/v1', wire_api: 'responses', requires_openai_auth: false,
    reasoning: 'high', web_search: false, mcp_servers: []
  };
  const config = profileConfigToml(canary);
  const expected = [
    'model_provider = "cc-switch-canary"', '[model_providers.cc-switch-canary]',
    'base_url = "https://relay.invalid/v1"', 'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"', 'web_search = "disabled"'
  ];
  const missing = expected.filter((item) => !config.includes(item));
  const secretFree = !/experimental_bearer_token|api[_-]?key\s*=\s*["']/i.test(config);
  if (missing.length || !secretFree) return { ok: false, revision: BRIDGE_REVISION, missing, secret_free: secretFree, parser: null };
  if (adapted) return { ok: true, revision: BRIDGE_REVISION, missing, secret_free: true, parser: 'test-adapter' };

  const home = path.join(basePath(), 'bridge', `conformance-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, 'config.toml'), config, 'utf8');
  const invocation = resolveCodexInvocation({ commandRunner, platform, exists, nodeExecutable });
  let parsed = invocation ? commandRunner(invocation.command, [...invocation.args, 'features', 'list'], ROOT, 15000, { CODEX_HOME: home, OPENAI_API_KEY: 'cc-switch-conformance-placeholder' }) : { ok: false, error: 'codex_executable_not_found', stderr: '' };
  let parser = invocation?.source || null;
  if (!parsed.ok) {
    const image = process.env.AIWS_CODEX_DOCKER_IMAGE || 'aiws-codex-runner:local';
    parsed = commandRunner('docker', ['run', '--rm', '--env', 'CODEX_HOME=/codex-home', '--env', 'OPENAI_API_KEY=cc-switch-conformance-placeholder', '-v', `${home}:/codex-home:rw`, image, 'features', 'list'], ROOT, 30000);
    parser = `docker:${image}`;
  }
  await fsp.rm(home, { recursive: true, force: true });
  return { ok: parsed.ok, revision: BRIDGE_REVISION, missing, secret_free: true, parser, parse_error: parsed.ok ? null : (parsed.stderr || parsed.error || 'codex_config_parse_failed').slice(-1000) };
}

async function writeBridgeCatalog(state, status) {
  const dir = path.join(basePath(), 'bridge');
  await fsp.mkdir(dir, { recursive: true });
  const providers = providerRows(state);
  const file = path.join(dir, 'providers.json');
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify({ schema_version: 1, bridge_revision: status.bridge.revision, generated_at: now(), providers }, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temp, file);
  status.catalog_file = file;
}

function providerRows(state) {
  return state.codex_profiles.filter((item) => isThirdPartyProvider(item.provider)).map((profile) => ({
    profile_id: profile.id,
    provider_id: profile.cc_switch_provider_id || codexProviderKey(profile.provider),
    name: profile.name,
    provider: profile.provider,
    base_url: profile.base_url,
    model: profile.model,
    wire_api: profile.wire_api || 'responses',
    sync_status: profile.cc_switch_status || 'pending',
    synced_at: profile.cc_switch_synced_at || null
  }));
}

function statusResponse(state, status) {
  return { ...status, sources: status.sources || ccSwitchSources, providers: providerRows(state) };
}

function upsert(state, patch) { let item = state.integration_statuses.find((entry) => entry.key === 'cc_switch'); if (!item) { item = { key: 'cc_switch', created_at: now() }; state.integration_statuses.push(item); } return Object.assign(item, patch); }
function basePath() { return path.join(AIWS_HOME, 'external', 'cc-switch'); }
