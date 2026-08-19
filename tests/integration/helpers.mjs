import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start as startApi } from '../../apps/api/server-legacy.mjs';
import { start as startBroker } from '../../apps/runner-broker/server.mjs';

export async function fixture({ setupGateBypass = true, config: configOverrides = {}, githubOptions = undefined } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-integration-'));
  const secret = 'integration-secret';
  const digest = `sha256:${'a'.repeat(64)}`;
  const broker = await startBroker({ config: { host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, executor: 'mock', runnerImage: `runner@${digest}` } });
  const brokerPort = broker.server.address().port;
  const app = await startApi({ githubOptions, config: { version: '3.0.0', apiPrefix: '/api/v1', host: '127.0.0.1', port: 0, home, databaseFile: path.join(home, 'data', 'state.sqlite'), casRoot: path.join(home, 'cas'), dataVolume: 'aiws-data-v3', brokerUrl: `http://127.0.0.1:${brokerPort}`, brokerMode: 'http', brokerSecret: secret, runnerDigest: digest, codexAvailable: false, githubAvailable: false, testOnlyBypassSetupGate: setupGateBypass, ...configOverrides } });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, broker, base, home, digest, async close() { await app.close(); await broker.close(); } };
}

export async function request(base, route, options = {}) {
  const { body, key, headers, ...requestOptions } = options;
  const response = await fetch(`${base}${route}`, {
    ...requestOptions,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

export async function mutate(base, route, body, key, method = 'POST') {
  return request(base, route, { method, body, key });
}

export async function eventually(read, predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return read();
}

export async function onboardProject(base, project, { content = {}, keyPrefix = 'project-onboarding', intake = {} } = {}) {
  const projectId = String(project?.json?.id || project?.id || project);
  const initial = await request(base, `/api/v1/projects/${projectId}`);
  if (initial.response.status !== 200) throw new Error(`project onboarding read failed: ${initial.response.status}`);

  const started = await mutate(base, `/api/v1/projects/${projectId}/intakes`, {
    mode: initial.json.intake?.mode || 'brainstorm',
    expected_revision: initial.json.revision,
    ...intake
  }, `${keyPrefix}-intake`);
  if (started.response.status !== 202) throw new Error(`project intake failed: ${started.response.status} ${started.json?.error?.code || ''}`.trim());

  const operation = await eventually(
    async () => (await request(base, `/api/v1/operations/${started.json.operation_id}`)).json,
    (value) => ['completed', 'failed', 'cancelled'].includes(value.status),
    10_000
  );
  if (operation.status !== 'completed') throw new Error(`project intake did not complete: ${operation.status} ${operation.error_code || ''}`.trim());

  const brief = await mutate(base, `/api/v1/projects/${projectId}/briefs`, { content }, `${keyPrefix}-brief`);
  if (brief.response.status !== 201) throw new Error(`brief preview failed: ${brief.response.status} ${brief.json?.error?.code || ''}`.trim());

  const current = await request(base, `/api/v1/projects/${projectId}`);
  const confirmed = await mutate(base, `/api/v1/projects/${projectId}/briefs/${brief.json.revision}/confirm`, {
    expected_revision: current.json.revision,
    intake_revision: current.json.intake.revision
  }, `${keyPrefix}-confirm`);
  if (confirmed.response.status !== 200) throw new Error(`brief confirmation failed: ${confirmed.response.status} ${confirmed.json?.error?.code || ''}`.trim());
  return { project: confirmed.json, intake: current.json.intake, brief: brief.json, operation };
}
