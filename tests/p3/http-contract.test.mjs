import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCleanRuntime } from '../../apps/api/src/clean/runtime.mjs';
import { createCleanHttpHandler } from '../../apps/api/src/clean/http.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p3-http-'));
  return {
    root,
    config: {
      runtime: 'v3-clean',
      apiVersion: '2',
      host: '127.0.0.1',
      port: 0,
      home: root,
      databaseFile: path.join(root, 'data', 'state.sqlite'),
      casRoot: path.join(root, 'cas'),
      receiptRoot: path.join(root, 'receipts'),
      vaultRoot: path.join(root, 'vault'),
      cursorSecret: 'p3-http-cursor-secret',
      sessionSecret: 'p3-http-session-secret',
      vaultMasterKey: 'p3-http-vault-master-secret',
      runtimeBuild: 'p3-http-test',
      maxBodyBytes: 1_000_000
    }
  };
}

async function listen(runtime) {
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry });
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('P3 HTTP uses the session cookie, closed contracts, and equivalent operation replay', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({ config: f.config, targetVersion: 3 });
  await runtime.recovery;
  const { server, base } = await listen(runtime);
  let cookie = '';
  let keyCounter = 0;
  const nextKey = () => `p3-http-${String(++keyCounter).padStart(2, '0')}-key`;
  async function call(method, route, body, expectedRevision, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = nextKey();
      if (expectedRevision !== undefined) headers['x-expected-revision'] = String(expectedRevision);
    }
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    return { response, payload, text };
  }
  try {
    let result = await call('GET', '/api/v2/account');
    assert.equal(result.response.status, 401);
    result = await call('POST', '/api/v2/setup', { display_name: 'HTTP Owner', team_name: 'HTTP Team' }, 0, { 'idempotency-key': 'p3-http-setup-key', 'x-expected-revision': '0' });
    assert.equal(result.response.status, 201);
    assert.match(result.response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(result.response.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal(result.text.includes('proof'), false);
    result = await call('GET', '/api/v2/account', undefined, undefined, { 'x-actor-id': 'actor_system_bootstrap', 'x-scopes': '*' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.data.account.kind, 'user');

    result = await call('POST', '/api/v2/projects', { name: 'HTTP Project', description: 'contract' }, 0);
    assert.equal(result.response.status, 201);
    const projectId = result.payload.data.project.id;
    assert.equal(result.payload.data.project.revision, 1);
    result = await call('POST', `/api/v2/projects/${projectId}/intake`, { mode: 'brainstorm', content: { goal: 'probe' } }, 1);
    assert.equal(result.response.status, 202);
    const operationId = result.payload.data.operation_id;
    result = await call('GET', `/api/v2/operations/${operationId}`);
    assert.equal(result.response.status, 200);
    for (let attempt = 0; attempt < 50 && !['succeeded', 'failed', 'cancelled'].includes(result.payload.data.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = await call('GET', `/api/v2/operations/${operationId}`);
    }
    assert.equal(result.payload.data.status, 'succeeded');

    const replay = await call('GET', `/api/v2/operations/${operationId}/events?format=json`);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.payload.data.terminal, true);
    assert.ok(replay.payload.data.events.length >= 2);
    const sse = await fetch(`${base}/api/v2/operations/${operationId}/events`, {
      headers: { cookie, accept: 'text/event-stream' }
    });
    const sseText = await sse.text();
    assert.equal(sse.status, 200);
    assert.match(sseText, /event: operation\./);
    assert.match(sseText, /data:/);

    result = await call('POST', `/api/v2/projects/${projectId}/intake`, { mode: 'brainstorm', unexpected: true }, 1);
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.code, 'unknown_field');
    result = await fetch(`${base}/api/v1/projects`, { headers: { cookie } });
    assert.equal(result.status, 410);
    assert.equal((await result.json()).error.code, 'route_retired');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('P3 project access remains resolver- and ACL-scoped', async () => {
  const f = fixture();
  const runtime = createCleanRuntime({
    config: f.config,
    targetVersion: 3,
    projectScopeResolver: (projectId) => String(projectId).startsWith('project_')
  });
  await runtime.recovery;
  try {
    const setup = await runtime.identity.setupComplete({ display_name: 'Owner', team_name: 'Team', idempotency_key: 'p3-scope-setup-key' });
    const principal = runtime.identity.authenticateProof(setup.session.proof);
    const project = await runtime.project.createProject({ name: 'Scoped', idempotency_key: 'p3-scope-project-key' }, principal);
    await runtime.identity.setAclEntry(
      project.id,
      { principal_actor_id: principal.actorId, resource: 'project', action: 'read', effect: 'deny', expected_revision: 0, idempotency_key: 'p3-scope-deny-key' },
      principal
    );
    assert.throws(() => runtime.project.getProject(project.id, principal), (error) => error.code === 'permission_denied');
    assert.throws(() => runtime.authorization.assert(principal, 'read', 'outside-project', { resource: 'project' }), (error) => error.code === 'project_denied');
  } finally {
    runtime.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
