import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-release-'));
process.env.AIWS_HOME = path.join(root, 'runtime-home');

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const migration = await import('../../apps/api/src/state-migration-v17.mjs');
  const release = await import('../../docker/release_volume.mjs');
  const sparseLegacy = migration.migrateState16To17({ schema_version: 12 });
  assert.equal(sparseLegacy.state.schema_version, 17);
  assert.deepEqual(sparseLegacy.state.mcp_clients, []);
  await stateApi.ensureRuntime();
  const sourceState = structuredClone(await stateApi.readState());
  sourceState.schema_version = 16;
  delete sourceState.mcp_clients;
  sourceState.codex_profiles[0].image = 'aiws-codex-runner:1.7.0-codex-0.144.0';
  const source = path.join(root, 'source'),
    target = path.join(root, 'target'),
    receipts = path.join(root, 'receipts');
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(source, 'data', 'state.json'), `${JSON.stringify(sourceState, null, 2)}\n`);
  fs.cpSync(source, target, { recursive: true });
  const sourceBytes = fs.readFileSync(path.join(source, 'data', 'state.json'));
  const archiveSha = 'a'.repeat(64),
    cloneManifest = path.join(receipts, 'clone.manifest.json');
  const clone = await release.verifyClonedVolumeV18({
    sourceRoot: source,
    targetRoot: target,
    manifestPath: cloneManifest,
    archiveSha256: archiveSha,
    clock: () => new Date('2026-07-17T02:00:00.000Z')
  });
  assert.equal(clone.source_volume, 'aiws-data-v17');
  assert.equal(clone.target_volume, 'aiws-data-v18');

  const migrated = await migration.migrateStateFileToV17(path.join(target, 'data', 'state.json'), {
    clock: () => new Date('2026-07-17T02:01:00.000Z')
  });
  assert.equal(migrated.state.schema_version, 17);
  assert.deepEqual(migrated.state.mcp_clients, []);
  assert.equal(migrated.state.codex_profiles[0].image, 'aiws-codex-runner:1.8.0-codex-0.144.0');
  const accepted = await release.acceptVolumeMigrationV18({
    mode: 'migrated',
    sourceRoot: source,
    targetRoot: target,
    cloneManifestPath: cloneManifest,
    archiveSha256: archiveSha,
    migrationVolume: 'v18-migration-test'
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.target_state.schema_version, 17);
  assert.equal(accepted.schema_migration.from_schema, 16);
  assert.equal(accepted.schema_migration.to_schema, 17);
  assert.equal(
    fs.readFileSync(path.join(source, 'data', 'state.json')).equals(sourceBytes),
    true,
    'schema 16 source remains byte-for-byte unchanged'
  );
  const checked = await release.validateV18ReleaseTarget(target);
  assert.equal(checked.schema_version, 17);
  assert.equal(checked.core_counts.mcp_clients, 0);

  const compose = fs.readFileSync('compose.yml', 'utf8');
  for (const value of ['name: aiws-v22', 'aiws-app:2.2.0', 'aiws-codex-runner:2.2.0-codex-0.144.0', 'aiws-data-v22'])
    assert.ok(compose.includes(value));
  for (const script of ['scripts/aiws.ps1', 'scripts/aiws.sh']) {
    const sourceText = fs.readFileSync(script, 'utf8');
    for (const value of [
      'aiws-data-v21',
      'aiws-data-v22',
      'aiws-app:2.2.0',
      'aiws-codex-runner:2.2.0-codex-0.144.0',
      'v22-release.mjs'
    ])
      assert.ok(sourceText.includes(value), `${script} ${value}`);
    assert.equal(sourceText.includes('aiws-data-v20'), false, `${script} only uses the immediate V2.1 source`);
  }
  const orchestrator = fs.readFileSync('docker/release_orchestrator.mjs', 'utf8');
  assert.ok(orchestrator.includes('health.version !== RELEASE_VERSION'));
  assert.ok(orchestrator.includes('health.schema_version !== RELEASE_SCHEMA'));
  await stateApi.checkpointAndCloseState();
  console.log('V1.8 release volume unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
