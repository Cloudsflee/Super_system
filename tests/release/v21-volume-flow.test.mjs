import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v21-volume-flow-')),
  source = path.join(root, 'aiws-data-v20'),
  target = path.join(root, 'aiws-data-v21'),
  migrationVolume = path.join(root, 'migration-volume');
process.env.AIWS_HOME = target;
process.env.AIWS_CONTEXT_REPOSITORY_FILE_LIMIT = '0';

try {
  const stateApi = await import('../../apps/api/src/state.mjs'),
    { migrateState19To20, normalizeState20Defaults, validateState20 } =
      await import('../../apps/api/src/state-migration-v20.mjs'),
    contextService = await import('../../apps/api/src/context-service.mjs'),
    release = await import('../../docker/release_volume.mjs'),
    { isV21UpgradeError, V21_HEALTH_POLL_MS, V21_HEALTH_REQUEST_TIMEOUT_MS, V21_HEALTH_WAIT_MS, v21RollbackAccepted } =
      await import('../../docker/v21-upgrade.mjs'),
    { findLegacyRunnerReferencesV21 } = await import('../../docker/release-volume-validation.mjs');

  const healthyRollback = { status: 'ok', version: '2.1.0', schema_version: 21 };
  assert.equal(v21RollbackAccepted(['container-1'], healthyRollback), true);
  assert.equal(v21RollbackAccepted([], healthyRollback), false);
  assert.equal(v21RollbackAccepted(['container-1'], { error_code: 'v21_health_check_failed' }), false);
  assert.equal(isV21UpgradeError({ code: 'v21_health_check_failed' }), true);
  assert.equal(isV21UpgradeError({ code: 23 }), false);
  assert.equal(isV21UpgradeError({}), false);
  assert.equal(V21_HEALTH_WAIT_MS, 600_000);
  assert.equal(V21_HEALTH_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(V21_HEALTH_POLL_MS, 2000);

  await stateApi.ensureRuntime();
  const sourceState = structuredClone(await stateApi.readState());
  sourceState.schema_version = 20;
  delete sourceState.migrated_to_schema_21_at;
  for (const collection of [
    'outcome_requirements',
    'outcome_evaluations',
    'outcome_waivers',
    'execution_stage_checkpoints'
  ])
    delete sourceState[collection];
  seedSchema20Executions(sourceState);
  for (const profile of sourceState.codex_profiles || []) {
    if (profile.image) profile.image = 'aiws-codex-runner:2.0.0-codex-0.144.0';
    if (profile.config?.image) profile.config.image = 'aiws-codex-runner:2.0.0-codex-0.144.0';
  }
  const integration = sourceState.integration_statuses.find((item) => item.key === 'codex_docker');
  if (integration) integration.image = 'aiws-codex-runner:2.0.0-codex-0.144.0';
  else
    sourceState.integration_statuses.push({
      key: 'codex_docker',
      status: 'ready',
      image: 'aiws-codex-runner:2.0.0-codex-0.144.0',
      updated_at: '2026-07-30T00:00:00.000Z'
    });
  normalizeState20Defaults(sourceState, '2026-07-30T00:00:00.000Z');
  validateState20(sourceState);

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
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
  assert.equal(clone.source_state.schema_version, 20);

  await stateApi.ensureRuntime();
  const migrated = await stateApi.readState(),
    ownerId = migrated.instance_owner_user_id || migrated.users.find((item) => item.role === 'owner').id,
    request = {
      headers: { 'x-aiws-user-id': ownerId },
      auth: { scopes: ['context:admin'] }
    };
  assert.equal(migrated.schema_version, 21);
  assert.equal(
    migrated.workflow_executions.find((item) => item.id === 'wex-v20-terminal').completion_status,
    'legacy_unassessed'
  );
  const active = migrated.workflow_executions.find((item) => item.id === 'wex-v20-active');
  assert.equal(active.completion_status, 'pending');
  assert.equal(active.outcome_contract_source, 'legacy_derived');
  assert.equal(
    migrated.outcome_requirements.some(
      (item) => item.workflow_execution_id === active.id && item.evaluator === 'manual_review' && item.mandatory
    ),
    true
  );
  assert.equal(
    migrated.codex_profiles.every((item) => !item.image || item.image === 'aiws-codex-runner:2.1.0-codex-0.144.0'),
    true
  );

  const rebuilt = await contextService.rebuildContext({ req: request });
  assert.equal(rebuilt.index.state, 'ready');
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
  assert.ok(accepted.preservation.allowed_changed_paths.includes('data/.context-index/minisearch-v1.json'));
  assert.equal(accepted.target_state.schema_version, 21);
  assert.equal(accepted.schema_migration.from_schema, 20);
  assert.equal(accepted.schema_migration.to_schema, 21);
  assert.equal(accepted.projection.warnings, 0);
  assert.equal(accepted.outcomes.legacy_unassessed, 1);
  assert.equal(accepted.outcomes.active_with_contract, 1);
  assert.ok(accepted.outcomes.requirements >= 1);
  assert.equal((await release.validateV21ReleaseTarget(target)).schema_version, 21);
  assert.equal(fs.readFileSync(path.join(source, 'data', 'state.json')).equals(sourceBytes), true);
  assert.equal((await release.volumeInventory(source)).hash, sourceInventory.hash);
  assert.equal(fs.readFileSync(path.join(source, 'vault', 'credential.enc'), 'utf8'), 'encrypted-v20-preserved');

  await stateApi.mutate((state) => {
    const user = state.users[0];
    user.display_name = `${user.display_name} refreshed`;
    user.updated_at = '2026-07-30T01:06:00.000Z';
  });
  await assert.rejects(() => release.validateV21ReleaseTarget(target));
  const deferred = await release.validateV21ReleaseTarget(target, 'aiws-data-v21', { deferProjection: true });
  assert.equal(deferred.accepted, true);
  assert.deepEqual(deferred.projection, { deferred: true, reason: 'release_refresh_required' });
  await contextService.rebuildContext({ req: request });
  assert.equal((await release.validateV21ReleaseTarget(target)).projection.warnings, 0);

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

  const historical = structuredClone(await stateApi.readState());
  historical.execution_events.push({ id: 'historical-runner-image', image: 'aiws-codex-runner:2.0.0-codex-0.144.0' });
  assert.deepEqual(findLegacyRunnerReferencesV21(historical), []);
  const activeLegacyRunner = structuredClone(historical);
  activeLegacyRunner.codex_profiles[0].image = 'aiws-codex-runner:2.0.0-codex-0.144.0';
  assert.equal(findLegacyRunnerReferencesV21(activeLegacyRunner).length, 1);

  assert.throws(
    () => migrateState19To20(awaitedState(stateApi)),
    (error) => error.code === 'state_schema_newer_than_runtime'
  );

  const compose = fs.readFileSync('compose.yml', 'utf8');
  for (const value of [
    'name: aiws-v21',
    'aiws-app:2.1.0',
    'aiws-codex-runner:2.1.0-codex-0.144.0',
    'aiws-data-v21',
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
    'maxBuffer: COMMAND_MAX_BUFFER_BYTES',
    'accept-v21',
    "compose(config, ['down', '--remove-orphans']",
    'checkAcceptedTarget(config, { deferProjection: true })',
    'waitForQuiescence(config, config.targetVolume)',
    'context.stopped_v21_containers = stopProjectApps(config.projectName)',
    'context.refresh = migrateAndBuildContext(config)',
    "'--rollback-image': 'rollbackImage'",
    "['container', 'commit', container.id, tag]",
    'restorePreviousV21(config, context)',
    'v21RollbackAccepted(restarted, health)',
    'restartContainers(context.stopped_v20_containers)',
    "'failed_previous_v21_restored'",
    "'failed_previous_v21_unchanged'",
    "'failed_v21_stopped_v20_restored'"
  ])
    assert.ok(upgrade.includes(value), value);
  assert.equal(upgrade.includes("volume', 'rm', config.sourceVolume"), false);

  console.log('V2.1 read-only clone, Outcome/Context acceptance, source retention, and rollback tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function seedSchema20Executions(state) {
  const ownerId = state.instance_owner_user_id || state.users[0].id,
    timestamp = '2026-07-30T00:00:00.000Z';
  state.projects.push({
    id: 'project-v20-source',
    title: 'V2.0 source fixture',
    status: 'active',
    owner_user_id: ownerId,
    created_by_user_id: ownerId,
    lifecycle_operation: null,
    deleted_at: null
  });
  state.project_memberships.push({
    id: 'membership-v20-source',
    project_id: 'project-v20-source',
    user_id: ownerId,
    role: 'owner',
    status: 'active'
  });
  state.workflows.push({
    id: 'workflow-v20-source',
    project_id: 'project-v20-source',
    title: 'Historical V2.0 workflow',
    status: 'active',
    workflow_revision: 1,
    version: 1,
    created_at: timestamp,
    updated_at: timestamp
  });
  state.workflow_executions.push(
    {
      id: 'wex-v20-terminal',
      project_id: 'project-v20-source',
      workflow_id: 'workflow-v20-source',
      workflow_revision: 1,
      status: 'completed',
      created_at: timestamp,
      started_at: timestamp,
      completed_at: timestamp,
      updated_at: timestamp
    },
    {
      id: 'wex-v20-active',
      project_id: 'project-v20-source',
      workflow_id: 'workflow-v20-source',
      workflow_revision: 1,
      status: 'running',
      created_at: timestamp,
      started_at: timestamp,
      updated_at: timestamp
    }
  );
}

function awaitedState(stateApi) {
  return JSON.parse(fs.readFileSync(path.join(process.env.AIWS_HOME, 'data', 'state.json'), 'utf8'));
}
