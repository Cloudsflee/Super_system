import { randomUUID } from 'node:crypto';
import { hashJson, id, now } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';
import { CredentialVault } from '../../credential-vault.mjs';
import { SetupRepository } from './repository.mjs';

const CREDENTIAL_KINDS = new Set([
  'codex_api_key', 'codex_oauth_bundle', 'github_app_private_key', 'github_webhook_secret'
]);

export class SetupService {
  constructor({ db, config, identity, operations = null, secrets = null, vault = null, clock = now, runtimeId = randomUUID() }) {
    this.repository = new SetupRepository(db);
    this.config = config;
    this.identity = identity;
    this.operations = operations;
    this.secrets = secrets;
    this.vault = vault || new CredentialVault(config.home);
    this.clock = clock;
    this.runtimeId = runtimeId;
  }

  async initialize() {
    const timestamp = this.clock();
    await this.repository.initialize(timestamp);
    if (this.config.codexCredential) {
      await this.repository.upsertBootstrapCredential({
        id: this.config.codexCredential.ref,
        provider: 'codex',
        kind: 'codex_api_key',
        label: this.config.codexCredential.profile || 'Bootstrap Codex',
        secretRef: 'secret_bundle:codex_default',
        timestamp
      });
      this.secrets?.remember(`bootstrap:${this.config.codexCredential.ref}`, this.config.codexCredential.auth);
    }
    if (this.config.githubCredential) {
      await this.repository.upsertBootstrapCredential({
        id: this.config.githubCredential.ref,
        provider: 'github',
        kind: 'github_webhook_secret',
        label: 'Bootstrap GitHub delivery token',
        secretRef: 'secret_bundle:github_delivery',
        timestamp
      });
      this.secrets?.remember(`bootstrap:${this.config.githubCredential.ref}`, this.config.githubCredential.token);
    }
    await this.expireCredentials();
    await this.cleanupOrphanedSecrets();
  }

  async expireCredentials() {
    const expired = await this.repository.expireCredentials(this.clock());
    for (const credential of expired) {
      this.secrets?.forget(`credential:${credential.id}`);
      if (String(credential.secret_ref || '').startsWith('vault:')) {
        queueMicrotask(() => this.vault.removeBySecretRef(credential.secret_ref));
      }
    }
    return expired.map((credential) => credential.id);
  }

  async cleanupOrphanedSecrets() {
    const referenced = await this.repository.referencedVaultFiles();
    const orphaned = this.vault.entries().filter((entry) => !referenced.has(entry));
    for (const file of orphaned) this.vault.removeBySecretRef(`vault:${file}`);
    return orphaned;
  }

  async listCredentials() {
    await this.expireCredentials();
    return (await this.repository.credentials()).map(publicCredential);
  }

  async createCredential(input = {}, ctx = {}) {
    const kind = credentialKind(input);
    const provider = kind.startsWith('codex_') ? 'codex' : 'github';
    const label = String(input?.label || '').trim();
    const secret = validateSecret(kind, input?.secret);
    const expiresAt = expiration(input?.expires_at, this.clock());
    assert(label.length >= 1 && label.length <= 120, 'invalid_input', 'credential label is required', { status: 422 });
    const credentialId = id('cred_vault');
    let secretRef = '';
    try {
      secretRef = `vault:${this.vault.putVersion(credentialId, 1, secret)}`;
      await this.repository.createCredential({
        id: credentialId, provider, kind, label, secretRef, expiresAt, timestamp: this.clock(),
        origin: 'vault', status: 'active', secretVersion: 1
      }, ctx.actor);
      this.secrets?.remember(`credential:${credentialId}`, secret);
    } catch (error) {
      if (secretRef) this.vault.removeBySecretRef(secretRef);
      throw normalizeCredentialError(error);
    }
    return publicCredential(await this.repository.credential(credentialId));
  }

  async createPendingCredential({ kind = 'codex_oauth_bundle', label = 'Codex device login', origin = 'device_auth', actor = 'usr_local_owner' } = {}) {
    assert(CREDENTIAL_KINDS.has(kind), 'invalid_input', 'credential kind is invalid', { status: 422 });
    const credentialId = id('cred_vault');
    await this.repository.createCredential({
      id: credentialId,
      provider: kind.startsWith('codex_') ? 'codex' : 'github',
      kind,
      label: String(label).slice(0, 120),
      secretRef: `pending:${credentialId}`,
      expiresAt: null,
      timestamp: this.clock(),
      origin,
      status: 'pending',
      secretVersion: 1
    }, actor);
    return publicCredential(await this.repository.credential(credentialId));
  }

  async activatePendingCredential(credentialId, secret, expectedRevision = 1, ctx = {}) {
    const current = await this.requiredCredential(credentialId);
    assert(current.status === 'pending', 'credential_state_invalid', 'credential is not pending', { status: 409 });
    const value = validateSecret(current.kind, secret);
    let secretRef = '';
    try {
      secretRef = `vault:${this.vault.putVersion(credentialId, current.secret_version, value)}`;
      await this.repository.activatePendingCredential({
        id: credentialId,
        secretRef,
        secretVersion: current.secret_version,
        timestamp: this.clock(),
        origin: current.origin
      }, expectedRevision, ctx.actor);
      this.secrets?.remember(`credential:${credentialId}`, value);
    } catch (error) {
      if (secretRef) this.vault.removeBySecretRef(secretRef);
      throw normalizeRevisionError(error, current.revision);
    }
    return publicCredential(await this.repository.credential(credentialId));
  }

  async rotateCredential(credentialId, input = {}, ctx = {}) {
    const current = await this.requiredCredential(credentialId);
    const expectedRevision = expected(input);
    assert(current.origin === 'vault', 'credential_readonly', 'bootstrap and imported credentials are read-only', { status: 409 });
    assert(current.status === 'active', 'credential_state_invalid', 'only active credentials can rotate', { status: 409 });
    const secret = validateSecret(current.kind, input?.secret);
    const nextVersion = Number(current.secret_version) + 1;
    const nextCredentialRevision = Number(current.revision) + 1;
    const profileUpdates = (await this.repository.codexProfiles())
      .filter((profile) => profile.credential_ref === credentialId)
      .map((profile) => ({
        id: profile.id,
        revision: profile.revision,
        configHash: profileConfigurationHash(profile, nextCredentialRevision)
      }));
    let secretRef = '';
    try {
      secretRef = `vault:${this.vault.putVersion(credentialId, nextVersion, secret)}`;
      await this.repository.rotateCredential({
        id: credentialId,
        secretRef,
        secretVersion: nextVersion,
        credentialRevision: nextCredentialRevision,
        profileUpdates,
        timestamp: this.clock()
      }, expectedRevision, ctx.actor);
    } catch (error) {
      if (secretRef) this.vault.removeBySecretRef(secretRef);
      throw normalizeRevisionError(error, current.revision);
    }
    this.secrets?.forget(`credential:${credentialId}`);
    this.secrets?.remember(`credential:${credentialId}`, secret);
    queueMicrotask(() => this.vault.removeBySecretRef(current.secret_ref));
    return publicCredential(await this.repository.credential(credentialId));
  }

  async revokeCredential(credentialId, input = {}, ctx = {}) {
    const current = await this.requiredCredential(credentialId);
    const expectedRevision = expected(input);
    assert(current.origin !== 'secret_bundle', 'credential_readonly', 'bootstrap credential is read-only', { status: 409 });
    try {
      await this.repository.revokeCredential({ id: credentialId, expectedRevision, timestamp: this.clock(), actor: ctx.actor });
    } catch (error) {
      throw normalizeRevisionError(error, current.revision);
    }
    this.secrets?.forget(`credential:${credentialId}`);
    queueMicrotask(() => this.vault.removeBySecretRef(current.secret_ref));
    return publicCredential(await this.repository.credential(credentialId));
  }

  async deleteCredential(credentialId, input = {}, ctx = {}) {
    const current = await this.requiredCredential(credentialId);
    const expectedRevision = expected(input);
    assert(current.origin !== 'secret_bundle', 'credential_readonly', 'bootstrap credential is read-only', { status: 409 });
    try {
      await this.repository.deleteCredential({ id: credentialId, expectedRevision, timestamp: this.clock(), actor: ctx.actor });
    } catch (error) {
      if (String(error?.message).includes('FOREIGN KEY')) throw new AppError('credential_in_use', 'credential is used by a setup resource', { status: 409 });
      throw normalizeRevisionError(error, current.revision);
    }
    this.secrets?.forget(`credential:${credentialId}`);
    queueMicrotask(() => this.vault.removeBySecretRef(current.secret_ref));
    return { id: credentialId, deleted: true };
  }

  async credentialSecret(credentialId) {
    await this.expireCredentials();
    const credential = await this.requiredCredential(credentialId);
    assert(credential.status === 'active', 'credential_unavailable', 'credential is not active', { status: 409 });
    let value = '';
    if (credential.origin === 'secret_bundle') {
      if (credential.secret_ref === 'secret_bundle:codex_default') value = this.config.codexCredential?.auth || '';
      if (credential.secret_ref === 'secret_bundle:github_delivery') value = this.config.githubCredential?.token || '';
    } else {
      value = this.vault.getBySecretRef(credential.secret_ref);
    }
    assert(value, 'credential_unavailable', 'credential secret is unavailable', { status: 409 });
    this.secrets?.remember(`credential:${credentialId}`, value);
    return value;
  }

  async activeCredentialSecrets() {
    const active = (await this.repository.credentials()).filter((row) => row.status === 'active');
    const values = [];
    for (const credential of active) {
      try { values.push(await this.credentialSecret(credential.id)); } catch { /* Metadata remains queryable when ciphertext is damaged. */ }
    }
    return values;
  }

  listCodexProfiles() {
    return this.repository.codexProfiles();
  }

  async createCodexProfile(input = {}, ctx = {}) {
    const profile = await this.validatedProfile(input);
    const profiles = await this.repository.codexProfiles();
    const profileId = id('cdp');
    await this.repository.createCodexProfile({
      ...profile,
      id: profileId,
      active: input?.is_active === true || !profiles.some((row) => row.is_active),
      timestamp: this.clock()
    }, ctx.actor);
    return this.repository.codexProfile(profileId);
  }

  async updateCodexProfile(profileId, input = {}, ctx = {}) {
    const current = await this.requiredProfile(profileId);
    const expectedRevision = expected(input);
    const profile = await this.validatedProfile({ ...current, ...input });
    try {
      await this.repository.updateCodexProfile({ ...profile, id: profileId, timestamp: this.clock() }, expectedRevision, ctx.actor);
    } catch (error) {
      throw normalizeRevisionError(error, current.revision);
    }
    return this.repository.codexProfile(profileId);
  }

  async activateCodexProfile(profileId, input = {}, ctx = {}) {
    const current = await this.requiredProfile(profileId);
    const expectedRevision = expected(input);
    assert(current.credential_status === 'active', 'credential_unavailable', 'profile credential is unavailable', { status: 409 });
    try {
      await this.repository.activateCodexProfile({ id: profileId, expectedRevision, timestamp: this.clock(), actor: ctx.actor });
    } catch (error) {
      throw normalizeRevisionError(error, current.revision);
    }
    return this.repository.codexProfile(profileId);
  }

  async activeProfileSnapshot({ includeSecret = false } = {}) {
    const profile = await this.repository.activeCodexProfile();
    if (!profile || profile.credential_status !== 'active') return null;
    const snapshot = {
      profile_id: profile.id,
      profile_revision: profile.revision,
      profile_hash: stableProfileHash(profile, this.config.runnerDigest),
      config_hash: profile.config_hash,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      base_url: profile.base_url,
      wire_api: profile.wire_api,
      reasoning: profile.reasoning,
      timeout_ms: profile.timeout_ms,
      auth_kind: profile.auth_kind,
      credential_ref: profile.credential_ref,
      credential_revision: profile.current_credential_revision,
      runner_digest: this.config.runnerDigest
    };
    if (includeSecret) snapshot.secret = await this.credentialSecret(profile.credential_ref);
    return snapshot;
  }

  async recordCodexProbe(profileId, expectedRevision, result) {
    const profile = await this.requiredProfile(profileId);
    const probeHash = this.codexProbeHash(profile);
    try {
      await this.repository.finishCodexProbe({
        id: profileId,
        expectedRevision,
        status: result?.status === 'available' ? 'available' : 'unavailable',
        probeHash,
        result,
        runnerDigest: this.config.runnerDigest,
        timestamp: this.clock()
      });
    } catch (error) {
      throw normalizeRevisionError(error, profile.revision);
    }
    return this.repository.codexProfile(profileId);
  }

  async createGithubApp(input = {}, ctx = {}) {
    const label = String(input?.label || '').trim();
    const appId = String(input?.app_id || '').trim();
    const clientId = String(input?.client_id || '').trim();
    assert(label.length >= 1 && label.length <= 120, 'invalid_input', 'GitHub App label is required', { status: 422 });
    assert(/^[1-9][0-9]{0,19}$/.test(appId), 'invalid_input', 'GitHub App id is invalid', { status: 422 });
    assert(clientId.length <= 200 && !/[\r\n\0]/.test(clientId), 'invalid_input', 'GitHub client id is invalid', { status: 422 });
    const privateKey = await this.requiredCredential(String(input?.private_key_ref || ''));
    const webhook = await this.requiredCredential(String(input?.webhook_secret_ref || ''));
    assert(privateKey.kind === 'github_app_private_key' && privateKey.status === 'active', 'invalid_input', 'active GitHub App private key is required', { status: 422 });
    assert(webhook.kind === 'github_webhook_secret' && webhook.status === 'active', 'invalid_input', 'active GitHub webhook secret is required', { status: 422 });
    const appConfigId = id('gha');
    await this.repository.createGithubApp({
      id: appConfigId,
      label,
      appId,
      clientId,
      privateKeyId: privateKey.id,
      webhookSecretId: webhook.id,
      timestamp: this.clock()
    }, ctx.actor);
    return this.repository.githubApp(appConfigId);
  }

  async listGithubApps() {
    const apps = await this.repository.githubApps();
    return Promise.all(apps.map(async (app) => ({
      ...app,
      installations: await this.installationsWithRepositories(app.id)
    })));
  }

  async createGithubInstallation(appConfigId, input = {}, ctx = {}) {
    const app = await this.requiredGithubApp(appConfigId);
    const expectedRevision = expected(input);
    const installationId = String(input?.installation_id || '').trim();
    const accountLogin = String(input?.account_login || '').trim();
    const permissions = normalizePermissions(input?.permissions);
    const repositories = normalizeRepositories(input?.repositories);
    assert(/^[1-9][0-9]{0,19}$/.test(installationId), 'invalid_input', 'GitHub installation id is invalid', { status: 422 });
    assert(accountLogin.length >= 1 && accountLogin.length <= 120 && !/[\r\n\0]/.test(accountLogin), 'invalid_input', 'GitHub account login is invalid', { status: 422 });
    const installation = id('ghi');
    try {
      await this.repository.createGithubInstallation({
        id: installation,
        appConfigId,
        installationId,
        accountLogin,
        permissions,
        repositories,
        status: permissionsReady(permissions) ? 'available' : 'blocked',
        errorCode: permissionsReady(permissions) ? '' : 'github_permission_missing',
        timestamp: this.clock()
      }, expectedRevision, ctx.actor);
    } catch (error) {
      if (String(error?.message).includes('UNIQUE')) throw new AppError('github_installation_exists', 'GitHub installation already exists', { status: 409 });
      throw normalizeRevisionError(error, app.revision);
    }
    return this.repository.githubInstallation(installation);
  }

  async recordGithubProbe(appConfigId, expectedRevision, result) {
    const app = await this.requiredGithubApp(appConfigId);
    const bundle = await this.githubBundle(appConfigId);
    const probeHash = this.githubProbeHash(app, bundle.installations, bundle.repositories);
    try {
      await this.repository.verifyGithubApp({
        id: appConfigId,
        expectedRevision,
        slug: String(result?.slug || '').slice(0, 120),
        status: result?.status === 'available' ? 'available' : 'unavailable',
        probeHash,
        result,
        timestamp: this.clock()
      });
    } catch (error) {
      throw normalizeRevisionError(error, app.revision);
    }
    return this.repository.githubApp(appConfigId);
  }

  async setupState() {
    await this.expireCredentials();
    const [record, owner, credentials, profiles, apps, installations, repositories] = await Promise.all([
      this.repository.setup(),
      this.identity.account(),
      this.repository.credentials(),
      this.repository.codexProfiles(),
      this.repository.githubApps(),
      this.repository.githubInstallations(),
      this.repository.githubRepositories()
    ]);
    const activeCredential = credentials.find((row) => row.provider === 'codex' && row.status === 'active');
    const profile = profiles.find((row) => row.is_active && row.credential_status === 'active');
    const verifiedApp = apps.find((row) => row.status === 'verified' && row.private_key_status === 'active' && row.webhook_status === 'active');
    const appInstallations = installations.filter((row) => row.app_config_id === verifiedApp?.id);
    const appRepositories = appInstallations.flatMap((installation) => {
      const stored = repositories.filter((row) => row.installation_id === installation.id);
      return stored.length ? stored : Array.isArray(installation.repositories) ? installation.repositories : [];
    });
    const availableInstallations = appInstallations.filter((row) => row.status === 'available');
    const repositoryReady = availableInstallations.some((installation) => {
      const stored = repositories.filter((row) => row.installation_id === installation.id);
      const selected = stored.length ? stored : Array.isArray(installation.repositories) ? installation.repositories : [];
      return permissionsReady(installation.permissions) && selected.some((row) => row.selected !== false);
    });
    const checks = {
      owner: owner?.status === 'active',
      active_codex_credential: Boolean(activeCredential),
      active_codex_profile: Boolean(profile),
      current_codex_probe: Boolean(profile && profile.probe_status === 'available' && profile.probe_hash === this.codexProbeHash(profile)),
      verified_github_app: Boolean(verifiedApp),
      active_github_installation: availableInstallations.length > 0,
      repository_permissions: repositoryReady,
      current_github_probe: Boolean(verifiedApp && verifiedApp.probe_status === 'available' && verifiedApp.probe_hash === this.githubProbeHash(verifiedApp, appInstallations, appRepositories))
    };
    const blockers = Object.entries(checks).filter(([, ready]) => !ready).map(([check]) => check);
    const ready = blockers.length === 0;
    return {
      id: record.id,
      status: ready ? 'ready' : 'blocked',
      complete: Boolean(record.completed_at && ready),
      can_complete: ready,
      completed_at: record.completed_at,
      revision: record.revision,
      checks,
      blockers,
      owner,
      credentials: credentials.map(publicCredential),
      codex_profiles: profiles,
      github_apps: await this.listGithubApps()
    };
  }

  async completeSetup(input = {}, ctx = {}) {
    const expectedRevision = expected(input);
    const state = await this.setupState();
    if (!state.can_complete) throw new AppError('setup_not_ready', 'setup checks are not ready', { status: 409, details: { revision: state.revision, blockers: state.blockers } });
    try {
      await this.repository.completeSetup({ expectedRevision, checks: state.checks, timestamp: this.clock(), actor: ctx.actor });
    } catch (error) {
      throw normalizeRevisionError(error, state.revision);
    }
    return this.setupState();
  }

  setupEvents(after = 0) {
    return this.repository.setupEvents(after);
  }

  async assertReady(command) {
    const state = await this.setupState();
    if (state.status !== 'ready' || !state.complete) throw new AppError('setup_not_ready', `setup blocks ${command}`, {
      status: 409,
      details: { revision: state.revision, blockers: state.blockers.length ? state.blockers : ['setup_incomplete'] }
    });
    return state;
  }

  codexProbeHash(profile) {
    return hashJson({ runtime_id: this.runtimeId, profile_hash: stableProfileHash(profile, this.config.runnerDigest), credential_revision: profile.current_credential_revision, runner_digest: this.config.runnerDigest });
  }

  githubProbeHash(app, installations, repositories) {
    return hashJson({
      runtime_id: this.runtimeId,
      app_id: app.id,
      app_revision: app.revision,
      private_key_revision: app.private_key_revision,
      webhook_revision: app.webhook_revision,
      installations: installations.map((row) => ({ id: row.id, revision: row.revision, status: row.status, permissions: row.permissions })),
      repositories: repositories.map((row) => ({ id: row.id || row.github_id || row.full_name, revision: row.revision || 1, selected: row.selected !== false }))
    });
  }

  async validatedProfile(input) {
    const label = String(input?.label || '').trim();
    const provider = String(input?.provider || 'openai').trim().toLowerCase();
    const model = String(input?.model || '').trim();
    const baseUrl = normalizeBaseUrl(input?.base_url, provider);
    const wireApi = String(input?.wire_api || 'responses').trim();
    const reasoning = String(input?.reasoning || 'medium').trim();
    const timeoutMs = Number(input?.timeout_ms ?? 120000);
    const credential = await this.requiredCredential(String(input?.credential_ref || ''));
    assert(label.length >= 1 && label.length <= 120, 'invalid_input', 'profile label is required', { status: 422 });
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider), 'invalid_input', 'profile provider is invalid', { status: 422 });
    assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model), 'invalid_input', 'profile model is invalid', { status: 422 });
    assert(['responses', 'chat'].includes(wireApi), 'invalid_input', 'profile wire API is invalid', { status: 422 });
    assert(['low', 'medium', 'high'].includes(reasoning), 'invalid_input', 'profile reasoning is invalid', { status: 422 });
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 5000 && timeoutMs <= 15 * 60 * 1000, 'invalid_input', 'profile timeout is invalid', { status: 422 });
    assert(credential.provider === 'codex' && credential.status === 'active', 'invalid_input', 'active Codex credential is required', { status: 422 });
    const authKind = credential.kind === 'codex_oauth_bundle' ? 'oauth_bundle' : 'api_key';
    const configHash = profileConfigurationHash({
      label,
      provider,
      model,
      base_url: baseUrl,
      wire_api: wireApi,
      reasoning,
      timeout_ms: timeoutMs,
      credential_ref: credential.id
    }, credential.revision);
    return {
      label, provider, model, baseUrl, wireApi, reasoning, timeoutMs,
      credentialId: credential.id,
      credentialRevision: credential.revision,
      authKind,
      configHash,
      runnerDigest: this.config.runnerDigest
    };
  }

  async requiredCredential(idValue) {
    await this.expireCredentials();
    const value = await this.repository.credential(String(idValue || ''));
    if (!value) throw new AppError('not_found', 'credential not found');
    return value;
  }

  async requiredProfile(idValue) {
    const value = await this.repository.codexProfile(String(idValue || ''));
    if (!value) throw new AppError('not_found', 'Codex profile not found');
    return value;
  }

  async requiredGithubApp(idValue) {
    const value = await this.repository.githubApp(String(idValue || ''));
    if (!value) throw new AppError('not_found', 'GitHub App not found');
    return value;
  }

  async installationsWithRepositories(appId) {
    const installations = await this.repository.githubInstallations(appId);
    return Promise.all(installations.map(async (installation) => ({
      ...installation,
      repositories: (await this.repository.githubRepositories(installation.id)).length
        ? await this.repository.githubRepositories(installation.id)
        : installation.repositories
    })));
  }

  async githubBundle(appId) {
    const installations = await this.repository.githubInstallations(appId);
    const repositories = (await Promise.all(installations.map(async (installation) => {
      const stored = await this.repository.githubRepositories(installation.id);
      return stored.length ? stored : installation.repositories || [];
    }))).flat();
    return { installations, repositories };
  }
}

function publicCredential(row) {
  if (!row) return null;
  const { secret_ref: _secretRef, ...metadata } = row;
  return { ...metadata, vault_backed: metadata.origin !== 'secret_bundle' };
}

function credentialKind(input) {
  const explicit = String(input?.kind || '').trim();
  if (CREDENTIAL_KINDS.has(explicit)) return explicit;
  const provider = String(input?.provider || '').trim();
  if (provider === 'codex') return 'codex_api_key';
  if (provider === 'github' && /private/i.test(String(input?.label || ''))) return 'github_app_private_key';
  if (provider === 'github') return 'github_webhook_secret';
  throw new AppError('invalid_input', 'credential kind is invalid', { status: 422 });
}

function validateSecret(kind, value) {
  const secret = typeof value === 'string' ? value : '';
  assert(secret.length >= 1 && Buffer.byteLength(secret) <= 64 * 1024 && !secret.includes('\0'), 'invalid_input', 'credential secret is invalid', { status: 422 });
  if (kind === 'codex_oauth_bundle') {
    let bundle;
    try { bundle = JSON.parse(secret); } catch { throw new AppError('invalid_input', 'OAuth bundle must be JSON', { status: 422 }); }
    assert(bundle && typeof bundle === 'object' && !Array.isArray(bundle), 'invalid_input', 'OAuth bundle must be an object', { status: 422 });
  }
  return secret;
}

function expiration(value, current) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  assert(Number.isFinite(parsed) && parsed > Date.parse(current), 'invalid_input', 'credential expires_at must be in the future', { status: 422 });
  return new Date(parsed).toISOString();
}

function expected(input) {
  const value = Number(input?.expected_revision);
  assert(Number.isInteger(value) && value > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
  return value;
}

function normalizeRevisionError(error, currentRevision) {
  if (String(error?.message).includes('transaction_precondition_failed') || String(error?.message).includes('EEXIST')) {
    return new AppError('revision_conflict', 'resource revision changed', { status: 409, details: { current_revision: Number(currentRevision) } });
  }
  return error;
}

function normalizeCredentialError(error) {
  if (error instanceof AppError) return error;
  if (String(error?.message).startsWith('credential_')) return new AppError(String(error.message), 'credential could not be stored', { status: 422 });
  return error;
}

function normalizeBaseUrl(value, provider) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (provider === 'openai') {
    assert(!raw, 'invalid_input', 'official OpenAI profile does not accept a custom Base URL', { status: 422 });
    return '';
  }
  let url;
  try { url = new URL(raw); } catch { throw new AppError('invalid_input', 'profile Base URL is invalid', { status: 422 }); }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && loopback), 'invalid_input', 'profile Base URL must use HTTPS or loopback HTTP', { status: 422 });
  assert(!url.username && !url.password && !url.search && !url.hash, 'invalid_input', 'profile Base URL contains unsupported credentials or query data', { status: 422 });
  return url.href.replace(/\/$/, '');
}

function stableProfileHash(profile, runnerDigest = profile.runner_digest) {
  return hashJson({
    id: profile.id || profile.profile_id,
    revision: Number(profile.revision || profile.profile_revision),
    config_hash: profile.config_hash,
    credential_ref: profile.credential_ref,
    credential_revision: Number(profile.current_credential_revision || profile.credential_revision),
    runner_digest: runnerDigest
  });
}

function profileConfigurationHash(profile, credentialRevision) {
  return hashJson({
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    base_url: profile.base_url ?? profile.baseUrl ?? '',
    wire_api: profile.wire_api ?? profile.wireApi ?? 'responses',
    reasoning: profile.reasoning,
    timeout_ms: Number(profile.timeout_ms ?? profile.timeoutMs),
    credential_ref: profile.credential_ref ?? profile.credentialId,
    credential_revision: Number(credentialRevision)
  });
}

function normalizePermissions(value) {
  const permissions = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(permissions).slice(0, 100).map(([key, access]) => [String(key).slice(0, 100), String(access).slice(0, 20)]));
}

function normalizeRepositories(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).map((repository) => ({
    github_id: String(repository?.github_id || repository?.id || '').slice(0, 40),
    full_name: String(repository?.full_name || '').slice(0, 240),
    selected: repository?.selected !== false
  })).filter((repository) => repository.github_id && /^[^/]+\/[^/]+$/.test(repository.full_name));
}

function permissionsReady(permissions) {
  return permissions?.metadata === 'read' && permissions?.contents === 'write' && permissions?.pull_requests === 'write';
}
