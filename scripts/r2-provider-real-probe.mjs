import fs from 'node:fs';
import path from 'node:path';
import { createGithubAppJwt } from '../apps/api/src/modules/setup/github-service.mjs';

const appId = String(process.env.AIWS_GITHUB_APP_ID || '');
const installationId = String(process.env.AIWS_GITHUB_INSTALLATION_ID || '');
const privateKeyFile = process.env.AIWS_GITHUB_APP_PRIVATE_KEY_FILE
  ? path.resolve(process.env.AIWS_GITHUB_APP_PRIVATE_KEY_FILE)
  : '';
const missing = [];
if (!/^[1-9][0-9]{0,19}$/.test(appId)) missing.push('AIWS_GITHUB_APP_ID');
if (!/^[1-9][0-9]{0,19}$/.test(installationId)) missing.push('AIWS_GITHUB_INSTALLATION_ID');
if (!privateKeyFile || !fs.existsSync(privateKeyFile)) missing.push('AIWS_GITHUB_APP_PRIVATE_KEY_FILE');

if (missing.length) {
  process.stdout.write(`${JSON.stringify({
    schema_version: 'aiws.v3.r2_provider_probe.v1',
    provider: 'github_app',
    status: 'candidate',
    reason: 'external_configuration_missing',
    missing
  }, null, 2)}\n`);
  process.exit(0);
}

try {
  const stat = fs.lstatSync(privateKeyFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > 64 * 1024) throw new Error('github_private_key_file_invalid');
  const apiRoot = String(process.env.AIWS_GITHUB_API_ROOT || 'https://api.github.com').replace(/\/+$/, '');
  const jwt = createGithubAppJwt({ appId, privateKey: fs.readFileSync(privateKeyFile, 'utf8') });
  const app = await request(apiRoot, '/app', jwt);
  if (String(app?.id || '') !== appId) throw new Error('github_app_mismatch');
  const installation = await request(apiRoot, `/app/installations/${installationId}`, jwt);
  const permissions = installation?.permissions || {};
  const permissionsReady = permissions.metadata === 'read' && permissions.contents === 'write' && permissions.pull_requests === 'write';
  if (!permissionsReady) throw new Error('github_permission_missing');
  const issued = await request(apiRoot, `/app/installations/${installationId}/access_tokens`, jwt, 'POST');
  const installationToken = String(issued?.token || '');
  if (installationToken.length < 8) throw new Error('github_installation_token_invalid');
  const repositories = await request(apiRoot, '/installation/repositories?per_page=1', installationToken);
  if (Number(repositories?.total_count || 0) < 1) throw new Error('github_repository_missing');
  process.stdout.write(`${JSON.stringify({
    schema_version: 'aiws.v3.r2_provider_probe.v1',
    provider: 'github_app',
    status: 'passed',
    app: { id: appId, slug: String(app.slug || '') },
    installation: { id: installationId, permissions_ready: true },
    repositories: { total_count: Number(repositories.total_count) }
  }, null, 2)}\n`);
} catch (error) {
  const errorCode = stableCode(error?.message);
  process.stderr.write(`${JSON.stringify({
    schema_version: 'aiws.v3.r2_provider_probe.v1',
    provider: 'github_app',
    status: 'failed',
    error_code: errorCode
  })}\n`);
  process.exitCode = 1;
}

async function request(root, requestPath, credential, method = 'GET') {
  let response;
  try {
    response = await fetch(`${root}${requestPath}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        'user-agent': 'aiws-v3-r2-evidence',
        'x-github-api-version': '2022-11-28'
      },
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(30_000)
    });
  } catch { throw new Error('github_api_unavailable'); }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;
  if (response.status === 401) throw new Error('github_auth_failed');
  if (response.status === 403) throw new Error('github_permission_missing');
  if (response.status === 404) throw new Error('github_resource_missing');
  if (response.status === 429) throw new Error('github_rate_limited');
  throw new Error(response.status >= 500 ? 'github_api_unavailable' : 'github_api_failed');
}

function stableCode(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return /^github_[a-z0-9_]{3,100}$/.test(normalized) ? normalized : 'github_probe_failed';
}
