import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify
} from 'node:crypto';
import { validateRunnerJobSpec, validateRunnerReceipt } from '../../api/src/clean/runner-protocol.mjs';

const WINDOW_MS = 60_000;
const NONCE = /^[A-Za-z0-9_-]{16,160}$/;

export class BridgeProtocol {
  constructor({ stateRoot, clock = () => new Date() } = {}) {
    if (!stateRoot) throw new TypeError('bridge_state_root_required');
    this.root = path.resolve(String(stateRoot)); this.clock = clock;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.protector = new DpapiProtector({ root: this.root });
    this.identity = this.loadIdentity(); this.pending = new Map();
    this.nonces = this.loadNonces();
    this.jobs = new Map();
  }

  publicIdentity() { return { schema_version: 'aiws.windows-bridge.identity.v1', identity_public_key: this.identity.identity.publicKey, transport_public_key: this.identity.transport.publicKey, capabilities: { conpty: process.platform === 'win32', dpapi: this.protector.available, git_bundle: true, runner_jobs: true } }; }

  beginPairing(input = {}) {
    const clientIdentity = normalizePublicKey(input.identity_public_key, 'ed25519');
    const clientTransport = normalizePublicKey(input.transport_public_key, 'x25519');
    const id = randomBytes(16).toString('hex'); const confirmationCode = String(Number.parseInt(randomBytes(4).toString('hex'), 16) % 1_000_000).padStart(6, '0');
    const transcript = { schema_version: 'aiws.bridge.pairing.v1', pairing_id: id, bridge_identity_public_key: this.identity.identity.publicKey, bridge_transport_public_key: this.identity.transport.publicKey, client_identity_public_key: clientIdentity, client_transport_public_key: clientTransport, created_at: this.now() };
    const transcriptSha256 = hash(canonical(transcript)); const confirmationCodeSha256 = hash(`${confirmationCode}:${transcriptSha256}`);
    const identityPrivate = this.protector.unprotect(this.identity.identity.privateRef).toString('utf8');
    const bridgeSignature = sign(null, Buffer.from(transcriptSha256, 'hex'), createPrivateKey(identityPrivate)).toString('base64url');
    this.pending.set(id, { transcript, transcriptSha256, confirmationCode, confirmationCodeSha256, expiresAt: Date.now() + WINDOW_MS });
    return { pairing_id: id, transcript, transcript_sha256: transcriptSha256, bridge_signature: bridgeSignature, confirmation_code: confirmationCode, confirmation_code_sha256: confirmationCodeSha256, expires_at: new Date(Date.now() + WINDOW_MS).toISOString() };
  }

  confirmPairing(input = {}) {
    const pending = this.pending.get(String(input.pairing_id || '')); if (!pending || Date.now() > pending.expiresAt) throw protocolError('pairing_expired', 409);
    if (!safeEqual(String(input.confirmation_code || ''), pending.confirmationCode)) throw protocolError('confirmation_mismatch', 403);
    let clientSignature; try { clientSignature = Buffer.from(String(input.client_signature || ''), 'base64url'); } catch { throw protocolError('client_signature_invalid', 403); }
    if (!verify(null, Buffer.from(pending.transcriptSha256, 'hex'), createPublicKey(pending.transcript.client_identity_public_key), clientSignature)) throw protocolError('client_signature_invalid', 403);
    const privateKey = this.protector.unprotect(this.identity.transport.privateRef).toString('utf8');
    const shared = diffieHellman({ privateKey: createPrivateKey(privateKey), publicKey: createPublicKey(pending.transcript.client_transport_public_key) });
    const secret = Buffer.from(hkdfSync('sha256', shared, Buffer.from(pending.transcriptSha256, 'hex'), Buffer.from('aiws-windows-bridge-pairing-v1'), 32));
    const secretRef = `pair-${pending.transcript.pairing_id}`; this.protector.protect(secretRef, secret);
    const encrypted = seal(secret, Buffer.from(pending.transcriptSha256, 'hex'), Buffer.from(canonical({ paired: true, transcript_sha256: pending.transcriptSha256 })));
    this.pending.delete(String(input.pairing_id));
    return { status: 'paired', shared_secret_ref: secretRef, paired_transcript_sha256: pending.transcriptSha256, encrypted_secret: encrypted, identity_public_key: this.identity.identity.publicKey, transport_public_key: this.identity.transport.publicKey };
  }

  authenticate(headers = {}, body = {}) {
    const secretRef = String(headers['x-aiws-secret-ref'] || ''); const timestamp = String(headers['x-aiws-timestamp'] || ''); const nonce = String(headers['x-aiws-nonce'] || ''); const signature = String(headers['x-aiws-signature'] || '');
    if (!NONCE.test(nonce) || !/^\d{13}$/.test(timestamp)) throw protocolError('bridge_auth_invalid', 401);
    if (Math.abs(Date.now() - Number(timestamp)) > WINDOW_MS) throw protocolError('bridge_timestamp_invalid', 401);
    if (this.nonces.has(nonce)) throw protocolError('bridge_nonce_replay', 409);
    const bodyHash = hash(canonical(body)); const signed = `${timestamp}\n${nonce}\n${bodyHash}`; const secret = this.protector.unprotect(secretRef); const expected = createHmac('sha256', secret).update(signed).digest('hex');
    if (!safeEqual(signature, expected)) throw protocolError('bridge_signature_invalid', 401);
    this.nonces.set(nonce, Number(timestamp)); this.persistNonces(); return { secretRef, nonce, bodyHash };
  }

  verifyBundle(input = {}) {
    const file = path.resolve(String(input.bundle_path || '')); if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw protocolError('bundle_missing', 404);
    const size = fs.statSync(file).size; if (size > Number(input.max_bytes || 1024 * 1024 * 1024)) throw protocolError('bundle_too_large', 422);
    const digest = hash(fs.readFileSync(file)); if (input.bundle_sha256 && digest !== String(input.bundle_sha256).toLowerCase()) throw protocolError('bundle_hash_mismatch', 422);
    const verify = spawnSync('git', ['bundle', 'verify', file], { encoding: 'utf8', windowsHide: true }); if (verify.status !== 0) throw protocolError('bundle_verify_failed', 422, { output: bounded(`${verify.stdout || ''}${verify.stderr || ''}`) });
    const heads = spawnSync('git', ['bundle', 'list-heads', file], { encoding: 'utf8', windowsHide: true }); if (heads.status !== 0) throw protocolError('bundle_heads_failed', 422);
    const rows = String(heads.stdout || '').trim().split(/\r?\n/).filter(Boolean).map((line) => { const [sha, ref] = line.trim().split(/\s+/, 2); return { sha, ref }; });
    if (input.repository_ref && !rows.some((row) => row.ref === input.repository_ref)) throw protocolError('bundle_ref_mismatch', 422);
    if (input.head_sha && !rows.some((row) => row.sha === input.head_sha)) throw protocolError('bundle_head_mismatch', 422);
    return { verified: true, bundle_sha256: digest, byte_length: size, heads: rows };
  }

  submitJob(input = {}) {
    const spec = validateRunnerJobSpec(input.spec);
    const servicePublicKey = normalizePublicKey(input.service_public_key, 'ed25519'); const json = canonical(spec); const signature = Buffer.from(String(input.signature || ''), 'base64url');
    if (!verify(null, Buffer.from(json), createPublicKey(servicePublicKey), signature)) throw protocolError('runner_signature_invalid', 403);
    const specHash = hash(json); const prior = [...this.jobs.values()].find((item) => item.spec.job_spec_id === spec.job_spec_id);
    if (prior) { if (prior.spec_hash !== specHash) throw protocolError('runner_job_conflict', 409); return { job_id: prior.job_id, status: prior.status }; }
    const jobId = `bridge_job_${randomBytes(16).toString('hex')}`; const job = { job_id: jobId, status: 'queued', spec: JSON.parse(json), spec_hash: specHash, created_at: this.now(), child: null, receipt: null, signature: null };
    this.jobs.set(jobId, job); queueMicrotask(() => this.executeJob(job).catch(() => undefined)); return { job_id: jobId, status: 'queued' };
  }

  jobStatus(jobId) { const job = this.jobs.get(String(jobId)); if (!job) return { job_id: String(jobId), status: 'unknown' }; return { job_id: job.job_id, status: job.status, ...(job.receipt ? { receipt: job.receipt, signature: job.signature, signer_public_key: this.identity.identity.publicKey } : {}) }; }

  cancelJob(jobId) { const job = this.jobs.get(String(jobId)); if (!job) return { job_id: String(jobId), status: 'unknown' }; if (!['succeeded', 'failed', 'cancelled', 'expired'].includes(job.status)) { job.status = 'cancelled'; terminate(job.child); this.finishJob(job, 'cancelled', null, Buffer.alloc(0), Buffer.alloc(0), 'cancelled'); } return this.jobStatus(job.job_id); }

  async executeJob(job) {
    if (job.status === 'cancelled') return; job.status = 'running'; job.started_at = this.now(); const home = path.join(this.root, 'jobs', job.job_id, 'codex-home'); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      const child = spawn(process.execPath, ['-e', "process.stdout.write('bridge runner completed\\n')"], { env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }); job.child = child; const stdout = []; const stderr = []; child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk))); child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk))); const deadline = Math.max(1, Date.parse(job.spec.deadline_at) - Date.now()); const timer = setTimeout(() => { job.timed_out = true; terminate(child); }, deadline); timer.unref?.(); const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve({ code })); }); clearTimeout(timer); const streams = boundedStreams(stdout, stderr); const status = job.status === 'cancelled' ? 'cancelled' : job.timed_out ? 'expired' : result.code === 0 ? 'succeeded' : 'failed'; this.finishJob(job, status, result.code, streams.stdout, streams.stderr, status === 'expired' ? 'runner_deadline_exceeded' : status === 'failed' ? 'runner_failed' : status === 'cancelled' ? 'cancelled' : '');
    } catch (error) { this.finishJob(job, job.status === 'cancelled' ? 'cancelled' : 'failed', 1, Buffer.alloc(0), Buffer.alloc(0), String(error?.code || 'runner_spawn_failed')); }
    finally { job.child = null; fs.rmSync(path.join(this.root, 'jobs', job.job_id), { recursive: true, force: true }); }
  }

  finishJob(job, status, exitCode, stdout, stderr, errorCode) {
    if (job.receipt && ['succeeded', 'failed', 'cancelled', 'expired'].includes(job.status)) return job;
    const finished = this.now(); const outputs = Array.isArray(job.spec.output_paths) ? job.spec.output_paths : []; const receipt = validateRunnerReceipt({ schema_version: 'runner.receipt.v2', receipt_id: `bridge_receipt_${randomBytes(16).toString('hex')}`, job_spec_id: job.spec.job_spec_id, job_spec_hash: job.spec_hash, runner_profile_ref: job.spec.runner_profile_ref, runner_job_ref: job.job_id, status, exit_code: exitCode, stdout_sha256: stdout.length ? hash(stdout) : '', stderr_sha256: stderr.length ? hash(stderr) : '', output_sha256: outputs.length ? hash(canonical(outputs)) : '', stdout_bytes: stdout.length, stderr_bytes: stderr.length, output_bytes: 0, output_paths: outputs, error_code: errorCode, started_at: job.started_at || job.created_at, finished_at: finished }, { expectedJobSpecId: job.spec.job_spec_id, expectedJobSpecHash: job.spec_hash }); const privateKey = this.protector.unprotect(this.identity.identity.privateRef).toString('utf8'); job.receipt = receipt; job.signature = sign(null, Buffer.from(canonical(receipt)), createPrivateKey(privateKey)).toString('base64url'); job.status = status; job.finished_at = finished; return job;
  }

  revoke(secretRef) { this.protector.remove(String(secretRef || '')); return { revoked: true }; }
  rotate(secretRef) { const ref = String(secretRef || ''); const current = this.protector.unprotect(ref); const salt = randomBytes(32); const secret = createHmac('sha256', current).update(Buffer.from('aiws-bridge-rotate-v1')).update(salt).digest(); this.protector.protect(ref, secret); return { rotated: true, rotation_salt: salt.toString('base64url'), rotation_proof: createHmac('sha256', secret).update('rotated').digest('hex') }; }
  now() { const value = this.clock(); return typeof value === 'string' ? value : new Date(value).toISOString(); }

  loadIdentity() {
    const metaFile = path.join(this.root, 'identity.json');
    if (fs.existsSync(metaFile)) { const value = JSON.parse(fs.readFileSync(metaFile, 'utf8')); this.protector.unprotect(value.identity.privateRef); this.protector.unprotect(value.transport.privateRef); return value; }
    const identity = generateKeyPairSync('ed25519'); const transport = generateKeyPairSync('x25519');
    const value = { identity: { publicKey: identity.publicKey.export({ type: 'spki', format: 'pem' }), privateRef: 'identity-ed25519' }, transport: { publicKey: transport.publicKey.export({ type: 'spki', format: 'pem' }), privateRef: 'transport-x25519' } };
    this.protector.protect(value.identity.privateRef, identity.privateKey.export({ type: 'pkcs8', format: 'pem' })); this.protector.protect(value.transport.privateRef, transport.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(metaFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); return value;
  }
  loadNonces() { try { const value = JSON.parse(this.protector.unprotect('nonce-journal').toString('utf8')); const floor = Date.now() - WINDOW_MS; return new Map(Object.entries(value).filter(([, timestamp]) => Number(timestamp) >= floor)); } catch { return new Map(); } }
  persistNonces() { const floor = Date.now() - WINDOW_MS; for (const [nonce, timestamp] of this.nonces) if (timestamp < floor) this.nonces.delete(nonce); this.protector.protect('nonce-journal', Buffer.from(canonical(Object.fromEntries(this.nonces)))); }
}

export class DpapiProtector {
  constructor({ root }) { this.root = path.resolve(root); this.available = process.platform === 'win32'; this.fallbackKey = createHash('sha256').update(`${process.env.USERNAME || 'local'}:${this.root}`).digest(); }
  protect(ref, bytes) { validateRef(ref); const file = this.file(ref); const input = Buffer.from(bytes); let payload; if (this.available) { const script = 'Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String($env:AIWS_DPAPI_INPUT);$o=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($o)'; const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AIWS_DPAPI_INPUT: input.toString('base64') } }); if (result.status !== 0) throw protocolError('dpapi_protect_failed', 503, { reason: String(result.stderr || '').slice(0, 200) }); payload = Buffer.from(String(result.stdout).trim(), 'base64'); } else payload = Buffer.concat([Buffer.from('AIWSFIX1'), Buffer.from(JSON.stringify(seal(this.fallbackKey, Buffer.from(ref), input)), 'utf8')]); const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, payload, { mode: 0o600 }); fs.renameSync(temp, file); return ref; }
  unprotect(ref) { validateRef(ref); const payload = fs.readFileSync(this.file(ref)); if (this.available) { const script = 'Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String($env:AIWS_DPAPI_INPUT);$o=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($o)'; const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AIWS_DPAPI_INPUT: payload.toString('base64') } }); if (result.status !== 0) throw protocolError('dpapi_unprotect_failed', 503, { reason: String(result.stderr || '').slice(0, 200) }); return Buffer.from(String(result.stdout).trim(), 'base64'); } if (payload.subarray(0, 8).toString() !== 'AIWSFIX1') throw protocolError('protected_state_invalid', 503); return open(this.fallbackKey, Buffer.from(ref), JSON.parse(payload.subarray(8).toString('utf8'))); }
  remove(ref) { validateRef(ref); fs.rmSync(this.file(ref), { force: true }); }
  file(ref) { return path.join(this.root, `${ref}.protected`); }
}

function seal(key, aad, plain) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key).subarray(0, 32), iv); cipher.setAAD(aad); const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]); return { algorithm: 'AES-256-GCM', iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }; }
function open(key, aad, value) { const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key).subarray(0, 32), Buffer.from(value.iv, 'base64url')); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(value.tag, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]); }
function normalizePublicKey(value, type) { const text = String(value || ''); if (!text.includes('PUBLIC KEY')) throw protocolError('public_key_invalid', 422); try { const key = createPublicKey(text); if (key.asymmetricKeyType !== type) throw new Error('type'); return text; } catch { throw protocolError('public_key_invalid', 422); } }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function validateRef(value) { if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,160}$/.test(String(value || ''))) throw protocolError('protected_ref_invalid', 400); }
function bounded(value) { return String(value || '').replace(/(?:[A-Za-z]:\\|\/(?:home|Users|root)\/)[^\s]+/g, '[path]').slice(0, 1000); }
function boundedStreams(output, errors) { const stdout = Buffer.concat(output).subarray(0, 2 * 1024 * 1024); const remaining = Math.max(0, 2 * 1024 * 1024 - stdout.length); return { stdout, stderr: Buffer.concat(errors).subarray(0, remaining) }; }
function terminate(child) { if (!child || child.exitCode != null) return; try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } } }
function protocolError(code, status = 400, details = {}) { const error = new Error(code); error.code = code; error.status = status; error.details = details; return error; }
