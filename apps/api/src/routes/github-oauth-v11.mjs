import { makeRoute, send } from '../http.mjs';
import { readLocalGithubAppConfig } from '../config.mjs';
import { addTrace, mutate, owner } from '../state.mjs';
import { hashString, now } from '../../../../packages/shared/index.mjs';

export const githubOauthV11Routes = [
  makeRoute('POST', '/integrations/github/oauth/device/start', startDeviceFlow),
  makeRoute('POST', '/integrations/github/oauth/device/poll', pollDeviceFlow)
];

async function startDeviceFlow({ res, body }) {
  const clientId = githubClientId(body);
  if (!clientId && body.mock !== true) return send(res, 400, {
    error: 'configuration_required',
    message: '请先设置 GITHUB_OAUTH_CLIENT_ID，或在演示中传入 mock:true。'
  });
  if (clientId && body.mock !== true) {
    const real = await githubDeviceCode(clientId, body.scope || 'repo');
    return send(res, real.ok ? 200 : 502, real.payload);
  }
  const result = {
    device_code: `dev_${Date.now().toString(16)}`,
    user_code: body.mock_user_code || 'AIWS-2026',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
    mock: body.mock === true || !clientId
  };
  return send(res, 200, result);
}

async function pollDeviceFlow({ res, body }) {
  if (body.mock_status === 'pending') return send(res, 202, { error: 'authorization_pending', interval: 5 });
  if (body.mock_status === 'error') return send(res, 400, { error: body.error || 'access_denied' });
  const clientId = githubClientId(body);
  if (clientId && body.mock !== true && !body.access_token) {
    const polled = await githubPollToken(clientId, body.device_code);
    if (!polled.ok) return send(res, polled.status, polled.payload);
    body.access_token = polled.payload.access_token;
  }
  const result = await mutate((state) => {
    const actor = owner(state);
    const tokenValue = body.access_token || `mock-gh-oauth-${body.device_code || Date.now()}`;
    const credential = {
      id: `cred_oauth_${Date.now().toString(16)}`,
      owner_user_id: actor.id,
      kind: 'oauth_device',
      provider: 'github',
      ref_name: 'oauth:device-flow',
      encrypted_value: `sha256:${hashString(tokenValue)}`,
      scopes: body.scopes || ['repo'],
      created_at: now(),
      updated_at: now()
    };
    const account = {
      id: `acct_oauth_${Date.now().toString(16)}`,
      user_id: actor.id,
      provider: 'github',
      provider_account_id: body.login || 'github-device-user',
      login: body.login || 'github-device-user',
      display_name: body.display_name || body.login || 'GitHub Device User',
      avatar_url: body.avatar_url || '',
      profile_url: `https://github.com/${body.login || 'github-device-user'}`,
      credential_ref_id: credential.id,
      scopes: credential.scopes,
      permissions_summary: { repo: true, pull_requests: true, mode: 'oauth-device-flow' },
      status: 'connected',
      last_verified_at: now(),
      created_at: now(),
      updated_at: now()
    };
    state.credential_refs.push(credential);
    state.connected_accounts = state.connected_accounts.filter((item) => !(item.user_id === actor.id && item.provider === 'github'));
    state.connected_accounts.push(account);
    addTrace(state, 'human.reviewed', { summary: 'GitHub OAuth device flow 已完成绑定。', data: { login: account.login, credential_ref_id: credential.id } }, actor.id);
    return { connected: true, account, credential_ref: { ...credential, encrypted_value: '***MASKED***' } };
  });
  return send(res, 200, result);
}

function githubClientId(body = {}) {
  return process.env.GITHUB_OAUTH_CLIENT_ID || body.client_id || readLocalGithubAppConfig().oauth_client_id || '';
}

async function githubDeviceCode(clientId, scope) {
  try {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope })
    });
    return { ok: res.ok, payload: await res.json() };
  } catch (error) {
    return { ok: false, payload: { error: 'github_device_flow_unreachable', message: error.message } };
  }
}

async function githubPollToken(clientId, deviceCode) {
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    });
    const payload = await res.json();
    if (payload.error === 'authorization_pending') return { ok: false, status: 202, payload };
    return { ok: Boolean(payload.access_token), status: payload.access_token ? 200 : 400, payload };
  } catch (error) {
    return { ok: false, status: 502, payload: { error: 'github_poll_unreachable', message: error.message } };
  }
}
