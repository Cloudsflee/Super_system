import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signedHeaders } from '../../apps/api/src/broker-client.mjs';
import { start as startBroker } from '../../apps/runner-broker/server.mjs';

const digest = `sha256:${'f'.repeat(64)}`;

function validSpec() {
  return {
    task_id: 'security-task',
    execution_id: 'exe_security1234',
    project_id: 'prj_security1234',
    workspace_subpath: 'projects/prj_security1234',
    image_digest: digest,
    execution_mode: 'read',
    resource_profile: 'standard',
    network_profile: 'none',
    input_paths: [],
    output_paths: [],
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    credential_ref: 'cred_ephemeral1'
  };
}

async function call(base, secret, method, requestPath, body, headers = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const response = await fetch(`${base}${requestPath}`, {
    method,
    headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...signedHeaders(secret, method, requestPath, raw), ...headers },
    body: raw || undefined
  });
  return { response, json: await response.json().catch(() => ({})) };
}

test('broker HTTP boundary verifies signatures, rejects unsafe specs, and redacts credentials', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-broker-security-'));
  const secret = 'security-secret-for-http-boundary';
  const broker = await startBroker({ config: { host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, executor: 'mock', runnerImage: `runner@${digest}` } });
  const base = `http://127.0.0.1:${broker.server.address().port}`;
  try {
    const body = validSpec();
    const validHeaders = signedHeaders(secret, 'POST', '/internal/v1/jobs', JSON.stringify(body));
    const created = await call(base, secret, 'POST', '/internal/v1/jobs', body, validHeaders);
    assert.equal(created.response.status, 201);
    assert.match(created.json.job_id, /^job_/);

    const replay = await fetch(`${base}/internal/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...validHeaders },
      body: JSON.stringify(body)
    });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, 'replay_detected');

    const tamperHeaders = signedHeaders(secret, 'POST', '/internal/v1/jobs', JSON.stringify(body));
    const tampered = await call(base, secret, 'POST', '/internal/v1/jobs', { ...body, task_id: 'tampered' }, tamperHeaders);
    assert.equal(tampered.response.status, 401);
    assert.equal(tampered.json.error.code, 'invalid_signature');

    for (const field of ['command', 'host_path', 'volumes', 'environment', 'privileged', 'cap_add']) {
      const rejected = await call(base, secret, 'POST', '/internal/v1/jobs', { ...body, [field]: 'unsafe' });
      assert.equal(rejected.response.status, 400, field);
      assert.equal(rejected.json.error.code, 'invalid_job_spec', field);
    }

    const cancelledCreate = await call(base, secret, 'POST', '/internal/v1/jobs', { ...body, task_id: 'cancel-me' });
    const cancelled = await call(base, secret, 'POST', `/internal/v1/jobs/${cancelledCreate.json.job_id}/cancel`, {});
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.json.status, 'cancelled');
    const status = await call(base, secret, 'GET', `/internal/v1/jobs/${created.json.job_id}`);
    assert.equal(status.response.status, 200);
    assert.equal(status.json.spec.credential_ref, '[ephemeral]');
    const missing = await call(base, secret, 'GET', '/internal/v1/jobs/job_missing');
    assert.equal(missing.response.status, 404);
    assert.equal(missing.json.error.code, 'not_found');
  } finally {
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
