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
    this.deviceAuth = new Map();
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

  async startCodexDeviceAuth() {
    const operationId = `da_${randomUUID().replaceAll('-', '')}`;
    const timestamp = new Date().toISOString();
    const operation = {
      operation_id: operationId,
      status: 'waiting_for_user',
      cursor: 1,
      created_at: timestamp,
      updated_at: timestamp,
      events: [{ cursor: 1, type: 'codex.device_auth.verification', data: { verification_url: 'https://auth.example.test/device', user_code: 'ABCD-EFGH', status: 'waiting_for_user' }, created_at: timestamp }],
      bundle: JSON.stringify({ tokens: { access_token: 'fixture-device-access-token', refresh_token: 'fixture-device-refresh-token' } })
    };
    this.deviceAuth.set(operationId, operation);
    setTimeout(() => {
      if (operation.status === 'cancelled') return;
      operation.status = 'completed';
      operation.cursor += 1;
      operation.updated_at = new Date().toISOString();
      operation.events.push({ cursor: operation.cursor, type: 'codex.device_auth.status', data: { status: 'completed' }, created_at: operation.updated_at });
    }, 25).unref?.();
    return publicMockDevice(operation);
  }

  async codexDeviceAuthStatus(operationId) {
    const operation = this.deviceAuth.get(operationId);
    if (!operation) throw new AppError('not_found', 'device auth operation not found', { status: 404 });
    return publicMockDevice(operation);
  }

  async codexDeviceAuthEvents(operationId, after = 0) {
    const operation = this.deviceAuth.get(operationId);
    if (!operation) throw new AppError('not_found', 'device auth operation not found', { status: 404 });
    return { events: operation.events.filter((event) => event.cursor > Number(after || 0)) };
  }

  async cancelCodexDeviceAuth(operationId) {
    const operation = this.deviceAuth.get(operationId);
    if (!operation) throw new AppError('not_found', 'device auth operation not found', { status: 404 });
    operation.status = 'cancelled';
    operation.bundle = null;
    return publicMockDevice(operation);
  }

  async claimCodexDeviceAuth(operationId) {
    const operation = this.deviceAuth.get(operationId);
    if (!operation || operation.status !== 'completed' || !operation.bundle) throw new AppError('device_auth_not_claimable', 'device auth is not complete', { status: 409 });
    const authBundle = operation.bundle;
    operation.bundle = null;
    operation.status = 'claimed';
    return { operation_id: operationId, status: 'claimed', auth_bundle: authBundle };
  }
}

function publicMockDevice(operation) {
  return {
    operation_id: operation.operation_id,
    status: operation.status,
    cursor: operation.cursor,
    created_at: operation.created_at,
    updated_at: operation.updated_at,
    error_code: null
  };
}

export class BrokerClient {
  constructor(config) {
    this.config = config;
    this.mock = config.brokerMode === 'mock' ? new MockBroker(config.runnerDigest) : null;
  }

  async request(method, requestPath, payload = undefined, timeoutMs = 3000) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const signaturePath = new URL(requestPath, 'http://broker.invalid').pathname;
    const response = await fetch(`${this.config.brokerUrl}${requestPath}`, {
      method,
      headers: signedHeaders(this.config.brokerSecret, method, signaturePath, body),
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

  codexProfileProbe(profile, secret) {
    const credential = {
      ref: profile.credential_ref,
      kind: profile.auth_kind === 'oauth_bundle' ? 'codex_oauth_bundle' : 'codex_api_key',
      revision: profile.credential_revision,
      auth: String(secret || '')
    };
    if (this.mock) return Promise.resolve({
      provider: 'codex', model: profile.model, status: 'unavailable', error_code: 'deterministic_adapter',
      checks: [{ phase: 'transport', status: 'failed', error_code: 'codex_transport_unavailable' }]
    });
    return this.request('POST', '/internal/v1/integrations/codex/profile-probe', { profile, credential }, Math.min(15 * 60 * 1000, Math.max(15_000, Number(profile.timeout_ms || 120000) + 15_000)));
  }

  submit(spec, options = {}) {
    if (this.mock) return this.mock.submit(spec);
    const profile = options.profile || null;
    const credential = options.credential || (this.config.codexCredential
      ? { ref: this.config.codexCredential.ref, kind: 'codex_api_key', auth: this.config.codexCredential.auth }
      : null);
    return this.request('POST', '/internal/v1/jobs', { spec, profile, credential });
  }

  status(jobId) {
    return this.mock ? this.mock.status(jobId) : this.request('GET', `/internal/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  cancel(jobId) {
    return this.mock ? this.mock.cancel(jobId) : this.request('POST', `/internal/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }

  startCodexDeviceAuth() {
    return this.mock ? this.mock.startCodexDeviceAuth() : this.request('POST', '/internal/v1/integrations/codex/device-auth', {}, 15_000);
  }

  codexDeviceAuthStatus(operationId) {
    return this.mock ? this.mock.codexDeviceAuthStatus(operationId) : this.request('GET', `/internal/v1/integrations/codex/device-auth/${encodeURIComponent(operationId)}`);
  }

  codexDeviceAuthEvents(operationId, after = 0) {
    return this.mock
      ? this.mock.codexDeviceAuthEvents(operationId, after)
      : this.request('GET', `/internal/v1/integrations/codex/device-auth/${encodeURIComponent(operationId)}/events?after=${Number(after) || 0}`);
  }

  cancelCodexDeviceAuth(operationId) {
    return this.mock ? this.mock.cancelCodexDeviceAuth(operationId) : this.request('POST', `/internal/v1/integrations/codex/device-auth/${encodeURIComponent(operationId)}/cancel`, {});
  }

  claimCodexDeviceAuth(operationId) {
    return this.mock ? this.mock.claimCodexDeviceAuth(operationId) : this.request('POST', `/internal/v1/integrations/codex/device-auth/${encodeURIComponent(operationId)}/claim`, {}, 15_000);
  }
}
