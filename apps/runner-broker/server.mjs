import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError, asAppError } from '../api/src/errors.mjs';
import { buildDockerArgs, redactJobSpec, validateJobSpec } from './src/job-spec.mjs';
import { normalizeRunnerErrorCode } from './src/runner-result.mjs';
import { createReplayGuard } from './src/signature.mjs';
import { DEVELOPMENT_RUNNER_DIGEST } from '../../packages/contracts/src/index.mjs';

const execFileAsync = promisify(execFile);
const SAFE_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DIGEST_IMAGE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:[a-f0-9]{64}$/i;
const CODEX_CLI_VERSION = '0.146.1';
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

export function brokerConfig(env = process.env) {
  const dataVolume = env.AIWS_DOCKER_DATA_VOLUME || 'aiws-data-v3';
  if (!SAFE_VOLUME_NAME.test(dataVolume)) throw new Error('data_volume_name_invalid');
  if (/v(?:12|13|14|15|16|17|18|19|20|21|22|23)/i.test(dataVolume)) throw new Error('legacy_data_volume_forbidden');
  const production = env.NODE_ENV === 'production';
  const executor = env.AIWS_BROKER_EXECUTOR || 'mock';
  const secret = readSecret(env.AIWS_BROKER_HMAC_SECRET_FILE) || env.AIWS_BROKER_HMAC_SECRET || (production ? '' : 'dev-only-local-broker-secret');
  const runnerDigest = env.AIWS_RUNNER_DIGEST || (production || executor === 'docker' ? '' : DEVELOPMENT_RUNNER_DIGEST);
  const runnerImage = env.AIWS_RUNNER_IMAGE || runnerDigest;
  const model = env.AIWS_CODEX_MODEL || 'gpt-5.5';
  if (!DIGEST.test(runnerDigest) || /^sha256:0{64}$/.test(runnerDigest)) throw new Error('runner_digest_required');
  if ((production || executor === 'docker') && secret.length < 32) throw new Error('broker_hmac_secret_required');
  if (!SAFE_MODEL.test(model)) throw new Error('model_name_invalid');
  if (executor === 'docker' && runnerImage !== runnerDigest && (!DIGEST_IMAGE.test(runnerImage) || !runnerImage.endsWith(`@${runnerDigest}`))) throw new Error('runner_image_must_be_digest_pinned');
  return {
    host: env.AIWS_BROKER_HOST || '127.0.0.1',
    port: Number(env.AIWS_BROKER_PORT || 4321),
    secret,
    dataRoot: env.AIWS_BROKER_DATA_ROOT || '/var/lib/aiws',
    dataVolume,
    runnerDigest,
    executor,
    runnerImage,
    model
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
  const config = options.config || brokerConfig(options.env || process.env);
  if (!SAFE_VOLUME_NAME.test(String(config.dataVolume || 'aiws-data-v3'))) throw new Error('data_volume_name_invalid');
  if (!SAFE_MODEL.test(String(config.model || 'gpt-5.5'))) throw new Error('model_name_invalid');
  if (!DIGEST.test(String(config.runnerDigest || ''))) throw new Error('runner_digest_required');
  if (config.executor === 'docker' && config.runnerImage !== config.runnerDigest && (!DIGEST_IMAGE.test(String(config.runnerImage || '')) || !String(config.runnerImage).endsWith(`@${config.runnerDigest}`))) throw new Error('runner_image_must_be_digest_pinned');
  const replay = createReplayGuard();
  const jobs = new Map();
  const credentials = new WeakMap();
  const activeProbes = new Map();
  let accepting = true;
  const retentionMs = Number(options.retentionMs ?? JOB_RETENTION_MS);
  const maxTerminalJobs = Number(options.maxTerminalJobs ?? MAX_TERMINAL_JOBS);
  const cleanupTimer = setInterval(() => pruneJobs(), 60_000);
  cleanupTimer.unref?.();
  const validate = (spec) => validateJobSpec(spec, { dataRoot: config.dataRoot, runnerDigest: config.runnerDigest, model: config.model });

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
    })();
    return job.termination;
  }

  async function probe() {
    if (config.executor !== 'docker') return { ready: true, executor: config.executor, runner_digest: config.runnerDigest };
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

  async function probeCodexProvider(model, credential) {
    if (config.executor !== 'docker') return { provider: 'codex', model, status: 'unavailable', checked_at: new Date().toISOString(), error_code: 'deterministic_adapter' };
    if (!credential?.auth) return { provider: 'codex', model, status: 'unavailable', checked_at: new Date().toISOString(), error_code: 'credential_missing' };
    try { await ensureModelNetwork(); }
    catch { return { provider: 'codex', model, status: 'unavailable', checked_at: new Date().toISOString(), error_code: 'egress_unavailable' }; }
    const containerName = `aiws-codex-probe-${randomUUID().replaceAll('-', '')}`;
    const args = [
      'run', '--rm', '--interactive', '--init', '--name', containerName,
      '--label', 'aiws.owner=aiws-v3', '--label', 'aiws.role=codex-probe',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only',
      '--network', 'aiws-runner-model', '--cpus', '1', '--memory', '1g', '--pids-limit', '256',
      '--tmpfs', '/tmp:size=256m,mode=1777',
      '--tmpfs', '/tmp/codex-home:rw,size=64m,mode=700,uid=10001,gid=10001',
      '--workdir', '/tmp', config.runnerImage
    ];
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const activeProbe = { child, containerName, timer: null };
    activeProbes.set(containerName, activeProbe);
    let stdout = '';
    let bytes = 0;
    child.stdout.on('data', (chunk) => { bytes += chunk.byteLength; if (bytes <= 2 * 1024 * 1024) stdout += chunk.toString('utf8'); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ mode: 'probe', model, credential, bundle: { objective: 'Reply with ok.', acceptance: [], input_assets: [], input_paths: [], output_paths: [], checks: ['node_test', 'git_diff_check'], prior_outputs_root: '/outputs', retry_context: null }, input_paths: [], output_paths: [] }));
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
        await execFileAsync('docker', ['rm', '--force', containerName], { encoding: 'utf8', timeout: 5_000, windowsHide: true }).catch(() => undefined);
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
      const available = outcome.code === 0 && parsed?.outcome === 'completed';
      return { provider: 'codex', model, status: available ? 'available' : 'unavailable', checked_at: new Date().toISOString(), error_code: available ? null : outcome.timeout ? 'probe_timeout' : parsed?.error_code || 'provider_failed' };
    } finally {
      clearTimeout(activeProbe.timer);
      activeProbes.delete(containerName);
    }
  }

  async function execute(job) {
    if (config.executor !== 'docker') {
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
    if (job.spec.network_profile === 'model') {
      await ensureModelNetwork();
    }
    const runtimeSpec = job.spec.credential_ref === '[ephemeral]'
      ? { ...job.spec, credential_ref: credentials.get(job)?.ref || null }
      : job.spec;
    const args = buildDockerArgs(runtimeSpec, { dataRoot: config.dataRoot, dataVolume: config.dataVolume, runnerDigest: config.runnerDigest, runnerImage: config.runnerImage, model: config.model });
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    job.container = child;
    job.containerName = args[args.indexOf('--name') + 1];
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
      const secrets = credential?.auth ? [credential.auth] : [];
      job.status = code === 0 && !stdoutExceeded && !job.timed_out ? 'completed' : 'failed';
      let normalized = null;
      try { normalized = JSON.parse(stdout); } catch { normalized = null; }
      const runnerCompleted = normalized?.outcome === 'completed' && code === 0 && !stdoutExceeded && !job.timed_out;
      job.result = normalized && typeof normalized === 'object'
        ? { outcome: runnerCompleted ? 'completed' : 'failed', summary: safeSummary(job.timed_out ? 'runner deadline exceeded' : stdoutExceeded ? 'runner output exceeded the size limit' : normalized.summary, secrets), changed_files: safePaths(normalized.changed_files), checks: Array.isArray(normalized.checks) ? normalized.checks.slice(0, 32).map((check) => ({ id: String(check?.id || 'unknown').slice(0, 80), passed: Boolean(check?.passed), exit_code: Number.isInteger(check?.exit_code) ? check.exit_code : null, stdout_sha256: /^[a-f0-9]{64}$/.test(String(check?.stdout_sha256 || '')) ? check.stdout_sha256 : null, error_code: normalizeRunnerErrorCode(check?.error_code, check?.passed ? '' : 'runner_failed') || null })) : [], events: safeEvents(normalized.events, secrets), output_paths: safePaths(job.spec.output_paths), usage: normalized.usage && typeof normalized.usage === 'object' ? Object.fromEntries(Object.entries(normalized.usage).filter(([, amount]) => Number.isFinite(amount)).slice(0, 16)) : {}, exit_code: code ?? 1, error_code: runnerCompleted ? null : normalizeRunnerErrorCode(normalized.error_code, job.timed_out ? 'runner_deadline_exceeded' : stdoutExceeded ? 'runner_output_too_large' : 'runner_failed') }
        : { outcome: code === 0 && !stdoutExceeded && !job.timed_out ? 'completed' : 'failed', summary: job.timed_out ? 'runner deadline exceeded' : stdoutExceeded ? 'runner output exceeded the size limit' : code === 0 ? 'runner completed' : 'runner exited with an error', changed_files: [], checks: [], output_paths: job.spec.output_paths || [], usage: {}, exit_code: code ?? 1, signal: signal || null, error_code: normalizeRunnerErrorCode(null, job.timed_out ? 'runner_deadline_exceeded' : stdoutExceeded ? 'runner_output_too_large' : 'runner_failed') };
      job.finished_at = new Date().toISOString();
      credentials.delete(job);
    });
    child.once('error', () => {
      clearTimeout(timeout);
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.result = { outcome: 'failed', summary: 'runner process failed to start', changed_files: [], checks: [], output_paths: [], usage: {}, exit_code: 1, error_code: 'runner_spawn_failed' };
        job.finished_at = new Date().toISOString();
        credentials.delete(job);
      }
    });
  }

  async function handler(req, res) {
    const requestId = randomUUID();
    const parsed = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const requestPath = parsed.pathname;
    try {
      if (req.method === 'GET' && requestPath === '/livez') return send(res, 200, { status: 'alive' });
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
        return send(res, 200, await probeCodexProvider(model, { ref: credential.ref, profile: String(credential.profile || 'default').slice(0, 80), auth: credential.auth }));
      }
      if (req.method === 'POST' && requestPath === '/internal/v1/jobs') {
        if (!accepting) throw new AppError('broker_shutting_down', 'broker is shutting down', { status: 503, retryable: true });
        const envelope = parsedBody.value?.spec ? parsedBody.value : { spec: parsedBody.value, credential: null };
        const spec = validate(envelope.spec);
        let credential = null;
        if (envelope.credential != null) {
          if (!spec.credential_ref || envelope.credential?.ref !== spec.credential_ref || typeof envelope.credential?.auth !== 'string' || envelope.credential.auth.length < 8 || envelope.credential.auth.length > 16_384) throw new AppError('invalid_job_spec', 'credential envelope does not match the job spec');
          credential = { ref: spec.credential_ref, profile: String(envelope.credential.profile || 'default').slice(0, 80), auth: envelope.credential.auth };
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
        await execFileAsync('docker', ['rm', '--force', probeJob.containerName], {
          encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024
        }).catch(() => undefined);
      }));
      activeProbes.clear();
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
