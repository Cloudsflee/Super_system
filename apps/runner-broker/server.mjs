import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hashJson } from '../api/src/crypto.mjs';
import { AppError, asAppError } from '../api/src/errors.mjs';
import { buildDockerArgs, redactJobSpec, validateJobSpec } from './src/job-spec.mjs';
import { normalizeRunnerErrorCode } from './src/runner-result.mjs';
import { createReplayGuard } from './src/signature.mjs';
import { DEVELOPMENT_RUNNER_DIGEST } from '../../packages/contracts/src/index.mjs';
import { parseCodexDeviceAuthLine } from '../../packages/contracts/src/codex-device-auth.mjs';

const execFileAsync = promisify(execFile);
const SAFE_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DIGEST_IMAGE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:[a-f0-9]{64}$/i;
const CODEX_CLI_VERSION = '0.146.1';
const DEVICE_AUTH_RETENTION_MS = 15 * 60 * 1000;
const CODEX_RUNNER_SCRIPT = fileURLToPath(new URL('./codex-runner.mjs', import.meta.url));
export const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_TERMINAL_JOBS = 10_000;

function safeSummary(value, secrets = []) {
  return secrets.filter(Boolean).map(String).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value || '')).replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]').replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function safeEvents(value, secrets = []) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((event) => ({
    type: /^runner\.[a-z._-]{1,80}$/.test(String(event?.type || '')) ? String(event.type) : 'runner.unknown',
    phase: String(event?.phase || 'unknown').slice(0, 40),
    exit_code: Number.isInteger(event?.exit_code) ? event.exit_code : null,
    file_count: Number.isInteger(event?.file_count) ? event.file_count : null,
    summary: safeSummary(event?.summary, secrets),
    summary_sha256: /^[a-f0-9]{64}$/.test(String(event?.summary_sha256 || '')) ? String(event.summary_sha256) : null
  }));
}

function safePaths(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item).replaceAll('\\', '/')).filter((item) => item && !item.startsWith('/') && !/^[A-Za-z]:/.test(item) && !item.split('/').includes('..')).slice(0, 100);
}

function credentialSecrets(credential) {
  const values = [];
  if (credential?.auth) values.push(String(credential.auth));
  if (credential?.kind === 'codex_oauth_bundle') {
    try {
      const visit = (value, key = '') => {
        if (typeof value === 'string' && /(?:token|secret|key|auth)/i.test(key) && value.length >= 4) values.push(value);
        else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      };
      visit(JSON.parse(String(credential.auth || '{}')));
    } catch { /* Invalid bundles are rejected by the API before broker submission. */ }
  }
  return [...new Set(values)];
}

function validateProviderProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('invalid_job_spec', 'provider profile is invalid');
  const profile = {
    profile_id: String(value.profile_id || ''),
    profile_revision: Number(value.profile_revision),
    profile_hash: String(value.profile_hash || ''),
    config_hash: String(value.config_hash || ''),
    label: String(value.label || ''),
    provider: String(value.provider || ''),
    model: String(value.model || ''),
    base_url: String(value.base_url || '').replace(/\/+$/, ''),
    wire_api: String(value.wire_api || ''),
    reasoning: String(value.reasoning || ''),
    timeout_ms: Number(value.timeout_ms),
    auth_kind: String(value.auth_kind || 'api_key'),
    credential_ref: String(value.credential_ref || ''),
    credential_revision: Number(value.credential_revision),
    runner_digest: String(value.runner_digest || '')
  };
  if (!/^cdp_[A-Za-z0-9_-]{8,}$/.test(profile.profile_id) || !Number.isInteger(profile.profile_revision) || profile.profile_revision < 1 || !/^[a-f0-9]{64}$/.test(profile.profile_hash)) throw new AppError('invalid_job_spec', 'provider profile binding is invalid');
  if (!/^[a-f0-9]{64}$/.test(profile.config_hash)) throw new AppError('invalid_job_spec', 'provider profile configuration hash is invalid');
  if (!profile.label || profile.label.length > 120) throw new AppError('invalid_job_spec', 'provider profile label is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile.provider) || !SAFE_MODEL.test(profile.model)) throw new AppError('invalid_job_spec', 'provider profile model is invalid');
  if (!['responses', 'chat'].includes(profile.wire_api) || !['low', 'medium', 'high'].includes(profile.reasoning) || !Number.isInteger(profile.timeout_ms) || profile.timeout_ms < 5000 || profile.timeout_ms > 15 * 60 * 1000) throw new AppError('invalid_job_spec', 'provider profile configuration is invalid');
  if (!['api_key', 'oauth_bundle'].includes(profile.auth_kind) || !/^cred_[A-Za-z0-9_-]{8,}$/.test(profile.credential_ref) || !Number.isInteger(profile.credential_revision) || profile.credential_revision < 1) throw new AppError('invalid_job_spec', 'provider credential binding is invalid');
  if (profile.runner_digest !== value.runner_digest || !DIGEST.test(profile.runner_digest)) throw new AppError('invalid_job_spec', 'provider runner digest is invalid');
  const expectedConfigHash = hashJson({
    label: profile.label,
    provider: profile.provider,
    model: profile.model,
    base_url: profile.base_url,
    wire_api: profile.wire_api,
    reasoning: profile.reasoning,
    timeout_ms: profile.timeout_ms,
    credential_ref: profile.credential_ref,
    credential_revision: profile.credential_revision
  });
  if (profile.config_hash !== expectedConfigHash) throw new AppError('invalid_job_spec', 'provider profile configuration hash is invalid');
  const expectedHash = hashJson({
    id: profile.profile_id,
    revision: profile.profile_revision,
    config_hash: profile.config_hash,
    credential_ref: profile.credential_ref,
    credential_revision: profile.credential_revision,
    runner_digest: profile.runner_digest
  });
  if (profile.profile_hash !== expectedHash) throw new AppError('invalid_job_spec', 'provider profile hash is invalid');
  if (profile.base_url) {
    let url;
    try { url = new URL(profile.base_url); } catch { throw new AppError('invalid_job_spec', 'provider Base URL is invalid'); }
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new AppError('invalid_job_spec', 'provider Base URL is invalid');
  }
  return profile;
}

export function brokerConfig(env = process.env) {
  const dataVolume = env.AIWS_DOCKER_DATA_VOLUME || 'aiws-data-v3';
  if (!SAFE_VOLUME_NAME.test(dataVolume)) throw new Error('data_volume_name_invalid');
  if (/v(?:12|13|14|15|16|17|18|19|20|21|22|23)/i.test(dataVolume)) throw new Error('legacy_data_volume_forbidden');
  const production = env.NODE_ENV === 'production';
  const executor = env.AIWS_BROKER_EXECUTOR || 'mock';
  if (!['mock', 'docker', 'host'].includes(executor)) throw new Error('broker_executor_invalid');
  const secret = readSecret(env.AIWS_BROKER_HMAC_SECRET_FILE) || env.AIWS_BROKER_HMAC_SECRET || (production ? '' : 'dev-only-local-broker-secret');
  const runnerDigest = env.AIWS_RUNNER_DIGEST || (production || executor === 'docker' ? '' : DEVELOPMENT_RUNNER_DIGEST);
  const runnerImage = env.AIWS_RUNNER_IMAGE || runnerDigest;
  const model = env.AIWS_CODEX_MODEL || 'gpt-5.5';
  const codexBinary = env.AIWS_CODEX_BINARY || 'codex';
  if (!DIGEST.test(runnerDigest) || /^sha256:0{64}$/.test(runnerDigest)) throw new Error('runner_digest_required');
  if ((production || executor === 'docker') && secret.length < 32) throw new Error('broker_hmac_secret_required');
  if (!SAFE_MODEL.test(model)) throw new Error('model_name_invalid');
  if (executor === 'docker' && runnerImage !== runnerDigest && (!DIGEST_IMAGE.test(runnerImage) || !runnerImage.endsWith(`@${runnerDigest}`))) throw new Error('runner_image_must_be_digest_pinned');
  if (executor === 'host' && !path.isAbsolute(codexBinary)) throw new Error('host_codex_binary_absolute_path_required');
  return {
    host: env.AIWS_BROKER_HOST || '127.0.0.1',
    port: Number(env.AIWS_BROKER_PORT || 4321),
    secret,
    dataRoot: env.AIWS_BROKER_DATA_ROOT || '/var/lib/aiws',
    dataVolume,
    runnerDigest,
    executor,
    runnerImage,
    model,
    codexBinary
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new AppError('payload_too_large', 'job spec is too large', { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return { raw: '', value: {} };
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return { raw, value: JSON.parse(raw) }; } catch { throw new AppError('invalid_json', 'request body must be JSON', { status: 400 }); }
}

export function createBroker(options = {}) {
  const suppliedConfig = options.config || brokerConfig(options.env || process.env);
  const config = {
    executor: 'mock',
    model: 'gpt-5.5',
    codexBinary: 'codex',
    ...suppliedConfig
  };
  if (!SAFE_VOLUME_NAME.test(String(config.dataVolume || 'aiws-data-v3'))) throw new Error('data_volume_name_invalid');
  if (!SAFE_MODEL.test(String(config.model || 'gpt-5.5'))) throw new Error('model_name_invalid');
  if (!DIGEST.test(String(config.runnerDigest || ''))) throw new Error('runner_digest_required');
  if (config.executor === 'docker' && config.runnerImage !== config.runnerDigest && (!DIGEST_IMAGE.test(String(config.runnerImage || '')) || !String(config.runnerImage).endsWith(`@${config.runnerDigest}`))) throw new Error('runner_image_must_be_digest_pinned');
  if (config.executor === 'host' && !path.isAbsolute(String(config.codexBinary || ''))) throw new Error('host_codex_binary_absolute_path_required');
  const replay = createReplayGuard();
  const jobs = new Map();
  const credentials = new WeakMap();
  const activeProbes = new Map();
  const deviceAuth = new Map();
  const deviceSecrets = new WeakMap();
  const deviceAuthRoot = path.resolve(config.dataRoot, '.codex-device-auth');
  const hostRuntimeRoot = path.resolve(config.dataRoot, '.codex-host');
  let accepting = true;
  const retentionMs = Number(options.retentionMs ?? JOB_RETENTION_MS);
  const maxTerminalJobs = Number(options.maxTerminalJobs ?? MAX_TERMINAL_JOBS);
  resetDeviceAuthRoot();
  resetHostRuntimeRoot();
  const cleanupTimer = setInterval(() => { pruneJobs(); pruneDeviceAuth(); }, 60_000);
  cleanupTimer.unref?.();
  const validate = (spec) => validateJobSpec(spec, { dataRoot: config.dataRoot, runnerDigest: config.runnerDigest, model: config.model });

  function resetDeviceAuthRoot() {
    fs.mkdirSync(deviceAuthRoot, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(deviceAuthRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^auth_[a-f0-9]{32}$/.test(entry.name)) continue;
      fs.rmSync(path.join(deviceAuthRoot, entry.name), { recursive: true, force: true });
    }
  }

  function resetHostRuntimeRoot() {
    fs.mkdirSync(hostRuntimeRoot, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(hostRuntimeRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^(?:run|probe)-[A-Za-z0-9_-]+$/.test(entry.name)) {
        fs.rmSync(path.join(hostRuntimeRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  function cleanupHostHome(job) {
    const target = path.resolve(job.hostHome || '');
    if (target.startsWith(`${hostRuntimeRoot}${path.sep}`)) fs.rmSync(target, { recursive: true, force: true });
    job.hostHome = null;
  }

  function hostRunnerEnvironment(home, spec) {
    return Object.fromEntries(Object.entries({
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      AIWS_CODEX_BINARY: config.codexBinary,
      AIWS_RUNNER_SANDBOX: spec.execution_mode === 'write' ? 'workspace-write' : 'read-only',
      AIWS_RUNNER_CODEX_HOME: home,
      AIWS_RUNNER_WORKSPACE_ROOT: path.resolve(config.dataRoot, spec.workspace_subpath),
      AIWS_RUNNER_INPUTS_ROOT: path.resolve(config.dataRoot, spec.input_subpath),
      AIWS_RUNNER_OUTPUTS_ROOT: path.resolve(config.dataRoot, spec.output_subpath)
    }).filter(([, value]) => value != null));
  }

  function cleanupDeviceHome(job) {
    const target = path.resolve(job.home || '');
    if (target.startsWith(`${deviceAuthRoot}${path.sep}`)) fs.rmSync(target, { recursive: true, force: true });
  }

  function pruneDeviceAuth(clock = Date.now()) {
    for (const [operationId, job] of deviceAuth) {
      const terminal = ['completed', 'failed', 'cancelled', 'expired', 'claimed'].includes(job.status);
      if (!terminal || clock - Date.parse(job.updated_at) < DEVICE_AUTH_RETENTION_MS) continue;
      deviceSecrets.delete(job);
      cleanupDeviceHome(job);
      deviceAuth.delete(operationId);
    }
  }

  function deviceEvent(job, type, data = {}) {
    const event = {
      cursor: job.events.length ? job.events.at(-1).cursor + 1 : 1,
      type,
      data,
      created_at: new Date().toISOString()
    };
    job.events.push(event);
    job.updated_at = event.created_at;
    return event;
  }

  function publicDeviceAuth(job) {
    return {
      operation_id: job.operation_id,
      status: job.status,
      error_code: job.error_code || null,
      cursor: job.events.at(-1)?.cursor || 0,
      created_at: job.created_at,
      updated_at: job.updated_at
    };
  }

  function consumeDeviceOutput(job, value, final = false) {
    const text = `${job.output_pending}${String(value || '')}`;
    const lines = text.split(/\r?\n/);
    const pending = lines.pop() || '';
    job.output_pending = final ? '' : pending;
    if (final && pending) lines.push(pending);
    for (const line of lines) {
      const parsed = parseCodexDeviceAuthLine(line);
      if (!parsed) continue;
      if (parsed.type === 'verification') {
        deviceEvent(job, 'codex.device_auth.verification', {
          verification_url: parsed.verification_url,
          user_code: parsed.user_code,
          status: parsed.status
        });
        job.status = parsed.status;
      } else {
        deviceEvent(job, 'codex.device_auth.status', { status: parsed.status });
        if (['failed', 'cancelled', 'expired'].includes(parsed.status)) job.status = parsed.status;
      }
    }
  }

  function completeDeviceAuth(job, code) {
    if (job.finalized || job.status === 'cancelled' || job.status === 'expired') return;
    job.finalized = true;
    clearTimeout(job.timer);
    consumeDeviceOutput(job, '', true);
    const authFile = path.join(job.home, 'auth.json');
    try {
      const stat = fs.lstatSync(authFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 64 * 1024) throw new Error('device_auth_bundle_invalid');
      const bundle = fs.readFileSync(authFile, 'utf8');
      const parsed = JSON.parse(bundle);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('device_auth_bundle_invalid');
      if (code !== 0) throw new Error('device_auth_failed');
      deviceSecrets.set(job, bundle);
      job.status = 'completed';
      job.error_code = '';
      deviceEvent(job, 'codex.device_auth.status', { status: 'completed' });
    } catch {
      job.status = 'failed';
      job.error_code = code === 0 ? 'device_auth_bundle_invalid' : 'device_auth_failed';
      deviceEvent(job, 'codex.device_auth.status', { status: 'failed', error_code: job.error_code });
      cleanupDeviceHome(job);
    }
  }

  async function startDeviceAuth() {
    if (!accepting) throw new AppError('broker_shutting_down', 'broker is shutting down', { status: 503, retryable: true });
    const operationId = `da_${randomUUID().replaceAll('-', '')}`;
    const home = path.join(deviceAuthRoot, `auth_${randomUUID().replaceAll('-', '')}`);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString();
    const job = {
      operation_id: operationId,
      status: 'starting',
      error_code: '',
      events: [],
      home,
      child: null,
      timer: null,
      output_pending: '',
      finalized: false,
      created_at: timestamp,
      updated_at: timestamp
    };
    deviceAuth.set(operationId, job);
    deviceEvent(job, 'codex.device_auth.status', { status: 'starting' });
    if (config.executor === 'mock') {
      deviceEvent(job, 'codex.device_auth.verification', {
        verification_url: 'https://auth.example.test/device',
        user_code: 'ABCD-EFGH',
        status: 'waiting_for_user'
      });
      job.status = 'waiting_for_user';
      setTimeout(() => {
        if (job.status === 'cancelled') return;
        deviceSecrets.set(job, JSON.stringify({ tokens: { access_token: 'fixture-device-access-token', refresh_token: 'fixture-device-refresh-token' } }));
        job.status = 'completed';
        deviceEvent(job, 'codex.device_auth.status', { status: 'completed' });
      }, 25).unref?.();
      return publicDeviceAuth(job);
    }
    let command;
    let args;
    if (config.executor === 'docker') {
      await ensureModelNetwork();
      command = 'docker';
      args = [
        'run', '--rm', '--init', '--name', `aiws-device-auth-${operationId}`,
        '--label', 'aiws.owner=aiws-v3', '--label', 'aiws.role=codex-device-auth',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'aiws-runner-model',
        '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
        '--mount', `type=bind,src=${home},dst=/codex-home`,
        '--env', 'HOME=/codex-home', '--env', 'CODEX_HOME=/codex-home',
        '--entrypoint', 'codex', config.runnerImage, 'login', '--device-auth'
      ];
    } else {
      command = config.codexBinary;
      args = ['login', '--device-auth'];
    }
    const env = config.executor === 'host'
      ? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, CODEX_HOME: home }
      : undefined;
    const child = spawn(command, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    job.child = child;
    child.stdout.on('data', (chunk) => consumeDeviceOutput(job, chunk));
    child.stderr.on('data', (chunk) => consumeDeviceOutput(job, chunk));
    child.once('error', () => completeDeviceAuth(job, 1));
    child.once('close', (code) => completeDeviceAuth(job, code ?? 1));
    job.timer = setTimeout(() => {
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return;
      job.status = 'expired';
      job.finalized = true;
      job.error_code = 'device_auth_timeout';
      child.kill('SIGTERM');
      deviceEvent(job, 'codex.device_auth.status', { status: 'expired', error_code: job.error_code });
      cleanupDeviceHome(job);
    }, 10 * 60 * 1000);
    job.timer.unref?.();
    return publicDeviceAuth(job);
  }

  async function cancelDeviceAuth(job) {
    if (!['completed', 'failed', 'cancelled', 'expired', 'claimed'].includes(job.status)) {
      job.status = 'cancelled';
      job.error_code = 'device_auth_cancelled';
      if (job.child?.exitCode == null) job.child.kill('SIGTERM');
      deviceEvent(job, 'codex.device_auth.status', { status: 'cancelled' });
    }
    clearTimeout(job.timer);
    deviceSecrets.delete(job);
    cleanupDeviceHome(job);
    return publicDeviceAuth(job);
  }

  function claimDeviceAuth(job) {
    if (job.status !== 'completed') throw new AppError('device_auth_not_claimable', 'device auth is not complete', { status: 409 });
    const authBundle = deviceSecrets.get(job);
    if (!authBundle) throw new AppError('device_auth_already_claimed', 'device auth bundle was already claimed', { status: 409 });
    deviceSecrets.delete(job);
    job.status = 'claimed';
    deviceEvent(job, 'codex.device_auth.status', { status: 'claimed' });
    clearTimeout(job.timer);
    cleanupDeviceHome(job);
    return { operation_id: job.operation_id, status: 'claimed', auth_bundle: authBundle };
  }

  function pruneJobs(clock = Date.now()) {
    const terminal = [];
    for (const [jobId, job] of jobs) {
      if (!['completed', 'failed', 'cancelled', 'unknown'].includes(job.status)) continue;
      const parsedFinished = Date.parse(job.finished_at || job.created_at || '');
      const finished = Number.isFinite(parsedFinished) ? parsedFinished : clock;
      if (clock - finished >= retentionMs) { credentials.delete(job); jobs.delete(jobId); continue; }
      terminal.push({ jobId, finished });
    }
    if (terminal.length > maxTerminalJobs) {
      terminal.sort((a, b) => a.finished - b.finished);
      for (const item of terminal.slice(0, terminal.length - maxTerminalJobs)) {
        const job = jobs.get(item.jobId);
        if (job) credentials.delete(job);
        jobs.delete(item.jobId);
      }
    }
  }

  async function terminateRunner(job) {
    if (job.termination) return job.termination;
    job.termination = (async () => {
      if (job.containerName) {
        await execFileAsync('docker', ['stop', '--time', '5', job.containerName], {
          encoding: 'utf8', timeout: 8_000, windowsHide: true, maxBuffer: 256 * 1024
        }).catch(() => undefined);
      }
      if (job.container && job.container.exitCode == null) job.container.kill('SIGTERM');
      if (job.container && job.container.exitCode == null) {
        await Promise.race([
          new Promise((resolve) => job.container.once('close', resolve)),
          new Promise((resolve) => setTimeout(resolve, 5_000))
        ]);
      }
      if (job.containerName) {
        await execFileAsync('docker', ['rm', '--force', job.containerName], {
          encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024
        }).catch(() => undefined);
      }
      cleanupHostHome(job);
    })();
    return job.termination;
  }

  async function probe() {
    if (config.executor === 'mock') return { ready: true, executor: config.executor, runner_digest: config.runnerDigest };
    if (config.executor === 'host') {
      try {
        const version = await execFileAsync(config.codexBinary, ['--version'], {
          encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 256 * 1024,
          env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }).filter(([, value]) => value != null))
        });
        const ready = version.stdout.trim() === `codex-cli ${CODEX_CLI_VERSION}`;
        return { ready, executor: config.executor, runner_digest: config.runnerDigest, error: ready ? null : 'runner_cli_version_mismatch' };
      } catch {
        return { ready: false, executor: config.executor, runner_digest: config.runnerDigest, error: 'runner_unavailable' };
      }
    }
    let imageInspected = false;
    try {
      const { stdout } = await execFileAsync('docker', ['image', 'inspect', config.runnerImage], {
        encoding: 'utf8', timeout: 3_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
      });
      const inspected = JSON.parse(stdout)[0];
      imageInspected = true;
      const pinned = inspected?.Id === config.runnerDigest || (inspected?.RepoDigests || []).some((value) => value.endsWith(`@${config.runnerDigest}`));
      let cliReady = false;
      if (pinned) {
        const version = await execFileAsync('docker', [
          'run', '--rm', '--network', 'none', '--read-only',
          '--tmpfs', '/codex-home:rw,size=16m,mode=700,uid=10001,gid=10001',
          '--env', 'HOME=/codex-home', '--env', 'CODEX_HOME=/codex-home',
          '--entrypoint', 'codex', config.runnerImage, '--version'
        ], {
          encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 256 * 1024
        });
        cliReady = version.stdout.trim() === `codex-cli ${CODEX_CLI_VERSION}`;
      }
      return {
        ready: Boolean(pinned && cliReady),
        executor: config.executor,
        runner_digest: config.runnerDigest,
        error: !pinned ? 'runner_digest_mismatch' : cliReady ? null : 'runner_cli_version_mismatch'
      };
    } catch {
      return { ready: false, executor: config.executor, runner_digest: config.runnerDigest, error: imageInspected ? 'runner_probe_failed' : 'runner_image_unavailable' };
    }
  }

  async function ensureModelNetwork() {
    await execFileAsync('docker', ['network', 'inspect', 'aiws-runner-model'], { encoding: 'utf8', timeout: 3_000, windowsHide: true })
      .catch(() => execFileAsync('docker', ['network', 'create', '--label', 'aiws.owner=aiws-v3', '--label', 'aiws.role=model-egress', 'aiws-runner-model'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }));
  }

  async function probeCodexProvider(profile, credential) {
    const model = profile.model;
    if (config.executor === 'mock') return { provider: 'codex', model, status: 'unavailable', checked_at: new Date().toISOString(), error_code: 'deterministic_adapter', checks: [{ phase: 'transport', status: 'failed', error_code: 'codex_transport_unavailable' }] };
    if (!credential?.auth) return { provider: 'codex', model, status: 'unavailable', checked_at: new Date().toISOString(), error_code: 'credential_missing', checks: [{ phase: 'transport', status: 'failed', error_code: 'codex_credential_missing' }] };
    let child;
    let containerName = '';
    let hostHome = '';
    if (config.executor === 'docker') {
      try { await ensureModelNetwork(); }
      catch { return { provider: 'codex', model, status: 'unavailable', checked_at: new Date().toISOString(), error_code: 'egress_unavailable', checks: [{ phase: 'transport', status: 'failed', error_code: 'codex_transport_failed' }] }; }
      containerName = `aiws-codex-probe-${randomUUID().replaceAll('-', '')}`;
      const args = [
        'run', '--rm', '--interactive', '--init', '--name', containerName,
        '--label', 'aiws.owner=aiws-v3', '--label', 'aiws.role=codex-probe',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only',
        '--network', 'aiws-runner-model', '--cpus', '1', '--memory', '1g', '--pids-limit', '256',
        '--tmpfs', '/tmp:size=256m,mode=1777',
        '--tmpfs', '/tmp/codex-home:rw,size=64m,mode=700,uid=10001,gid=10001',
        '--workdir', '/tmp', config.runnerImage
      ];
      child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } else {
      hostHome = fs.mkdtempSync(path.join(hostRuntimeRoot, 'probe-'));
      const workspace = path.join(hostHome, 'workspace');
      const inputs = path.join(hostHome, 'inputs');
      const outputs = path.join(hostHome, 'outputs');
      const codexHome = path.join(hostHome, 'home');
      for (const directory of [workspace, inputs, outputs]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const relative = (value) => path.relative(config.dataRoot, value);
      child = spawn(process.execPath, [CODEX_RUNNER_SCRIPT], {
        cwd: workspace,
        env: hostRunnerEnvironment(codexHome, {
          workspace_subpath: relative(workspace), input_subpath: relative(inputs), output_subpath: relative(outputs)
        }),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      });
    }
    const probeId = containerName || `host-${randomUUID()}`;
    const activeProbe = { child, containerName, hostHome, timer: null };
    activeProbes.set(probeId, activeProbe);
    let stdout = '';
    let bytes = 0;
    child.stdout.on('data', (chunk) => { bytes += chunk.byteLength; if (bytes <= 2 * 1024 * 1024) stdout += chunk.toString('utf8'); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ mode: 'probe', model, profile, credential, bundle: { objective: 'Reply with ok.', acceptance: [], input_assets: [], input_paths: [], output_paths: [], checks: ['node_test', 'git_diff_check'], prior_outputs_root: '/outputs', retry_context: null }, input_paths: [], output_paths: [] }));
    try {
      const outcome = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(activeProbe.timer);
          resolve(value);
        };
        child.once('close', (code) => finish({ code: code ?? 1, timeout: false }));
        child.once('error', () => finish({ code: 1, timeout: false }));
        activeProbe.timer = setTimeout(() => finish({ code: 1, timeout: true }), 90_000);
        activeProbe.timer.unref?.();
      });
      if (outcome.timeout) {
        child.kill('SIGTERM');
        if (containerName) await execFileAsync('docker', ['rm', '--force', containerName], { encoding: 'utf8', timeout: 5_000, windowsHide: true }).catch(() => undefined);
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
      const available = outcome.code === 0 && parsed?.outcome === 'completed';
      const errorCode = available ? null : outcome.timeout ? 'probe_timeout' : parsed?.error_code || 'provider_failed';
      const checks = outcome.timeout
        ? [{ phase: 'transport', status: 'failed', error_code: 'codex_transport_timeout' }]
        : !parsed
          ? [{ phase: 'transport', status: 'passed', error_code: null }, { phase: 'protocol', status: 'failed', error_code: 'codex_protocol_failed' }]
          : [
              { phase: 'transport', status: 'passed', error_code: null },
              { phase: 'protocol', status: 'passed', error_code: null },
              { phase: 'model', status: /model/i.test(String(errorCode || '')) ? 'failed' : 'passed', error_code: /model/i.test(String(errorCode || '')) ? 'codex_model_failed' : null },
              { phase: 'inference', status: available ? 'passed' : 'failed', error_code: available ? null : 'codex_inference_failed' }
            ];
      return { provider: 'codex', model, status: available ? 'available' : 'unavailable', checked_at: new Date().toISOString(), error_code: errorCode, checks };
    } finally {
      clearTimeout(activeProbe.timer);
      activeProbes.delete(probeId);
      cleanupHostHome(activeProbe);
    }
  }

  async function execute(job) {
    if (config.executor === 'mock') {
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (job.status === 'cancelled') return;
      const outputRoot = path.resolve(
        config.dataRoot,
        job.spec.execution_mode === 'write' ? job.spec.workspace_subpath : job.spec.output_subpath
      );
      for (const relative of job.spec.output_paths || []) {
        const target = path.resolve(outputRoot, relative);
        if (!target.startsWith(`${outputRoot}${path.sep}`)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o770 });
        fs.writeFileSync(target, 'deterministic runner output\n', { encoding: 'utf8', mode: 0o660 });
      }
      job.status = 'completed';
      job.result = {
        outcome: 'completed', summary: 'deterministic runner completed', changed_files: [],
        checks: [{ id: 'node_test', passed: true, exit_code: 0, stdout_sha256: null }, { id: 'git_diff_check', passed: true, exit_code: 0, stdout_sha256: null }],
        output_paths: job.spec.output_paths || [], usage: {}
      };
      job.finished_at = new Date().toISOString();
      credentials.delete(job);
      return;
    }
    let child;
    if (config.executor === 'docker') {
      if (job.spec.network_profile === 'model') await ensureModelNetwork();
      const runtimeSpec = job.spec.credential_ref === '[ephemeral]'
        ? { ...job.spec, credential_ref: credentials.get(job)?.ref || null }
        : job.spec;
      const args = buildDockerArgs(runtimeSpec, { dataRoot: config.dataRoot, dataVolume: config.dataVolume, runnerDigest: config.runnerDigest, runnerImage: config.runnerImage, model: config.model });
      child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      job.containerName = args[args.indexOf('--name') + 1];
    } else {
      const workspace = path.resolve(config.dataRoot, job.spec.workspace_subpath);
      const inputs = path.resolve(config.dataRoot, job.spec.input_subpath);
      const outputs = path.resolve(config.dataRoot, job.spec.output_subpath);
      for (const directory of [workspace, inputs, outputs]) fs.mkdirSync(directory, { recursive: true, mode: 0o770 });
      job.hostHome = fs.mkdtempSync(path.join(hostRuntimeRoot, 'run-'));
      child = spawn(process.execPath, [CODEX_RUNNER_SCRIPT], {
        cwd: workspace,
        env: hostRunnerEnvironment(job.hostHome, job.spec),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      });
    }
    job.container = child;
    let stdout = '';
    let stdoutBytes = 0;
    let stdoutExceeded = false;
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= 2 * 1024 * 1024) stdout += chunk.toString('utf8');
      else if (!stdoutExceeded) {
        stdoutExceeded = true;
        void terminateRunner(job);
      }
    });
    child.stdin.end(JSON.stringify({
      task_id: job.spec.task_id,
      execution_id: job.spec.execution_id,
      mode: job.spec.execution_mode,
      bundle: job.spec.bundle,
      input_paths: job.spec.input_paths,
      input_subpath: job.spec.input_subpath,
      output_paths: job.spec.output_paths,
      worktree_subpath: job.spec.worktree_subpath,
      baseline_sha: job.spec.baseline_sha,
      model: job.spec.model,
      credential: credentials.get(job) || null
      , profile: credentials.get(job)?.profile || null
    }));
    child.stdin.on('error', () => undefined);
    const timeout = setTimeout(() => {
      job.timed_out = true;
      void terminateRunner(job);
    }, Math.max(1, Date.parse(job.spec.deadline_at) - Date.now()));
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (job.status === 'cancelled') return;
      const credential = credentials.get(job);
      const secrets = credentialSecrets(credential);
      job.status = code === 0 && !stdoutExceeded && !job.timed_out ? 'completed' : 'failed';
      let normalized = null;
      try { normalized = JSON.parse(stdout); } catch { normalized = null; }
      const runnerCompleted = normalized?.outcome === 'completed' && code === 0 && !stdoutExceeded && !job.timed_out;
      job.result = normalized && typeof normalized === 'object'
        ? { outcome: runnerCompleted ? 'completed' : 'failed', summary: safeSummary(job.timed_out ? 'runner deadline exceeded' : stdoutExceeded ? 'runner output exceeded the size limit' : normalized.summary, secrets), changed_files: safePaths(normalized.changed_files), checks: Array.isArray(normalized.checks) ? normalized.checks.slice(0, 32).map((check) => ({ id: String(check?.id || 'unknown').slice(0, 80), passed: Boolean(check?.passed), exit_code: Number.isInteger(check?.exit_code) ? check.exit_code : null, stdout_sha256: /^[a-f0-9]{64}$/.test(String(check?.stdout_sha256 || '')) ? check.stdout_sha256 : null, error_code: normalizeRunnerErrorCode(check?.error_code, check?.passed ? '' : 'runner_failed') || null })) : [], events: safeEvents(normalized.events, secrets), output_paths: safePaths(job.spec.output_paths), usage: normalized.usage && typeof normalized.usage === 'object' ? Object.fromEntries(Object.entries(normalized.usage).filter(([, amount]) => Number.isFinite(amount)).slice(0, 16)) : {}, exit_code: code ?? 1, error_code: runnerCompleted ? null : normalizeRunnerErrorCode(normalized.error_code, job.timed_out ? 'runner_deadline_exceeded' : stdoutExceeded ? 'runner_output_too_large' : 'runner_failed') }
        : { outcome: code === 0 && !stdoutExceeded && !job.timed_out ? 'completed' : 'failed', summary: job.timed_out ? 'runner deadline exceeded' : stdoutExceeded ? 'runner output exceeded the size limit' : code === 0 ? 'runner completed' : 'runner exited with an error', changed_files: [], checks: [], output_paths: job.spec.output_paths || [], usage: {}, exit_code: code ?? 1, signal: signal || null, error_code: normalizeRunnerErrorCode(null, job.timed_out ? 'runner_deadline_exceeded' : stdoutExceeded ? 'runner_output_too_large' : 'runner_failed') };
      job.finished_at = new Date().toISOString();
      credentials.delete(job);
      cleanupHostHome(job);
    });
    child.once('error', () => {
      clearTimeout(timeout);
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.result = { outcome: 'failed', summary: 'runner process failed to start', changed_files: [], checks: [], output_paths: [], usage: {}, exit_code: 1, error_code: 'runner_spawn_failed' };
        job.finished_at = new Date().toISOString();
        credentials.delete(job);
        cleanupHostHome(job);
      }
    });
  }

  async function handler(req, res) {
    const requestId = randomUUID();
    const parsed = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const requestPath = parsed.pathname;
    try {
      if (req.method === 'GET' && requestPath === '/health') return send(res, 200, { status: 'alive' });
      const parsedBody = req.method === 'POST' ? await readBody(req) : { raw: '', value: {} };
      replay.verify(req.headers, req.method || 'GET', requestPath, parsedBody.raw, config.secret);
      if (req.method === 'GET' && requestPath === '/internal/v1/probe') {
        return send(res, 200, await probe());
      }
      if (req.method === 'POST' && requestPath === '/internal/v1/integrations/codex/probe') {
        const model = String(parsedBody.value?.model || '');
        const credential = parsedBody.value?.credential;
        if (model !== config.model) throw new AppError('invalid_job_spec', 'model is not registered');
        if (!credential || credential.ref !== 'cred_codex_default' || typeof credential.auth !== 'string' || credential.auth.length < 8 || credential.auth.length > 16_384) throw new AppError('invalid_job_spec', 'probe credential is invalid');
        const profileConfig = {
          label: 'Bootstrap Codex', provider: 'openai', model, base_url: '', wire_api: 'responses',
          reasoning: 'medium', timeout_ms: 120000, credential_ref: credential.ref, credential_revision: 1
        };
        const configHash = hashJson(profileConfig);
        const profileHash = hashJson({
          id: 'cdp_bootstrap00', revision: 1, config_hash: configHash,
          credential_ref: credential.ref, credential_revision: 1, runner_digest: config.runnerDigest
        });
        const profile = validateProviderProfile({
          profile_id: 'cdp_bootstrap00', profile_revision: 1, profile_hash: profileHash,
          config_hash: configHash, ...profileConfig,
          auth_kind: 'api_key', credential_ref: credential.ref, credential_revision: 1, runner_digest: config.runnerDigest
        });
        return send(res, 200, await probeCodexProvider(profile, { ref: credential.ref, kind: 'codex_api_key', auth: credential.auth }));
      }
      if (req.method === 'POST' && requestPath === '/internal/v1/integrations/codex/profile-probe') {
        const profile = validateProviderProfile(parsedBody.value?.profile);
        const credential = parsedBody.value?.credential;
        if (profile.runner_digest !== config.runnerDigest) throw new AppError('invalid_job_spec', 'provider profile is not registered');
        if (!credential || credential.ref !== profile.credential_ref || Number(credential.revision) !== profile.credential_revision || !['codex_api_key', 'codex_oauth_bundle'].includes(String(credential.kind)) || typeof credential.auth !== 'string' || credential.auth.length < 1 || credential.auth.length > 64 * 1024) throw new AppError('invalid_job_spec', 'profile credential is invalid');
        return send(res, 200, await probeCodexProvider(profile, { ref: credential.ref, kind: credential.kind, auth: credential.auth }));
      }
      if (req.method === 'POST' && requestPath === '/internal/v1/integrations/codex/device-auth') {
        return send(res, 201, await startDeviceAuth());
      }
      const deviceMatch = requestPath.match(/^\/internal\/v1\/integrations\/codex\/device-auth\/([^/]+)(?:\/(events|cancel|claim))?$/);
      if (deviceMatch) {
        const job = deviceAuth.get(decodeURIComponent(deviceMatch[1]));
        if (!job) throw new AppError('not_found', 'device auth operation not found', { status: 404 });
        const action = deviceMatch[2] || '';
        if (req.method === 'GET' && !action) return send(res, 200, publicDeviceAuth(job));
        if (req.method === 'GET' && action === 'events') {
          const after = Number(parsed.searchParams.get('after') || 0);
          return send(res, 200, { events: job.events.filter((event) => event.cursor > after).slice(0, 500) });
        }
        if (req.method === 'POST' && action === 'cancel') return send(res, 200, await cancelDeviceAuth(job));
        if (req.method === 'POST' && action === 'claim') return send(res, 200, claimDeviceAuth(job));
      }
      if (req.method === 'POST' && requestPath === '/internal/v1/jobs') {
        if (!accepting) throw new AppError('broker_shutting_down', 'broker is shutting down', { status: 503, retryable: true });
        const envelope = parsedBody.value?.spec ? parsedBody.value : { spec: parsedBody.value, credential: null };
        const spec = validate(envelope.spec);
        const profile = envelope.profile == null ? null : validateProviderProfile(envelope.profile);
        if (spec.profile_id) {
          if (!profile || profile.profile_id !== spec.profile_id || profile.profile_revision !== spec.profile_revision || profile.profile_hash !== spec.profile_hash || profile.model !== spec.model || profile.runner_digest !== spec.image_digest) throw new AppError('invalid_job_spec', 'profile envelope does not match the job spec');
        } else if (profile) throw new AppError('invalid_job_spec', 'job spec does not declare a profile binding');
        let credential = null;
        if (envelope.credential != null) {
          if (!spec.credential_ref || envelope.credential?.ref !== spec.credential_ref || (profile && Number(envelope.credential?.revision) !== profile.credential_revision) || typeof envelope.credential?.auth !== 'string' || envelope.credential.auth.length < 8 || envelope.credential.auth.length > 64 * 1024) throw new AppError('invalid_job_spec', 'credential envelope does not match the job spec');
          const kind = String(envelope.credential.kind || 'codex_api_key');
          if (!['codex_api_key', 'codex_oauth_bundle'].includes(kind) || (profile && profile.credential_ref !== spec.credential_ref)) throw new AppError('invalid_job_spec', 'credential kind does not match the profile');
          credential = { ref: spec.credential_ref, kind, revision: Number(envelope.credential.revision || 1), auth: envelope.credential.auth, profile };
        }
        if (spec.network_profile === 'model' && !credential) throw new AppError('invalid_job_spec', 'model network requires an ephemeral credential');
        const jobId = `job_${randomUUID().replaceAll('-', '')}`;
        const job = { job_id: jobId, status: 'queued', spec: redactJobSpec(spec), created_at: new Date().toISOString(), result: null };
        if (credential) credentials.set(job, credential);
        jobs.set(jobId, job);
        setImmediate(async () => {
          if (job.status === 'cancelled') return;
          job.status = 'running';
          job.started_at = new Date().toISOString();
          try { await execute(job); } catch {
            if (job.status !== 'cancelled') {
              job.status = 'failed';
              job.result = { outcome: 'failed', summary: 'runner setup failed', changed_files: [], checks: [], output_paths: [], usage: {}, exit_code: 1, error_code: 'runner_setup_failed' };
              job.finished_at = new Date().toISOString();
            }
            credentials.delete(job);
            cleanupHostHome(job);
          }
        });
        return send(res, 201, { job_id: jobId, status: job.status });
      }
      const match = requestPath.match(/^\/internal\/v1\/jobs\/([^/]+)(?:\/cancel)?$/);
      if (match) {
        const job = jobs.get(decodeURIComponent(match[1]));
        if (!job) throw new AppError('not_found', 'job not found', { status: 404 });
        if (req.method === 'GET') return send(res, 200, { job_id: job.job_id, status: job.status, result: job.result, created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at, spec: job.spec });
        if (req.method === 'POST' && requestPath.endsWith('/cancel')) {
          if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
            job.status = 'cancelled';
            await terminateRunner(job);
            job.finished_at = new Date().toISOString();
          }
          credentials.delete(job);
          return send(res, 200, { job_id: job.job_id, status: job.status });
        }
      }
      throw new AppError('not_found', 'broker route not found', { status: 404 });
    } catch (error) {
      const appError = asAppError(error);
      return send(res, appError.status, { error: { code: appError.code, message: appError.message, retryable: appError.retryable, request_id: requestId, details: appError.details } });
    }
  }

  return {
    config,
    jobs,
    deviceAuth,
    replay,
    handler,
    probe,
    pruneJobs,
    async close() {
      if (!accepting) return;
      accepting = false;
      clearInterval(cleanupTimer);
      await Promise.all([...activeProbes.values()].map(async (probeJob) => {
        clearTimeout(probeJob.timer);
        if (probeJob.child.exitCode == null) probeJob.child.kill('SIGTERM');
        if (probeJob.containerName) {
          await execFileAsync('docker', ['rm', '--force', probeJob.containerName], {
            encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024
          }).catch(() => undefined);
        }
        cleanupHostHome(probeJob);
      }));
      activeProbes.clear();
      await Promise.all([...deviceAuth.values()].map((job) => cancelDeviceAuth(job)));
      deviceAuth.clear();
      const active = [...jobs.values()].filter((job) => !['completed', 'failed', 'cancelled', 'unknown'].includes(job.status));
      await Promise.all(active.map(async (job) => {
        job.status = 'cancelled';
        await terminateRunner(job);
        job.finished_at = new Date().toISOString();
        credentials.delete(job);
      }));
      for (const job of jobs.values()) credentials.delete(job);
    }
  };
}

function readSecret(file) {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export async function start(options = {}) {
  const broker = createBroker(options);
  const server = http.createServer((req, res) => Promise.resolve(broker.handler(req, res)).catch((error) => send(res, 500, { error: { code: 'internal_error', message: error.message, retryable: false } })));
  await new Promise((resolve) => server.listen(broker.config.port, broker.config.host, resolve));
  const address = server.address();
  process.stdout.write(`AIWS runner-broker listening on http://${address.address}:${address.port}\n`);
  return {
    ...broker,
    server,
    close: async () => {
      await broker.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await start();
  const shutdown = async () => { await running.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
