import { createHmac, randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { sha256 } from './crypto.mjs';

function signature(secret, method, requestPath, body, timestamp, nonce) {
  const payload = [method.toUpperCase(), requestPath, timestamp, nonce, sha256(body)].join('\n');
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function signedHeaders(secret, method, requestPath, body, clock = Date.now()) {
  const timestamp = String(clock);
  const nonce = randomUUID();
  return {
    'content-type': 'application/json',
    'x-aiws-timestamp': timestamp,
    'x-aiws-nonce': nonce,
    'x-aiws-signature': signature(secret, method, requestPath, body, timestamp, nonce)
  };
}

class MockBroker {
  constructor(digest) {
    this.digest = digest;
    this.jobs = new Map();
  }

  async probe() {
    return { ready: true, executor: 'mock', runner_digest: this.digest };
  }

  async submit(spec) {
    const jobId = `job_${randomUUID().replaceAll('-', '')}`;
    const job = { job_id: jobId, status: 'queued', spec: { ...spec, credential_ref: undefined }, created_at: new Date().toISOString() };
    this.jobs.set(jobId, job);
    setTimeout(() => {
      const current = this.jobs.get(jobId);
      if (!current || current.status === 'cancelled') return;
      current.status = 'completed';
      current.finished_at = new Date().toISOString();
      current.result = { exit_code: 0, output_paths: spec.output_paths ?? [] };
    }, 35);
    return { job_id: jobId, status: job.status };
  }

  async status(jobId) {
    return this.jobs.get(jobId) || { job_id: jobId, status: 'unknown' };
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (job && !['completed', 'failed', 'cancelled'].includes(job.status)) job.status = 'cancelled';
    return job || { job_id: jobId, status: 'unknown' };
  }
}

export class BrokerClient {
  constructor(config) {
    this.config = config;
    this.mock = config.brokerMode === 'mock' ? new MockBroker(config.runnerDigest) : null;
  }

  async request(method, requestPath, payload = undefined) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const response = await fetch(`${this.config.brokerUrl}${requestPath}`, {
      method,
      headers: signedHeaders(this.config.brokerSecret, method, requestPath, body),
      body: body || undefined,
      signal: AbortSignal.timeout(3000)
    }).catch((error) => {
      throw new AppError('broker_unavailable', 'runner broker is unavailable', { retryable: true, details: { cause: error.message } });
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new AppError(data.error?.code || 'broker_unavailable', data.error?.message || 'runner broker rejected request', {
        status: response.status,
        retryable: response.status >= 500,
        details: data.error?.details || {}
      });
    }
    return data;
  }

  probe() {
    return this.mock ? this.mock.probe() : this.request('GET', '/internal/v1/probe');
  }

  submit(spec) {
    return this.mock ? this.mock.submit(spec) : this.request('POST', '/internal/v1/jobs', spec);
  }

  status(jobId) {
    return this.mock ? this.mock.status(jobId) : this.request('GET', `/internal/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  cancel(jobId) {
    return this.mock ? this.mock.cancel(jobId) : this.request('POST', `/internal/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }
}
