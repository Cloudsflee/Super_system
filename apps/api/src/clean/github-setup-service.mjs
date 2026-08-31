import fs from 'node:fs';
import { createHmac, createPrivateKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

const MAX_SECRET_BYTES = 512 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;
const STATE_TTL_MS = 30 * 60 * 1000;
const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/;
const APP_ID = INSTALLATION_ID;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

export class CleanGithubSetupService {
  constructor({ config = {}, identity, vault, p8Service, fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
    if (!identity || !vault || !p8Service) throw new TypeError('github_setup_dependencies_required');
    if (typeof fetchImpl !== 'function') throw new TypeError('github_setup_fetch_required');
    this.config = config;
    this.identity = identity;
    this.vault = vault;
    this.p8Service = p8Service;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.stateKey = String(config.providerDiscoverySecret || config.sessionSecret || 'v3-clean-github-setup');
  }

  discover(_input = {}, principal) {
    requirePrincipal(principal);
    const context = this.#profileContext(principal);
    const app = this.#publicApp(context.profile);
    const installed = Boolean(context.profile?.config?.installation_id);
    const connected = context.profile?.status === 'available' && installed;
    const serverManaged = this.#hostedConfigured();
    return {
      provider: 'github',
      status: connected ? 'connected' : installed ? 'verification_required' : (context.profile || serverManaged) ? 'installation_required' : 'manifest_required',
      app,
      server_managed: serverManaged,
      profile: context.profile,
      can_install: Boolean((context.profile || serverManaged) && app.slug),
      can_create_manifest: true,
      repositories_count: 0
    };
  }

  async manifest(input = {}, principal) {
    requirePrincipal(principal);
    const action = String(input.action || '');
    if (action === 'start') return this.#startManifest(input, principal);
    if (action === 'callback') return this.#completeManifest(input, principal);
    if (action === 'configure') return this.#configureExisting(input, principal);
    throw new PlatformError('schema_invalid', 'GitHub manifest action is invalid', {}, 422);
  }

  async installation(input = {}, principal) {
    requirePrincipal(principal);
    const action = String(input.action || '');
    if (action === 'start') return this.#startInstallation(input, principal);
    if (action === 'complete') return this.#completeInstallation(input, principal);
    if (action === 'sync') return this.#syncInstallation(input, principal);
    throw new PlatformError('schema_invalid', 'GitHub installation action is invalid', {}, 422);
  }

  #startManifest(input, principal) {
    const callbackBase = callbackOrigin(input.callback_origin, this.config.githubApp?.webOrigin);
    const returnPath = returnPathOf(input.return_path);
    const nonce = randomBytes(12).toString('base64url');
    const state = this.#signState('manifest', principal, { nonce, callback_origin: callbackBase, return_path: returnPath });
    const callback = callbackUrl(callbackBase, returnPath, 'manifest');
    const setup = callbackUrl(callbackBase, returnPath, 'installation');
    const manifest = {
      name: `AIWS Local ${nonce.slice(0, 8)}`,
      url: callbackBase,
      hook_attributes: { url: `${callbackBase}/api/v2/webhooks/github`, active: false },
      redirect_url: callback,
      setup_url: setup,
      setup_on_update: true,
      public: false,
      default_permissions: {
        administration: 'write',
        checks: 'read',
        contents: 'write',
        pull_requests: 'write',
        metadata: 'read'
      },
      default_events: []
    };
    return setupReceipt({
      action: 'manifest', status: 'authorization_required', app: this.#publicApp(), state, manifest,
      manifestUrl: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}&manifest=${encodeURIComponent(JSON.stringify(manifest))}`
    });
  }

  async #completeManifest(input, principal) {
    const state = this.#verifyState(input.state, 'manifest', principal);
    const prior = this.#credentialForScope(principal, 'manifest_nonce', state.nonce);
    if (prior) return this.#installationRequiredReceipt(prior, principal, state.callback_origin, state.return_path);
    const code = bounded(input.code, 512, 'github_manifest_code_required');
    const converted = await this.#convertManifest(code);
    let proof = null;
    try {
      const app = normalizeApp({
        app_id: converted.id,
        client_id: converted.client_id,
        slug: converted.slug,
        app_name: converted.name || converted.slug
      });
      proof = githubBundle({
        app_id: app.app_id,
        client_id: app.client_id,
        client_secret: converted.client_secret,
        private_key: converted.pem,
        webhook_secret: converted.webhook_secret,
        slug: app.slug
      });
      const bound = await this.#bindBase({
        app,
        proof,
        scope: { source: 'manifest', app_id: app.app_id, manifest_nonce: state.nonce },
        origin: 'github_manifest',
        forceRotate: false,
        idempotencyKey: derivedKey(input.idempotency_key, `manifest:${state.nonce}`)
      }, principal);
      return this.#installationReceipt(bound.profile, app, principal, state.callback_origin, state.return_path);
    } finally {
      proof?.fill(0);
      clearConverted(converted);
    }
  }

  async #configureExisting(input, principal) {
    if (input.confirmed !== true) throw new PlatformError('confirmation_required', 'GitHub App configuration requires confirmation', {}, 400);
    const defaults = this.#publicApp();
    const app = normalizeApp({
      app_id: input.app_id || defaults.app_id,
      client_id: input.client_id || defaults.client_id,
      slug: input.slug || defaults.slug,
      app_name: input.app_name || defaults.name
    });
    validatePrivateKey(input.private_key);
    let proof = null;
    try {
      proof = githubBundle({
        app_id: app.app_id,
        client_id: app.client_id,
        private_key: input.private_key,
        webhook_secret: input.webhook_secret || '',
        slug: app.slug
      });
      const bound = await this.#bindBase({
        app,
        proof,
        scope: { source: 'manual', app_id: app.app_id },
        origin: 'manual_rebind',
        forceRotate: true,
        idempotencyKey: derivedKey(input.idempotency_key, `manual:${app.app_id}`)
      }, principal);
      return this.#installationReceipt(
        bound.profile,
        app,
        principal,
        callbackOrigin(input.callback_origin, this.config.githubApp?.webOrigin),
        returnPathOf(input.return_path)
      );
    } finally {
      proof?.fill(0);
      if (Object.hasOwn(input, 'private_key')) input.private_key = '';
      if (Object.hasOwn(input, 'webhook_secret')) input.webhook_secret = '';
    }
  }

  async #startInstallation(input, principal) {
    const callback = callbackOrigin(input.callback_origin, this.config.githubApp?.webOrigin);
    const returnPath = returnPathOf(input.return_path);
    let context = this.#profileContext(principal, input.profile_id);
    if (!context.profile) {
      if (!this.#hostedConfigured()) throw new PlatformError('github_app_configuration_required', 'GitHub App configuration is required', {}, 409);
      context = await this.#bindHosted(principal, input.idempotency_key);
    }
    const app = this.#publicApp(context.profile);
    if (!app.slug) throw new PlatformError('github_app_slug_required', 'GitHub App slug is required', {}, 409);
    if (context.profile.config?.installation_id) {
      const profile = context.profile.status === 'available'
        ? context.profile
        : await this.#probe(context.profile, input.idempotency_key, principal);
      return this.#syncProfile(profile, principal, 'sync');
    }
    const existing = await this.#discoverExistingInstallation(context, input.idempotency_key, principal);
    if (existing) return existing;
    return this.#installationReceipt(context.profile, app, principal, callback, returnPath);
  }

  async #completeInstallation(input, principal) {
    const installationId = String(input.installation_id || '');
    if (!INSTALLATION_ID.test(installationId)) throw new PlatformError('schema_invalid', 'GitHub installation id is invalid', {}, 422);
    const state = input.state ? this.#verifyState(input.state, 'installation', principal) : null;
    let context = this.#profileContext(principal, input.profile_id || state?.profile_id);
    if (!context.profile) {
      if (!this.#hostedConfigured()) throw new PlatformError('github_app_configuration_required', 'GitHub App configuration is required', {}, 409);
      context = await this.#bindHosted(principal, input.idempotency_key);
    }
    if (state?.app_id && String(context.profile.config?.app_id || '') !== String(state.app_id)) {
      throw new PlatformError('github_state_mismatch', 'GitHub installation state does not match the configured App', {}, 409);
    }
    const profile = await this.#bindInstallation(context, installationId, input.idempotency_key, principal);
    return this.#syncProfile(profile, principal, 'complete');
  }

  async #syncInstallation(input, principal) {
    const context = this.#profileContext(principal, input.profile_id);
    if (!context.profile?.config?.installation_id) throw new PlatformError('github_installation_required', 'GitHub App installation is required', {}, 409);
    let profile = context.profile;
    if (profile.status !== 'available') profile = await this.#probe(profile, input.idempotency_key, principal);
    return this.#syncProfile(profile, principal, 'sync');
  }

  async #discoverExistingInstallation(context, idempotencyKey, principal) {
    if (typeof this.p8Service.github?.listInstallations !== 'function' || !context.credential) return null;
    let lease = null;
    let privateKey = null;
    let bundle = null;
    try {
      lease = Buffer.from(this.vault.read(context.credential.external_ref));
      bundle = parseBundle(lease);
      privateKey = Buffer.from(normalizePem(bundle.private_key), 'utf8');
      const result = await this.p8Service.github.listInstallations({
        appId: context.profile.config?.app_id || bundle.app_id,
        privateKey
      }, { limit: 100 });
      const installations = (result.installations || []).filter((item) => INSTALLATION_ID.test(String(item.id || '')) && !item.suspended_at);
      if (installations.length !== 1) return null;
      const profile = await this.#bindInstallation(context, String(installations[0].id), derivedKey(idempotencyKey, 'discovered-installation'), principal);
      return this.#syncProfile(profile, principal, 'complete');
    } catch (error) {
      if (['github_unavailable', 'github_request_failed', 'external_result_unknown'].includes(String(error?.code || ''))) return null;
      throw error;
    } finally {
      clearSecretObject(bundle);
      privateKey?.fill(0);
      lease?.fill(0);
    }
  }

  async #bindHosted(principal, idempotencyKey) {
    const hosted = this.config.githubApp || {};
    const app = normalizeApp({ app_id: hosted.appId, client_id: hosted.clientId, slug: hosted.slug, app_name: hosted.name });
    let privateKey = null;
    let proof = null;
    try {
      privateKey = hosted.privateKey
        ? Buffer.from(normalizePem(hosted.privateKey), 'utf8')
        : readStrictSecretFile(hosted.privateKeyPath, MAX_SECRET_BYTES);
      validatePrivateKey(privateKey);
      proof = githubBundle({
        app_id: app.app_id,
        client_id: app.client_id,
        client_secret: hosted.clientSecret || '',
        private_key: privateKey.toString('utf8'),
        webhook_secret: hosted.webhookSecret || '',
        slug: app.slug
      });
      const bound = await this.#bindBase({
        app,
        proof,
        scope: { source: 'hosted', app_id: app.app_id },
        origin: 'hosted',
        forceRotate: false,
        idempotencyKey: derivedKey(idempotencyKey, `hosted:${app.app_id}`)
      }, principal);
      return { ...bound, app };
    } finally {
      privateKey?.fill(0);
      proof?.fill(0);
    }
  }

  async #bindBase({ app, proof, scope, origin, forceRotate, idempotencyKey }, principal) {
    const credentials = this.identity.credentials(principal);
    let credential = credentials.find((item) => item.provider === 'github'
      && item.status !== 'revoked'
      && String(item.scope?.app_id || '') === app.app_id
      && (scope.manifest_nonce == null || item.scope?.manifest_nonce === scope.manifest_nonce));
    if (!credential) {
      const created = await this.identity.createCredential({
        provider: 'github', scope, origin, external_ref: `github:${scope.source}:${app.app_id}`,
        idempotency_key: derivedKey(idempotencyKey, 'credential')
      }, principal);
      credential = created.credential;
    }
    if (credential.status !== 'active' || forceRotate) {
      const binding = credential.status === 'active'
        ? await this.identity.rotateCredential(credential.id, {
            proof, expected_revision: credential.revision, idempotency_key: derivedKey(idempotencyKey, 'credential-rotate')
          }, principal)
        : await this.identity.rebindCredential(credential.id, {
            proof, expected_revision: credential.revision, idempotency_key: derivedKey(idempotencyKey, 'credential-rebind')
          }, principal);
      if (binding.status !== 'succeeded') throw new PlatformError(binding.error_code || 'credential_bind_failed', 'GitHub credential binding failed', {}, 409);
      credential = this.identity.credentials(principal).find((item) => item.id === credential.id);
    }
    const config = { app_id: app.app_id, client_id: app.client_id, slug: app.slug, auth_type: 'github_app' };
    let profile = this.identity.profiles(principal).find((item) => item.provider === 'github'
      && item.credential_ref_id === credential.id
      && item.lifecycle_status !== 'disabled');
    if (!profile) {
      const created = await this.identity.createProfile({
        provider: 'github', label: app.name || 'GitHub App', credential_ref_id: credential.id, config,
        idempotency_key: derivedKey(idempotencyKey, 'profile-create')
      }, principal);
      profile = created.profile;
    } else if (!samePublicConfig(profile.config, config)) {
      const updated = await this.identity.updateProfile(profile.id, {
        label: app.name || profile.label, credential_ref_id: credential.id, config,
        expected_revision: profile.revision, idempotency_key: derivedKey(idempotencyKey, 'profile-update')
      }, principal);
      profile = updated.profile;
    }
    return { credential, profile };
  }

  async #bindInstallation(context, installationId, idempotencyKey, principal) {
    let profile = context.profile;
    const credential = context.credential;
    const existingInstallation = String(profile.config?.installation_id || '');
    if (existingInstallation === installationId && profile.status === 'available') return profile;
    let lease = null;
    let proof = null;
    let bundle = null;
    try {
      lease = Buffer.from(this.vault.read(credential.external_ref));
      bundle = parseBundle(lease);
      bundle.installation_id = installationId;
      proof = Buffer.from(canonicalJson(bundle), 'utf8');
      const rotated = await this.identity.rotateCredential(credential.id, {
        proof,
        expected_revision: credential.revision,
        idempotency_key: derivedKey(idempotencyKey, `installation-credential:${installationId}`)
      }, principal);
      if (rotated.status !== 'succeeded') throw new PlatformError(rotated.error_code || 'credential_bind_failed', 'GitHub installation binding failed', {}, 409);
    } finally {
      clearSecretObject(bundle);
      lease?.fill(0);
      proof?.fill(0);
    }
    const refreshedCredential = this.identity.credentials(principal).find((item) => item.id === credential.id);
    const config = { ...profile.config, app_id: String(profile.config?.app_id || context.app.app_id), slug: profile.config?.slug || context.app.slug, installation_id: installationId };
    const updated = await this.identity.updateProfile(profile.id, {
      label: profile.label,
      credential_ref_id: refreshedCredential.id,
      config,
      expected_revision: profile.revision,
      idempotency_key: derivedKey(idempotencyKey, `installation-profile:${installationId}`)
    }, principal);
    profile = await this.#probe(updated.profile, idempotencyKey, principal);
    return profile;
  }

  async #probe(profile, idempotencyKey, principal) {
    const probe = await this.identity.probeProfile(profile.id, {
      expected_revision: profile.revision,
      idempotency_key: derivedKey(idempotencyKey, `probe:${profile.id}:${profile.revision}`)
    }, principal);
    if (probe.status !== 'succeeded') throw new PlatformError(probe.error_code || 'github_probe_failed', 'GitHub App probe failed', {}, 409);
    const current = this.identity.profiles(principal).find((item) => item.id === profile.id);
    if (!current || current.status !== 'available') throw new PlatformError('github_probe_failed', 'GitHub App probe did not become available', {}, 409);
    return current;
  }

  async #syncProfile(profile, principal, action) {
    const result = await this.p8Service.listGithubRepositories(profile.id, { profile_id: profile.id, limit: 100 }, principal);
    return setupReceipt({
      action,
      status: 'connected',
      app: this.#publicApp(profile),
      profile,
      repositories: result.repositories || [],
      nextCursor: result.next_cursor || null
    });
  }

  #installationRequiredReceipt(credential, principal, callbackOrigin, returnPath) {
    const profile = this.identity.profiles(principal).find((item) => item.credential_ref_id === credential.id && item.provider === 'github' && item.lifecycle_status !== 'disabled');
    if (!profile) throw new PlatformError('github_profile_not_found', 'GitHub App profile was not found', {}, 404);
    return this.#installationReceipt(profile, this.#publicApp(profile), principal, callbackOrigin, returnPath);
  }

  #installationReceipt(profile, app, principal, callbackOrigin, returnPath) {
    const state = this.#signState('installation', principal, {
      nonce: randomBytes(12).toString('base64url'),
      profile_id: profile.id,
      app_id: app.app_id,
      callback_origin: callbackOrigin,
      return_path: returnPath
    });
    return setupReceipt({
      action: 'installation',
      status: 'installation_required',
      app,
      profile,
      state,
      installationUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`
    });
  }

  #profileContext(principal, requestedProfileId = null) {
    const credentials = new Map(this.identity.credentials(principal).map((item) => [item.id, item]));
    const profiles = this.identity.profiles(principal).filter((item) => item.provider === 'github' && item.lifecycle_status !== 'disabled');
    const profile = requestedProfileId
      ? profiles.find((item) => item.id === String(requestedProfileId))
      : profiles.find((item) => item.status === 'available' && credentials.get(item.credential_ref_id)?.status === 'active')
        || profiles.find((item) => credentials.get(item.credential_ref_id)?.status === 'active')
        || null;
    if (requestedProfileId && !profile) throw new PlatformError('github_profile_not_found', 'GitHub App profile was not found', {}, 404);
    const credential = profile ? credentials.get(profile.credential_ref_id) || null : null;
    return { profile, credential, app: this.#publicApp(profile) };
  }

  #credentialForScope(principal, key, value) {
    return this.identity.credentials(principal).find((item) => item.provider === 'github' && item.status === 'active' && item.scope?.[key] === value) || null;
  }

  #publicApp(profile = null) {
    const hosted = this.config.githubApp || {};
    const config = profile?.config || {};
    return normalizeApp({
      app_id: config.app_id || hosted.appId,
      client_id: config.client_id || hosted.clientId,
      slug: config.slug || hosted.slug,
      app_name: profile?.label || hosted.name || 'GitHub App'
    }, { allowIncomplete: true });
  }

  #hostedConfigured() {
    const app = this.config.githubApp || {};
    return Boolean(APP_ID.test(String(app.appId || '')) && APP_SLUG.test(String(app.slug || '')) && (String(app.privateKey || '').trim() || app.privateKeyPath));
  }

  async #convertManifest(code) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    timer.unref?.();
    try {
      const response = await this.fetch(`${String(this.config.githubApp?.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '')}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'aiws-v3-clean-setup',
          'x-github-api-version': '2022-11-28'
        }
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_GITHUB_RESPONSE_BYTES) throw new PlatformError('github_response_too_large', 'GitHub manifest response exceeded its bound', {}, 502);
      let value;
      try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new PlatformError('github_response_invalid', 'GitHub manifest response was invalid', {}, 502); }
      finally { bytes.fill(0); }
      if (!response.ok) throw new PlatformError('github_manifest_conversion_failed', 'GitHub App manifest conversion failed', { status: response.status, request_id: response.headers.get('x-github-request-id') || null }, 502);
      if (!value?.id || !value?.slug || !value?.pem) throw new PlatformError('github_response_invalid', 'GitHub manifest response was incomplete', {}, 502);
      validatePrivateKey(value.pem);
      return value;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('github_unavailable', 'GitHub is unavailable', { reason: String(error?.code || error?.name || 'network_error').slice(0, 80) }, 503);
    } finally {
      clearTimeout(timer);
    }
  }

  #signState(kind, principal, fields) {
    const payload = Buffer.from(canonicalJson({ v: 1, kind, actor_id: principal.actorId, expires_at: nowMs(this.clock) + STATE_TTL_MS, ...fields }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.stateKey).update(payload, 'utf8').digest('base64url');
    return `${payload}.${signature}`;
  }

  #verifyState(value, kind, principal) {
    const token = String(value || '');
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || token.length > 4096) throw new PlatformError('github_state_invalid', 'GitHub setup state is invalid', {}, 400);
    const expected = createHmac('sha256', this.stateKey).update(payload, 'utf8').digest();
    let supplied;
    try { supplied = Buffer.from(signature, 'base64url'); } catch { supplied = Buffer.alloc(0); }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new PlatformError('github_state_invalid', 'GitHub setup state is invalid', {}, 400);
    let decoded;
    try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new PlatformError('github_state_invalid', 'GitHub setup state is invalid', {}, 400); }
    if (decoded?.v !== 1 || decoded.kind !== kind || decoded.actor_id !== principal.actorId || Number(decoded.expires_at || 0) <= nowMs(this.clock)) {
      throw new PlatformError('github_state_invalid', 'GitHub setup state is invalid or expired', {}, 400);
    }
    return decoded;
  }
}

function setupReceipt({ action, status, app, profile = null, probe = null, repositories = [], nextCursor = null, state = null, manifest = null, manifestUrl = null, installationUrl = null }) {
  return {
    action,
    status,
    app,
    profile,
    probe,
    repositories,
    next_cursor: nextCursor,
    state,
    manifest,
    manifest_url: manifestUrl,
    installation_url: installationUrl
  };
}

function githubBundle(value) {
  validatePrivateKey(value.private_key);
  const bundle = {
    app_id: String(value.app_id),
    client_id: String(value.client_id || ''),
    client_secret: String(value.client_secret || ''),
    private_key: normalizePem(value.private_key),
    webhook_secret: String(value.webhook_secret || ''),
    slug: String(value.slug || '')
  };
  const bytes = Buffer.from(canonicalJson(bundle), 'utf8');
  clearSecretObject(bundle);
  if (!bytes.length || bytes.length > MAX_SECRET_BYTES) {
    bytes.fill(0);
    throw new PlatformError('schema_invalid', 'GitHub App credential bundle is invalid', {}, 422);
  }
  return bytes;
}

function parseBundle(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.private_key) throw new Error('shape');
    return value;
  } catch {
    throw new PlatformError('github_app_identity_missing', 'GitHub App credential bundle is invalid', {}, 409);
  }
}

function normalizeApp(value, { allowIncomplete = false } = {}) {
  const app = {
    name: String(value.app_name || value.name || 'GitHub App').replace(/[\r\n\0]/g, ' ').trim().slice(0, 120),
    app_id: String(value.app_id || '').trim(),
    client_id: String(value.client_id || '').trim().slice(0, 160),
    slug: String(value.slug || '').trim().toLowerCase()
  };
  if ((!allowIncomplete || app.app_id) && !APP_ID.test(app.app_id)) throw new PlatformError('schema_invalid', 'GitHub App id is invalid', {}, 422);
  if ((!allowIncomplete || app.slug) && !APP_SLUG.test(app.slug)) throw new PlatformError('schema_invalid', 'GitHub App slug is invalid', {}, 422);
  return app;
}

function validatePrivateKey(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(normalizePem(value), 'utf8');
  try {
    if (!bytes.length || bytes.length > MAX_SECRET_BYTES) throw new Error('length');
    const key = createPrivateKey(bytes);
    if (!['rsa', 'rsa-pss'].includes(key.asymmetricKeyType)) throw new Error('type');
  } catch {
    throw new PlatformError('github_private_key_invalid', 'GitHub App private key is invalid', {}, 422);
  } finally {
    if (!Buffer.isBuffer(value)) bytes.fill(0);
  }
}

function readStrictSecretFile(file, maximum) {
  if (!file) throw new PlatformError('github_private_key_missing', 'GitHub App private key is unavailable', {}, 409);
  let before;
  try { before = fs.lstatSync(file); } catch { throw new PlatformError('github_private_key_missing', 'GitHub App private key is unavailable', {}, 409); }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) throw new PlatformError('github_private_key_invalid', 'GitHub App private key file is invalid', {}, 409);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size || !sameFile(before, opened)) throw new PlatformError('github_private_key_race', 'GitHub App private key changed during read', {}, 409);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== bytes.length || !sameFile(opened, after)) {
      bytes.fill(0);
      throw new PlatformError('github_private_key_race', 'GitHub App private key changed during read', {}, 409);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function callbackOrigin(input, configured) {
  const raw = String(input || configured || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new PlatformError('github_callback_origin_invalid', 'GitHub callback origin is invalid', {}, 422); }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || (!loopback && parsed.origin !== configured)) {
    throw new PlatformError('github_callback_origin_invalid', 'GitHub callback origin is invalid', {}, 422);
  }
  return parsed.origin;
}

function callbackUrl(origin, returnPath, kind) {
  return `${origin}/?github_callback=${kind}#/${returnPath}`;
}

function returnPathOf(value) {
  const result = String(value || 'setup');
  if (!['setup', 'settings'].includes(result)) throw new PlatformError('schema_invalid', 'GitHub callback return path is invalid', {}, 422);
  return result;
}

function samePublicConfig(left = {}, right = {}) {
  return ['app_id', 'client_id', 'slug', 'auth_type'].every((key) => String(left?.[key] || '') === String(right?.[key] || ''));
}

function sameFile(left, right) {
  if (Number.isInteger(left.ino) && Number.isInteger(right.ino) && left.ino && right.ino && left.ino !== right.ino) return false;
  if (Number.isInteger(left.dev) && Number.isInteger(right.dev) && left.dev !== right.dev) return false;
  return left.size === right.size && Number(left.mtimeMs) === Number(right.mtimeMs);
}

function normalizePem(value) {
  return (Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '')).replace(/\\n/g, '\n').trim();
}

function clearConverted(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of ['client_secret', 'pem', 'webhook_secret']) value[key] = null;
}

function clearSecretObject(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of ['client_secret', 'private_key', 'webhook_secret']) if (Object.hasOwn(value, key)) value[key] = '';
}

function bounded(value, maximum, code) {
  const result = String(value || '').trim();
  if (!result || result.length > maximum) throw new PlatformError(code, 'GitHub callback field is invalid', {}, 422);
  return result;
}

function derivedKey(base, label) {
  return `github-${sha256Hex(`${String(base || '')}\0${label}`).slice(0, 48)}`;
}

function nowMs(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const result = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(result) ? result : Date.now();
}

function requirePrincipal(principal) {
  if (!principal?.actorId) throw new PlatformError('authentication_required', 'active session proof is required', {}, 401);
}
