import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync,
  randomBytes, sign, timingSafeEqual, verify
} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildDockerRunnerArgs } from '../api/src/clean/runner-adapters.mjs';
import { validateRunnerJobSpec, validateRunnerReceipt } from '../api/src/clean/runner-protocol.mjs';

const execFileAsync = promisify(execFile);
const WINDOW_MS = 60_000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'external_result_unknown']);

export function createCleanBroker(options = {}) {
  const host = String(options.host || process.env.AIWS_BROKER_HOST || '127.0.0.1'); if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('clean_broker_loopback_required');
  const port = Number(options.port ?? process.env.AIWS_BROKER_PORT ?? 4322); const secret = String(options.secret || process.env.AIWS_RUNNER_BROKER_SECRET || ''); if (secret.length < 16) throw new Error('clean_broker_secret_required');
  const runnerDigest = String(options.runnerDigest || process.env.AIWS_RUNNER_DIGEST || '').toLowerCase(); if (!/^sha256:[a-f0-9]{64}$/.test(runnerDigest)) throw new Error('clean_broker_digest_required');
  const stateRoot = path.resolve(options.stateRoot || process.env.AIWS_BROKER_STATE || path.join(os.homedir(), '.ai-workspace', 'clean-runner-broker')); fs.mkdirSync(path.join(stateRoot, 'jobs'), { recursive: true, mode: 0o700 });
  const identity = loadIdentity(stateRoot); const jobs = loadJobs(stateRoot); const nonces = new Map(); const children = new Map(); const spawnImpl = options.spawnImpl || spawn;
  const executeFile = options.execFileImpl || execFileAsync;

  async function probe() { const result = await executeFile('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 }); return { schema_version: 'aiws.clean-broker.probe.v1', status: 'ready', docker_server_version: String(result.stdout || '').trim(), runner_digest: runnerDigest, identity_public_key: identity.publicKey, capabilities: ['digest-pinned', 'cap-drop-all', 'read-only-root', 'no-new-privileges', 'bounded-tmpfs', 'bounded-network'] }; }

  async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1'); if (req.method === 'GET' && url.pathname === '/livez') return send(res, 200, { status: 'live', process: 'v3-clean-runner-broker' });
      const body = await readBody(req); authenticate(req.headers, req.method || 'GET', url.pathname, body.raw, secret, nonces);
      if (req.method === 'GET' && url.pathname === '/internal/v2/probe') return send(res, 200, await probe());
      if (req.method === 'POST' && url.pathname === '/internal/v2/jobs') {
        const envelope = body.value || {}; const spec = validateRunnerJobSpec(envelope.spec, { expectedImageDigest: runnerDigest }); const specJson = canonical(spec); const publicKey = String(envelope.service_public_key || '');
        if (!publicKey || (options.servicePublicKey && publicKey.trim() !== String(options.servicePublicKey).trim()) || !verify(null, Buffer.from(specJson), createPublicKey(publicKey), Buffer.from(String(envelope.signature || ''), 'base64url'))) throw brokerError('runner_signature_invalid', 403);
        const specHash = hash(specJson); const prior = [...jobs.values()].find((item) => item.spec.job_spec_id === spec.job_spec_id); if (prior) { if (prior.spec_hash !== specHash) throw brokerError('runner_job_conflict', 409); return send(res, 200, publicJob(prior)); }
        const jobId = `broker_job_${randomBytes(16).toString('hex')}`; const job = { job_id: jobId, status: 'queued', spec, spec_hash: specHash, created_at: new Date().toISOString(), receipt: null, signature: null, signer_public_key: identity.publicKey }; jobs.set(jobId, job); persistJob(stateRoot, job); queueMicrotask(() => execute(job).catch(() => undefined)); return send(res, 201, publicJob(job));
      }
      const match = url.pathname.match(/^\/internal\/v2\/jobs\/([^/]+)(?:\/(cancel))?$/); if (match) {
        const id = decodeURIComponent(match[1]); let job = jobs.get(id); if (!job) return send(res, 200, { job_id: id, status: 'unknown' });
        if (req.method === 'GET' && !match[2]) { if (!TERMINAL.has(job.status) && !children.has(id)) job = await reconcile(job); return send(res, 200, publicJob(job)); }
        if (req.method === 'POST' && match[2] === 'cancel') { if (!TERMINAL.has(job.status)) { job.status = 'cancelled'; terminate(children.get(id)); await executeFile('docker', ['rm', '--force', containerName(job)], { windowsHide: true, timeout: 10_000 }).catch(() => undefined); finish(job, 'cancelled', null, Buffer.alloc(0), Buffer.alloc(0), 'cancelled'); } return send(res, 200, publicJob(job)); }
      }
      return send(res, 404, { error: { code: 'not_found' } });
    } catch (error) { return send(res, Number(error?.status || 500), { error: { code: String(error?.code || 'internal_error'), message: String(error?.message || 'internal error').slice(0, 160), details: error?.details || {} } }); }
  }

  async function execute(job) {
    if (job.status === 'cancelled') return; job.status = 'running'; job.started_at = new Date().toISOString(); persistJob(stateRoot, job);
    const args = buildDockerRunnerArgs(job.spec, { image: runnerDigest, dataVolume: options.dataVolume || process.env.AIWS_CLEAN_DATA_VOLUME || 'aiws-clean-data' }); const stdout = []; const stderr = [];
    try { const child = spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); children.set(job.job_id, child); child.stdout?.on('data', (chunk) => pushBounded(stdout, chunk)); child.stderr?.on('data', (chunk) => pushBounded(stderr, chunk)); const deadline = Math.max(1, Date.parse(job.spec.deadline_at) - Date.now()); const timer = setTimeout(() => { job.timed_out = true; terminate(child); }, deadline); timer.unref?.(); const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve({ code })); }); clearTimeout(timer); const status = job.status === 'cancelled' ? 'cancelled' : job.timed_out ? 'expired' : result.code === 0 ? 'succeeded' : 'failed'; finish(job, status, result.code, Buffer.concat(stdout), Buffer.concat(stderr), status === 'expired' ? 'runner_deadline_exceeded' : status === 'failed' ? 'runner_failed' : ''); }
    catch (error) { finish(job, job.status === 'cancelled' ? 'cancelled' : 'failed', 1, Buffer.concat(stdout), Buffer.concat(stderr), String(error?.code || 'runner_spawn_failed')); }
    finally { children.delete(job.job_id); }
  }

  function finish(job, status, exitCode, stdout, stderr, errorCode) { const finished = new Date().toISOString(); const outputs = job.spec.output_paths || []; const receipt = validateRunnerReceipt({ schema_version: 'runner.receipt.v2', receipt_id: `broker_receipt_${randomBytes(16).toString('hex')}`, job_spec_id: job.spec.job_spec_id, job_spec_hash: job.spec_hash, runner_profile_ref: job.spec.runner_profile_ref, runner_job_ref: job.job_id, status, exit_code: exitCode, stdout_sha256: stdout.length ? hash(stdout) : '', stderr_sha256: stderr.length ? hash(stderr) : '', output_sha256: outputs.length ? hash(canonical(outputs)) : '', stdout_bytes: stdout.length, stderr_bytes: stderr.length, output_bytes: 0, output_paths: outputs, error_code: errorCode, started_at: job.started_at || job.created_at, finished_at: finished }); const json = canonical(receipt); job.status = status; job.receipt = receipt; job.signature = sign(null, Buffer.from(json), identity.privateKey).toString('base64url'); job.finished_at = finished; persistJob(stateRoot, job); }
  async function reconcile(job) { try { const result = await executeFile('docker', ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', containerName(job)], { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 }); const [status, code] = String(result.stdout || '').trim().split(/\s+/, 2); if (status === 'running') return job; if (['exited', 'dead'].includes(status)) finish(job, Number(code) === 0 ? 'succeeded' : 'failed', Number(code), Buffer.alloc(0), Buffer.alloc(0), Number(code) === 0 ? '' : 'runner_failed'); else job.status = 'external_result_unknown'; } catch { job.status = 'external_result_unknown'; persistJob(stateRoot, job); } return job; }
  async function close() { for (const [id, child] of children) { terminate(child); const job = jobs.get(id); if (job && !TERMINAL.has(job.status)) finish(job, 'cancelled', null, Buffer.alloc(0), Buffer.alloc(0), 'broker_shutdown'); } children.clear(); }
  return { host, port, stateRoot, runnerDigest, jobs, identity_public_key: identity.publicKey, handler, probe, close };
}

export async function start(options = {}) { const app = createCleanBroker(options); const server = http.createServer((req, res) => void Promise.resolve(app.handler(req, res))); await new Promise((resolve) => server.listen(app.port, app.host, resolve)); const address = server.address(); return { ...app, server, url: `http://${address.address}:${address.port}`, close: async () => { await app.close(); await new Promise((resolve) => server.close(resolve)); } }; }

function authenticate(headers, method, route, raw, secret, nonces) { const timestamp = String(headers['x-aiws-timestamp'] || ''); const nonce = String(headers['x-aiws-nonce'] || ''); const bodyHash = String(headers['x-aiws-body-sha256'] || ''); const signature = String(headers['x-aiws-signature'] || ''); if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > WINDOW_MS || !/^[A-Za-z0-9_-]{16,160}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(bodyHash) || hash(raw) !== bodyHash) throw brokerError('broker_signature_invalid', 401); for (const [key, value] of nonces) if (value < Date.now() - WINDOW_MS) nonces.delete(key); if (nonces.has(nonce)) throw brokerError('broker_nonce_replay', 409); const expected = createHmac('sha256', secret).update(`${method}\n${route}\n${timestamp}\n${nonce}\n${bodyHash}`).digest('hex'); if (!safeEqual(signature, expected)) throw brokerError('broker_signature_invalid', 401); nonces.set(nonce, Number(timestamp)); }
async function readBody(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw brokerError('body_too_large', 413); chunks.push(chunk); } const raw = size ? Buffer.concat(chunks).toString('utf8') : canonical({}); try { return { raw, value: size ? JSON.parse(raw) : {} }; } catch { throw brokerError('invalid_json', 400); } }
function loadIdentity(root) { const file = path.join(root, 'identity.json'); if (fs.existsSync(file)) { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return { publicKey: value.public_key, privateKey: createPrivateKey(value.private_key) }; } const pair = generateKeyPairSync('ed25519'); const value = { public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }; fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); return { publicKey: value.public_key, privateKey: pair.privateKey }; }
function loadJobs(root) { const jobs = new Map(); for (const name of fs.readdirSync(path.join(root, 'jobs')).filter((item) => /^broker_job_[A-Za-z0-9]+\.json$/.test(item))) { try { const value = JSON.parse(fs.readFileSync(path.join(root, 'jobs', name), 'utf8')); jobs.set(value.job_id, value); } catch { /* a corrupt local state record reconciles as unknown */ } } return jobs; }
function persistJob(root, job) { const safe = { ...job, child: undefined }; const file = path.join(root, 'jobs', `${job.job_id}.json`); const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, file); }
function publicJob(job) { return { job_id: job.job_id, status: job.status, ...(job.receipt ? { receipt: job.receipt, signature: job.signature, signer_public_key: job.signer_public_key } : {}) }; }
function containerName(job) { return `aiws-${job.spec.job_spec_id}`; }
function pushBounded(chunks, chunk) { const current = chunks.reduce((total, item) => total + item.length, 0); if (current < 1024 * 1024) chunks.push(Buffer.from(chunk).subarray(0, 1024 * 1024 - current)); }
function terminate(child) { if (!child || child.exitCode != null) return; try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } } }
function send(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); return value; }
function brokerError(code, status, details = {}) { const error = new Error(code); error.code = code; error.status = status; error.details = details; return error; }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`; return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const running = await start(); process.stdout.write(`V3-Clean Runner Broker listening on ${running.url}\n`); const shutdown = async () => { await running.close(); process.exit(0); }; process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); }
