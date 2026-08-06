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
      current.result = {
        outcome: 'completed', summary: 'deterministic runner completed', changed_files: [],
        checks: [{ id: 'node_test', passed: true, exit_code: 0, stdout_sha256: null }, { id: 'git_diff_check', passed: true, exit_code: 0, stdout_sha256: null }],
        output_paths: spec.output_paths ?? [], usage: {}
      };
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

  async request(method, requestPath, payload = undefined, timeoutMs = 3000) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const response = await fetch(`${this.config.brokerUrl}${requestPath}`, {
      method,
      headers: signedHeaders(this.config.brokerSecret, method, requestPath, body),
      body: body || undefined,
      signal: AbortSignal.timeout(timeoutMs)
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
    return this.mock ? this.mock.probe() : this.request('GET', '/internal/v1/probe', undefined, 15_000);
  }

  codexProbe() {
    if (this.mock) return Promise.resolve({ provider: 'codex', status: 'unavailable', error_code: 'deterministic_adapter' });
    const credential = this.config.codexCredential
      ? { ref: this.config.codexCredential.ref, profile: this.config.codexCredential.profile, auth: this.config.codexCredential.auth }
      : null;
    return this.request('POST', '/internal/v1/integrations/codex/probe', { model: this.config.codexModel, credential }, 120_000);
  }

  submit(spec) {
    if (this.mock) return this.mock.submit(spec);
    const credential = this.config.codexCredential
      ? { ref: this.config.codexCredential.ref, profile: this.config.codexCredential.profile, auth: this.config.codexCredential.auth }
      : null;
    return this.request('POST', '/internal/v1/jobs', { spec, credential });
  }

  status(jobId) {
    return this.mock ? this.mock.status(jobId) : this.request('GET', `/internal/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  cancel(jobId) {
    return this.mock ? this.mock.cancel(jobId) : this.request('POST', `/internal/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }
}
