import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { signedHeaders } from '../../apps/api/src/broker-client.mjs';
import { hashJson } from '../../apps/api/src/crypto.mjs';
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

test('broker accepts a dynamic model only with an exact Profile snapshot', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-broker-profile-'));
  const secret = 'security-secret-for-profile-binding';
  const broker = await startBroker({ config: { host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, executor: 'mock', runnerImage: `runner@${digest}`, model: 'broker-default' } });
  const base = `http://127.0.0.1:${broker.server.address().port}`;
  try {
    const profileConfig = {
      label: 'Fixture profile', provider: 'fixture', model: 'profile-model',
      base_url: 'https://provider.example/v1', wire_api: 'responses', reasoning: 'high',
      timeout_ms: 30000, credential_ref: 'cred_profile12345678', credential_revision: 2
    };
    const binding = {
      id: 'cdp_profile12345678', revision: 3, config_hash: hashJson(profileConfig),
      credential_ref: profileConfig.credential_ref, credential_revision: profileConfig.credential_revision, runner_digest: digest
    };
    const profile = {
      profile_id: binding.id, profile_revision: binding.revision,
      profile_hash: hashJson(binding), config_hash: binding.config_hash,
      ...profileConfig, auth_kind: 'api_key', runner_digest: digest
    };
    const spec = {
      ...validSpec(), task_id: 'profile-task', model: profile.model, network_profile: 'model',
      credential_ref: profile.credential_ref, profile_id: profile.profile_id,
      profile_revision: profile.profile_revision, profile_hash: profile.profile_hash
    };
    const credential = { ref: profile.credential_ref, kind: 'codex_api_key', revision: 2, auth: 'profile-secret-value' };
    const accepted = await call(base, secret, 'POST', '/internal/v1/jobs', { spec, profile, credential });
    assert.equal(accepted.response.status, 201, JSON.stringify(accepted.json));

    const staleCredential = await call(base, secret, 'POST', '/internal/v1/jobs', { spec: { ...spec, task_id: 'stale-credential' }, profile, credential: { ...credential, revision: 1 } });
    assert.equal(staleCredential.response.status, 400);
    assert.equal(staleCredential.json.error.code, 'invalid_job_spec');

    const tampered = await call(base, secret, 'POST', '/internal/v1/jobs', { spec: { ...spec, task_id: 'tampered-profile' }, profile: { ...profile, model: 'other-model' }, credential });
    assert.equal(tampered.response.status, 400);
    assert.equal(tampered.json.error.code, 'invalid_job_spec');
    const hashTampered = await call(base, secret, 'POST', '/internal/v1/jobs', { spec: { ...spec, task_id: 'tampered-hash' }, profile: { ...profile, config_hash: 'b'.repeat(64) }, credential });
    assert.equal(hashTampered.response.status, 400);
    assert.equal(hashTampered.json.error.code, 'invalid_job_spec');
  } finally {
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('explicit Host executor runs the bound Profile and removes its Codex home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-host-profile-'));
  const workspace = path.join(home, 'projects', 'prj_host12345678');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'exec'), `
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
  fs.writeFileSync(output, JSON.stringify({ summary: 'host profile complete' }));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', message: 'host profile complete', usage: { output_tokens: 2 } }) + '\\n');
});
`, 'utf8');
  for (const args of [['init'], ['config', 'user.email', 'fixture@example.test'], ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    const run = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
  }
  const baseline = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8', windowsHide: true }).stdout.trim();
  const secret = 'security-secret-for-host-profile';
  const broker = await startBroker({ config: {
    host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3',
    runnerDigest: digest, runnerImage: digest, executor: 'host', codexBinary: process.execPath,
    model: 'broker-default'
  } });
  const base = `http://127.0.0.1:${broker.server.address().port}`;
  try {
    const profileConfig = {
      label: 'Host fixture', provider: 'fixture', model: 'host-profile-model',
      base_url: 'https://provider.example/v1', wire_api: 'responses', reasoning: 'medium',
      timeout_ms: 30000, credential_ref: 'cred_host12345678', credential_revision: 4
    };
    const binding = {
      id: 'cdp_host12345678', revision: 2, config_hash: hashJson(profileConfig),
      credential_ref: profileConfig.credential_ref, credential_revision: profileConfig.credential_revision,
      runner_digest: digest
    };
    const profile = {
      profile_id: binding.id, profile_revision: binding.revision, profile_hash: hashJson(binding),
      config_hash: binding.config_hash, ...profileConfig, auth_kind: 'api_key', runner_digest: digest
    };
    const spec = {
      task_id: 'host-profile', execution_id: 'exe_host12345678', project_id: 'prj_host12345678',
      workspace_subpath: 'projects/prj_host12345678', image_digest: digest, execution_mode: 'read',
      resource_profile: 'light', network_profile: 'model', input_paths: [], output_paths: [],
      deadline_at: new Date(Date.now() + 60_000).toISOString(), credential_ref: profile.credential_ref,
      profile_id: profile.profile_id, profile_revision: profile.profile_revision, profile_hash: profile.profile_hash,
      model: profile.model, baseline_sha: baseline,
      bundle: { objective: 'Host fixture', acceptance: [], input_paths: [], output_paths: [], checks: ['node_test', 'git_diff_check'] }
    };
    const created = await call(base, secret, 'POST', '/internal/v1/jobs', {
      spec, profile, credential: { ref: profile.credential_ref, kind: 'codex_api_key', revision: 4, auth: 'host-profile-secret-value' }
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.json));
    let status;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = await call(base, secret, 'GET', `/internal/v1/jobs/${created.json.job_id}`);
      if (['completed', 'failed'].includes(status.json.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status.json.status, 'completed', JSON.stringify(status.json));
    assert.equal(status.json.result.summary, 'host profile complete');
    assert.equal(JSON.stringify(status.json).includes('host-profile-secret-value'), false);
    assert.deepEqual(fs.readdirSync(path.join(home, '.codex-host')), []);
  } finally {
    await broker.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
