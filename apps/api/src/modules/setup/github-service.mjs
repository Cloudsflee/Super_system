import { createHmac, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
import { now, sha256 } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';

const DEFAULT_API_ROOT = 'https://api.github.com';
const ACCEPTED_WEBHOOK_EVENTS = new Set(['installation', 'installation_repositories', 'repository']);

export class GithubService {
  constructor({ config, setup, operations, github = null, fetchImpl = null, clock = now }) {
    this.config = config;
    this.setup = setup;
    this.operations = operations;
    this.fetch = fetchImpl || github?.fetch || globalThis.fetch;
    this.apiRoot = String(config.githubAppApiRoot || github?.apiRoot || DEFAULT_API_ROOT).replace(/\/+$/, '');
    this.clock = clock;
  }

  async discoverInstallations(appConfigId, input = {}, ctx = {}) {
    const app = await this.requiredApp(appConfigId);
    const expectedRevision = expected(input);
    assertRevision(app, expectedRevision);
    return this.operations.create({
      kind: 'github.installations.discover', resourceType: 'github_app', resourceId: app.id, actor: ctx.actor,
      executor: async (operationContext) => {
        const jwt = await this.appJwt(app);
        const remote = await this.paginate('/app/installations', jwt, operationContext.signal);
        const installations = remote.map((item) => normalizeInstallation(app.id, item));
        await this.setup.repository.discoverGithubInstallations({
          appConfigId: app.id, expectedRevision, installations, timestamp: this.clock()
        }, ctx.actor);
        for (const installation of installations) {
          await operationContext.emit('github.installation.discovered', {
            installation_id: installation.installationId,
            account_login: installation.accountLogin,
            status: installation.status,
            error_code: installation.errorCode || null
          });
        }
        return { app_config_id: app.id, installations: installations.map(publicInstallation) };
      }
    });
  }

  async syncRepositories(installationId, input = {}, ctx = {}) {
    const installation = await this.setup.repository.githubInstallation(installationId);
    if (!installation) throw new AppError('not_found', 'GitHub installation not found');
    const expectedRevision = expected(input);
    assertRevision(installation, expectedRevision);
    const app = await this.requiredApp(installation.app_config_id);
    return this.operations.create({
      kind: 'github.repositories.sync', resourceType: 'github_installation', resourceId: installation.id, actor: ctx.actor,
      executor: async (operationContext) => {
        const jwt = await this.appJwt(app);
        const token = await this.installationToken(installation.installation_id, jwt, operationContext.signal);
        const remote = await this.paginate('/installation/repositories', token, operationContext.signal, { installationToken: true });
        const repositories = remote.map((item) => normalizeRepository(installation.id, item));
        const ready = permissionsReady(installation.permissions) && repositories.some((item) => item.selected);
        await this.setup.repository.syncGithubRepositories({
          installationId: installation.id,
          expectedRevision,
          repositories,
          status: ready ? 'available' : 'blocked',
          errorCode: ready ? '' : permissionsReady(installation.permissions) ? 'github_repository_missing' : 'github_permission_missing',
          timestamp: this.clock()
        }, ctx.actor);
        await operationContext.emit('github.repositories.synced', { installation_id: installation.id, count: repositories.length, status: ready ? 'available' : 'blocked' });
        return { installation_id: installation.id, status: ready ? 'available' : 'blocked', repositories: repositories.map(publicRepository) };
      }
    });
  }

  async probe(input = {}, ctx = {}) {
    const appId = String(input?.app_config_id || input?.app_id || '');
    const app = appId ? await this.requiredApp(appId) : (await this.setup.repository.githubApps())[0];
    if (!app) throw new AppError('github_app_missing', 'GitHub App configuration is required', { status: 409 });
    const expectedRevision = Number(input?.expected_revision || app.revision);
    assert(Number.isInteger(expectedRevision) && expectedRevision > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    assertRevision(app, expectedRevision);
    return this.operations.create({
      kind: 'github.probe', resourceType: 'github_app', resourceId: app.id, actor: ctx.actor,
      executor: (operationContext) => this.runProbe(app, expectedRevision, operationContext)
    });
  }

  async runProbe(app, expectedRevision, operationContext) {
    const checks = [];
    let result;
    try {
      const jwt = await this.appJwt(app);
      checks.push(check('jwt', true));
      const remoteApp = await this.request('GET', '/app', { token: jwt, signal: operationContext.signal });
      const slug = String(remoteApp?.slug || '').slice(0, 120);
      if (!slug || String(remoteApp?.id || '') !== String(app.app_id)) throw new GithubProviderError('github_app_mismatch');
      checks.push(check('app', true));
      const installations = await this.setup.repository.githubInstallations(app.id);
      const installation = installations.find((item) => item.status === 'available');
      if (!installation) throw new GithubProviderError('github_installation_missing');
      checks.push(check('installation', true));
      if (!permissionsReady(installation.permissions)) throw new GithubProviderError('github_permission_missing');
      checks.push(check('permissions', true));
      const token = await this.installationToken(installation.installation_id, jwt, operationContext.signal);
      const remoteRepositories = await this.request('GET', '/installation/repositories?per_page=1', { token, installationToken: true, signal: operationContext.signal });
      const cached = await this.setup.repository.githubRepositories(installation.id);
      if (!cached.some((item) => item.selected) || Number(remoteRepositories?.total_count || 0) < 1) throw new GithubProviderError('github_repository_missing');
      checks.push(check('repositories', true));
      result = { status: 'available', error_code: null, slug, checks };
    } catch (error) {
      const code = stableGithubCode(error?.code || 'github_probe_failed');
      const phases = ['jwt', 'app', 'installation', 'permissions', 'repositories'];
      const failedPhase = phases[checks.length] || 'repositories';
      checks.push(check(failedPhase, false, code));
      for (const phase of phases.slice(checks.length)) checks.push({ phase, status: 'skipped', error_code: code });
      result = { status: 'unavailable', error_code: code, slug: '', checks };
    }
    await this.setup.recordGithubProbe(app.id, expectedRevision, result);
    return { app_config_id: app.id, ...result };
  }

  async webhook(rawBody, headers = {}) {
    const deliveryId = String(headers['x-github-delivery'] || '');
    const eventName = String(headers['x-github-event'] || '').toLowerCase();
    const signature = String(headers['x-hub-signature-256'] || '');
    assert(/^[A-Za-z0-9-]{8,100}$/.test(deliveryId), 'github_delivery_invalid', 'GitHub delivery id is invalid', { status: 400 });
    assert(/^[a-z_]{2,80}$/.test(eventName), 'github_event_invalid', 'GitHub event name is invalid', { status: 400 });
    let payload;
    try { payload = JSON.parse(Buffer.from(rawBody).toString('utf8')); }
    catch { throw new AppError('invalid_json', 'webhook body must be JSON', { status: 400 }); }
    const externalAppId = String(payload?.app?.id || payload?.installation?.app_id || payload?.sender?.app_id || '');
    const apps = await this.setup.repository.githubApps();
    const app = apps.find((item) => String(item.app_id) === externalAppId) || (apps.length === 1 ? apps[0] : null);
    if (!app) throw new AppError('not_found', 'GitHub App configuration not found');
    const secret = await this.setup.credentialSecret(app.webhook_secret_ref);
    if (!verifyGithubWebhook(secret, rawBody, signature)) throw new AppError('github_webhook_signature_invalid', 'GitHub webhook signature is invalid', { status: 401 });
    const bodySha256 = sha256(rawBody);
    const existing = await this.setup.repository.webhookDelivery(deliveryId);
    if (existing) {
      if (existing.body_sha256 !== bodySha256) throw new AppError('github_delivery_conflict', 'GitHub delivery id was reused', { status: 409 });
      return existing.receipt;
    }
    const action = String(payload?.action || '').slice(0, 80);
    const installationId = String(payload?.installation?.id || '');
    const accepted = ACCEPTED_WEBHOOK_EVENTS.has(eventName);
    const revoked = eventName === 'installation' && ['deleted', 'suspend'].includes(action);
    const receipt = { delivery_id: deliveryId, status: accepted ? 'accepted' : 'ignored', event_name: eventName, action };
    try {
      await this.setup.repository.insertWebhookDelivery({
        deliveryId, eventName, action, status: receipt.status, receipt, bodySha256,
        appConfigId: app.id, installationId,
        installationStatus: revoked ? 'revoked' : '',
        errorCode: revoked ? 'github_installation_revoked' : 'github_webhook_changed',
        timestamp: this.clock()
      });
    } catch (error) {
      if (!String(error?.message).includes('UNIQUE')) throw error;
      const replay = await this.setup.repository.webhookDelivery(deliveryId);
      if (!replay || replay.body_sha256 !== bodySha256) throw new AppError('github_delivery_conflict', 'GitHub delivery id was reused', { status: 409 });
      return replay.receipt;
    }
    return receipt;
  }

  async appJwt(app) {
    const privateKey = await this.setup.credentialSecret(app.private_key_ref);
    return createGithubAppJwt({ appId: app.app_id, privateKey, issuedAt: Date.parse(this.clock()) });
  }

  async installationToken(installationId, jwt, signal) {
    const result = await this.request('POST', `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { token: jwt, body: {}, signal });
    const token = String(result?.token || '');
    if (token.length < 8 || token.length > 4096) throw new GithubProviderError('github_installation_token_invalid');
    return token;
  }

  async paginate(requestPath, token, signal, { installationToken = false } = {}) {
    const values = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = requestPath.includes('?') ? '&' : '?';
      const data = await this.request('GET', `${requestPath}${separator}per_page=100&page=${page}`, { token, installationToken, signal });
      const items = Array.isArray(data) ? data : Array.isArray(data?.repositories) ? data.repositories : [];
      values.push(...items);
      if (items.length < 100) break;
    }
    return values.slice(0, 1000);
  }

  async request(method, requestPath, { token, installationToken = false, body, signal } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.apiRoot}${requestPath}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `${installationToken ? 'Bearer' : 'Bearer'} ${token}`,
          'content-type': 'application/json',
          'user-agent': 'aiws-v3',
          'x-github-api-version': '2022-11-28'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new GithubProviderError('github_request_timeout');
      throw new GithubProviderError('github_api_unavailable');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) throw new GithubProviderError('github_auth_failed');
      if (response.status === 403) throw new GithubProviderError('github_permission_missing');
      if (response.status === 404) throw new GithubProviderError('github_resource_missing');
      if (response.status === 429) throw new GithubProviderError('github_rate_limited');
      throw new GithubProviderError(response.status >= 500 ? 'github_api_unavailable' : 'github_api_failed');
    }
    return data;
  }

  async requiredApp(id) {
    const app = await this.setup.repository.githubApp(id);
    if (!app) throw new AppError('not_found', 'GitHub App configuration not found');
    return app;
  }
}

export function createGithubAppJwt({ appId, privateKey, issuedAt = Date.now() }) {
  assert(/^[1-9][0-9]{0,19}$/.test(String(appId)), 'github_app_invalid', 'GitHub App id is invalid', { status: 422 });
  const seconds = Math.floor(Number(issuedAt) / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  let key;
  try { key = createPrivateKey(String(privateKey || '')); }
  catch { throw new AppError('github_private_key_invalid', 'GitHub App private key is invalid', { status: 422 }); }
  if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'rsa-pss') throw new AppError('github_private_key_invalid', 'GitHub App private key must be RSA', { status: 422 });
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url')}`;
}

export function verifyGithubWebhook(secret, rawBody, signature) {
  if (!/^sha256=[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  const expected = Buffer.from(createHmac('sha256', String(secret || '')).update(rawBody).digest('hex'), 'hex');
  const actual = Buffer.from(String(signature).slice('sha256='.length), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

class GithubProviderError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function normalizeInstallation(appId, value) {
  const installationId = String(value?.id || '');
  if (!/^[1-9][0-9]{0,19}$/.test(installationId)) throw new GithubProviderError('github_installation_invalid');
  const permissions = normalizePermissions(value?.permissions);
  const ready = permissionsReady(permissions) && !value?.suspended_at;
  return {
    id: `ghi_${sha256(`${appId}\n${installationId}`).slice(0, 24)}`,
    installationId,
    accountLogin: String(value?.account?.login || '').slice(0, 120),
    permissions,
    status: ready ? 'available' : value?.suspended_at ? 'revoked' : 'blocked',
    errorCode: ready ? '' : value?.suspended_at ? 'github_installation_suspended' : 'github_permission_missing'
  };
}

function normalizeRepository(installationId, value) {
  const githubId = String(value?.id || '');
  if (!/^[1-9][0-9]{0,19}$/.test(githubId) || !/^[^/\s]+\/[^/\s]+$/.test(String(value?.full_name || ''))) throw new GithubProviderError('github_repository_invalid');
  return {
    id: `ghr_${sha256(`${installationId}\n${githubId}`).slice(0, 24)}`,
    githubId,
    fullName: String(value.full_name).slice(0, 240),
    defaultBranch: String(value.default_branch || '').slice(0, 120),
    private: Boolean(value.private),
    selected: true,
    permissions: normalizePermissions(value.permissions)
  };
}

function normalizePermissions(value) {
  const permissions = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(permissions).slice(0, 100).map(([key, access]) => [String(key).slice(0, 100), String(access).toLowerCase().slice(0, 20)]));
}

function permissionsReady(value) {
  return value?.metadata === 'read' && value?.contents === 'write' && value?.pull_requests === 'write';
}

function publicInstallation(value) {
  return { installation_id: value.installationId, account_login: value.accountLogin, permissions: value.permissions, status: value.status, error_code: value.errorCode || null };
}

function publicRepository(value) {
  return { github_id: value.githubId, full_name: value.fullName, default_branch: value.defaultBranch, private: value.private, selected: value.selected, permissions: value.permissions };
}

function expected(input) {
  const value = Number(input?.expected_revision);
  assert(Number.isInteger(value) && value > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
  return value;
}

function assertRevision(resource, expectedRevision) {
  if (Number(resource.revision) !== expectedRevision) throw new AppError('revision_conflict', 'resource revision changed', { status: 409, details: { current_revision: Number(resource.revision) } });
}

function stableGithubCode(value) {
  const code = String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return /^github_[a-z0-9_]{3,100}$/.test(code) ? code : 'github_probe_failed';
}

function check(phase, passed, errorCode = null) {
  return { phase, status: passed ? 'passed' : 'failed', error_code: passed ? null : errorCode };
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}
