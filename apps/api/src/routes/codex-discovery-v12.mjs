import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { discoverLocalCodex, DiscoveryError, resolveDiscoveryImport } from '../codex-discovery-service.mjs';
import { validateProfileInput, writeProfileConfig } from '../codex-service.mjs';
import { publishCcSwitchCatalog } from '../cc-switch-service.mjs';
import { putSecret, removeSecret } from '../vault.mjs';
import { cleanupCodexAuthHomes, persistImportedDeviceAuth } from '../codex-device-auth.mjs';
import { id, now } from '../../../../packages/shared/index.mjs';

export const codexDiscoveryV12Routes = [
  makeRoute('GET', '/codex/discovery', async ({ res }) => send(res, 200, await discoverLocalCodex())),
  makeRoute('POST', '/codex/discovery/import', importDiscovery)
];

async function importDiscovery({ res, body }) {
  if (body.confirmed !== true) throw new HttpError(409, { error: 'discovery_import_confirmation_required' });
  let resolved;
  try { resolved = await resolveDiscoveryImport({ discoveryId: body.discovery_id, sourceRevision: body.source_revision }); }
  catch (error) { if (error instanceof DiscoveryError) throw new HttpError(error.status, { error: error.code }); throw error; }
  const suppliedKey = Object.hasOwn(body, 'api_key');
  if (resolved.descriptor.has_credential && suppliedKey) throw new HttpError(400, { error: 'discovered_credential_override_not_allowed' });
  if (!resolved.descriptor.has_credential && !validCredential(body.api_key)) throw new HttpError(400, { error: 'api_key_required' });
  const authBundle = String(resolved.auth_bundle || ''), credential = resolved.descriptor.has_credential ? resolved.credential : String(body.api_key).trim();
  if (!authBundle && !validCredential(credential)) throw new HttpError(409, { error: 'discovered_credential_unavailable' });

  const state = await readState();
  const reconfiguration = Boolean(state.setup_states[0]?.completed_at);
  if (reconfiguration && body.reconfigure !== true) throw new HttpError(409, { error: 'discovery_reconfiguration_required' });
  const profile = {
    id: id('cdxp'), kind: 'docker', name: String(body.profile_name || resolved.descriptor.name || resolved.descriptor.provider).trim().slice(0, 100),
    provider: resolved.descriptor.provider, provider_name: resolved.descriptor.provider_name,
    base_url: resolved.descriptor.base_url, wire_api: 'responses', requires_openai_auth: resolved.descriptor.requires_openai_auth === true,
    model: resolved.descriptor.model, reasoning: 'high', web_search: false, mcp_servers: [], timeout_ms: 120000, mounts: [],
    image: 'aiws-codex-runner:local', status: 'validated', is_active: true,
    discovery_source: { source_id: resolved.source.source_id, source_provider_id: resolved.source.source_provider_id, type: resolved.source.type, revision: resolved.source.revision },
    credential_configured: true, created_at: now(), updated_at: now()
  };
  const validation = validateProfileInput(state, profile);
  if (!validation.ok) throw new HttpError(400, { error: 'invalid_discovered_codex_profile', details: validation.errors });
  const ref = await putSecret(authBundle ? 'codex_local_auth_bundle' : `codex_discovery_${profile.provider}`, authBundle || credential);
  let changed, authHome = null;
  try {
    Object.assign(profile, discoveryBinding(profile, resolved.source));
    if (authBundle) authHome = await persistImportedDeviceAuth(authBundle, profile.id);
    Object.assign(profile, await writeProfileConfig(profile, authHome));
    changed = await mutate(async (data) => {
      const actor = owner(data), auth = upsertAuth(data);
      const previousRefs = Object.values(auth.refs || {}).filter(Boolean), previousHome = auth.home || null;
      const previousProfileHomes = data.codex_profiles.map((item) => item.codex_home).filter(Boolean);
      Object.assign(auth, { status: 'authenticated', provider: profile.provider, refs: authBundle ? { auth_bundle: ref } : { credential: ref }, home: authHome, base_url: profile.base_url, wire_api: 'responses', auth_mode: authBundle ? 'local_codex' : 'discovery', discovery_source: profile.discovery_source, updated_at: now() });
      data.codex_profiles.forEach((item) => { item.is_active = false; });
      profile.created_by_user_id = actor.id;
      data.codex_profiles.push(profile);
      data.integration_statuses.push({ key: 'codex_discovery_binding', profile_id: profile.id, status: 'synced', source_id: resolved.source.source_id, source_provider_id: resolved.source.source_provider_id, source_type: resolved.source.type, source_revision: resolved.source.revision, created_at: now(), updated_at: now() });
      for (const probe of data.integration_statuses.filter((item) => item.key === 'codex_probe')) probe.status = 'stale';
      data.setup_states.forEach((item) => { item.completed_at = null; item.updated_at = now(); });
      await publishCcSwitchCatalog(data);
      addTrace(data, 'codex.profile.created', { summary: `Imported local Codex provider: ${profile.provider}`, data: { source_type: resolved.source.type, profile_id: profile.id } }, actor.id);
      return { previousRefs, previousHome, previousProfileHomes };
    });
  } catch (error) { await removeSecret(ref); await cleanupCodexAuthHomes([authHome]); throw error; }
  await Promise.allSettled(changed.previousRefs.filter((item) => item !== ref).map(removeSecret));
  await cleanupCodexAuthHomes([
    ...(changed.previousHome && changed.previousHome !== authHome ? [changed.previousHome] : []),
    ...changed.previousProfileHomes
  ]);
  return send(res, 201, { profile, authenticated: true, source: resolved.source, reconfiguration_started: reconfiguration });
}

function discoveryBinding(_profile, source) { return { configuration_source: `discovery:${source.type}`, cc_switch_required: false, cc_switch_status: 'not_required', cc_switch_provider_id: null, cc_switch_synced_at: null, cc_switch_binding_type: null, cc_switch_discovery_revision: null, cc_switch_bridge_revision: null, cc_switch_source_commit: null }; }
function validCredential(value) { return typeof value === 'string' && value.trim().length >= 4 && value.length <= 65536 && !/[\r\n\0]/.test(value); }
function upsertAuth(state) { let item = state.integration_statuses.find((entry) => entry.key === 'codex_auth'); if (!item) { item = { key: 'codex_auth', created_at: now() }; state.integration_statuses.push(item); } return item; }
