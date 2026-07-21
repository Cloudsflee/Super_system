import { createHash, randomBytes } from 'node:crypto';
import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { computeSetupStatus } from '../setup-status.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { putSecret, readSecret, removeSecret } from '../vault.mjs';
import { connectedGithubAccount, githubJson, resolveGithubAppConfig, verifyApp } from '../github-service.mjs';
import { id, now } from '../../../../packages/shared/index.mjs';
import { readLocalGithubAppConfig } from '../config.mjs';
import { accessibleProjectIds, actorForRequest, instanceOwnerId, requireInstanceOwner } from '../project-governance-v19.mjs';
import { revokeRepositoryInstallationBindingsInState } from '../repository-lifecycle-v19.mjs';

export const githubConfigV12Routes = [
  makeRoute('GET', '/github/status', githubStatus),
  makeRoute('GET', '/github/app-config/defaults', appConfigDefaults),
  makeRoute('POST', '/github/app-config/validate', saveAppConfig),
  makeRoute('POST', '/github/app-config/manual', saveAppConfig),
  makeRoute('POST', '/github/manifest/start', manifestStart),
  makeRoute('POST', '/github/manifest/callback', manifestCallback),
  makeRoute('POST', '/github/device/start', deviceStart),
  makeRoute('POST', '/github/device/poll', devicePoll),
  makeRoute('POST', '/github/app-config/reset', resetAppConfig),
  makeRoute('POST', '/github/disconnect', disconnect)
];

async function appConfigDefaults({ res }) {
  const config = readLocalGithubAppConfig();
  return send(res, 200, { app_id: String(config.app_id || ''), client_id: String(config.oauth_client_id || config.client_id || ''), app_name: String(config.app_name || '') });
}

async function githubStatus({ req, res }) {
  const state = await readState(), actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  const account = connectedGithubAccount(state, actor?.id), allowed = accessibleProjectIds(state, actor?.id);
  const tokenProjects = new Set(req.auth?.extra?.project_allowlist || []); if (tokenProjects.size) for (const projectId of [...allowed]) if (!tokenProjects.has(projectId)) allowed.delete(projectId);
  const remoteIds = new Set(state.project_repository_bindings.filter((item) => allowed.has(item.project_id) && item.status !== 'removed').map((item) => state.canonical_repositories.find((repo) => repo.id === item.canonical_repository_id)?.repository_id).filter(Boolean));
  const unrestrictedOwner = actor?.id === instanceOwnerId(state) && !tokenProjects.size;
  const installations = state.github_installations.filter((item) => item.status === 'active').map((item) => unrestrictedOwner ? item : { ...item, repositories: (item.repositories || []).filter((repo) => remoteIds.has(String(repo.id))) }).filter((item) => unrestrictedOwner || item.repositories.length);
  return send(res, 200, { connected: Boolean(account), login: account?.login, installation_count: installations.length, repository_count: installations.flatMap((item) => item.repositories || []).length, setup: computeSetupStatus(state).steps.github });
}

async function saveAppConfig({ req, res, body, query }) {
  if (req) assertGithubOwner(await readState(), req);
  await requireConfigurationConfirmation(body);
  requireFields(body, ['app_id', 'client_id', 'client_secret', 'private_key', 'webhook_secret']);
  const config = { id: id('ghapp'), mode: 'byo', app_id: String(body.app_id), client_id: body.client_id, slug: body.slug || '', status: 'pending', refs: {}, created_at: now(), updated_at: now() };
  config.refs = { client: await putSecret('github_client', body.client_secret), private_key: await putSecret('github_private_key', body.private_key), webhook: await putSecret('github_webhook', body.webhook_secret) };
  try {
    const verified = testAdapter(body, query) ? { id: body.app_id, slug: body.slug || 'aiws-test-app' } : await verifyApp(config);
    Object.assign(config, { status: 'validated', slug: verified.slug || config.slug, verified_at: now() });
  } catch (error) { await Promise.all(Object.values(config.refs).map(removeSecret)); throw new HttpError(400, { error: 'github_app_validation_failed', message: error.message }); }
  const previousRefs = await mutate((state) => {
    const actor = owner(state);
    const refs = [...state.github_app_configs.flatMap((item) => Object.values(item.refs || {})), ...state.connected_accounts.filter((item) => item.provider === 'github').map((item) => item.credential_ref)].filter(Boolean);
    state.github_app_configs = [config];
    state.connected_accounts = state.connected_accounts.filter((item) => item.provider !== 'github');
    revokeRepositoryInstallationBindingsInState(state, null, null, { reason: 'github_app_reconfigured' });
    state.github_installations = [];
    state.repository_bindings = [];
    state.setup_states.forEach((item) => { item.completed_at = null; item.updated_at = now(); });
    addTrace(state, 'github.app.configured', { summary: `GitHub App ${config.app_id} 已验证，Owner 授权需要重新确认。` }, actor.id);
    return refs;
  });
  await Promise.all(previousRefs.filter((ref) => !Object.values(config.refs).includes(ref)).map(removeSecret));
  const result = publicConfig(config);
  return send(res, 200, result);
}

async function manifestStart({ req, res }) {
  assertGithubOwner(await readState(), req);
  const state = randomBytes(18).toString('hex');
  const baseUrl = publicBaseUrl();
  const webhookActive = !isLoopback(baseUrl);
  const manifest = { name: 'AI Workspace', url: baseUrl, hook_attributes: { url: `${baseUrl}/api/github/webhook`, active: webhookActive }, redirect_url: `${baseUrl}/setup`, setup_url: `${baseUrl}/integrations/github/install/setup`, setup_on_update: true, public: true, default_permissions: { administration: 'write', checks: 'read', contents: 'write', pull_requests: 'write', metadata: 'read' }, default_events: webhookActive ? ['installation', 'installation_repositories', 'push', 'pull_request'] : [] };
  await mutate((data) => { upsert(data, 'github_manifest', { status: 'pending', state_hash: hash(state), updated_at: now() }); });
  return send(res, 200, { state, manifest, manifest_url: `https://github.com/settings/apps/new?state=${state}&manifest=${encodeURIComponent(JSON.stringify(manifest))}` });
}

async function manifestCallback({ res, body, query }) {
  const adapted = testAdapter(body, query);
  const suppliedState = body.state || query.state;
  if (!suppliedState) throw new HttpError(400, { error: 'manifest_state_required' });
  if (!adapted && !body.code) throw new HttpError(400, { error: 'manifest_code_required' });
  await mutate((data) => {
    const request = data.integration_statuses.find((item) => item.key === 'github_manifest');
    if (!request || request.state_hash !== hash(suppliedState)) throw new HttpError(400, { error: 'manifest_state_mismatch' });
    if (request.status !== 'pending') throw new HttpError(409, { error: 'manifest_callback_already_used' });
    Object.assign(request, { status: 'consumed', consumed_at: now(), updated_at: now() });
  });
  const converted = adapted ? { id: 101, client_id: 'Iv1.test', client_secret: 'test-client', pem: 'test-pem', webhook_secret: 'test-hook', slug: 'aiws-test' }
    : await githubJson(`https://api.github.com/app-manifests/${encodeURIComponent(body.code)}/conversions`, { method: 'POST' });
  return saveAppConfig({ res, body: { app_id: converted.id, client_id: converted.client_id, client_secret: converted.client_secret, private_key: converted.pem, webhook_secret: converted.webhook_secret, slug: converted.slug, adapter: body.adapter, confirmed: true }, query });
}

async function deviceStart({ req, res, body, query }) {
  const state = await readState(), actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  const config = resolveGithubAppConfig(state);
  const clientId = config?.client_id;
  if (!clientId && !testAdapter(body, query)) throw new HttpError(400, { error: 'github_client_id_required' });
  const response = testAdapter(body, query) ? { device_code: 'test-device-code', user_code: 'AIWS-2026', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }
    : await githubJson('https://github.com/login/device/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId }) });
  const requestId = id('ghdev'), ref = await putSecret('github_device', response.device_code);
  const expiresIn = Math.max(1, Number(response.expires_in || 900)), interval = Math.max(1, Number(response.interval || 5));
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  await mutate((data) => { upsert(data, `github_device:${requestId}`, { status: 'pending', client_id: clientId, requested_by_user_id: actor.id, refs: { device: ref }, interval, expires_at: expiresAt, next_poll_at: now(), updated_at: now() }); });
  return send(res, 200, {
    status: 'authorization_required', request_id: requestId, user_code: response.user_code,
    verification_uri: response.verification_uri, expires_in: expiresIn, expires_at: expiresAt, interval,
    action_required: { type: 'github_device_authorization', verification_uri: response.verification_uri, user_code: response.user_code, expires_at: expiresAt },
    next: { operation_id: 'aiws.github.post.github.device.poll', arguments: { body: { request_id: requestId } }, poll_after_seconds: interval }
  });
}

async function devicePoll({ req, res, body, query }) {
  const state = await readState(), actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }), request = state.integration_statuses.find((item) => item.key === `github_device:${body.request_id}`);
  if (!request) throw new HttpError(404, { error: 'device_request_not_found' });
  if (request.requested_by_user_id && request.requested_by_user_id !== actor.id) throw new HttpError(403, { error: 'github_device_request_actor_mismatch' });
  if (request.status !== 'pending') throw new HttpError(409, { error: 'device_request_not_pending', status: request.status });
  if (Date.parse(request.expires_at) <= Date.now()) return finishDeviceError(res, request, 'expired_token');
  const adapted = testAdapter(body, query);
  if (!adapted && Date.parse(request.next_poll_at || 0) > Date.now()) throw new HttpError(429, { error: 'device_poll_too_fast', retry_after: request.interval });
  const response = adapted ? adapterDeviceResponse(body) 
    : await githubJson('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: request.client_id, device_code: await readSecret(request.refs.device), grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
  if (response.error) return finishDeviceError(res, request, response.error, response.error_description);
  if (!response.access_token) throw new HttpError(502, { error: 'github_device_token_missing' });
  const user = adapted ? { id: body.test_github_user_id || 1, login: body.test_github_login || 'aiws-owner', name: body.test_github_name || 'AIWS Owner' } : await githubJson('https://api.github.com/user', { headers: { authorization: `Bearer ${response.access_token}` } });
  const ref = await putSecret('github_oauth', response.access_token);
  let changed;
  try {
    changed = await mutate((data) => {
      const current = data.integration_statuses.find((item) => item.key === request.key);
      if (!current || current.status !== 'pending') throw new HttpError(409, { error: 'device_request_not_pending', status: current?.status });
      return connectAccount(data, user, ref, current, actor.id);
    });
  } catch (error) { await removeSecret(ref); throw error; }
  await removeSecret(request.refs.device);
  await removeSecret(changed.previous_ref);
  return send(res, 200, changed.response);
}

async function finishDeviceError(res, source, error, message = '') {
  const pending = ['authorization_pending', 'slow_down'].includes(error);
  const terminal = !pending;
  const result = await mutate((state) => {
    const request = state.integration_statuses.find((item) => item.key === source.key);
    if (!request) throw new HttpError(404, { error: 'device_request_not_found' });
    if (error === 'slow_down') request.interval = Math.min(60, Number(request.interval || 5) + 5);
    Object.assign(request, { status: pending ? 'pending' : error === 'expired_token' ? 'expired' : 'failed', error, error_description: message || null, next_poll_at: new Date(Date.now() + Number(request.interval || 5) * 1000).toISOString(), updated_at: now() });
    return { interval: request.interval, expires_at: request.expires_at };
  });
  if (terminal) await removeSecret(source.refs?.device);
  const status = pending ? 202 : error === 'expired_token' ? 410 : error === 'access_denied' ? 403 : 400;
  return send(res, status, { error, message, ...result });
}

async function disconnect({ req, res, body }) {
  assertGithubOwner(await readState(), req);
  await requireConfigurationConfirmation(body);
  const refs = await mutate((state) => { const actor = owner(state), values = state.connected_accounts.filter((item) => item.provider === 'github').map((item) => item.credential_ref).filter(Boolean); state.connected_accounts = state.connected_accounts.filter((item) => item.provider !== 'github'); revokeRepositoryInstallationBindingsInState(state, null, null, { reason: 'github_disconnected' }); state.github_installations = []; state.repository_bindings = []; state.setup_states.forEach((item) => { item.completed_at = null; }); addTrace(state, 'human.reviewed', { summary: 'GitHub 已断开。' }, actor.id); return values; });
  await Promise.all(refs.map(removeSecret));
  return send(res, 200, { connected: false });
}

async function resetAppConfig({ req, res, body }) {
  assertGithubOwner(await readState(), req);
  await requireConfigurationConfirmation(body);
  const refs = await mutate((state) => {
    if (state.setup_states[0]?.mode === 'hosted') throw new HttpError(409, { error: 'hosted_github_app_managed_by_provider' });
    const actor = owner(state);
    const values = [...state.github_app_configs.flatMap((item) => Object.values(item.refs || {})), ...state.connected_accounts.filter((item) => item.provider === 'github').map((item) => item.credential_ref)].filter(Boolean);
    state.github_app_configs = []; state.connected_accounts = state.connected_accounts.filter((item) => item.provider !== 'github');
    revokeRepositoryInstallationBindingsInState(state, null, null, { reason: 'github_app_reset' });
    state.github_installations = []; state.repository_bindings = [];
    state.setup_states.forEach((item) => { item.completed_at = null; item.updated_at = now(); });
    addTrace(state, 'human.reviewed', { summary: 'GitHub App 本地配置已清除，等待重新配置。' }, actor.id);
    return values;
  });
  await Promise.all(refs.map(removeSecret));
  return send(res, 200, { configured: false });
}

function connectAccount(state, user, ref, request, actorId) { const actor = state.users.find((item) => item.id === actorId) || owner(state); const conflict = state.connected_accounts.find((item) => item.provider === 'github' && item.status === 'connected' && item.user_id !== actor.id && String(item.provider_account_id) === String(user.id)); if (conflict) throw new HttpError(409, { error: 'github_identity_already_linked' }); const previous = state.connected_accounts.find((item) => item.provider === 'github' && item.user_id === actor.id)?.credential_ref || null; const account = { id: id('acct'), user_id: actor.id, provider: 'github', provider_account_id: String(user.id), login: user.login, display_name: user.name || user.login, credential_ref: ref, status: 'connected', scopes: ['repo'], last_verified_at: now(), created_at: now(), updated_at: now() }; state.connected_accounts = state.connected_accounts.filter((item) => item.provider !== 'github' || item.user_id !== actor.id); state.connected_accounts.push(account); Object.assign(request, { status: 'completed', completed_at: now(), completed_by_user_id: actor.id, updated_at: now() }); addTrace(state, 'github.account.connected', { summary: `GitHub identity connected: ${account.login}` }, actor.id); return { previous_ref: previous, response: { connected: true, account: { ...account, credential_ref: '***MASKED***' } } }; }
function adapterDeviceResponse(body) { if (body.test_response && typeof body.test_response === 'object') return body.test_response; if (body.test_status && body.test_status !== 'success') return { error: body.test_status, error_description: `test ${body.test_status}` }; return { access_token: 'test-access-token', token_type: 'bearer', scope: 'repo' }; }
function publicConfig(config) { return { ...config, refs: { client: '***MASKED***', private_key: '***MASKED***', webhook: '***MASKED***' } }; }
function requireFields(body, names) { const missing = names.filter((name) => !body[name]); if (missing.length) throw new HttpError(400, { error: 'missing_fields', fields: missing }); }
function upsert(state, key, patch) { let item = state.integration_statuses.find((entry) => entry.key === key); if (!item) { item = { key, created_at: now() }; state.integration_statuses.push(item); } return Object.assign(item, patch, { key }); }
function hash(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }
function publicBaseUrl() { return String(process.env.AIWS_PUBLIC_BASE_URL || 'http://localhost:4317').replace(/\/$/, ''); }
function isLoopback(value) { try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname); } catch { throw new HttpError(500, { error: 'invalid_public_base_url' }); } }
async function requireConfigurationConfirmation(body = {}) { const state = await readState(); if (state.setup_states[0]?.completed_at && body.confirmed !== true) throw new HttpError(409, { error: 'configuration_confirmation_required' }); }
function assertGithubOwner(state, req) { const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }); return requireInstanceOwner(state, actor?.id); }
