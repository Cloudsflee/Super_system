import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v20-volume-flow-'));
const source = path.join(root, 'aiws-data-v19');
const target = path.join(root, 'aiws-data-v20');
const migrationVolume = path.join(root, 'migration-volume');
process.env.AIWS_HOME = target;
process.env.AIWS_CONTEXT_REPOSITORY_FILE_LIMIT = '0';

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const { CONTEXT_INTERNAL_COLLECTIONS } = await import('../../packages/system-context/src/index.mjs');
  const { validateState19 } = await import('../../apps/api/src/state-migration-v19.mjs');
  const contextService = await import('../../apps/api/src/context-service.mjs');
  const release = await import('../../docker/release_volume.mjs');
  const { findLegacyRunnerReferencesV20 } = await import('../../docker/release-volume-validation.mjs');

  await stateApi.ensureRuntime();
  const sourceState = structuredClone(await stateApi.readState());
  sourceState.schema_version = 19;
  delete sourceState.context_projection_coverage;
  delete sourceState.migrated_to_schema_20_at;
  for (const collection of CONTEXT_INTERNAL_COLLECTIONS) delete sourceState[collection];
  for (const profile of sourceState.codex_profiles || []) {
    if (profile.image) profile.image = 'aiws-codex-runner:1.10.0-codex-0.144.0';
    if (profile.config?.image) profile.config.image = 'aiws-codex-runner:1.10.0-codex-0.144.0';
  }
  sourceState.integration_statuses.push({
    key: 'codex_docker',
    status: 'ready',
    image: 'aiws-codex-runner:1.10.0-codex-0.144.0',
    updated_at: '2026-07-26T00:00:00.000Z'
  });
  validateState19(sourceState);

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.mkdirSync(path.join(source, 'vault'), { recursive: true });
  fs.mkdirSync(migrationVolume, { recursive: true });
  fs.writeFileSync(path.join(source, 'data', 'state.json'), `${JSON.stringify(sourceState, null, 2)}\n`);
  fs.writeFileSync(path.join(source, 'vault', 'credential.enc'), 'encrypted-v19-preserved');
  fs.cpSync(source, target, { recursive: true });

  const sourceBytes = fs.readFileSync(path.join(source, 'data', 'state.json'));
  const sourceInventory = await release.volumeInventory(source);
  const archiveSha256 = 'd'.repeat(64);
  const cloneManifestPath = path.join(migrationVolume, 'clone.manifest.json');
  const clone = await release.verifyClonedVolumeV20({
    sourceRoot: source,
    targetRoot: target,
    manifestPath: cloneManifestPath,
    archiveSha256,
    clock: () => new Date('2026-07-26T01:00:00.000Z')
  });
  assert.equal(clone.migration, 'aiws-volume-v19-to-v20');
  assert.equal(clone.source_volume, 'aiws-data-v19');
  assert.equal(clone.target_volume, 'aiws-data-v20');
  assert.equal(clone.source_state.schema_version, 19);

  await stateApi.ensureRuntime();
  const migrated = await stateApi.readState();
  const ownerId = migrated.instance_owner_user_id || migrated.users.find((item) => item.role === 'owner').id;
  const req = {
    headers: { 'x-aiws-user-id': ownerId },
    auth: { scopes: ['context:admin'] }
  };
  const rebuilt = await contextService.rebuildContext({ req });
  assert.equal(rebuilt.index.state, 'ready');
  const migratedState = await stateApi.readState();
  assert.equal(migratedState.schema_version, 20);
  assert.ok(migratedState.context_nodes.length > 0);
  assert.equal(
    migratedState.context_nodes.filter((node) => node.status === 'active' && !node.current_version_id).length,
    0
  );
  assert.equal(migratedState.context_projection_coverage.warnings.length, 0);
  assert.equal(
    migratedState.integration_statuses.find((item) => item.key === 'codex_docker').image,
    'aiws-codex-runner:2.0.0-codex-0.144.0'
  );
  for (const version of migratedState.context_document_versions)
    assert.ok(
      fs.existsSync(path.join(target, 'cas', ...version.cas_ref.storage_path.split('/'))),
      `missing context CAS ${version.id}: ${version.cas_ref.storage_path}`
    );

  const accepted = await release.acceptVolumeMigrationV20({
    sourceRoot: source,
    targetRoot: target,
    cloneManifestPath,
    archiveSha256,
    migrationVolume: 'aiws-v20-migration-test',
    clock: () => new Date('2026-07-26T01:05:00.000Z')
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.source_preserved, true);
  assert.equal(accepted.target_state.schema_version, 20);
  assert.equal(accepted.schema_migration.from_schema, 19);
  assert.equal(accepted.schema_migration.to_schema, 20);
  assert.equal(accepted.projection.warnings, 0);
  assert.equal(accepted.projection.active_nodes, accepted.projection.current_documents);
  assert.equal((await release.validateV20ReleaseTarget(target)).schema_version, 20);
  assert.equal(fs.readFileSync(path.join(source, 'data', 'state.json')).equals(sourceBytes), true);
  assert.equal((await release.volumeInventory(source)).hash, sourceInventory.hash);
  assert.equal(fs.readFileSync(path.join(source, 'vault', 'credential.enc'), 'utf8'), 'encrypted-v19-preserved');

  const indexFile = path.join(target, 'data', '.context-index', 'minisearch-v1.json');
  const indexBytes = fs.readFileSync(indexFile);
  fs.writeFileSync(indexFile, '{"schema_version":"broken"}');
  await assert.rejects(
    () => release.validateV20ReleaseTarget(target),
    (error) => error.code === 'context_index_snapshot_invalid'
  );
  fs.writeFileSync(indexFile, indexBytes);

  const historical = structuredClone(migratedState);
  historical.execution_events.push({ id: 'history', image: 'aiws-codex-runner:1.10.0-codex-0.144.0' });
  assert.deepEqual(findLegacyRunnerReferencesV20(historical), []);

  const compose = fs.readFileSync('compose.yml', 'utf8');
  for (const value of ['name: aiws-v20', 'aiws-app:2.0.0', 'aiws-codex-runner:2.0.0-codex-0.144.0', 'aiws-data-v20'])
    assert.ok(compose.includes(value), value);
  const upgrade = fs.readFileSync('docker/v20-upgrade.mjs', 'utf8');
  for (const value of [
    'type=volume,src=${config.sourceVolume},dst=/source,readonly',
    'clone-verify-v20',
    'migrateAndBuildContext(config)',
    'accept-v20',
    "compose(config, ['down', '--remove-orphans']",
    'restartContainers(context.stopped_v110_containers)',
    "status: 'failed_v20_stopped_v110_restored'"
  ])
    assert.ok(upgrade.includes(value), value);
  assert.equal(upgrade.includes("volume', 'rm', config.sourceVolume"), false);

  console.log('V2.0 read-only clone, projection acceptance, source retention, and rollback tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
