import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { start as startApi } from '../../apps/api/server.mjs';
import { signedHeaders } from '../../apps/api/src/broker-client.mjs';
import { loadConfig } from '../../apps/api/src/config.mjs';
import { start as startBroker } from '../../apps/runner-broker/server.mjs';

async function mutate(base, route, body, key) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json;
}

async function eventually(read, predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return read();
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

test('ephemeral Codex credentials never enter state, events, errors, Broker status, or CAS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-credential-boundary-'));
  const home = path.join(root, 'data-volume');
  const secretFile = path.join(root, 'codex-secret.json');
  const credential = 'fixture-auth-material-1234567890';
  const brokerSecret = 'broker-hmac-secret-for-credential-test';
  const digest = `sha256:${'9'.repeat(64)}`;
  fs.writeFileSync(secretFile, JSON.stringify({ provider: 'openai', profile: 'default', model: 'codex-mini-latest', api_key: credential }), { mode: 0o600 });
  let broker;
  let app;
  try {
    broker = await startBroker({ config: { host: '127.0.0.1', port: 0, secret: brokerSecret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, executor: 'mock', runnerImage: digest, model: 'codex-mini-latest' } });
    const brokerBase = `http://127.0.0.1:${broker.server.address().port}`;
    const config = loadConfig({
      AIWS_HOME: home,
      AIWS_BROKER_MODE: 'http',
      AIWS_BROKER_URL: brokerBase,
      AIWS_BROKER_HMAC_SECRET: brokerSecret,
      AIWS_RUNNER_DIGEST: digest,
      AIWS_CODEX_SECRET_FILE: secretFile,
      AIWS_CODEX_MODEL: 'codex-mini-latest'
    });
    app = await startApi({ config: { ...config, host: '127.0.0.1', port: 0 } });
    const base = `http://127.0.0.1:${app.server.address().port}`;

    const project = await mutate(base, '/api/v1/projects', { name: 'Credential boundary', repository: { source: { kind: 'fixture', id: 'designsignal-v1' } } }, 'credential-project');
    await mutate(base, `/api/v1/projects/${project.id}/briefs`, { content: { objective: 'Verify credential isolation', acceptance: ['node_test'] } }, 'credential-brief');
    await mutate(base, `/api/v1/projects/${project.id}/workflows`, { tasks: [{ id: 'inspect', title: 'Inspect', level: 1, mode: 'read', outputs: ['analysis.md'] }] }, 'credential-workflow');
    const execution = await mutate(base, `/api/v1/projects/${project.id}/executions`, {}, 'credential-execution');
    await mutate(base, `/api/v1/executions/${execution.id}/start`, { expected_revision: execution.revision }, 'credential-start');
    const completed = await eventually(async () => (await fetch(`${base}/api/v1/executions/${execution.id}`)).json(), (value) => value.status === 'completed');
    assert.equal(completed.status, 'completed');

    const attempt = await app.database.get('SELECT broker_job_id FROM task_attempts WHERE execution_id=? AND task_id=? ORDER BY attempt_no DESC LIMIT 1', [execution.id, 'inspect']);
    const brokerStatus = await app.broker.status(attempt.broker_job_id);
    const capabilities = await (await fetch(`${base}/api/v1/system/capabilities`)).json();
    assert.equal(capabilities.codex.status, 'unknown');
    assert.equal(capabilities.codex.error_code, 'not_probed');
    const events = await app.domain.events(execution.id, 0);
    const credentialRef = await app.database.get('SELECT * FROM credential_refs WHERE id=?', ['cred_codex_default']);
    assert.equal(credentialRef.secret_ref, 'secret_bundle:codex_default');

    const sse = await fetch(`${base}/api/v1/executions/${execution.id}/events`, { signal: AbortSignal.timeout(2_000) });
    const reader = sse.body.getReader();
    const firstChunk = await reader.read();
    await reader.cancel();

    const invalidSpec = {
      task_id: 'unsafe', execution_id: 'exe_credential1234', project_id: 'prj_credential1234',
      workspace_subpath: 'projects/prj_credential1234', image_digest: digest,
      execution_mode: 'read', resource_profile: 'standard', network_profile: 'none',
      input_paths: [], output_paths: [], deadline_at: new Date(Date.now() + 60_000).toISOString(),
      credential_ref: 'cred_codex_default', command: credential
    };
    const envelope = JSON.stringify({ spec: invalidSpec, credential: { ref: 'cred_codex_default', profile: 'default', auth: credential } });
    const errorResponse = await fetch(`${brokerBase}/internal/v1/jobs`, {
      method: 'POST', headers: signedHeaders(brokerSecret, 'POST', '/internal/v1/jobs', envelope), body: envelope
    });
    const errorBody = await errorResponse.json();
    assert.equal(errorResponse.status, 400);

    const exposedSurfaces = JSON.stringify({ completed, brokerStatus, capabilities, events, errorBody, sse: new TextDecoder().decode(firstChunk.value || new Uint8Array()) });
    assert.equal(exposedSurfaces.includes(credential), false);
    assert.equal(JSON.stringify(credentialRef).includes(credential), false);

    await app.close();
    app = null;
    await broker.close();
    broker = null;
    for (const file of walkFiles(home)) {
      assert.equal(fs.readFileSync(file).includes(Buffer.from(credential)), false, `credential persisted in ${path.relative(home, file)}`);
    }
  } finally {
    if (app) await app.close();
    if (broker) await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
