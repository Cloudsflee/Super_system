import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emptyState } from '../../apps/api/src/state.mjs';
import { materializeContextDocumentsInState } from '../../apps/api/src/context-projection.mjs';
import {
  migrateState19To20,
  normalizeState20Defaults,
  validateState20
} from '../../apps/api/src/state-migration-v20.mjs';
import { migrateStateFileToV21, validateState21 } from '../../apps/api/src/state-migration-v21.mjs';
import { contextIndexableNodes, contextSearchIndexSnapshotHash } from '../../packages/system-context/src/index.mjs';
import { findLegacyRunnerReferencesV21 } from '../../docker/release-volume-validation.mjs';
import {
  V21_HEALTH_POLL_MS,
  V21_HEALTH_REQUEST_TIMEOUT_MS,
  V21_HEALTH_WAIT_MS,
  isV21UpgradeError,
  v21RollbackAccepted
} from '../../docker/v21-upgrade.mjs';
import * as release from '../../docker/release_volume.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v21-volume-flow-')),
  source = path.join(root, 'aiws-data-v20'),
  target = path.join(root, 'aiws-data-v21'),
  migrationVolume = path.join(root, 'migration-volume');

try {
  const healthyRollback = { status: 'ok', version: '2.1.0', schema_version: 21 };
  assert.equal(v21RollbackAccepted(['container-1'], healthyRollback), true);
  assert.equal(v21RollbackAccepted([], healthyRollback), false);
  assert.equal(v21RollbackAccepted(['container-1'], { error_code: 'v21_health_check_failed' }), false);
  assert.equal(isV21UpgradeError({ code: 'v21_health_check_failed' }), true);
  assert.equal(isV21UpgradeError({ code: 23 }), false);
  assert.equal(V21_HEALTH_WAIT_MS, 600_000);
  assert.equal(V21_HEALTH_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(V21_HEALTH_POLL_MS, 2000);

  const sourceState = emptyState();
  sourceState.schema_version = 20;
  delete sourceState.migrated_to_schema_21_at;
  delete sourceState.migrated_to_schema_22_at;
  for (const collection of [
    'outcome_requirements',
    'outcome_evaluations',
    'outcome_waivers',
    'execution_stage_checkpoints'
  ])
    delete sourceState[collection];
  normalizeState20Defaults(sourceState, '2026-07-30T00:00:00.000Z');
  validateState20(sourceState);

  fs.mkdirSync(path.join(source, 'data', '.context-index'), { recursive: true });
  fs.mkdirSync(path.join(source, 'vault'), { recursive: true });
  fs.mkdirSync(migrationVolume, { recursive: true });
  fs.writeFileSync(path.join(source, 'data', 'state.json'), `${JSON.stringify(sourceState, null, 2)}\n`);
  fs.writeFileSync(
    path.join(source, 'data', '.context-index', 'minisearch-v1.json'),
    '{"schema_version":"legacy-v20-index"}'
  );
  fs.writeFileSync(path.join(source, 'vault', 'credential.enc'), 'encrypted-v20-preserved');
  fs.cpSync(source, target, { recursive: true });

  const sourceBytes = fs.readFileSync(path.join(source, 'data', 'state.json')),
    sourceInventory = await release.volumeInventory(source),
    archiveSha256 = 'e'.repeat(64),
    cloneManifestPath = path.join(migrationVolume, 'clone.manifest.json'),
    clone = await release.verifyClonedVolumeV21({
      sourceRoot: source,
      targetRoot: target,
      manifestPath: cloneManifestPath,
      archiveSha256,
      clock: () => new Date('2026-07-30T01:00:00.000Z')
    });
  assert.equal(clone.migration, 'aiws-volume-v20-to-v21');
  assert.equal(clone.source_volume, 'aiws-data-v20');
  assert.equal(clone.target_volume, 'aiws-data-v21');

  const stateFile = path.join(target, 'data', 'state.json'),
    migration = await migrateStateFileToV21(stateFile, {
      clock: () => new Date('2026-07-30T01:01:00.000Z')
    }),
    migrated = migration.state;
  await materializeContextDocumentsInState(migrated, {
    maxJobs: 10_000,
    casRoot: path.join(target, 'cas')
  });
  validateState21(migrated);
  fs.writeFileSync(stateFile, `${JSON.stringify(migrated, null, 2)}\n`);
  writeLegacyIndex(target, migrated);

  const accepted = await release.acceptVolumeMigrationV21({
    sourceRoot: source,
    targetRoot: target,
    cloneManifestPath,
    archiveSha256,
    migrationVolume: 'aiws-v21-migration-test',
    clock: () => new Date('2026-07-30T01:05:00.000Z')
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.source_preserved, true);
  assert.equal(accepted.target_state.schema_version, 21);
  assert.equal(accepted.schema_migration.from_schema, 20);
  assert.equal(accepted.schema_migration.to_schema, 21);
  assert.equal(accepted.projection.warnings, 0);
  assert.equal((await release.validateV21ReleaseTarget(target)).schema_version, 21);
  assert.equal(fs.readFileSync(path.join(source, 'data', 'state.json')).equals(sourceBytes), true);
  assert.equal((await release.volumeInventory(source)).hash, sourceInventory.hash);
  assert.equal(fs.readFileSync(path.join(source, 'vault', 'credential.enc'), 'utf8'), 'encrypted-v20-preserved');

  const indexFile = path.join(target, 'data', '.context-index', 'minisearch-v1.json'),
    indexBytes = fs.readFileSync(indexFile);
  fs.writeFileSync(indexFile, '{"schema_version":"broken"}');
  await assert.rejects(
    () => release.validateV21ReleaseTarget(target),
    (error) => error.code === 'context_index_snapshot_invalid'
  );
  assert.equal(
    (await release.validateV21ReleaseTarget(target, 'aiws-data-v21', { deferProjection: true })).accepted,
    true
  );
  fs.writeFileSync(indexFile, indexBytes);

  const historical = structuredClone(migrated);
  historical.execution_events.push({ id: 'historical-runner-image', image: 'aiws-codex-runner:2.0.0-codex-0.144.0' });
  assert.deepEqual(findLegacyRunnerReferencesV21(historical), []);
  assert.throws(
    () => migrateState19To20(migrated),
    (error) => error.code === 'state_schema_newer_than_runtime'
  );

  const compose = fs.readFileSync('compose.yml', 'utf8');
  for (const value of [
    'name: aiws-v22',
    'aiws-app:2.2.0',
    'aiws-codex-runner:2.2.0-codex-0.144.0',
    'aiws-data-v22',
    'NODE_OPTIONS: "--max-old-space-size=4096"',
    'timeout: 30s',
    'start_period: 5m'
  ])
    assert.ok(compose.includes(value), value);
  const upgrade = fs.readFileSync('docker/v21-upgrade.mjs', 'utf8');
  for (const value of [
    'type=volume,src=${config.sourceVolume},dst=/source,readonly',
    'clone-verify-v21',
    'migrateAndBuildContext(config)',
    'accept-v21',
    'restorePreviousV21(config, context)',
    'v21RollbackAccepted(restarted, health)',
    'restartContainers(context.stopped_v20_containers)'
  ])
    assert.ok(upgrade.includes(value), value);
  assert.equal(upgrade.includes("volume', 'rm', config.sourceVolume"), false);

  console.log('V2.1 read-only clone, Outcome/Context acceptance, source retention, and rollback tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeLegacyIndex(targetRoot, state) {
  const nodes = contextIndexableNodes(state.context_nodes),
    payload = {
      schema_version: 'aiws.context_index.v1',
      snapshot_hash: contextSearchIndexSnapshotHash(nodes),
      rebuilt_at: '2026-07-30T01:04:00.000Z',
      index: { fixture: true }
    };
  fs.mkdirSync(path.join(targetRoot, 'data', '.context-index'), { recursive: true });
  fs.writeFileSync(
    path.join(targetRoot, 'data', '.context-index', 'minisearch-v1.json'),
    `${JSON.stringify(payload)}\n`
  );
}
