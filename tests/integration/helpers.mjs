import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start as startApi } from '../../apps/api/server.mjs';
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
