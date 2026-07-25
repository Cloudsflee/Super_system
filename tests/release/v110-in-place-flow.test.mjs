import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertOnlyAppReplaced,
  executionActivityProbeScript,
  inspectExecutionActivity,
  V110_SCHEMA,
  V110_VERSION,
  V110_VOLUME
} from '../../docker/v110-upgrade.mjs';
import { normalizeOfficialRunnerImagesV19 } from '../../apps/api/src/state-migration-v19.mjs';

assert.equal(V110_VERSION, '1.10.0');
assert.equal(V110_SCHEMA, 19);
assert.equal(V110_VOLUME, 'aiws-data-v19');
assert.equal(
  inspectExecutionActivity({ node_runs: [], deliveries: [], workflow_executions: [], task_executions: [] }).active,
  false
);
const active = inspectExecutionActivity({
  node_runs: [{ id: 'run-1', status: 'running' }],
  deliveries: [],
  workflow_executions: [
    { id: 'wex-1', status: 'paused' },
    { id: 'wex-old', status: 'completed' }
  ],
  task_executions: [
    { id: 'tex-1', workflow_execution_id: 'wex-1', status: 'awaiting_human' },
    { id: 'tex-old', workflow_execution_id: 'wex-old', status: 'pending' }
  ]
});
assert.equal(active.active, true);
assert.deepEqual(
  active.records.map((item) => item.id),
  ['run-1', 'wex-1', 'tex-1']
);

const runnerState = {
  codex_profiles: [
    { id: 'official', image: 'aiws-codex-runner:1.9.0-codex-0.144.0' },
    { id: 'custom', image: 'registry.example/codex:1.9.0' }
  ],
  integration_statuses: [
    { key: 'codex_probe', profile_id: 'official', status: 'ready', updated_at: 'old' },
    { key: 'codex_probe', profile_id: 'custom', status: 'ready', updated_at: 'old' }
  ]
};
const runnerUpdate = normalizeOfficialRunnerImagesV19(runnerState, { timestamp: '2026-07-23T00:00:00.000Z' });
assert.equal(runnerUpdate.changed, true);
assert.deepEqual(runnerUpdate.profile_ids, ['official']);
assert.equal(runnerState.codex_profiles[0].image, 'aiws-codex-runner:1.10.0-codex-0.144.0');
assert.equal(runnerState.codex_profiles[1].image, 'registry.example/codex:1.9.0');
assert.deepEqual(
  runnerState.integration_statuses.map((item) => item.status),
  ['stale', 'ready']
);

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v110-release-'));
try {
  const statePath = path.join(probeRoot, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      ballast: 'x'.repeat(4 * 1024 * 1024),
      node_runs: [{ id: 'run-large', status: 'running' }],
      deliveries: [],
      workflow_executions: [],
      task_executions: []
    })
  );
  const probe = spawnSync(process.execPath, ['-e', executionActivityProbeScript(statePath)], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(probe.stdout.length < 256, `activity probe output must stay compact: ${probe.stdout.length}`);
  assert.deepEqual(JSON.parse(probe.stdout), {
    active: true,
    records: [{ type: 'node_run', id: 'run-large', status: 'running' }]
  });
} finally {
  fs.rmSync(probeRoot, { recursive: true, force: true });
}

assert.equal(
  assertOnlyAppReplaced({
    beforeRunning: ['app-old', 'db', 'gateway'],
    afterRunning: ['app-new', 'db', 'gateway'],
    oldAppId: 'app-old',
    newAppId: 'app-new'
  }),
  true
);
assert.equal(
  assertOnlyAppReplaced({
    beforeRunning: ['8a0d3cf55ab6', 'database'],
    afterRunning: ['c3e6d74970bc', 'database'],
    oldAppId: '8a0d3cf55ab60151f70acea0d938af69bc5e2d3e9ddff208b1c194fac4323b13',
    newAppId: 'c3e6d74970bcfde1eb3240cde507495f67c4a1fef38ca60070fa48f5699e977f'
  }),
  true
);
assert.throws(
  () =>
    assertOnlyAppReplaced({
      beforeRunning: ['app-old', 'gateway'],
      afterRunning: ['app-new'],
      oldAppId: 'app-old',
      newAppId: 'app-new'
    }),
  (error) => error.code === 'v110_unrelated_container_changed'
);
const source = fs.readFileSync('docker/v110-upgrade.mjs', 'utf8');
for (const value of [
  "compose(config, ['stop', '--timeout', '30', 'app'])",
  "['up', '-d', '--no-deps', '--force-recreate', 'app']",
  'backupVolume(config)',
  'migrateAndValidate(config)',
  'assertOnlyAppReplaced'
])
  assert.ok(source.includes(value), value);
console.log('V1.10 in-place volume backup and app-only replacement tests passed');
