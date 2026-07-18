import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v19-release-'));
process.env.AIWS_HOME = path.join(root, 'runtime-home');

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const migration = await import('../../apps/api/src/state-migration-v18.mjs');
  const release = await import('../../docker/release_volume.mjs');
  await stateApi.ensureRuntime();
  const sourceState = structuredClone(await stateApi.readState());
  sourceState.schema_version = 17;
  for (const collection of ['workflow_generations', 'workflow_generation_events', 'repository_connections', 'repository_targets', 'delivery_policies', 'deliveries', 'delivery_events', 'workflow_migration_batches', 'workflow_migration_jobs']) delete sourceState[collection];
  sourceState.codex_profiles[0].image = 'aiws-codex-runner:1.8.0-codex-0.144.0';
  const source = path.join(root, 'source'), target = path.join(root, 'target'), receipts = path.join(root, 'receipts');
  fs.mkdirSync(path.join(source, 'data'), { recursive: true }); fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(source, 'data', 'state.json'), `${JSON.stringify(sourceState, null, 2)}\n`);
  fs.cpSync(source, target, { recursive: true });
  const sourceBytes = fs.readFileSync(path.join(source, 'data', 'state.json'));
  const archiveSha = 'c'.repeat(64), cloneManifest = path.join(receipts, 'clone.manifest.json');
  const clone = await release.verifyClonedVolumeV19({ sourceRoot: source, targetRoot: target, manifestPath: cloneManifest, archiveSha256: archiveSha, clock: () => new Date('2026-07-18T02:00:00.000Z') });
  assert.equal(clone.source_volume, 'aiws-data-v18');
  assert.equal(clone.target_volume, 'aiws-data-v19');
  assert.equal(clone.source_state.schema_version, 17);

  const migrated = await migration.migrateStateFileToV18(path.join(target, 'data', 'state.json'), { clock: () => new Date('2026-07-18T02:01:00.000Z') });
  assert.equal(migrated.state.schema_version, 18);
  assert.equal(migrated.state.codex_profiles[0].image, 'aiws-codex-runner:1.9.0-codex-0.144.0');
  assert.equal(migrated.manifest.from_schema, 17);
  assert.equal(migrated.manifest.to_schema, 18);
  const accepted = await release.acceptVolumeMigrationV19({ mode: 'migrated', sourceRoot: source, targetRoot: target, cloneManifestPath: cloneManifest, archiveSha256: archiveSha, migrationVolume: 'v19-migration-test' });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.target_state.schema_version, 18);
  assert.equal(accepted.schema_migration.from_schema, 17);
  assert.equal(accepted.schema_migration.to_schema, 18);
  assert.equal(fs.readFileSync(path.join(source, 'data', 'state.json')).equals(sourceBytes), true, 'schema 17 source remains byte-for-byte unchanged');
  const checked = await release.validateV19ReleaseTarget(target);
  assert.equal(checked.schema_version, 18);
  assert.equal(checked.legacy_runner_references.length, 0);

  const compose = fs.readFileSync('compose.yml', 'utf8');
  for (const value of ['name: aiws-v19', 'aiws-app:1.9.0', 'aiws-codex-runner:1.9.0-codex-0.144.0', 'aiws-data-v19']) assert.ok(compose.includes(value), value);
  for (const script of ['scripts/aiws.ps1', 'scripts/aiws.sh']) {
    const text = fs.readFileSync(script, 'utf8');
    for (const value of ['aiws-data-v18', 'aiws-data-v19', 'aiws-app:1.9.0', 'aiws-codex-runner:1.9.0-codex-0.144.0', 'v19-release.mjs']) assert.ok(text.includes(value), `${script}: ${value}`);
  }
  const orchestrator = fs.readFileSync('docker/release_orchestrator.mjs', 'utf8');
  assert.ok(orchestrator.includes("RELEASE_V19 ? 18"));
  assert.ok(orchestrator.includes('health.version !== RELEASE_VERSION'));
  assert.ok(orchestrator.includes('health.schema_version !== RELEASE_SCHEMA'));

  console.log('V1.9 release volume flow tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
