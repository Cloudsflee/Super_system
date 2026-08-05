import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError, asAppError } from '../api/src/errors.mjs';
import { buildDockerArgs, redactJobSpec, validateJobSpec } from './src/job-spec.mjs';
import { createReplayGuard } from './src/signature.mjs';
import { DEVELOPMENT_RUNNER_DIGEST } from '../../packages/contracts/src/index.mjs';

const execFileAsync = promisify(execFile);

export function brokerConfig(env = process.env) {
  const dataVolume = env.AIWS_DOCKER_DATA_VOLUME || 'aiws-data-v3';
  if (/v(?:12|13|14|15|16|17|18|19|20|21|22|23)/i.test(dataVolume)) throw new Error('legacy_data_volume_forbidden');
  const production = env.NODE_ENV === 'production';
  const executor = env.AIWS_BROKER_EXECUTOR || 'mock';
  const secret = readSecret(env.AIWS_BROKER_HMAC_SECRET_FILE) || env.AIWS_BROKER_HMAC_SECRET || (production ? '' : 'dev-only-local-broker-secret');
  const runnerDigest = env.AIWS_RUNNER_DIGEST || (production || executor === 'docker' ? '' : DEVELOPMENT_RUNNER_DIGEST);
  const runnerImage = env.AIWS_RUNNER_IMAGE || runnerDigest;
  if (!/^sha256:[a-f0-9]{64}$/.test(runnerDigest) || /^sha256:0{64}$/.test(runnerDigest)) throw new Error('runner_digest_required');
  if ((production || executor === 'docker') && secret.length < 32) throw new Error('broker_hmac_secret_required');
  if (executor === 'docker' && runnerImage !== runnerDigest && !runnerImage.endsWith(`@${runnerDigest}`)) throw new Error('runner_image_must_be_digest_pinned');
  return {
    host: env.AIWS_BROKER_HOST || '127.0.0.1',
    port: Number(env.AIWS_BROKER_PORT || 4321),
    secret,
    dataRoot: env.AIWS_BROKER_DATA_ROOT || '/var/lib/aiws',
    dataVolume,
    runnerDigest,
    executor,
    runnerImage
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
  try { return { raw, value: JSON.parse(raw) }; } catch { throw new AppError('invalid_json', 'request body must be JSON'); }
}

export function createBroker(options = {}) {
  const config = options.config || brokerConfig(options.env || process.env);
  const replay = createReplayGuard();
  const jobs = new Map();
  const validate = (spec) => validateJobSpec(spec, { dataRoot: config.dataRoot, runnerDigest: config.runnerDigest });

  async function probe() {
    if (config.executor !== 'docker') return { ready: true, executor: config.executor, runner_digest: config.runnerDigest };
    try {
      const { stdout } = await execFileAsync('docker', ['image', 'inspect', config.runnerImage], {
        encoding: 'utf8', timeout: 3_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024
      });
      const inspected = JSON.parse(stdout)[0];
      const pinned = inspected?.Id === config.runnerDigest || (inspected?.RepoDigests || []).some((value) => value.endsWith(`@${config.runnerDigest}`));
      return {
        ready: Boolean(pinned),
        executor: config.executor,
        runner_digest: config.runnerDigest,
        error: pinned ? null : 'runner_digest_mismatch'
      };
    } catch {
      return { ready: false, executor: config.executor, runner_digest: config.runnerDigest, error: 'runner_image_unavailable' };
    }
  }

  async function execute(job) {
    if (config.executor !== 'docker') {
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (job.status === 'cancelled') return;
      job.status = 'completed';
      job.result = { exit_code: 0, output_paths: job.spec.output_paths };
      job.finished_at = new Date().toISOString();
      return;
    }
    const args = buildDockerArgs(job.spec, { dataVolume: config.dataVolume, runnerImage: config.runnerImage });
    const child = spawn('docker', args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    job.container = child;
    child.stdin.end(JSON.stringify({ task_id: job.spec.task_id, execution_id: job.spec.execution_id, mode: job.spec.execution_mode }));
    child.once('exit', (code, signal) => {
      if (job.status === 'cancelled') return;
      job.status = code === 0 ? 'completed' : 'failed';
      job.result = { exit_code: code ?? 1, signal: signal || null, output_paths: job.spec.output_paths };
      job.finished_at = new Date().toISOString();
    });
    child.once('error', () => {
      if (job.status !== 'cancelled') {
        job.status = 'failed';
        job.result = { exit_code: 1, error_code: 'runner_spawn_failed' };
        job.finished_at = new Date().toISOString();
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
      if (req.method === 'POST' && requestPath === '/internal/v1/jobs') {
        const spec = validate(parsedBody.value);
        const jobId = `job_${randomUUID().replaceAll('-', '')}`;
        const job = { job_id: jobId, status: 'queued', spec: redactJobSpec(spec), created_at: new Date().toISOString(), result: null };
        jobs.set(jobId, job);
        setImmediate(async () => {
          if (job.status === 'cancelled') return;
          job.status = 'running';
          job.started_at = new Date().toISOString();
          await execute(job);
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
            job.container?.kill('SIGTERM');
            job.finished_at = new Date().toISOString();
          }
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
    probe
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
  return { ...broker, server, close: () => new Promise((resolve) => server.close(resolve)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await start();
  const shutdown = async () => { await running.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
