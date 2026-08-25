import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  EVIDENCE_ASSET_VERSION,
  PARSER_RECEIPT_VERSION,
  signParserReceipt,
  verifyParserJob
} from './parser-protocol.mjs';
import { buildDockerParserArgs } from './parser-docker.mjs';

export { buildDockerParserArgs } from './parser-docker.mjs';

const TERMINAL = new Set(['parsed', 'unsupported', 'invalid', 'resource_exceeded', 'failed', 'cancelled', 'external_result_unknown']);

export class DeterministicParserAdapter {
  constructor({ clock = () => new Date(), execute = null, identity = null, imageDigest = null } = {}) {
    this.clock = clock;
    this.execute = execute;
    this.identity = identity || generateKeyPairSync('ed25519');
    this.imageDigest = imageDigest;
    this.jobs = new Map();
  }

  publicIdentity() {
    return this.identity.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  async probe() {
    return {
      schema_version: 'aiws.parser-adapter.probe.v1',
      status: 'ready',
      worker_image_digest: this.imageDigest,
      identity_public_key: this.publicIdentity(),
      capabilities: ['signed-job', 'signed-receipt', 'bounded-output', 'cancel', 'restart-status']
    };
  }

  async submit(jobValue, context = {}) {
    const verified = verifyParserJob(jobValue, context.jobSignature, context.servicePublicKey, {
      expectedImageDigest: this.imageDigest || jobValue.worker_image_digest,
      now: () => Date.now()
    });
    const input = Buffer.from(context.input || []);
    if (sha256Hex(input) !== verified.job.input_sha256 || input.byteLength !== verified.job.input_bytes) {
      throw new PlatformError('parser_input_mismatch', 'parser input changed before execution', {}, 409);
    }
    const id = opaqueId('parser_job');
    const job = { job_id: id, status: 'queued', job: verified.job, jobHash: verified.job_sha256, input, context, created_at: iso(this.clock), controller: new AbortController() };
    this.jobs.set(id, job);
    queueMicrotask(() => this.runJob(job).catch(() => undefined));
    return { job_id: id, status: 'queued' };
  }

  async runJob(job) {
    if (job.status === 'cancelled') return;
    job.status = 'running';
    job.started_at = iso(this.clock);
    let result;
    try {
      result = this.execute
        ? await this.execute(job.job, { input: job.input, signal: job.controller.signal, fixture: job.context.fixture || {} })
        : await parseDeterministicFixture(job.input, job.job.format_key, job.job.limits, job.controller.signal);
    } catch (error) {
      result = { status: 'failed', error_code: String(error?.code || 'parser_failed'), outputs: [] };
    }
    if (job.status === 'cancelled') result = { status: 'cancelled', error_code: 'parser_cancelled', outputs: [] };
    const outputs = normalizeAdapterOutputs(result.outputs || []);
    const manifest = outputManifest(outputs);
    const receiptValue = {
      schema_version: PARSER_RECEIPT_VERSION,
      receipt_id: opaqueId('parser_receipt'),
      parser_job_id: job.job.parser_job_id,
      parser_run_ref: job.job.parser_run_ref,
      job_sha256: job.jobHash,
      status: String(result.status || 'failed'),
      input_sha256: job.job.input_sha256,
      format_sha256: job.job.format_sha256,
      limits_sha256: job.job.limits_sha256,
      checkpoint_token_hash: job.job.checkpoint_token_hash,
      output_manifest: manifest,
      output_manifest_sha256: sha256Hex(canonicalJson(manifest)),
      error_code: String(result.error_code || ''),
      started_at: job.started_at,
      finished_at: iso(this.clock)
    };
    const signed = signParserReceipt(receiptValue, this.identity.privateKey, expectedReceipt(job));
    job.status = signed.receipt.status;
    job.receipt = signed.receipt;
    job.signature = signed.signature;
    job.outputs = outputs;
    job.finished_at = signed.receipt.finished_at;
    job.input.fill(0);
  }

  async status(jobId) {
    const job = this.jobs.get(String(jobId));
    if (!job) return { job_id: String(jobId), status: 'unknown' };
    return {
      job_id: job.job_id,
      status: job.status,
      ...(job.receipt ? { receipt: job.receipt, signature: job.signature, signer_public_key: this.publicIdentity(), outputs: publicOutputs(job.outputs) } : {})
    };
  }

  async cancel(jobId) {
    const job = this.jobs.get(String(jobId));
    if (!job) return { job_id: String(jobId), status: 'unknown' };
    if (!TERMINAL.has(job.status)) {
      job.status = 'cancelled';
      job.controller.abort();
    }
    return { job_id: job.job_id, status: job.status };
  }
}

export class BrokerParserAdapter {
  constructor({ baseUrl = null, secret = '', fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/$/, '') : null;
    this.secret = String(secret || '');
    this.fetch = fetchImpl;
    this.clock = clock;
  }

  async probe() { return this.request('GET', '/internal/v2/parser-jobs/probe', {}); }
  async submit(job, context = {}) {
    return this.request('POST', '/internal/v2/parser-jobs', {
      job,
      signature: context.jobSignature,
      service_public_key: context.servicePublicKey,
      input_base64: Buffer.from(context.input || []).toString('base64')
    });
  }
  async status(jobId) { return this.request('GET', `/internal/v2/parser-jobs/${encodeURIComponent(jobId)}`, {}); }
  async cancel(jobId) { return this.request('POST', `/internal/v2/parser-jobs/${encodeURIComponent(jobId)}/cancel`, {}); }

  async request(method, route, body) {
    if (!this.baseUrl || !this.fetch || this.secret.length < 16) throw new PlatformError('parser_unavailable', 'Clean Broker parser transport is unavailable', {}, 503);
    const raw = canonicalJson(body || {});
    const timestamp = String(Number(this.clock()));
    const nonce = randomBytes(18).toString('base64url');
    const bodyHash = sha256Hex(raw);
    const signature = createHmac('sha256', this.secret).update(`${method}\n${route}\n${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${route}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-aiws-timestamp': timestamp, 'x-aiws-nonce': nonce, 'x-aiws-body-sha256': bodyHash, 'x-aiws-signature': signature },
        ...(method === 'GET' ? {} : { body: raw })
      });
    } catch (error) {
      throw new PlatformError('parser_unavailable', 'Clean Broker parser request failed', { reason: String(error?.code || 'transport') }, 503);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new PlatformError(String(payload?.error?.code || 'parser_failed'), 'Clean Broker parser request failed', payload?.error?.details || {}, response.status);
    return payload;
  }
}

function normalizeAdapterOutputs(values) {
  return values.map((value, index) => {
    const bytes = Buffer.from(value.bytes || []);
    const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
    return {
      kind: String(value.kind || `output_${index + 1}`),
      bytes,
      content_sha256: sha256Hex(bytes),
      byte_length: bytes.byteLength,
      media_type: String(value.media_type || 'application/octet-stream'),
      metadata,
      metadata_sha256: sha256Hex(canonicalJson(metadata))
    };
  });
}

function outputManifest(outputs) {
  return {
    schema_version: EVIDENCE_ASSET_VERSION,
    outputs: outputs.map(({ kind, content_sha256, byte_length, media_type, metadata_sha256 }) => ({ kind, content_sha256, byte_length, media_type, metadata_sha256 }))
  };
}

function publicOutputs(outputs = []) {
  return outputs.map(({ bytes, metadata, metadata_sha256: _metadataHash, ...value }) => ({ ...value, metadata, content_base64: bytes.toString('base64') }));
}

function expectedReceipt(job) {
  return {
    expectedJobId: job.job.parser_job_id,
    expectedJobHash: job.jobHash,
    expectedInputHash: job.job.input_sha256,
    expectedFormatHash: job.job.format_sha256,
    expectedLimitsHash: job.job.limits_sha256,
    expectedCheckpointHash: job.job.checkpoint_token_hash
  };
}

function iso(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  return typeof value === 'string' ? value : new Date(value).toISOString();
}

async function parseDeterministicFixture(bytesValue, formatValue, limits = {}, signal) {
  if (signal?.aborted) return { status: 'cancelled', error_code: 'parser_cancelled', outputs: [] };
  const bytes = Buffer.from(bytesValue || []);
  if (bytes.byteLength > Number(limits.max_input_bytes || 25 * 1024 * 1024)) return { status: 'resource_exceeded', error_code: 'parser_input_too_large', outputs: [] };
  const format = String(formatValue || '').toLowerCase();
  let output;
  let mediaType;
  let metadata;
  try {
    if (format === 'json') {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      output = Buffer.from(canonicalJson(value));
      mediaType = 'application/json';
      metadata = { root_type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value };
    } else if (format === 'text' || format === 'markdown') {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      output = Buffer.from(value);
      mediaType = format === 'markdown' ? 'text/markdown' : 'text/plain';
      metadata = { characters: value.length, lines: value ? value.split(/\r?\n/).length : 0 };
    } else {
      return { status: 'unsupported', error_code: 'parser_format_unsupported', outputs: [] };
    }
  } catch {
    return { status: 'invalid', error_code: format === 'json' ? 'parser_invalid_json' : 'parser_invalid_utf8', outputs: [] };
  }
  if (output.byteLength > Number(limits.max_expanded_bytes || 100 * 1024 * 1024)) return { status: 'resource_exceeded', error_code: 'parser_quota_expanded_bytes', outputs: [] };
  return { status: 'parsed', error_code: '', outputs: [{ kind: 'parsed', bytes: output, media_type: mediaType, metadata }] };
}
