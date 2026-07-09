import { send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { resolveToken } from '../helpers.mjs';
import { hashString, now } from '../../../../packages/shared/index.mjs';

export function githubAccount(state, actorId) {
  return state.connected_accounts.find((item) => item.user_id === actorId && item.provider === 'github') || null;
}

export async function connectToken({ res, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const credentialId = `cred_${Date.now().toString(16)}`;
    const refName = body.token?.startsWith('env:') ? body.token : body.env_ref || 'env:GITHUB_TOKEN';
    const token = resolveToken(body.token || body.env_ref);
    const login = token ? (body.login || 'mock-github-user') : 'unverified-env-ref';
    const credential = buildCredential({ credentialId, actor, refName, body });
    const account = buildAccount({ actor, login, credential, token, body });

    state.credential_refs.push(credential);
    state.connected_accounts = state.connected_accounts.filter((item) => !(item.user_id === actor.id && item.provider === 'github'));
    state.connected_accounts.push(account);
    addTrace(state, 'human.reviewed', { summary: 'GitHub 账号已绑定（token/env ref 已 mask）。', data: { login: account.login, credential_ref_id: credential.id } }, actor.id);

    return { account, credential_ref: { ...credential, encrypted_value: credential.encrypted_value ? '***MASKED***' : '' } };
  });
  return send(res, 200, result);
}

function buildCredential({ credentialId, actor, refName, body }) {
  return {
    id: credentialId,
    owner_user_id: actor.id,
    kind: String(refName).startsWith('env:') ? 'env_ref' : 'encrypted_token',
    provider: 'github',
    ref_name: String(refName).startsWith('env:') ? refName : 'local:encrypted-token',
    encrypted_value: String(refName).startsWith('env:') ? '' : `sha256:${hashString(body.token || '')}`,
    expires_at: null,
    scopes: body.scopes || ['repo'],
    created_at: now(),
    updated_at: now()
  };
}

function buildAccount({ actor, login, credential, token, body }) {
  return {
    id: `acct_${Date.now().toString(16)}`,
    user_id: actor.id,
    provider: 'github',
    provider_account_id: body.provider_account_id || login,
    login,
    display_name: body.display_name || login,
    avatar_url: body.avatar_url || '',
    profile_url: `https://github.com/${login}`,
    credential_ref_id: credential.id,
    scopes: credential.scopes,
    permissions_summary: { repo: true, pull_requests: true, mode: token ? 'verified-or-mock' : 'env-ref-pending' },
    status: token || String(credential.ref_name).startsWith('env:') ? 'connected' : 'error',
    last_verified_at: now(),
    created_at: now(),
    updated_at: now()
  };
}

export async function githubStatus({ res }) {
  const state = await readState();
  const actor = owner(state);
  const account = githubAccount(state, actor.id);
  return send(res, 200, { connected: Boolean(account), account });
}

export async function disconnect({ res }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    state.connected_accounts = state.connected_accounts.filter((item) => !(item.user_id === actor.id && item.provider === 'github'));
    addTrace(state, 'human.reviewed', { summary: 'GitHub 绑定已断开，历史 CodeChange / PR 保留。' }, actor.id);
    return { connected: false };
  });
  return send(res, 200, result);
}

export async function checkRepoAccess({ res, body }) {
  const state = await readState();
  const actor = owner(state);
  const account = githubAccount(state, actor.id);
  return send(res, 200, {
    owner: body.owner,
    repo: body.repo,
    status: account ? 'accessible' : 'unknown',
    permissions: account ? { pull: true, push: true, admin: false } : { pull: false, push: false, reason: 'GitHub 未绑定；可生成 PR 草稿。' }
  });
}
