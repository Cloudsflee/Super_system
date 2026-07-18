import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, makeRoute, send } from '../http.mjs';
import { CODEX_HOME_DIR } from '../config.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { CODEX_WIRE_APIS, codexAuthMatchesProfile, codexAuthProviderMatchesProfile, isThirdPartyProvider, normalizeProviderBaseUrl, probeCodex, validateProfileInput, writeProfileConfig } from '../codex-service.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { putSecret, removeSecret } from '../vault.mjs';
import { createChangeProposal, id, now } from '../../../../packages/shared/index.mjs';
import { ccSwitchBinding, ccSwitchStatus, publishCcSwitchCatalog, syncCcSwitch } from '../cc-switch-service.mjs';
import { cleanupCodexAuthHomes, extractDeviceAuthPublicState, persistDeviceAuth, readDeviceAuthBundle } from '../codex-device-auth.mjs';
import { inspectCodexRuntimeCached } from '../codex-runtime-status.mjs';
import { CODEX_PROBE_PHASES, classifyCodexExecution, completeCodexProbe, probeCheck, probeFailure } from '../codex-probe.mjs';
import { codexProbeEvidenceMatches, createCodexProbeEvidence } from '../codex-probe-evidence.mjs';
import { codexRuntimeV12Routes } from './codex-runtime-v12.mjs';
import { assertProfileAllowed, buildCodexContainerInvocation, DEFAULT_RUNNER_IMAGE } from '../container-runtime-config.mjs';
import { spawnContainerProcess } from '../container-runtime.mjs';

const authProcesses = new Map();

export const codexV12Routes = [
  ...codexRuntimeV12Routes,
  makeRoute('POST', '/codex/auth/device/start', deviceAuthStart),
  makeRoute('GET', '/codex/auth/device/:id/events', deviceAuthEvents),
  makeRoute('POST', '/codex/auth/device/:id/cancel', cancelDeviceAuth),
  makeRoute('POST', '/codex/auth/api-key', apiKeyAuth),
  makeRoute('POST', '/codex/auth/reset', resetAuth),
  makeRoute('GET', '/codex/profiles', listProfiles),
  makeRoute('POST', '/codex/profiles', createProfile),
  makeRoute('PUT', '/codex/profiles/:id', updateProfile),
  makeRoute('DELETE', '/codex/profiles/:id', deleteProfile),
  makeRoute('POST', '/codex/profiles/:id/validate', validateProfile),
  makeRoute('POST', '/codex/profiles/:id/propose-apply', proposeProfile),
  makeRoute('GET', '/codex/cc-switch/status', getCcSwitchStatus),
  makeRoute('POST', '/codex/cc-switch/sync', ccSwitchSync),
  makeRoute('POST', '/codex/cc-switch/import', ccSwitchImport),
  makeRoute('POST', '/codex/probe', runProbe)
];

async function deviceAuthStart({ res, body, query }) {
  if (testAdapter(body, query)) { const status = await markAuthenticated('chatgpt', null, null, { auth_mode: 'device' }); return send(res, 200, status); }
  const requestId = id('cdxauth'), home = path.join(CODEX_HOME_DIR, `device-${requestId}`);
  await fsp.mkdir(home, { recursive: true });
  const record = { id: requestId, status: 'running', public: { status: 'running' }, privateText: '', home };
  const invocation = buildCodexContainerInvocation({
    kind: 'device-login', sessionId: requestId, stdin: true, codexHome: home,
    containerEnv: { CODEX_HOME: '/codex-home' }, commandArgs: ['login', '--device-auth']
  });
  const child = spawnContainerProcess(invocation, { env: process.env });
  authProcesses.set(requestId, { child, record });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { record.privateText = `${record.privateText}${chunk}`.slice(-8192); record.public = extractDeviceAuthPublicState(record.privateText, record.public); });
  child.on('error', () => { record.status = 'failed'; record.public.status = 'failed'; });
  child.on('close', async (code) => { if (record.status !== 'cancelled') { record.status = code === 0 ? 'completed' : 'failed'; if (code === 0) { let bundleRef; try { const authHome = await persistDeviceAuth(home); bundleRef = await putSecret('codex_device_auth_bundle', await readDeviceAuthBundle(authHome)); await markAuthenticated('chatgpt', null, authHome, { auth_bundle_ref: bundleRef, auth_mode: 'device' }); } catch { await removeSecret(bundleRef); record.status = 'failed'; } } } record.public.status = record.status; record.privateText = ''; await cleanupCodexAuthHomes([home]); setTimeout(() => authProcesses.delete(requestId), 300000); });
  return send(res, 202, { request_id: requestId, status: record.status, events_url: `/codex/auth/device/${requestId}/events`, cancel_url: `/codex/auth/device/${requestId}/cancel` });
}

async function deviceAuthEvents({ req, res, params }) {
  const process = authProcesses.get(params.id);
  if (!process) throw new HttpError(404, { error: 'codex_auth_request_not_found' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let previous = '';
  await new Promise((resolve) => { const timer = setInterval(() => { const payload = JSON.stringify(process.record.public); if (payload !== previous) { previous = payload; res.write(`event: auth\ndata: ${payload}\n\n`); } if (process.record.status !== 'running') { res.write(`event: done\ndata: ${JSON.stringify({ status: process.record.status })}\n\n`); clearInterval(timer); authProcesses.delete(params.id); res.end(); resolve(); } }, 250); req.on('close', () => { clearInterval(timer); resolve(); }); });
}

async function cancelDeviceAuth({ res, params }) { const process = authProcesses.get(params.id); if (!process) throw new HttpError(404, { error: 'codex_auth_request_not_found' }); if (process.record.status !== 'running') throw new HttpError(409, { error: 'codex_auth_request_not_running' }); process.record.status = 'cancelled'; process.record.public.status = 'cancelled'; process.child.kill(); await cleanupCodexAuthHomes([process.record.home]); setTimeout(() => authProcesses.delete(params.id), 300000); return send(res, 202, { request_id: params.id, status: 'cancelled' }); }

async function apiKeyAuth({ res, body }) {
  const provider = String(body.provider || '').trim().toLowerCase();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(provider)) throw new HttpError(400, { error: 'invalid_provider' });
  const rawBaseUrl = body.base_url ?? body.api_url ?? body.provider_url;
  const baseUrl = normalizeProviderBaseUrl(rawBaseUrl);
  if (isThirdPartyProvider(provider) && !String(rawBaseUrl || '').trim()) throw new HttpError(400, { error: 'base_url_required' });
  if (String(rawBaseUrl || '').trim() && !baseUrl) throw new HttpError(400, { error: 'invalid_base_url' });
  const wireApi = body.wire_api || 'responses';
  if (!CODEX_WIRE_APIS.includes(wireApi)) throw new HttpError(400, { error: 'unsupported_wire_api', supported: CODEX_WIRE_APIS, detail: 'Chat Completions requires a separately managed cc-switch local proxy; this bridge writes Codex-native Responses configuration only.' });
  const state = await readState();
  const current = state.integration_statuses.find((item) => item.key === 'codex_auth');
  const canReuse = !body.api_key && current?.status === 'authenticated' && current?.refs?.credential && String(current.provider || '').toLowerCase() === provider;
  if (!body.api_key && !canReuse) throw new HttpError(400, { error: 'api_key_required' });
  const ref = body.api_key ? await putSecret(`codex_${provider}`, body.api_key) : current.refs.credential;
  try { return send(res, 200, await markAuthenticated(provider, ref, null, { base_url: baseUrl, wire_api: wireApi, auth_mode: 'api_key' })); }
  catch (error) { if (body.api_key) await removeSecret(ref); throw error; }
}

async function resetAuth({ res, body }) {
  await requireConfigurationConfirmation(body);
  const previous = await mutate((state) => {
    const actor = owner(state), auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
    const refs = Object.values(auth?.refs || {}).filter(Boolean);
    if (auth) Object.assign(auth, { status: 'configuration_required', refs: {}, home: null, updated_at: now() });
    for (const probe of state.integration_statuses.filter((item) => item.key === 'codex_probe')) probe.status = 'stale';
    state.setup_states.forEach((item) => { item.completed_at = null; item.updated_at = now(); });
    addTrace(state, 'human.reviewed', { summary: 'Codex 凭据已清除，等待重新认证。' }, actor.id);
    return { refs, homes: [auth?.home, ...state.codex_profiles.map((item) => item.codex_home)].filter(Boolean) };
  });
  await Promise.allSettled(previous.refs.map(removeSecret));
  await cleanupCodexAuthHomes(previous.homes);
  return send(res, 200, { authenticated: false });
}

async function listProfiles({ res }) { return send(res, 200, (await readState()).codex_profiles); }

async function createProfile({ res, body }) {
  const state = await readState(), validation = validateProfileInput(state, body);
  if (state.setup_states[0]?.completed_at && body.confirmed !== true) throw new HttpError(409, { error: 'configuration_confirmation_required' });
  if (!validation.ok) throw new HttpError(400, { error: 'invalid_codex_profile', details: validation.errors });
  const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  if (auth?.status !== 'authenticated') throw new HttpError(409, { error: 'codex_auth_required' });
  const initialSetup = !state.setup_states[0]?.completed_at;
  const profile = { id: id('cdxp'), kind: 'docker', ...profilePatch(body), image: DEFAULT_RUNNER_IMAGE, status: 'validated', is_active: initialSetup, created_at: now(), updated_at: now() };
  assertProfileAuth(auth, profile);
  const ccSwitch = state.integration_statuses.find((item) => item.key === 'cc_switch');
  Object.assign(profile, ccSwitchBinding(profile, ccSwitch));
  Object.assign(profile, await writeProfileConfig(profile, auth.home));
  const result = await mutate(async (data) => { const actor = owner(data); if (initialSetup) data.codex_profiles.forEach((item) => { item.is_active = false; }); profile.created_by_user_id = actor.id; data.codex_profiles.push(profile); await publishCcSwitchCatalog(data); addTrace(data, 'codex.profile.created', { summary: `Codex profile: ${profile.name}` }, actor.id); return profile; });
  return send(res, 201, result);
}

async function updateProfile({ res, params, body }) { const state = await readState(), current = state.codex_profiles.find((item) => item.id === params.id); if (!current) throw new HttpError(404, { error: 'profile_not_found' }); const auth = state.integration_statuses.find((item) => item.key === 'codex_auth'); const legacyRepair = current.status === 'configuration_required' || !codexAuthMatchesProfile(auth, current) || (isThirdPartyProvider(current.provider) && !normalizeProviderBaseUrl(current.base_url)); if (state.setup_states[0]?.completed_at && !legacyRepair) throw new HttpError(409, { error: 'profile_change_proposal_required' }); const merged = { ...current, ...body }; const validation = validateProfileInput(state, merged); if (!validation.ok) throw new HttpError(400, { error: 'invalid_codex_profile', details: validation.errors }); const patch = profilePatch(merged); assertProfileAuth(auth, patch); const ccSwitch = state.integration_statuses.find((item) => item.key === 'cc_switch'); const result = await mutate(async (data) => { const profile = data.codex_profiles.find((item) => item.id === params.id); Object.assign(profile, patch, ccSwitchBinding(patch, ccSwitch), { status: 'validated', updated_at: now() }); Object.assign(profile, await writeProfileConfig(profile, auth?.home)); for (const probe of data.integration_statuses.filter((item) => item.key === 'codex_probe' && item.profile_id === profile.id)) probe.status = 'stale'; data.setup_states.forEach((item) => { item.completed_at = null; item.updated_at = now(); }); await publishCcSwitchCatalog(data); return profile; }); return send(res, 200, result); }
async function deleteProfile({ res, params }) { const result = await mutate(async (state) => { const profile = state.codex_profiles.find((item) => item.id === params.id); if (!profile) throw new HttpError(404, { error: 'profile_not_found' }); if (state.setup_states[0]?.completed_at) throw new HttpError(409, { error: 'profile_change_proposal_required' }); if (profile.is_active) throw new HttpError(409, { error: 'active_profile_cannot_be_deleted' }); state.codex_profiles = state.codex_profiles.filter((item) => item.id !== params.id); await publishCcSwitchCatalog(state); return profile; }); const profileHome = path.resolve(result.codex_home || path.join(CODEX_HOME_DIR, result.id)); if (path.dirname(profileHome) === path.resolve(CODEX_HOME_DIR)) await fsp.rm(profileHome, { recursive: true, force: true }); return send(res, 200, result); }
async function validateProfile({ res, params }) { const state = await readState(), profile = state.codex_profiles.find((item) => item.id === params.id); if (!profile) throw new HttpError(404, { error: 'profile_not_found' }); const validation = validateProfileInput(state, profile); return send(res, validation.ok ? 200 : 400, validation); }

async function proposeProfile({ res, params }) { const result = await mutate((state) => { const actor = owner(state), profile = state.codex_profiles.find((item) => item.id === params.id); if (!profile) throw new HttpError(404, { error: 'profile_not_found' }); try { assertProfileAllowed(profile); } catch (error) { throw new HttpError(409, { error: error.message }); } if (profile.status !== 'validated') throw new HttpError(409, { error: 'validated_profile_required' }); const auth = state.integration_statuses.find((item) => item.key === 'codex_auth'); assertProfileAuth(auth, profile); const probe = state.integration_statuses.find((item) => item.key === 'codex_probe' && item.profile_id === profile.id && item.status === 'ready'); if (!probe) throw new HttpError(409, { error: 'profile_probe_required' }); const proposal = createChangeProposal({ projectId: null, changeType: 'codex_profile_apply', title: `切换 Codex Profile：${profile.name}`, summary: '影响后续 Assist 与 NodeRun', before: state.codex_profiles.find((item) => item.is_active), after: profile, risks: ['模型与 Provider 行为可能变化'], applyAction: { type: 'codex_profile_apply', profile_id: profile.id }, actorId: actor.id }); state.change_proposals.push(proposal); addTrace(state, 'change_proposal.created', { target_id: proposal.id, summary: proposal.title }, actor.id); return proposal; }); return send(res, 201, result); }

async function getCcSwitchStatus({ res }) { return send(res, 200, await ccSwitchStatus()); }
async function ccSwitchSync({ res, body, query }) { await requireConfigurationConfirmation(body); return send(res, 200, await syncCcSwitch({ adapted: testAdapter(body, query) })); }
async function ccSwitchImport({ res, body }) {
  if (body.source !== 'cc_switch_catalog' || !body.entry || typeof body.entry !== 'object' || Array.isArray(body.entry)) throw new HttpError(400, { error: 'cc_switch_catalog_entry_required' });
  if (containsSensitiveProviderField(body.entry)) throw new HttpError(400, { error: 'cc_switch_catalog_must_not_contain_secret' });
  if ((body.entry.mounts && (!Array.isArray(body.entry.mounts) || body.entry.mounts.length)) || (body.entry.mcp_servers && (!Array.isArray(body.entry.mcp_servers) || body.entry.mcp_servers.length))) throw new HttpError(400, { error: 'cc_switch_catalog_runtime_fields_not_allowed' });
  const allowedFields = new Set(['provider', 'provider_id', 'name', 'provider_name', 'base_url', 'wire_api', 'model', 'reasoning', 'web_search', 'timeout_ms', 'mounts', 'mcp_servers']);
  const unsupportedFields = Object.keys(body.entry).filter((key) => !allowedFields.has(key));
  if (unsupportedFields.length) throw new HttpError(400, { error: 'unsupported_cc_switch_catalog_field', fields: unsupportedFields });
  const status = await ccSwitchStatus();
  if (status.status !== 'synced' || status.bridge?.ready !== true) throw new HttpError(409, { error: 'cc_switch_bridge_not_ready' });
  const entry = body.entry;
  const provider = String(entry.provider || entry.provider_id || '').trim().toLowerCase();
  if (!provider || !entry.model || !entry.base_url) throw new HttpError(400, { error: 'invalid_cc_switch_catalog_entry' });
  if (!isThirdPartyProvider(provider)) throw new HttpError(400, { error: 'cc_switch_catalog_third_party_only' });
  return createProfile({ res, body: { name: entry.name || `${provider} (cc-switch)`, provider, provider_name: entry.provider_name || entry.name || provider, base_url: entry.base_url, wire_api: entry.wire_api || 'responses', requires_openai_auth: false, model: entry.model, reasoning: entry.reasoning || 'high', web_search: entry.web_search === true, timeout_ms: entry.timeout_ms || 120000, mounts: [], mcp_servers: [], confirmed: body.confirmed === true } });
}

async function runProbe({ res, body, query }) {
  const state = await readState();
  const profile = state.codex_profiles.find((item) => item.id === body.profile_id && item.status === 'validated')
    || (!body.profile_id && state.codex_profiles.find((item) => item.is_active && item.status === 'validated'));
  if (!profile) throw new HttpError(404, { error: 'validated_profile_not_found' });
  const adapted = testAdapter(body, query);
  let result, runtime = null, startedEvidence = null;
  if (adapted) result = adaptedProbeResult(body.test_result);
  else {
    runtime = await inspectCodexRuntimeCached({ image: profile.image || undefined, maxAgeMs: 1000 });
    const auth = state.integration_statuses.find((item) => item.key === 'codex_auth');
    startedEvidence = createCodexProbeEvidence({ profile, auth, runtime });
    result = await probeCodex(state, profile, runtime);
  }
  const status = await mutate((data) => {
    const actor = owner(data);
    let evidence = null;
    if (result.ok && !adapted) {
      const currentProfile = data.codex_profiles.find((item) => item.id === profile.id);
      const currentAuth = data.integration_statuses.find((item) => item.key === 'codex_auth');
      evidence = createCodexProbeEvidence({ profile: currentProfile, auth: currentAuth, runtime });
      if (!codexProbeEvidenceMatches(startedEvidence, evidence)) {
        result = failedProbeResult(probeFailure('codex_probe_configuration_changed'));
        evidence = null;
      }
    }
    const item = upsertProbe(data, profile.id, { status: result.ok ? 'ready' : 'failed', detail: result, evidence, updated_at: now() });
    addTrace(data, 'codex.probe.completed', { summary: `Codex probe: ${item.status}`, data: { ok: result.ok, phase: result.phase, error_code: result.error_code || null } }, actor.id);
    return item;
  });
  if (!result.ok) throw new HttpError(409, {
    error: result.error_code,
    message: result.summary,
    action: result.action,
    phase: result.phase,
    retryable: result.retryable,
    probe: result
  });
  return send(res, 200, status);
}

async function markAuthenticated(provider, ref, home, metadata = {}) {
  const changed = await mutate((state) => {
    const actor = owner(state), current = state.integration_statuses.find((item) => item.key === 'codex_auth');
    const previousRefs = Object.values(current?.refs || {}).filter(Boolean);
    const previousHome = current?.home || null;
    const profileHomes = state.codex_profiles.map((item) => item.codex_home).filter(Boolean);
    const refs = ref ? { credential: ref } : metadata.auth_bundle_ref ? { auth_bundle: metadata.auth_bundle_ref } : {};
    const item = upsert(state, 'codex_auth', { status: 'authenticated', provider, refs, home, base_url: metadata.base_url || null, wire_api: metadata.wire_api || 'responses', auth_mode: metadata.auth_mode || (home ? 'device' : 'api_key'), updated_at: now() });
    for (const probe of state.integration_statuses.filter((entry) => entry.key === 'codex_probe')) probe.status = 'stale';
    state.setup_states.forEach((entry) => { entry.completed_at = null; entry.updated_at = now(); });
    addTrace(state, 'codex.authenticated', { summary: `Codex auth: ${provider}` }, actor.id);
    return { previousRefs, previousHome, profileHomes, response: { authenticated: true, provider, base_url: item.base_url, wire_api: item.wire_api, auth_mode: item.auth_mode, status: item.status } };
  });
  const retained = new Set([ref, metadata.auth_bundle_ref].filter(Boolean));
  await Promise.allSettled(changed.previousRefs.filter((item) => !retained.has(item)).map(removeSecret));
  await cleanupCodexAuthHomes([
    ...(changed.previousHome && changed.previousHome !== home ? [changed.previousHome] : []),
    ...changed.profileHomes
  ]);
  return changed.response;
}
function upsert(state, key, patch) { let item = state.integration_statuses.find((entry) => entry.key === key); if (!item) { item = { key, created_at: now() }; state.integration_statuses.push(item); } return Object.assign(item, patch, { key }); }
function upsertProbe(state, profileId, patch) { let item = state.integration_statuses.find((entry) => entry.key === 'codex_probe' && entry.profile_id === profileId); if (!item) { item = { key: 'codex_probe', profile_id: profileId, created_at: now() }; state.integration_statuses.push(item); } return Object.assign(item, patch, { key: 'codex_probe', profile_id: profileId }); }
function profilePatch(body) { const provider = String(body.provider || '').trim().toLowerCase(); const baseUrl = normalizeProviderBaseUrl(body.base_url ?? body.api_url ?? body.provider_url); return { name: String(body.name || '').trim().slice(0, 100), provider, provider_name: String(body.provider_name || provider).trim().slice(0, 100), base_url: baseUrl, wire_api: body.wire_api || 'responses', requires_openai_auth: body.requires_openai_auth === true, model: String(body.model || '').trim(), reasoning: body.reasoning || 'high', web_search: body.web_search === true, mcp_servers: body.mcp_servers || [], timeout_ms: Number(body.timeout_ms || 120000), mounts: body.mounts || [] }; }
async function requireConfigurationConfirmation(body = {}) { const state = await readState(); if (state.setup_states[0]?.completed_at && body.confirmed !== true) throw new HttpError(409, { error: 'configuration_confirmation_required' }); }
function assertProfileAuth(auth, profile) { if (!codexAuthProviderMatchesProfile(auth, profile)) throw new HttpError(409, { error: 'codex_auth_provider_mismatch' }); if (!codexAuthMatchesProfile(auth, profile)) throw new HttpError(409, { error: 'codex_auth_endpoint_mismatch' }); }
function containsSensitiveProviderField(value) { if (!value || typeof value !== 'object') return false; return Object.entries(value).some(([key, item]) => /^(?:api_key|access_token|bearer_token|experimental_bearer_token|auth|secret|client_secret|credential|credential_ref|token)$/i.test(key) || (item && typeof item === 'object' && containsSensitiveProviderField(item))); }
function adaptedProbeResult(value) {
  if (!value || value.ok === true) return { ok: true, phase: 'inference', summary: 'Codex 非写入探针已通过', checks: CODEX_PROBE_PHASES.map((phase) => probeCheck(phase)), process: { exit_code: 0, timed_out: false } };
  const diagnostic = `${value.diagnostic || ''}\n${value.process?.stderr || ''}\n${value.process?.stdout || ''}`;
  const failure = value.error_code ? probeFailure(value.error_code, { process: value.process }) : classifyCodexExecution(value.process || { ok: false, code: 1 }, { diagnostic });
  return failedProbeResult(failure);
}
function failedProbeResult(failure) { return completeCodexProbe({ ok: true, checks: [] }, failure); }
