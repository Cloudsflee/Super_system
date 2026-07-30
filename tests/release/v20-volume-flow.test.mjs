import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  const {
    CONTEXT_INTERNAL_COLLECTIONS,
    buildContextSearchIndex,
    contextIndexableNodes,
    reconcileContextProjectionState,
    serializeContextSearchIndex
  } = await import('../../packages/system-context/src/index.mjs');
  const { validateState19 } = await import('../../apps/api/src/state-migration-v19.mjs');
  const { V20_SOURCE_COLLECTIONS, migrateStateFileToV20, validateState20 } =
    await import('../../apps/api/src/state-migration-v20.mjs');
  const { materializeContextDocumentsInState } = await import('../../apps/api/src/context-projection.mjs');
  const release = await import('../../docker/release_volume.mjs');
  const { v20RollbackAccepted } = await import('../../docker/v20-upgrade.mjs');
  const { findLegacyRunnerReferencesV20 } = await import('../../docker/release-volume-validation.mjs');

  const healthyRollback = { status: 'ok', version: '2.0.0', schema_version: 20 };
  assert.equal(v20RollbackAccepted(['container-1'], healthyRollback), true);
  assert.equal(v20RollbackAccepted([], healthyRollback), false);
  assert.equal(v20RollbackAccepted(['container-1'], { error_code: 'v20_health_check_failed' }), false);

  await stateApi.ensureRuntime();
  const sourceState = structuredClone(await stateApi.readState());
  sourceState.schema_version = 19;
  delete sourceState.context_projection_coverage;
  delete sourceState.migrated_to_schema_20_at;
  for (const collection of [
    'outcome_requirements',
    'outcome_evaluations',
    'outcome_waivers',
    'execution_stage_checkpoints'
  ])
    delete sourceState[collection];
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

  const targetStateFile = path.join(target, 'data', 'state.json');
  await migrateStateFileToV20(targetStateFile, { clock: () => new Date('2026-07-26T01:01:00.000Z') });
  const rebuilt = await rebuildV20Context(target, {
    V20_SOURCE_COLLECTIONS,
    buildContextSearchIndex,
    contextIndexableNodes,
    materializeContextDocumentsInState,
    reconcileContextProjectionState,
    serializeContextSearchIndex,
    validateState20
  });
  assert.equal(rebuilt.index.state, 'ready');
  const migratedState = JSON.parse(fs.readFileSync(targetStateFile, 'utf8'));
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

  await mutateV20State(
    targetStateFile,
    { V20_SOURCE_COLLECTIONS, reconcileContextProjectionState, validateState20 },
    (state) => {
      const user = state.users[0];
      user.display_name = `${user.display_name} refreshed`;
      user.updated_at = '2026-07-26T01:06:00.000Z';
    }
  );
  await assert.rejects(() => release.validateV20ReleaseTarget(target));
  const deferred = await release.validateV20ReleaseTarget(target, 'aiws-data-v20', { deferProjection: true });
  assert.equal(deferred.accepted, true);
  assert.deepEqual(deferred.projection, { deferred: true, reason: 'release_refresh_required' });
  await rebuildV20Context(target, {
    V20_SOURCE_COLLECTIONS,
    buildContextSearchIndex,
    contextIndexableNodes,
    materializeContextDocumentsInState,
    reconcileContextProjectionState,
    serializeContextSearchIndex,
    validateState20
  });
  assert.equal((await release.validateV20ReleaseTarget(target)).projection.warnings, 0);

  const indexFile = path.join(target, 'data', '.context-index', 'minisearch-v1.json');
  const indexBytes = fs.readFileSync(indexFile);
  fs.writeFileSync(indexFile, '{"schema_version":"broken"}');
  await assert.rejects(
    () => release.validateV20ReleaseTarget(target),
    (error) => error.code === 'context_index_snapshot_invalid'
  );
  assert.equal(
    (await release.validateV20ReleaseTarget(target, 'aiws-data-v20', { deferProjection: true })).accepted,
    true
  );
  fs.writeFileSync(indexFile, indexBytes);

  const historical = structuredClone(migratedState);
  historical.execution_events.push({ id: 'history', image: 'aiws-codex-runner:1.10.0-codex-0.144.0' });
  assert.deepEqual(findLegacyRunnerReferencesV20(historical), []);

  const compose = fs.readFileSync('compose.yml', 'utf8');
  for (const value of ['name: aiws-v21', 'aiws-app:2.1.0', 'aiws-codex-runner:2.1.0-codex-0.144.0', 'aiws-data-v21'])
    assert.ok(compose.includes(value), value);
  const upgrade = fs.readFileSync('docker/v20-upgrade.mjs', 'utf8');
  for (const value of [
    'type=volume,src=${config.sourceVolume},dst=/source,readonly',
    'clone-verify-v20',
    'migrateAndBuildContext(config)',
    'maxBuffer: COMMAND_MAX_BUFFER_BYTES',
    'accept-v20',
    "compose(config, ['down', '--remove-orphans']",
    'checkAcceptedTarget(config, { deferProjection: true })',
    'waitForQuiescence(config, config.targetVolume)',
    'context.stopped_v20_containers = stopProjectApps(config.projectName)',
    'context.refresh = migrateAndBuildContext(config)',
    "'--rollback-image': 'rollbackImage'",
    "['container', 'commit', container.id, tag]",
    "['stop', '--timeout', '30', id]",
    'restorePreviousV20(config, context)',
    'v20RollbackAccepted(restarted, health)',
    "if (!restored) compose(config, ['down', '--remove-orphans']",
    'restartContainers(context.stopped_v110_containers)',
    "'failed_previous_v20_restored'",
    "'failed_previous_v20_unchanged'",
    "'failed_v20_stopped_v110_restored'"
  ])
    assert.ok(upgrade.includes(value), value);
  assert.equal(upgrade.includes("volume', 'rm', config.sourceVolume"), false);
  for (const script of ['scripts/aiws.ps1', 'scripts/aiws.sh']) {
    const source = fs.readFileSync(script, 'utf8');
    assert.ok(source.includes('AIWS_ROLLBACK_IMAGE'), `${script} rollback image override`);
    assert.ok(source.includes('--rollback-image'), `${script} rollback image handoff`);
    assert.ok(source.includes('docker image tag'), `${script} rollback image preservation`);
  }
  const posix = fs.readFileSync('scripts/aiws.sh', 'utf8'),
    rollbackFunction = posix.slice(
      posix.indexOf('preserve_rollback_image() {'),
      posix.indexOf('\nbuild_verify_image()', posix.indexOf('preserve_rollback_image() {'))
    ),
    firstInstallProbe = spawnSync('bash', [], {
      input: `set -e\ndocker() { return 0; }\n${rollbackFunction}\nrollback_image=$(preserve_rollback_image)\nprintf 'continued'\n`,
      encoding: 'utf8'
    });
  assert.equal(firstInstallProbe.status, 0, firstInstallProbe.stderr);
  assert.equal(firstInstallProbe.stdout, 'continued');

  console.log('V2.0 read-only clone, projection acceptance, source retention, and rollback tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function rebuildV20Context(
  targetRoot,
  {
    V20_SOURCE_COLLECTIONS,
    buildContextSearchIndex,
    contextIndexableNodes,
    materializeContextDocumentsInState,
    reconcileContextProjectionState,
    serializeContextSearchIndex,
    validateState20
  }
) {
  const stateFile = path.join(targetRoot, 'data', 'state.json'),
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    timestamp = new Date().toISOString();
  reconcileContextProjectionState(state, { sourceCollections: V20_SOURCE_COLLECTIONS, timestamp, force: true });
  const projection = await materializeContextDocumentsInState(state, {
    force: true,
    casRoot: path.join(targetRoot, 'cas')
  });
  assert.equal(projection.failed, 0, JSON.stringify(projection.failures));
  validateState20(state);
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const nodes = contextIndexableNodes(state.context_nodes),
    built = await buildContextSearchIndex({
      nodes: state.context_nodes,
      documentVersions: state.context_document_versions,
      edges: state.context_edges,
      readDocument: (version) =>
        fs.promises.readFile(path.join(targetRoot, 'cas', ...version.cas_ref.storage_path.split('/')), 'utf8')
    }),
    rebuiltAt = new Date().toISOString(),
    payload = serializeContextSearchIndex(built.index, {
      snapshotHash: built.snapshot_hash,
      rebuiltAt
    }),
    indexDirectory = path.join(targetRoot, 'data', '.context-index');
  fs.mkdirSync(indexDirectory, { recursive: true });
  fs.writeFileSync(path.join(indexDirectory, 'minisearch-v1.json'), JSON.stringify(payload));
  return {
    projection,
    index: {
      state: 'ready',
      snapshot_hash: built.snapshot_hash,
      node_count: nodes.length,
      rebuilt_at: rebuiltAt,
      error_code: null
    }
  };
}

async function mutateV20State(
  stateFile,
  { V20_SOURCE_COLLECTIONS, reconcileContextProjectionState, validateState20 },
  apply
) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await apply(state);
  reconcileContextProjectionState(state, {
    sourceCollections: V20_SOURCE_COLLECTIONS,
    timestamp: new Date().toISOString()
  });
  validateState20(state);
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}
