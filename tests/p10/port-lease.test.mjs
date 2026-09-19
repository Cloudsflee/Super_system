// Owner: Platform/Testing. Phase: post-P10 D-040 maintenance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquirePortLease, startProbeWithPorts, waitForHttpReady } from '../../scripts/lib/port-lease.mjs';
import { nodeInvocation } from '../../scripts/lib/gate-process.mjs';

const root = process.cwd();
const children = [];
const options = { cwd: root, workspaceRoot: root, stdout: false, stderr: false };
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
function childServer(scope, port, extra = '') {
  const code = "const http=require('node:http'); const s=http.createServer((q,r)=>r.end('healthy')); s.listen(" + port + ", '127.0.0.1',()=>{ console.log('bound:" + port + "'); " + extra + " });";
  const child = scope.spawn(nodeInvocation('-e', [code]), options);
  children.push(child);
  return child;
}
const ready = (scope, child) => scope.ready(0, 'http://127.0.0.1:' + scope.leases[0].port, { child, readyOutput: new RegExp('bound:' + scope.leases[0].port + '\\b'), timeoutMs: 3000 });
function gone(child) { assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH'); }

test('parallel leases hold OS listeners and share one exclusive lock namespace', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-exclusive-'));
  const leases = [];
  try {
    leases.push(...await Promise.all(Array.from({ length: 4 }, () => acquirePortLease({ lockDirectory: directory }))));
    assert.equal(new Set(leases.map(lease => lease.port)).size, 4);
    const [lease] = leases;
    const competitor = net.createServer();
    await assert.rejects(() => new Promise((resolve, reject) => { competitor.once('error', reject); competitor.listen(lease.port, '127.0.0.1', resolve); }), error => error.code === 'EADDRINUSE');
    await lease.handoff();
    await assert.rejects(() => acquirePortLease({ port: lease.port, lockDirectory: directory }), error => error.code === 'EADDRINUSE');
    assert.ok(fs.existsSync(lease.lock_path));
  } finally {
    for (const lease of leases) await lease.release();
    assert.deepEqual(fs.readdirSync(directory), []);
    fs.rmSync(directory, { recursive: true });
  }
});

test('concurrent E2E and release startup shapes bind unique ports and dispose children and directories', async () => {
  const starts = await Promise.all(['e2e', 'release'].map(name => startProbeWithPorts({ prefix: 'lease-' + name, start: async scope => {
    await scope.leases[0].handoff();
    const child = childServer(scope, scope.leases[0].port);
    await ready(scope, child);
    assert.equal(fs.existsSync(scope.leases[0].lock_path), false);
    return { child, port: scope.leases[0].port };
  } })));
  try {
    assert.notEqual(starts[0].port, starts[1].port);
    for (const item of starts) assert.equal(await (await fetch('http://127.0.0.1:' + item.port)).text(), 'healthy');
  } finally {
    for (const item of starts) { await item.scope.dispose(); gone(item.child); assert.equal(fs.existsSync(item.scope.directory), false); }
  }
});

test('a real stolen port retries startup after cleanup and preserves the successful attempt', async () => {
  const blocker = http.createServer((q, r) => r.end('wrong server'));
  const attempts = [];
  let result;
  try {
    result = await startProbeWithPorts({ prefix: 'lease-collision', retryDelays: [0], start: async scope => {
      for (const prior of attempts) assert.equal(fs.existsSync(prior.directory), false);
      attempts.push(scope);
      const port = scope.leases[0].port;
      await scope.leases[0].handoff();
      if (scope.attempt === 1) await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
      const child = childServer(scope, port);
      await ready(scope, child);
      return { child };
    } });
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0].leases[0].port, attempts[1].leases[0].port);
    assert.equal(fs.existsSync(attempts[0].leases[0].lock_path), false);
  } finally { await result?.scope.dispose(); await close(blocker); }
});

test('all socket resource failures exhaust bounded retries after closing browsers, children, locks and state', async () => {
  for (const code of ['EADDRINUSE', 'ERR_ADDRESS_IN_USE', 'ERR_NO_BUFFER_SPACE']) {
    const attempts = [], spawned = [];
    let closedBrowsers = 0;
    await assert.rejects(() => startProbeWithPorts({ prefix: 'lease-exhaust', retryDelays: [0, 0], start: async scope => {
      for (const prior of attempts) assert.equal(fs.existsSync(prior.directory), false);
      for (const child of spawned) gone(child);
      attempts.push(scope);
      await scope.leases[0].handoff();
      const child = childServer(scope, scope.leases[0].port);
      spawned.push(child);
      await ready(scope, child);
      scope.browser({ close: async () => { closedBrowsers += 1; } });
      fs.writeFileSync(path.join(scope.directory, 'partial'), 'partial');
      throw Object.assign(new Error(code), { code });
    } }), error => error.code === 'port_start_retry_exhausted');
    assert.equal(attempts.length, 3);
    assert.equal(closedBrowsers, 3);
    for (const scope of attempts) { assert.equal(fs.existsSync(scope.directory), false); assert.ok(scope.leases.every(lease => !fs.existsSync(lease.lock_path))); }
    for (const child of spawned) gone(child);
  }
});

test('readiness rejects unrelated HTTP success and a stalled health request remains bounded', async () => {
  const unrelated = http.createServer((q, r) => r.end('wrong server'));
  await listen(unrelated);
  let attempt = 0;
  try {
    await assert.rejects(() => startProbeWithPorts({ prefix: 'lease-readiness', start: async scope => {
      attempt += 1;
      await scope.leases[0].handoff();
      const child = childServer(scope, scope.leases[0].port);
      await waitForHttpReady('http://127.0.0.1:' + unrelated.address().port, { child, readyOutput: /never-emitted-binding/, timeoutMs: 200 });
    } }), error => error.code === 'port_ready_timeout');
    assert.equal(attempt, 1);
    unrelated.removeAllListeners('request');
    unrelated.on('request', () => {});
    const started = Date.now();
    await assert.rejects(() => startProbeWithPorts({ prefix: 'lease-stalled', start: async scope => {
      await scope.leases[0].handoff();
      const child = childServer(scope, scope.leases[0].port);
      await waitForHttpReady('http://127.0.0.1:' + unrelated.address().port, { child, readyOutput: /bound:/, timeoutMs: 250 });
    } }), error => error.code === 'port_ready_timeout');
    assert.ok(Date.now() - started < 5000);
  } finally { await close(unrelated); }
});

test('failure after startup never repeats publication or any external action', async () => {
  let starts = 0, externalActions = 0;
  const result = await startProbeWithPorts({ prefix: 'lease-once', start: async () => { starts += 1; return {}; } });
  try {
    await assert.rejects(async () => { externalActions += 1; throw new Error('ERR_NO_BUFFER_SPACE after external action'); }, /ERR_NO_BUFFER_SPACE/);
    assert.equal(starts, 1);
    assert.equal(externalActions, 1);
  } finally { await result.scope.dispose(); }
});
