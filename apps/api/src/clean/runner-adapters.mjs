import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createHash, createHmac, generateKeyPairSync, randomBytes
} from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { RUNNER_RESOURCE_PROFILES, signRunnerReceipt } from './runner-protocol.mjs';

const execFileAsync = promisify(execFile);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'external_result_unknown']);

export class DeterministicRunnerAdapter {
  constructor({ type = 'host', clock = () => new Date(), execute = null, identity = null } = {}) {
    this.type = type; this.clock = clock; this.execute = execute; this.jobs = new Map();
    this.identity = identity || generateKeyPairSync('ed25519');
  }

  publicIdentity() { return this.identity.publicKey.export({ type: 'spki', format: 'pem' }).toString(); }
  async probe() { return { status: 'ready', runner_type: this.type, identity_public_key: this.publicIdentity(), capabilities: capabilitiesFor(this.type), limits: RUNNER_RESOURCE_PROFILES }; }

  async submit(spec, context = {}) {
    const id = opaqueId('runner_job');
    const job = { job_id: id, status: 'queued', spec, context, created_at: iso(this.clock), receipt: null, signature: null };
    this.jobs.set(id, job);
    queueMicrotask(() => this.runJob(job).catch(() => undefined));
    return { job_id: id, status: 'queued' };
  }

  async runJob(job) {
    if (job.status === 'cancelled') return;
    job.status = 'running'; job.started_at = iso(this.clock);
    let result;
    try {
      result = this.execute ? await this.execute(job.spec, job.context) : deterministicResult(job.context);
    } catch (error) {
      result = { status: String(error?.code || '') === 'external_result_unknown' ? 'external_result_unknown' : 'failed', exit_code: 1, error_code: String(error?.code || 'runner_failed') };
    } finally {
      if (Buffer.isBuffer(job.context?.credential)) job.context.credential.fill(0);
    }
    if (job.status === 'cancelled') result = { status: 'cancelled', exit_code: null, error_code: 'cancelled' };
    const finished = iso(this.clock);
    const receipt = receiptValue(job, result, finished);
    const signed = signRunnerReceipt(receipt, this.identity.privateKey, { expectedJobSpecId: job.spec.job_spec_id, expectedJobSpecHash: job.context.specHash });
    job.status = signed.receipt.status; job.receipt = signed.receipt; job.signature = signed.signature; job.finished_at = finished;
  }

  async status(jobId) {
    const job = this.jobs.get(String(jobId));
    if (!job) return { job_id: String(jobId), status: 'unknown' };
    return { job_id: job.job_id, status: job.status, ...(job.receipt ? { receipt: job.receipt, signature: job.signature, signer_public_key: this.publicIdentity() } : {}) };
  }

  async cancel(jobId) {
    const job = this.jobs.get(String(jobId));
    if (!job) return { job_id: String(jobId), status: 'unknown' };
    if (!TERMINAL.has(job.status)) {
      job.status = 'cancelled';
      const signed = signRunnerReceipt(receiptValue(job, { status: 'cancelled', exit_code: null, error_code: 'cancelled' }, iso(this.clock)), this.identity.privateKey, { expectedJobSpecId: job.spec.job_spec_id, expectedJobSpecHash: job.context.specHash });
      job.receipt = signed.receipt; job.signature = signed.signature; job.finished_at = signed.receipt.finished_at;
    }
    return { job_id: job.job_id, status: job.status };
  }
}

export class HostRunnerAdapter extends DeterministicRunnerAdapter {
  constructor({ homeRoot = null, clock, spawnImpl = spawn, identity = null } = {}) {
    super({ type: 'host', clock, identity });
    this.homeRoot = path.resolve(homeRoot || path.join(os.tmpdir(), 'aiws-host-runner-homes'));
    this.spawnImpl = spawnImpl; this.children = new Map();
    fs.mkdirSync(this.homeRoot, { recursive: true, mode: 0o700 });
  }

  async probe() {
    const result = await execFileAsync(process.execPath, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 });
    return { status: 'ready', runner_type: 'host', identity_public_key: this.publicIdentity(), runtime: String(result.stdout || '').trim(), capabilities: capabilitiesFor('host'), limits: RUNNER_RESOURCE_PROFILES };
  }

  async runJob(job) {
    if (job.status === 'cancelled') return;
    job.status = 'running'; job.started_at = iso(this.clock);
    const home = path.join(this.homeRoot, job.job_id);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const script = [
      "const crypto=require('node:crypto')",
      "const value=JSON.parse(process.env.AIWS_RUNNER_TASK || '{}')",
      "process.stdout.write(JSON.stringify({status:'succeeded',task_ref:value.task_ref||'',output_paths:value.output_paths||[]})+'\\n')"
    ].join(';');
    const output = []; const errors = [];
    try {
      const child = this.spawnImpl(process.execPath, ['-e', script], {
        cwd: job.context.workspacePath || process.cwd(),
        env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', CODEX_HOME: home, AIWS_RUNNER_TASK: JSON.stringify({ task_ref: job.spec.task_ref, output_paths: job.spec.output_paths }) },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'
      });
      this.children.set(job.job_id, child);
      const deadline = Math.max(1, Date.parse(job.spec.deadline_at) - Date.now());
      const timer = setTimeout(() => { job.timed_out = true; terminateTree(child); }, deadline); timer.unref?.();
      child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
      const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
      clearTimeout(timer); this.children.delete(job.job_id);
      const { stdout, stderr } = boundedStreams(output, errors);
      const status = job.status === 'cancelled' ? 'cancelled' : job.timed_out ? 'expired' : result.code === 0 ? 'succeeded' : 'failed';
      const signed = signRunnerReceipt(receiptValue(job, { status, exit_code: result.code, error_code: status === 'expired' ? 'runner_deadline_exceeded' : status === 'failed' ? 'runner_failed' : status === 'cancelled' ? 'cancelled' : '', stdout, stderr }, iso(this.clock)), this.identity.privateKey, { expectedJobSpecId: job.spec.job_spec_id, expectedJobSpecHash: job.context.specHash });
      job.status = signed.receipt.status; job.receipt = signed.receipt; job.signature = signed.signature; job.finished_at = signed.receipt.finished_at;
    } catch (error) {
      const status = job.status === 'cancelled' ? 'cancelled' : 'failed'; const signed = signRunnerReceipt(receiptValue(job, { status, exit_code: status === 'cancelled' ? null : 1, error_code: status === 'cancelled' ? 'cancelled' : String(error?.code || 'runner_spawn_failed') }, iso(this.clock)), this.identity.privateKey, { expectedJobSpecId: job.spec.job_spec_id, expectedJobSpecHash: job.context.specHash });
      job.status = status; job.receipt = signed.receipt; job.signature = signed.signature;
    } finally {
      this.children.delete(job.job_id);
      if (Buffer.isBuffer(job.context?.credential)) job.context.credential.fill(0);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  async cancel(jobId) {
    const child = this.children.get(String(jobId)); if (child) terminateTree(child);
    return super.cancel(jobId);
  }
}

export class BrokerRunnerAdapter {
  constructor({ baseUrl = null, secret = '', fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/$/, '') : null; this.secret = String(secret || ''); this.fetch = fetchImpl; this.clock = clock;
  }
  async probe() { return this.request('GET', '/internal/v2/probe', {}); }
  async submit(spec, context = {}) { return this.request('POST', '/internal/v2/jobs', { spec, signature: context.specSignature, service_public_key: context.servicePublicKey }); }
  async status(jobId) { return this.request('GET', `/internal/v2/jobs/${encodeURIComponent(jobId)}`, {}); }
  async cancel(jobId) { return this.request('POST', `/internal/v2/jobs/${encodeURIComponent(jobId)}/cancel`, {}); }
  async request(method, route, body) {
    if (!this.baseUrl || !this.fetch || this.secret.length < 16) throw new PlatformError('runner_unavailable', 'Clean Broker transport is unavailable', {}, 503);
    const raw = canonicalJson(body || {}); const timestamp = String(Number(this.clock())); const nonce = randomBytes(18).toString('base64url');
    const bodyHash = sha256Hex(raw); const signature = createHmac('sha256', this.secret).update(`${method}\n${route}\n${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
    let response;
    try { response = await this.fetch(`${this.baseUrl}${route}`, { method, headers: { 'content-type': 'application/json', 'x-aiws-timestamp': timestamp, 'x-aiws-nonce': nonce, 'x-aiws-body-sha256': bodyHash, 'x-aiws-signature': signature }, ...(method === 'GET' ? {} : { body: raw }) }); }
    catch (error) { throw new PlatformError('runner_unavailable', 'Clean Broker request failed', { reason: String(error?.code || 'transport') }, 503); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new PlatformError(String(payload?.error?.code || 'runner_failed'), 'Clean Broker request failed', payload?.error?.details || {}, response.status);
    return payload;
  }
}

export class BridgeJobAdapter {
  constructor({ bridgeAdapter, leaseForProfile } = {}) { this.bridge = bridgeAdapter; this.leaseForProfile = leaseForProfile; }
  async probe(profile) { const result = await this.withLease(profile, (lease) => this.bridge.probe(lease)); const identity = await this.bridge.identity(); return { ...result, runner_type: 'windows_bridge', identity_public_key: identity.identity_public_key || profile.identity_public_key || '', limits: RUNNER_RESOURCE_PROFILES }; }
  async submit(spec, context = {}) { return this.withLease(context.profile, (lease) => this.bridge.submitJob({ spec, signature: context.specSignature, service_public_key: context.servicePublicKey }, lease)); }
  async status(jobId, context = {}) { return this.withLease(context.profile, (lease) => this.bridge.jobStatus(jobId, lease)); }
  async cancel(jobId, context = {}) { return this.withLease(context.profile, (lease) => this.bridge.cancelJob(jobId, lease)); }
  async withLease(profile, callback) { const lease = this.leaseForProfile(profile); try { return await callback(lease); } finally { if (Buffer.isBuffer(lease?.secret)) lease.secret.fill(0); } }
}

export function buildDockerRunnerArgs(spec, { image = null, dataVolume = 'aiws-clean-data', workspaceSubpath = null, inputSubpath = null, outputSubpath = null } = {}) {
  const profile = RUNNER_RESOURCE_PROFILES[spec.resource_profile];
  if (!profile) throw new PlatformError('runner_resource_profile_invalid', 'runner resource profile is invalid', {}, 422);
  const reference = image || spec.image_digest;
  if (!/^([a-z0-9]+(?:[._/-][a-z0-9]+)*)?@?sha256:[a-f0-9]{64}$/i.test(String(reference || ''))) throw new PlatformError('runner_digest_invalid', 'Docker image must be digest pinned', {}, 422);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dataVolume)) throw new PlatformError('runner_volume_invalid', 'Docker data volume is invalid', {}, 422);
  const workspace = workspaceSubpath || `executions/${spec.execution_ref}/tasks/${spec.task_ref}`;
  const inputs = inputSubpath || `executions/${spec.execution_ref}/inputs`;
  const outputs = outputSubpath || `executions/${spec.execution_ref}/outputs/${spec.task_ref}`;
  return [
    'run', '--rm', '--init', '--name', `aiws-${spec.job_spec_id}`,
    '--label', 'aiws.owner=v3-clean', '--label', `aiws.execution=${spec.execution_ref}`, '--label', `aiws.job=${spec.job_spec_id}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only',
    '--network', spec.capabilities.includes('network:model') ? 'aiws-runner-model' : 'none',
    '--cpus', String(profile.cpus), '--memory', String(profile.memory_bytes), '--pids-limit', String(profile.pids),
    '--tmpfs', `/tmp:size=${profile.tmpfs_bytes},mode=1777`, '--tmpfs', '/tmp/codex-home:size=268435456,mode=700',
    '--mount', `type=volume,src=${dataVolume},dst=/workspace,volume-subpath=${workspace}${spec.execution_mode === 'read' ? ',readonly' : ''}`,
    '--mount', `type=volume,src=${dataVolume},dst=/inputs,volume-subpath=${inputs},readonly`,
    '--mount', `type=volume,src=${dataVolume},dst=/outputs,volume-subpath=${outputs}`,
    '--workdir', '/workspace', reference
  ];
}

function deterministicResult(context) {
  const fixture = context?.fixture || {};
  if (fixture.error_code) return { status: fixture.status || 'failed', exit_code: fixture.exit_code ?? 1, error_code: fixture.error_code, stdout: Buffer.from(String(fixture.stdout || '')), stderr: Buffer.from(String(fixture.stderr || '')), output_bytes: Number(fixture.output_bytes || 0) };
  return { status: fixture.status || 'succeeded', exit_code: fixture.exit_code ?? 0, error_code: '', stdout: Buffer.from(String(fixture.stdout || 'runner completed\n')), stderr: Buffer.from(String(fixture.stderr || '')), output_bytes: Number(fixture.output_bytes || 0) };
}

function receiptValue(job, result = {}, finishedAt) {
  const stdout = Buffer.from(result.stdout || ''); const stderr = Buffer.from(result.stderr || '');
  const outputPaths = Array.isArray(result.output_paths) ? result.output_paths : job.spec.output_paths;
  const outputHash = String(result.output_sha256 || (outputPaths.length ? sha256Hex(canonicalJson(outputPaths)) : ''));
  return {
    schema_version: 'runner.receipt.v2', receipt_id: opaqueId('runner_receipt'), job_spec_id: job.spec.job_spec_id,
    job_spec_hash: String(job.context.specHash || ''), runner_profile_ref: job.spec.runner_profile_ref, runner_job_ref: job.job_id,
    status: String(result.status || 'failed'), exit_code: result.exit_code == null ? null : Number(result.exit_code),
    stdout_sha256: stdout.length ? hash(stdout) : '', stderr_sha256: stderr.length ? hash(stderr) : '', output_sha256: outputHash,
    stdout_bytes: stdout.length, stderr_bytes: stderr.length, output_bytes: Number(result.output_bytes || 0), output_paths: outputPaths,
    error_code: String(result.error_code || ''), started_at: job.started_at || job.created_at, finished_at: finishedAt
  };
}

function capabilitiesFor(type) { return type === 'docker' ? ['workspace:read', 'workspace:write', 'network:none', 'network:model', 'check:node_test', 'check:git_diff_check'] : ['workspace:read', 'workspace:write', 'network:none', 'check:node_test', 'check:git_diff_check']; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function iso(clock) { const value = typeof clock === 'function' ? clock() : new Date(); return typeof value === 'string' ? value : new Date(value).toISOString(); }
function boundedStreams(output, errors) { const stdout = Buffer.concat(output).subarray(0, 2 * 1024 * 1024); const remaining = Math.max(0, 2 * 1024 * 1024 - stdout.length); return { stdout, stderr: Buffer.concat(errors).subarray(0, remaining) }; }
function terminateTree(child) { if (!child || child.exitCode != null) return; try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGKILL'); } catch { /* process already exited */ } } }
