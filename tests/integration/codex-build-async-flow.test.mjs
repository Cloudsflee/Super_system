import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.AIWS_TEST_PORT || 4598);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-codex-build-'));
const bin = path.join(home, 'bin');
const marker = path.join(home, 'image-ready');
fs.mkdirSync(bin, { recursive: true });
const fakeDockerScript = installFakeDocker();
let server = startServer();

await waitForServer();
try {
  const startedAt = Date.now();
  const first = await request('/codex/docker/build', { method: 'POST', body: '{}' }, 202);
  assert.ok(Date.now() - startedAt < 1200, 'build start returns before the long build finishes');
  assert.match(first.operation_id, /^cdxbuild_/);
  const second = await request('/codex/docker/build', { method: 'POST', body: '{}' }, 202);
  assert.equal(second.operation_id, first.operation_id);
  assert.equal(second.attached, true);

  const sse = fetch(url(first.events_url)).then(async (response) => { assert.equal(response.status, 200); return response.text(); });
  const responsiveAt = Date.now();
  const [health, setup] = await Promise.all([request('/health'), request('/setup/status')]);
  assert.equal(health.status, 'ok');
  assert.equal(setup.complete, false);
  assert.ok(Date.now() - responsiveAt < 1200, 'health and setup remain responsive during Docker Build');
  const active = await request('/codex/docker/builds/active');
  assert.equal(active.operation.operation_id, first.operation_id);

  const events = await sse;
  assert.match(events, /event: snapshot/);
  assert.match(events, /event: (?:phase|log)/);
  assert.match(events, /event: completed/);
  assert.equal(events.includes('super-secret-value'), false);
  const completed = await request(`/codex/docker/builds/${first.operation_id}`);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.phase.label, '完成');
  assert.equal((await request('/codex/docker/builds/active')).operation, null);
  assert.equal((await request('/setup/status')).steps.codex.checks.docker_ready, true);
  const deployment = await request('/system/deployment');
  assert.equal(deployment.capabilities.native_assist.available, true);
  assert.equal(deployment.capabilities.linux_cli.available, true);

  const replayResponse = await fetch(url(`/codex/docker/builds/${first.operation_id}/events`), { headers: { 'last-event-id': String(Math.max(0, completed.last_event_id - 1)) } });
  const replay = await replayResponse.text();
  assert.match(replay, /event: completed/);

  const clientRequestId = 'req_integration_build_123';
  const missing = await fetch(url('/codex/docker/builds/missing'), { headers: { 'x-aiws-request-id': clientRequestId } });
  const missingBody = await missing.json();
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-aiws-request-id'), clientRequestId);
  assert.equal(missingBody.request_id, clientRequestId);
  for (const field of ['error', 'message', 'action', 'phase', 'retryable', 'request_id']) assert.ok(Object.hasOwn(missingBody, field));

  fs.rmSync(marker, { force: true });
  await delay(1700);
  const cancellable = await request('/codex/docker/build', { method: 'POST', body: '{}' }, 202);
  await waitForOperation(cancellable.operation_id, (value) => value.phase.key === 'building');
  await request(`/codex/docker/builds/${cancellable.operation_id}/cancel`, { method: 'POST', body: '{}' }, 202);
  const cancelled = await waitForOperation(cancellable.operation_id, (value) => value.status === 'cancelled');
  assert.equal(cancelled.error_code, 'docker_build_cancelled');
  assert.equal(fs.existsSync(marker), false);

  await delay(1700);
  const interrupted = await request('/codex/docker/build', { method: 'POST', body: '{}' }, 202);
  await waitForOperation(interrupted.operation_id, (value) => value.phase.key === 'building');
  await stopServer();
  server = startServer();
  await waitForServer();
  assert.equal((await request('/codex/docker/builds/active')).operation, null, 'in-memory build is cleared after service restart');

  console.log('Codex async build integration tests passed');
} finally {
  await stopServer();
  fs.rmSync(home, { recursive: true, force: true });
}

function startServer() {
  const child = spawn(process.execPath, ['apps/api/server.mjs'], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, AIWS_PORT: String(port), AIWS_HOME: home, AIWS_FAKE_DOCKER_MARKER: marker, AIWS_TEST_DOCKER_SCRIPT: fakeDockerScript, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(5000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function request(route, init = {}, expected = 200) {
  const headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  const response = await fetch(url(route), { ...init, headers });
  const body = await response.json();
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(body)}\n${server.output}`);
  return body;
}
function url(route) { return `http://127.0.0.1:${port}${route}`; }
async function waitForServer() {
  for (let index = 0; index < 100; index++) {
    try { if ((await request('/health')).status === 'ok') return; } catch { await delay(50); }
  }
  throw new Error(`server did not start: ${server.output}`);
}
async function waitForOperation(id, predicate) {
  for (let index = 0; index < 200; index++) {
    const value = await request(`/codex/docker/builds/${id}`);
    if (predicate(value)) return value;
    await delay(25);
  }
  throw new Error(`operation did not reach expected state: ${id}`);
}

function installFakeDocker() {
  const script = path.join(bin, 'fake-docker.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';\nconst args=process.argv.slice(2),marker=process.env.AIWS_FAKE_DOCKER_MARKER;\nif(args[0]==='info'){console.log('29.4.1');process.exit(0);}\nif(args[0]==='image'&&args[1]==='inspect'){if(fs.existsSync(marker)){console.log(JSON.stringify([{RootFS:{Type:'layers',Layers:['sha256:unit-layer']},Config:{Env:[]}}]));process.exit(0);}console.error('Error: No such image');process.exit(1);}\nif(args[0]==='build'){console.log('fake build started token=super-secret-value');setTimeout(()=>{fs.writeFileSync(marker,'ready');console.log('fake build completed');},2500);process.on('SIGTERM',()=>process.exit(143));}else{process.exit(0);}\n`, 'utf8');
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'docker.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-docker.mjs" %*\r\n`, 'utf8');
  else { const executable = path.join(bin, 'docker'); fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-docker.mjs" "$@"\n`, { mode: 0o755 }); }
  return script;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
