import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { removeIsolatedProviderTree } from './app-server-adapter.mjs';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_BYTES = 512 * 1024;
const MAX_DEVICE_OUTPUT_BYTES = 64 * 1024;
const DEVICE_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired', 'interrupted']);
const DEVICE_URL_PATTERN = /https?:\/\/[^\s<>"']+/i;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3}\b/i;

export class CleanLocalSetupService {
  constructor({ config = {}, db, identity, operations, clock = () => new Date().toISOString(), deviceLoginRunner = null, spawnImpl = spawn } = {}) {
    if (!db || !identity || !operations) throw new TypeError('local_setup_dependencies_required');
    this.config = config;
    this.db = db;
    this.identity = identity;
    this.operations = operations;
    this.clock = clock;
    this.deviceLoginRunner = deviceLoginRunner;
    this.spawn = spawnImpl;
    this.discoveryKey = String(config.providerDiscoverySecret || config.sessionSecret || 'v3-clean-local-discovery');
    this.roots = normalizeDiscoveryRoots(config.codexDiscoveryRoots);
    this.deviceRoot = path.resolve(String(config.providerHomeRoot || path.join(config.home || os.tmpdir(), 'provider-homes')), 'device-login');
    this.deviceJobs = new Map();
    this.closed = false;
  }

  discoverCodex(_input = {}, principal) {
    requirePrincipal(principal);
    return { sources: this.roots.map((root) => {
      const scanned = scanCodexRoot(root, this.discoveryKey);
      const view = publicSource(scanned);
      clearPrivateRecords(scanned);
      return view;
    }) };
  }

  async importCodex(input = {}, principal) {
    requirePrincipal(principal);
    if (input.confirmed !== true) throw new PlatformError('confirmation_required', 'Codex discovery import requires confirmation', {}, 400);
    const root = this.roots.find((candidate) => sourceId(candidate, this.discoveryKey) === String(input.source_id || ''));
    if (!root) throw new PlatformError('discovery_source_not_found', 'Codex discovery source was not found', {}, 404);
    let scanned = null;
    let fallbackSecret = null;
    let lease = null;
    try {
      scanned = scanCodexRoot(root, this.discoveryKey);
      if (scanned.source_revision !== String(input.source_revision || '')) {
        throw new PlatformError('discovery_source_stale', 'Codex discovery source changed', { source_id: scanned.id, current_revision: scanned.source_revision }, 409);
      }
      const selected = scanned.privateRecords.get(String(input.record_id || ''));
      if (!selected) throw new PlatformError('discovery_record_not_found', 'Codex discovery record was not found', {}, 404);
      let selectedForBind = selected;
      if ((selected.authType === 'keyring_only' || !selected.secret?.length) && input.api_key != null) {
        fallbackSecret = Buffer.from(String(input.api_key), 'utf8');
        if (!fallbackSecret.length || fallbackSecret.length > MAX_AUTH_BYTES) throw new PlatformError('schema_invalid', 'Codex API key is invalid', {}, 422);
        selectedForBind = { ...selected, authType: 'api_key', secret: fallbackSecret };
      }
      if (!selectedForBind.secret?.length) {
        throw new PlatformError('device_login_required', 'Codex keyring credentials require Device Login', { auth_type: selected.authType }, 409);
      }
      lease = Buffer.from(selectedForBind.secret);
      return await this.#bindCodexCredential({ selected: selectedForBind, source: scanned, input, origin: 'discovery' }, principal, lease);
    } finally {
      lease?.fill(0);
      fallbackSecret?.fill(0);
      clearPrivateRecords(scanned);
    }
  }

  async startDeviceLogin(input = {}, principal) {
    requirePrincipal(principal);
    if (this.closed) throw new PlatformError('not_ready', 'local setup service is closing', {}, 503);
    const id = opaqueId('codex_login');
    const operation = await this.operations.create({
      actorId: principal.actorId,
      commandId: 'provider.codex.device_login.start',
      kind: 'provider.codex.device_login',
      idempotencyKey: String(input.idempotency_key || ''),
      request: { label: bounded(input.label || 'Codex Device Login', 120) },
      resourceType: 'provider_device_login',
      resourceId: id
    });
    if (operation.replayed) {
      const prior = this.deviceJobs.get(operation.resource_id);
      return { login: prior ? this.#deviceView(prior) : loginFromOperation(operation), operation };
    }
    const job = {
      id,
      actorId: principal.actorId,
      operationId: operation.operation_id,
      label: bounded(input.label || 'Codex Device Login', 120),
      profileLabel: bounded(input.profile_label || input.label || 'Codex', 120),
      model: bounded(input.model || '', 160),
      status: 'starting',
      verificationUrl: null,
      userCode: null,
      errorCode: null,
      profileId: null,
      credentialId: null,
      home: null,
      child: null,
      createdAt: this.#time(),
      updatedAt: this.#time()
    };
    this.deviceJobs.set(id, job);
    this.operations.registerExecutor(operation.operation_id, async (context) => {
      try {
        return await this.#runDeviceLogin(job, input, principal, context);
      } catch (error) {
        if (!DEVICE_TERMINAL.has(job.status)) job.status = context.signal.aborted ? 'cancelled' : stableDeviceStatus(error);
        job.errorCode = stableDeviceError(error, job.status);
        job.updatedAt = this.#time();
        throw error;
      } finally {
        await this.#cleanupDeviceJob(job);
      }
    });
    return { login: this.#deviceView(job), operation };
  }

  deviceLogin(id, principal) {
    requirePrincipal(principal);
    const key = String(id || '');
    const job = this.deviceJobs.get(key);
    const operation = job
      ? this.operations.get(job.operationId, { actorId: principal.actorId })
      : this.#deviceOperation(key, principal);
    return { login: job ? this.#deviceView(job, operation) : loginFromOperation(operation), operation };
  }

  async cancelDeviceLogin(id, input = {}, principal) {
    requirePrincipal(principal);
    const job = this.deviceJobs.get(String(id || ''));
    if (!job) throw new PlatformError('device_login_not_found', 'Codex Device Login was not found', {}, 404);
    const operation = this.operations.get(job.operationId, { actorId: principal.actorId });
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status)) {
      return { login: this.#deviceView(job, operation), operation };
    }
    const requested = await this.operations.requestCancel(job.operationId, {
      actorId: principal.actorId,
      expectedRevision: Number(input.expected_revision),
      idempotencyKey: String(input.idempotency_key || ''),
      requestHash: sha256Hex(canonicalJson({ id: job.id, expected_revision: Number(input.expected_revision) })),
      reason: bounded(input.reason || 'user_cancelled', 200)
    });
    job.status = 'cancelled';
    job.errorCode = 'device_login_cancelled';
    job.updatedAt = this.#time();
    this.operations.abort(job.operationId);
    try { job.child?.kill?.(); } catch { /* operation abort remains authoritative */ }
    return { login: this.#deviceView(job, requested), operation: requested };
  }

  async recover() {
    fs.mkdirSync(this.deviceRoot, { recursive: true, mode: 0o700 });
    const pending = this.operations.listByCommand('provider.codex.device_login.start', {
      statuses: ['accepted', 'queued', 'running', 'paused']
    });
    for (const row of pending) {
      const job = {
        id: row.resource_id,
        actorId: row.actor_id,
        operationId: row.operation_id,
        label: 'Codex Device Login',
        profileLabel: 'Codex',
        model: '',
        status: 'interrupted',
        verificationUrl: null,
        userCode: null,
        errorCode: 'device_login_interrupted',
        profileId: null,
        credentialId: null,
        home: null,
        child: null,
        createdAt: row.created_at,
        updatedAt: this.#time()
      };
      this.deviceJobs.set(job.id, job);
      await this.operations.run(row.operation_id, async () => { throw new PlatformError('device_login_interrupted', 'Codex Device Login was interrupted by restart', {}, 409); });
    }
    for (const entry of fs.readdirSync(this.deviceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await removeIsolatedProviderTree(path.join(this.deviceRoot, entry.name));
    }
    return pending.length;
  }

  async close() {
    this.closed = true;
    for (const job of this.deviceJobs.values()) {
      if (!DEVICE_TERMINAL.has(job.status)) {
        job.status = 'interrupted';
        job.errorCode = 'device_login_interrupted';
        this.operations.abort(job.operationId);
        try { job.child?.kill?.(); } catch { /* cleanup below owns removal */ }
      }
      await this.#cleanupDeviceJob(job);
    }
  }

  async #runDeviceLogin(job, input, principal, context) {
    fs.mkdirSync(this.deviceRoot, { recursive: true, mode: 0o700 });
    job.home = fs.mkdtempSync(path.join(this.deviceRoot, 'login-'));
    fs.writeFileSync(path.join(job.home, 'request.json'), canonicalJson({ id: job.id, operation_id: job.operationId, status: 'running' }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    job.status = 'waiting_for_user';
    job.updatedAt = this.#time();
    const onEvent = (event) => {
      if (event?.verification_url) job.verificationUrl = event.verification_url;
      if (event?.user_code) job.userCode = event.user_code;
      if (event?.status) job.status = event.status === 'authorized' ? 'binding' : event.status;
      job.updatedAt = this.#time();
    };
    if (this.deviceLoginRunner) {
      await this.deviceLoginRunner({ home: job.home, signal: context.signal, onEvent });
    } else {
      await runCodexDeviceLogin({
        command: this.config.providerCommand || 'codex',
        home: job.home,
        timeoutMs: Math.max(30_000, Math.min(15 * 60 * 1000, Number(input.timeout_ms || 10 * 60 * 1000))),
        signal: context.signal,
        onEvent,
        spawnImpl: this.spawn
      });
    }
    context.ensureActive();
    job.status = 'binding';
    const auth = readStrictFile(path.join(job.home, 'auth.json'), MAX_AUTH_BYTES, { required: true });
    const selected = authRecord(Buffer.from(auth), {}, 'Device Login');
    selected.id = `codex_device_${hmac(this.discoveryKey, `record\0${job.id}`).slice(0, 24)}`;
    if (selected.authType !== 'chatgpt' || !selected.secret.length) {
      selected.secret.fill(0);
      throw new PlatformError('device_login_auth_invalid', 'Device Login did not produce a ChatGPT auth bundle', {}, 409);
    }
    try {
      const bound = await this.#bindCodexCredential({
        selected,
        source: { id: job.id, source_revision: hmac(this.discoveryKey, `device\0${job.id}`) },
        input: { label: job.label, profile_label: job.profileLabel, model: job.model, idempotency_key: derivedKey(input.idempotency_key, 'bind'), expected_revision: 0 },
        origin: 'device_auth'
      }, principal, selected.secret);
      job.status = 'completed';
      job.profileId = bound.profile.id;
      job.credentialId = bound.credential.id;
      job.updatedAt = this.#time();
      return { login_id: job.id, status: job.status, profile_id: job.profileId, credential_id: job.credentialId };
    } finally {
      selected.secret.fill(0);
      auth.fill(0);
    }
  }

  async #bindCodexCredential({ selected, source, input, origin = 'discovery' }, principal, lease) {
    const recordScope = { auth_type: selected.authType, discovery_record_id: selected.id, discovery_source_id: source.id };
    let credential = this.identity.credentials(principal).find((item) => item.provider === 'codex' && item.scope?.discovery_record_id === selected.id && item.status !== 'revoked');
    if (!credential) {
      const created = await this.identity.createCredential({
        provider: 'codex', scope: recordScope, external_ref: `codex:${source.id}:${selected.id}`,
        origin, idempotency_key: derivedKey(input.idempotency_key, 'credential')
      }, principal);
      credential = created.credential;
    }
    const bindInput = { proof: lease, expected_revision: credential.revision, idempotency_key: derivedKey(input.idempotency_key, 'secret') };
    const binding = credential.status === 'active'
      ? await this.identity.rotateCredential(credential.id, bindInput, principal)
      : await this.identity.rebindCredential(credential.id, bindInput, principal);
    if (binding.status !== 'succeeded') throw new PlatformError(binding.error_code || 'credential_bind_failed', 'Codex credential binding failed', {}, 409);
    credential = this.identity.credentials(principal).find((item) => item.id === credential.id);
    const config = {
      model: bounded(input.model || selected.model || '', 160),
      model_provider: bounded(selected.provider || 'openai', 80),
      wire_api: selected.wireApi,
      reasoning_effort: selected.reasoning,
      auth_type: selected.authType,
      discovery_record_id: selected.id,
      discovery_source_id: source.id,
      ...(selected.baseUrl ? { provider_definition: { base_url: selected.baseUrl, wire_api: selected.wireApi, requires_openai_auth: true } } : {})
    };
    let profile = this.identity.profiles(principal).find((item) => item.provider === 'codex' && item.config?.discovery_record_id === selected.id && item.lifecycle_status !== 'disabled');
    if (profile) {
      const updated = await this.identity.updateProfile(profile.id, {
        label: bounded(input.profile_label || input.label || selected.label || 'Codex', 160), credential_ref_id: credential.id,
        config, expected_revision: profile.revision, idempotency_key: derivedKey(input.idempotency_key, 'profile-update')
      }, principal);
      profile = updated.profile;
    } else {
      const created = await this.identity.createProfile({
        provider: 'codex', label: bounded(input.profile_label || input.label || selected.label || 'Codex', 160),
        credential_ref_id: credential.id, config, idempotency_key: derivedKey(input.idempotency_key, 'profile-create')
      }, principal);
      profile = created.profile;
    }
    const probe = await this.identity.probeProfile(profile.id, { expected_revision: profile.revision, idempotency_key: derivedKey(input.idempotency_key, 'probe') }, principal);
    profile = this.identity.profiles(principal).find((item) => item.id === profile.id);
    return {
      source_id: source.id,
      source_revision: source.source_revision,
      credential,
      profile,
      probe,
      auth_type: selected.authType
    };
  }

  #deviceView(job, operation = null) {
    const current = operation || this.operations.get(job.operationId, { actorId: job.actorId });
    const status = operationStatusToLogin(current.status, job.status);
    return {
      id: job.id,
      status,
      verification_uri: status === 'waiting_for_user' ? job.verificationUrl : null,
      user_code: status === 'waiting_for_user' ? job.userCode : null,
      profile_id: job.profileId,
      credential_id: job.credentialId,
      error_code: current.error_code || job.errorCode,
      revision: current.revision,
      created_at: job.createdAt,
      updated_at: job.updatedAt
    };
  }

  #deviceOperation(id, principal) {
    const operation = this.operations.findByResource('provider_device_login', String(id || ''), { actorId: principal.actorId });
    if (!operation) throw new PlatformError('device_login_not_found', 'Codex Device Login was not found', {}, 404);
    return operation;
  }

  async #cleanupDeviceJob(job) {
    const home = job.home;
    job.home = null;
    job.child = null;
    if (home) await removeIsolatedProviderTree(home);
  }

  #time() {
    const value = typeof this.clock === 'function' ? this.clock() : this.clock;
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
}

export function normalizeDiscoveryRoots(input) {
  const configured = Array.isArray(input) && input.length
    ? input
    : [{ hint: '~/.codex', path: path.join(os.homedir(), '.codex'), priority: 3 }];
  const unique = new Map();
  for (const [index, item] of configured.entries()) {
    const configuredType = String(item?.type || '').trim().toLowerCase();
    // Clean setup discovers Codex homes only. Historical provider switch
    // sources are deliberately ignored at this boundary.
    if (configuredType && configuredType !== 'codex_home') continue;
    const candidate = String(item?.path || '');
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const resolved = path.resolve(candidate);
    const key = normalizePath(resolved);
    const rawHint = String(item?.hint || item?.source_hint || item?.type || '');
    const hint = ['AIWS_HOST_CODEX_HOME', 'CODEX_HOME', '~/.codex'].includes(rawHint)
      ? rawHint
      : '~/.codex';
    if (!unique.has(key)) unique.set(key, {
      hint,
      displayName: discoveryLabel(item?.display_name || item?.label || hint, hint),
      path: resolved,
      priority: Number.isInteger(Number(item?.priority)) ? Number(item.priority) : index + 1
    });
  }
  return Object.freeze([...unique.values()].sort((left, right) => left.priority - right.priority).map((value) => Object.freeze(value)));
}

export function scanCodexRoot(root, key) {
  const id = sourceId(root, key);
  const privateRecords = new Map();
  let status = 'available';
  let errorCode = null;
  let contentDigest = sha256Hex(`missing\0${root.hint}`);
  let config = null;
  let auth = null;
  try {
    assertStrictDirectory(root.path);
    config = readStrictFile(path.join(root.path, 'config.toml'), MAX_CONFIG_BYTES);
    auth = readStrictFile(path.join(root.path, 'auth.json'), MAX_AUTH_BYTES);
    const digest = createHash('sha256');
    digest.update('codex-home-v2\0');
    for (const [name, bytes] of [['config.toml', config], ['auth.json', auth]]) {
      digest.update(name).update('\0');
      if (bytes) digest.update(bytes);
      digest.update('\0');
    }
    contentDigest = digest.digest('hex');
    const configValue = parseConfig(config);
    const selected = authRecord(auth, configValue, 'Host Codex');
    selected.id = `codex_record_${hmac(key, `record\0${id}\0default`).slice(0, 24)}`;
    privateRecords.set(selected.id, selected);
  } catch (error) {
    status = error?.code === 'ENOENT' ? 'unavailable' : 'invalid';
    errorCode = status === 'unavailable' ? 'codex_home_missing' : stableDiscoveryError(error);
  } finally {
    config?.fill(0);
    auth?.fill(0);
  }
  const sourceRevision = hmac(key, `revision\0${id}\0${contentDigest}`);
  const records = [...privateRecords.values()].map(publicRecord);
  return {
    id,
    type: 'codex_home',
    source_type: 'codex_home',
    display_name: root.displayName || root.hint,
    source_hint: root.hint,
    path_hint: root.hint,
    priority: root.priority,
    source_revision: sourceRevision,
    status,
    error_code: errorCode,
    records,
    privateRecords
  };
}

export function readStrictFile(file, maximum, { required = false } = {}) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (!required && error?.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw codedError('discovery_file_invalid');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size || opened.size > maximum || !sameFile(before, opened)) throw codedError('discovery_file_race');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== bytes.length || !sameFile(opened, after)) throw codedError('discovery_file_race');
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

async function runCodexDeviceLogin({ command, home, timeoutMs, signal, onEvent, spawnImpl }) {
  const executable = resolveCodexCommand(command);
  const child = spawnImpl(executable, ['login', '--device-auth'], {
    env: { ...providerEnvironment(process.env), CODEX_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32' && /\.cmd$/i.test(executable)
  });
  let outputBytes = 0;
  let pending = '';
  const consume = (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > MAX_DEVICE_OUTPUT_BYTES) { try { child.kill(); } catch {} return; }
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      const event = parseCodexDeviceAuthLine(line);
      if (event) onEvent(event);
    }
  };
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on?.('data', consume);
  child.stderr?.on?.('data', consume);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => { try { child.kill(); } catch {} finish(new PlatformError('operation_cancelled', 'Device Login was cancelled', {}, 409)); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(new PlatformError('device_login_expired', 'Device Login expired', {}, 408)); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener?.('abort', abort, { once: true });
    child.once('error', (error) => finish(new PlatformError('device_login_unavailable', 'Codex Device Login process did not start', { reason: String(error?.code || 'spawn_failed') }, 503)));
    child.once('close', (code) => {
      if (pending) { const event = parseCodexDeviceAuthLine(pending); if (event) onEvent(event); }
      if (outputBytes > MAX_DEVICE_OUTPUT_BYTES) return finish(new PlatformError('device_login_output_exceeded', 'Codex Device Login output exceeded its bound', {}, 503));
      return Number(code) === 0 ? finish() : finish(new PlatformError('device_login_failed', 'Codex Device Login did not complete', { exit_status: Number(code) }, 409));
    });
  });
}

function authRecord(authBytes, config, fallbackLabel) {
  const auth = parseAuth(authBytes);
  const providerName = bounded(config?.model_provider || 'openai', 80);
  const provider = config?.model_providers?.[providerName] || {};
  const apiKey = typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()
    ? Buffer.from(auth.OPENAI_API_KEY, 'utf8')
    : typeof auth?.api_key === 'string' && auth.api_key.trim() ? Buffer.from(auth.api_key, 'utf8') : null;
  const tokens = auth?.tokens && typeof auth.tokens === 'object' ? auth.tokens : auth;
  const chatgpt = Boolean(tokens?.access_token || tokens?.refresh_token || String(auth?.auth_mode || '').toLowerCase() === 'chatgpt');
  const secret = apiKey || (chatgpt && authBytes ? Buffer.from(authBytes) : Buffer.alloc(0));
  const authType = apiKey ? 'api_key' : chatgpt ? 'chatgpt' : authBytes ? 'keyring_only' : 'none';
  return {
    id: '',
    label: bounded(config?.profile || fallbackLabel, 120),
    provider: providerName,
    model: bounded(config?.model || '', 160),
    baseUrl: safeBaseUrl(provider?.base_url || ''),
    wireApi: String(provider?.wire_api || 'responses').toLowerCase() === 'chat' ? 'chat' : 'responses',
    reasoning: ['low', 'medium', 'high', 'xhigh'].includes(String(config?.model_reasoning_effort || '')) ? String(config.model_reasoning_effort) : 'medium',
    authType,
    secret
  };
}

function publicRecord(record) {
  return {
    id: record.id,
    label: record.label,
    provider: record.provider,
    model: record.model,
    auth_type: record.authType,
    auth_kind: record.authType,
    credential_available: record.secret.length > 0,
    base_url_configured: Boolean(record.baseUrl),
    wire_api: record.wireApi,
    reasoning: record.reasoning
  };
}

function publicSource(source) {
  return {
    id: source.id,
    type: source.type || 'codex_home',
    source_type: source.source_type || 'codex_home',
    display_name: source.display_name || source.source_hint,
    source_hint: source.source_hint,
    path_hint: source.path_hint || source.source_hint,
    priority: source.priority,
    source_revision: source.source_revision,
    status: source.status,
    error_code: source.error_code,
    records: source.records
  };
}

function clearPrivateRecords(source) {
  for (const record of source?.privateRecords?.values?.() || []) record.secret?.fill(0);
}

function sourceId(root, key) {
  return `codex_source_${hmac(key, `source\0${root.hint}\0${normalizePath(root.path)}`).slice(0, 24)}`;
}

function parseConfig(bytes) {
  if (!bytes?.length) return {};
  try {
    const value = parseToml(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { throw codedError('codex_config_invalid'); }
}

function parseAuth(bytes) {
  if (!bytes?.length) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch { throw codedError('codex_auth_invalid'); }
}

function assertStrictDirectory(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError('discovery_root_invalid');
  if (normalizePath(root) !== normalizePath(fs.realpathSync(root))) throw codedError('discovery_root_invalid');
}

function sameFile(left, right) {
  if (Number.isInteger(left.ino) && Number.isInteger(right.ino) && left.ino && right.ino && left.ino !== right.ino) return false;
  if (Number.isInteger(left.dev) && Number.isInteger(right.dev) && left.dev !== right.dev) return false;
  return left.size === right.size && Number(left.mtimeMs) === Number(right.mtimeMs);
}

function safeBaseUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return '';
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}

function providerEnvironment(env) {
  const allowed = new Set(['ALLUSERSPROFILE','APPDATA','COMSPEC','HOME','HOMEDRIVE','HOMEPATH','LANG','LOCALAPPDATA','NODE_EXTRA_CA_CERTS','NO_PROXY','HTTPS_PROXY','HTTP_PROXY','PATH','PATHEXT','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','SHELL','SSL_CERT_DIR','SSL_CERT_FILE','SYSTEMDRIVE','SYSTEMROOT','TEMP','TMP','TMPDIR','TZ','USERPROFILE','WINDIR']);
  return Object.fromEntries(Object.entries(env || {}).filter(([name]) => allowed.has(String(name).toUpperCase())).map(([name, value]) => [name, String(value)]));
}

function resolveCodexCommand(command) {
  if (process.platform !== 'win32' || command !== 'codex') return command;
  const result = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && result.stdout.trim() ? 'codex.cmd' : command;
}

// Device-login output is treated as an untrusted line protocol. Keep only the
// verification URL/code and a bounded status; never retain raw process output.
function parseCodexDeviceAuthLine(value) {
  const line = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!line) return null;
  const rawUrl = line.match(DEVICE_URL_PATTERN)?.[0]?.replace(/[),.;]+$/, '') || '';
  let verification_url = null;
  try {
    const url = new URL(rawUrl);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
      url.search = '';
      url.hash = '';
      verification_url = url.href;
    }
  } catch { /* output may be an ordinary status line */ }
  const user_code = line.match(DEVICE_CODE_PATTERN)?.[0]?.toUpperCase() || null;
  if (verification_url || user_code) return { type: 'verification', verification_url, user_code, status: 'waiting_for_user' };
  if (/successfully logged in|authentication (?:complete|successful)|login successful/i.test(line)) return { type: 'status', status: 'authorized' };
  if (/expired|timed? out/i.test(line)) return { type: 'status', status: 'expired' };
  if (/denied|declined|cancelled|canceled/i.test(line)) return { type: 'status', status: 'cancelled' };
  if (/\b(?:error|failed|failure)\b/i.test(line)) return { type: 'status', status: 'failed' };
  return null;
}

function loginFromOperation(operation) {
  const status = operationStatusToLogin(operation.status, operation.result?.status);
  return {
    id: operation.resource_id,
    status,
    verification_uri: null,
    user_code: null,
    profile_id: operation.result?.profile_id || null,
    credential_id: operation.result?.credential_id || null,
    error_code: operation.error_code || null,
    revision: operation.revision,
    created_at: operation.created_at,
    updated_at: operation.updated_at
  };
}

function operationStatusToLogin(operationStatus, jobStatus) {
  if (operationStatus === 'succeeded') return 'completed';
  if (operationStatus === 'cancelled') return 'cancelled';
  if (operationStatus === 'expired') return 'expired';
  if (operationStatus === 'failed') return jobStatus === 'interrupted' ? 'interrupted' : 'failed';
  return jobStatus || 'starting';
}

function stableDeviceStatus(error) {
  return String(error?.code || '').includes('expired') ? 'expired' : String(error?.code || '').includes('cancel') ? 'cancelled' : 'failed';
}

function stableDeviceError(error, status) {
  const code = String(error?.code || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return /^device_login_[a-z0-9_]+$/.test(code) || code === 'operation_cancelled' ? code : `device_login_${status}`;
}

function stableDiscoveryError(error) {
  const code = String(error?.code || '').toLowerCase();
  return /^codex_|^discovery_/.test(code) ? code : 'discovery_source_invalid';
}

function hmac(key, value) {
  return createHmac('sha256', key).update(String(value), 'utf8').digest('hex');
}

function derivedKey(base, label) {
  return `local-${sha256Hex(`${String(base || '')}\0${label}`).slice(0, 48)}`;
}

function normalizePath(value) {
  const normalized = path.resolve(String(value)).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function bounded(value, maximum) {
  return String(value || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, maximum);
}

function discoveryLabel(value, fallback) {
  const label = bounded(value, 120);
  if (!label || /(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s]+[\\/])+[^\s]*/.test(label)) return fallback;
  return label;
}

function requirePrincipal(principal) {
  if (!principal?.actorId) throw new PlatformError('authentication_required', 'active session proof is required', {}, 401);
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function constantTimeBufferEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}
