import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v22-performance-'));
process.env.AIWS_HOME = root;
process.env.NODE_ENV = 'test';
const state = await import(`../../apps/api/src/state.mjs?v22-performance=${Date.now()}`),
  health = await import('../../apps/api/src/runtime-health.mjs');
try {
  await state.ensureRuntime();
  const liveSamples = [],
    snapshotSamples = [];
  for (let index = 0; index < 200; index += 1) {
    let started = performance.now();
    health.livezSnapshot();
    liveSamples.push(performance.now() - started);
    started = performance.now();
    await state.readStateSnapshot();
    snapshotSamples.push(performance.now() - started);
  }
  assert.ok(percentile(liveSamples, 0.95) < 5, `livez p95 ${percentile(liveSamples, 0.95)}ms`);
  assert.ok(percentile(snapshotSamples, 0.95) < 10, `snapshot p95 ${percentile(snapshotSamples, 0.95)}ms`);
  const revision = state.stateRevision();
  const idleStarted = performance.now();
  for (let index = 0; index < 100; index += 1) await state.mutate(() => undefined);
  const idleElapsed = performance.now() - idleStarted;
  assert.equal(state.stateRevision(), revision);
  assert.ok(idleElapsed < 500, `100 idle mutations took ${idleElapsed.toFixed(3)}ms`);
  console.log(
    `V2.2 performance passed (livez p95=${percentile(liveSamples, 0.95).toFixed(3)}ms, ` +
      `snapshot p95=${percentile(snapshotSamples, 0.95).toFixed(3)}ms, idle=${idleElapsed.toFixed(3)}ms)`
  );
} finally {
  await state.checkpointAndCloseState().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

function percentile(values, ratio) {
  const ordered = values.slice().sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
}
