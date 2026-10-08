import test from 'node:test';
import assert from 'node:assert/strict';
import * as active from '../../apps/api/server.mjs';
import { createApp as createCleanApp } from '../../apps/api/clean-server.mjs';

test('public server exposes only active entrypoints', () => {
  assert.deepEqual(Object.keys(active).sort(), ['ACTIVE_RUNTIME_PHASE', 'ACTIVE_SCHEMA_VERSION', 'ACTIVE_TARGET_VERSION', 'createApp', 'start']);
  assert.throws(() => createCleanApp({ targetVersion: 8 }), /active_schema_version_required/);
  assert.throws(() => createCleanApp({ runtimePhase: 9 }), /active_runtime_phase_required/);
});
