import { createSign } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readSecret } from './vault.mjs';
import { HttpError } from './http.mjs';
import { githubDispatcher } from './outbound-proxy.mjs';

export function resolveGithubAppConfig(state) {
  const mode = state.setup_states?.[0]?.mode;
  const local = state.github_app_configs?.find((item) => item.status === 'validated') || null;
  const hosted = hostedConfig();
  if (mode === 'hosted') return hosted;
  if (mode === 'byo') return local;
  return local || hosted;
}

function hostedConfig() {
  const appId = process.env.AIWS_HOSTED_GITHUB_APP_ID;
  const clientId = process.env.AIWS_HOSTED_GITHUB_CLIENT_ID;
  const slug = process.env.AIWS_HOSTED_GITHUB_APP_SLUG;
  const hasPrivateKey = Boolean(process.env.AIWS_HOSTED_GITHUB_PRIVATE_KEY || process.env.AIWS_HOSTED_GITHUB_PRIVATE_KEY_PATH);
  if (!appId || !clientId || !slug || !hasPrivateKey || !process.env.AIWS_HOSTED_GITHUB_CLIENT_SECRET || !process.env.AIWS_HOSTED_GITHUB_WEBHOOK_SECRET) return null;
  return {
    id: 'github_app_hosted', mode: 'hosted', app_id: appId, client_id: clientId, slug,
    status: 'validated', private_key_path: process.env.AIWS_HOSTED_GITHUB_PRIVATE_KEY_PATH || null,
    refs: {
      client: process.env.AIWS_HOSTED_GITHUB_CLIENT_SECRET ? 'env:AIWS_HOSTED_GITHUB_CLIENT_SECRET' : null,
      private_key: process.env.AIWS_HOSTED_GITHUB_PRIVATE_KEY ? 'env:AIWS_HOSTED_GITHUB_PRIVATE_KEY' : null,
      webhook: process.env.AIWS_HOSTED_GITHUB_WEBHOOK_SECRET ? 'env:AIWS_HOSTED_GITHUB_WEBHOOK_SECRET' : null
    }
  };
}

export async function appCredentials(config) {
  if (!config) return null;
  const refs = config.refs || {};
  const fromFile = config.private_key_path
    ? await fsp.readFile(path.resolve(config.private_key_path), 'utf8').catch(() => '')
    : '';
  return {
    appId: config.app_id,
    clientId: config.client_id,
    clientSecret: await readSecret(refs.client),
    privateKey: normalizePrivateKey(await readSecret(refs.private_key) || fromFile),
    webhookSecret: await readSecret(refs.webhook)
  };
}

export function createAppJwt(appId, privateKey, timestamp = Math.floor(Date.now() / 1000)) {
  if (!appId || !privateKey) throw new Error('github_app_credentials_missing');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iat: timestamp - 60, exp: timestamp + 540, iss: String(appId) });
  const unsigned = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

export async function githubJson(url, options = {}) {
  let response;
  try {
    const dispatcher = options.dispatcher || githubDispatcher(url);
    response = await fetch(url, {
      ...options,
      ...(dispatcher ? { dispatcher } : {}),
      signal: options.signal || AbortSignal.timeout(githubTimeout()),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ai-workspace-v1.9', 'x-github-api-version': '2022-11-28', ...options.headers }
    });
  } catch (error) {
    throw new HttpError(502, {
      error: 'github_network_unavailable', message: 'Unable to reach GitHub.',
      action: 'Check network and proxy settings, then retry.', phase: 'github', retryable: true,
      reason: String(error?.cause?.code || error?.code || error?.name || 'network_error')
    });
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) {
    const error = new Error(data.message || `github_http_${response.status}`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function githubTimeout() {
  const value = Number(process.env.AIWS_GITHUB_HTTP_TIMEOUT_MS || 15000);
  return Number.isFinite(value) ? Math.max(1000, Math.min(60000, Math.trunc(value))) : 15000;
}

export async function verifyApp(config, request = githubJson) {
  const credentials = await appCredentials(config);
  const jwt = createAppJwt(credentials.appId, credentials.privateKey);
  return request('https://api.github.com/app', { headers: { authorization: `Bearer ${jwt}` } });
}

export async function createInstallationToken(config, installationId, request = githubJson) {
  const credentials = await appCredentials(config);
  const jwt = createAppJwt(credentials.appId, credentials.privateKey);
  return request(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST', headers: { authorization: `Bearer ${jwt}` }
  });
}

export function githubGitAuthEnv(token) {
  const value = String(token || '');
  if (!value) throw new Error('github_installation_token_missing');
  const encoded = Buffer.from(`x-access-token:${value}`, 'utf8').toString('base64');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`
  };
}

export async function fetchInstallationRepositories(config, installationId, request = githubJson) {
  const token = await createInstallationToken(config, installationId, request);
  const repositories = [];
  for (let page = 1; page <= 100; page++) {
    const result = await request(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { headers: { authorization: `Bearer ${token.token}` } });
    repositories.push(...(result.repositories || []).map((repository) => ({
      ...repository,
      permissions: installationRepositoryPermissions(repository.permissions, token.permissions)
    })));
    if ((result.repositories || []).length < 100) return { ...result, total_count: Number(result.total_count || repositories.length), repositories };
  }
  return { total_count: repositories.length, repositories };
}

export async function fetchUserInstallations(account, request = githubJson) {
  const token = await readSecret(account?.credential_ref);
  if (!token) throw new Error('github_account_reauthorization_required');
  return request('https://api.github.com/user/installations?per_page=100', {
    headers: { authorization: `Bearer ${token}` }
  });
}

export function connectedGithubAccount(state, userId = null) {
  return state.connected_accounts.find((item) => item.provider === 'github'
    && item.status === 'connected'
    && (!userId || item.user_id === userId)
    && String(item.credential_ref || '').startsWith('vault:'));
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function normalizePrivateKey(value) { return String(value || '').replace(/\\n/g, '\n'); }
function installationRepositoryPermissions(repository = {}, installation = {}) {
  const contents = installation.contents;
  return {
    ...repository,
    pull: repository.pull === true || contents === 'read' || contents === 'write',
    push: repository.push === true || contents === 'write',
    admin: repository.admin === true || installation.administration === 'write'
  };
}
