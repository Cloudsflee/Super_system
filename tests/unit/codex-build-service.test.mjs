import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexBuildManager, classifyBuildFailure, sanitizeBuildLog } from '../../apps/api/src/codex-build-service.mjs';

const missing = { ready: false, docker: { ok: true }, image: { ready: false, error_code: 'codex_probe_image_missing' } };
const ready = { ready: true, docker: { ok: true }, image: { ready: true, id: 'sha256:test' } };

{
  let inspectCalls = 0, spawnCalls = 0;
  const manager = new CodexBuildManager({
    inspectRuntime: async () => { const call = ++inspectCalls; await delay(5); return call <= 2 ? missing : ready; },
    invalidateRuntime: () => undefined,
    spawnProcess: () => {
      spawnCalls += 1;
      const child = fakeChild();
      setImmediate(() => {
        for (let index = 0; index < 240; index++) child.stdout.write(`step ${index} token=secret-${index} ${'x'.repeat(400)}\n`);
        child.stderr.write('Authorization: Bearer sk-super-secret-value\n');
        child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
      });
      return child;
    }
  });
  const [first, second] = await Promise.all([manager.ensure({ image: 'runner:test' }), manager.ensure({ image: 'runner:test' })]);
  assert.equal(first.immediate, false);
  assert.equal(second.immediate, false);
  assert.equal(first.operation.operation_id, second.operation.operation_id, 'same image attaches to one operation');
  const completed = await waitFor(() => manager.get(first.operation.operation_id)?.status === 'completed' && manager.get(first.operation.operation_id));
  assert.equal(spawnCalls, 1);
  assert.ok(completed.logs.length <= 200);
  assert.ok(Buffer.byteLength(completed.logs.map((item) => item.text).join(''), 'utf8') <= 64 * 1024);
  assert.equal(completed.logs.some((item) => /sk-super-secret|secret-239/.test(item.text)), false);
  const replay = manager.eventsSince(first.operation.operation_id, 0);
  assert.ok(Buffer.byteLength(replay.events.filter((event) => event.type === 'log').map((event) => event.data.text).join(''), 'utf8') <= 64 * 1024);
  const labels = replay.events.filter((event) => event.type === 'phase').map((event) => event.data.label);
  assert.deepEqual(labels, ['运行时检查', '准备构建', '构建镜像', '验证镜像', '完成']);
  assert.equal(replay.events.at(-1).type, 'completed');
  const tail = manager.eventsSince(first.operation.operation_id, replay.events.at(-2).id);
  assert.equal(tail.events.length, 1);
  assert.equal(tail.events[0].type, 'completed');
}

{
  const signals = [];
  const manager = new CodexBuildManager({
    inspectRuntime: async () => missing,
    invalidateRuntime: () => undefined,
    forceKillMs: 15,
    spawnProcess: () => fakeChild((child, signal) => {
      signals.push(signal || 'SIGTERM');
      if (signal === 'SIGKILL') child.emit('close', null, signal);
    })
  });
  const started = await manager.ensure({ image: 'runner:cancel' });
  await waitFor(() => manager.get(started.operation.operation_id)?.phase.key === 'building');
  manager.cancel(started.operation.operation_id);
  const cancelled = await waitFor(() => manager.get(started.operation.operation_id)?.status === 'cancelled' && manager.get(started.operation.operation_id));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(cancelled.error_code, 'docker_build_cancelled');
}

{
  const manager = new CodexBuildManager({
    inspectRuntime: async () => missing,
    invalidateRuntime: () => undefined,
    timeoutMs: 15,
    forceKillMs: 5,
    spawnProcess: () => fakeChild((child) => setImmediate(() => child.emit('close', null, 'SIGTERM')))
  });
  const started = await manager.ensure({ image: 'runner:timeout' });
  const failed = await waitFor(() => manager.get(started.operation.operation_id)?.status === 'failed' && manager.get(started.operation.operation_id));
  assert.equal(failed.error_code, 'docker_build_timeout');
  assert.equal(failed.retryable, true);
}

{
  const signals = [];
  const manager = new CodexBuildManager({
    inspectRuntime: async () => missing,
    invalidateRuntime: () => undefined,
    timeoutMs: 15,
    forceKillMs: 5,
    spawnProcess: () => fakeChild((_child, signal) => { signals.push(signal || 'SIGTERM'); })
  });
  const started = await manager.ensure({ image: 'runner:timeout-with-open-pipes' });
  const failed = await waitFor(() => manager.get(started.operation.operation_id)?.status === 'failed' && manager.get(started.operation.operation_id));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(failed.error_code, 'docker_build_timeout');
}

assert.equal(classifyBuildFailure('no space left on device').error_code, 'docker_build_disk_full');
assert.equal(classifyBuildFailure('permission denied').error_code, 'docker_build_permission_denied');
assert.equal(classifyBuildFailure('TLS handshake timeout').error_code, 'docker_build_network_failed');
assert.equal(classifyBuildFailure('cannot connect to the Docker daemon').error_code, 'docker_unavailable');
assert.equal(classifyBuildFailure('executor failed').error_code, 'docker_build_failed');
assert.equal(sanitizeBuildLog('GET https://user:pass@example.test/path?token=secret token=abc'), 'GET https://example.test/path token=***MASKED***');

console.log('Codex async build service unit tests passed');

function fakeChild(onKill = (child, signal) => child.emit('close', null, signal || 'SIGTERM')) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { onKill(child, signal); return true; };
  return child;
}

async function waitFor(read, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = read(); if (value) return value; await delay(5); }
  throw new Error('timed out waiting for build state');
}
function delay(value) { return new Promise((resolve) => setTimeout(resolve, value)); }
