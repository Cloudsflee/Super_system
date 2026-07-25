import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-volume-flow-'));
const runtimeHome = path.join(root, 'runtime');
process.env.AIWS_HOME = runtimeHome;

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const migration = await import('../../apps/api/src/state-migration-v17.mjs');
  const release = await import('../../docker/release_volume.mjs');
  await stateApi.ensureRuntime();

  const source = path.join(root, 'aiws-data-v17');
  const target = path.join(root, 'aiws-data-v18');
  const failedTarget = path.join(root, 'failed-target');
  const fresh = path.join(root, 'fresh-target');
  const manifests = path.join(root, 'migration-volume');
  fs.mkdirSync(path.join(source, 'data', 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(source, 'vault'), { recursive: true });
  fs.mkdirSync(path.join(source, 'codex-homes', 'profile-release'), { recursive: true });
  fs.mkdirSync(manifests, { recursive: true });

  const sourceState = structuredClone(await stateApi.readState());
  sourceState.schema_version = 16;
  delete sourceState.mcp_clients;
  sourceState.projects.push({
    id: 'project-v18-release',
    title: 'V1.8 release fixture',
    goal: 'Migrate safely',
    status: 'active',
    onboarding_state: 'confirmed',
    settings: { token_budget: 12000, preferred_runner: 'codex_docker', workspace_root_whitelist: [] },
    lifecycle_operation: null
  });
  sourceState.codex_profiles = [
    { id: 'profile-release', kind: 'docker', image: 'aiws-codex-runner:1.7.0-codex-0.144.0', status: 'validated' }
  ];
  fs.writeFileSync(path.join(source, 'data', 'state.json'), `${JSON.stringify(sourceState, null, 2)}\n`);
  fs.writeFileSync(path.join(source, 'vault', 'credential.enc'), 'encrypted-v18-volume-sentinel');
  fs.writeFileSync(path.join(source, 'codex-homes', 'profile-release', 'config.toml'), 'model = "release"\n');
  fs.cpSync(source, target, { recursive: true });
  fs.cpSync(source, failedTarget, { recursive: true });

  const sourceStateBytes = fs.readFileSync(path.join(source, 'data', 'state.json'));
  const sourceInventory = await release.volumeInventory(source);
  const archiveSha = 'c'.repeat(64);
  const cloneManifest = path.join(manifests, 'clone.manifest.json');
  const clone = await release.verifyClonedVolumeV18({
    sourceRoot: source,
    targetRoot: target,
    manifestPath: cloneManifest,
    archiveSha256: archiveSha
  });
  assert.equal(clone.status, 'clone_verified');
  assert.equal(clone.source_state.schema_version, 16);
  assert.equal(clone.source_volume, 'aiws-data-v17');
  assert.equal(clone.target_volume, 'aiws-data-v18');

  const migrated = await migration.migrateStateFileToV17(path.join(target, 'data', 'state.json'), {
    clock: sequenceClock('2026-07-17T03:00:00.000Z')
  });
  assert.equal(migrated.state.schema_version, 17);
  assert.deepEqual(migrated.state.mcp_clients, []);
  assert.equal(migrated.state.codex_profiles[0].image, 'aiws-codex-runner:1.8.0-codex-0.144.0');
  assert.equal(fs.readFileSync(migrated.backup_path).equals(sourceStateBytes), true);
  const accepted = await release.acceptVolumeMigrationV18({
    mode: 'migrated',
    sourceRoot: source,
    targetRoot: target,
    cloneManifestPath: cloneManifest,
    archiveSha256: archiveSha,
    migrationVolume: 'aiws-v18-migration-test'
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.schema_migration.from_schema, 16);
  assert.equal(accepted.schema_migration.to_schema, 17);
  assert.equal(accepted.preservation.missing_paths.length, 0);
  assert.equal((await release.validateV18ReleaseTarget(target)).schema_version, 17);
  assert.equal(
    fs.readFileSync(path.join(source, 'data', 'state.json')).equals(sourceStateBytes),
    true,
    'source state remains byte-for-byte unchanged'
  );
  assert.equal(
    (await release.volumeInventory(source)).hash,
    sourceInventory.hash,
    'read-only source inventory remains unchanged'
  );

  fs.writeFileSync(path.join(target, 'idempotent-sentinel.txt'), 'keep');
  const acceptedStateHash = sha256(fs.readFileSync(path.join(target, 'data', 'state.json')));
  assert.equal(
    release.selectTargetVolume({ targetExists: true, targetEmpty: false, sourceExists: true, sourceEmpty: false }),
    'reuse'
  );
  assert.equal((await release.validateV18ReleaseTarget(target)).accepted, true);
  assert.equal(sha256(fs.readFileSync(path.join(target, 'data', 'state.json'))), acceptedStateHash);
  assert.equal(fs.readFileSync(path.join(target, 'idempotent-sentinel.txt'), 'utf8'), 'keep');

  const failedBytes = fs.readFileSync(path.join(failedTarget, 'data', 'state.json'));
  await assert.rejects(
    () =>
      migration.migrateStateFileToV17(path.join(failedTarget, 'data', 'state.json'), {
        clock: sequenceClock('2026-07-17T04:00:00.000Z'),
        afterReplace: () => {
          throw Object.assign(new Error('simulated_acceptance_failure'), { code: 'simulated_acceptance_failure' });
        }
      }),
    /simulated_acceptance_failure/
  );
  assert.equal(
    fs.readFileSync(path.join(failedTarget, 'data', 'state.json')).equals(failedBytes),
    true,
    'failed migration restores target state'
  );
  assert.equal(
    fs.readFileSync(path.join(source, 'data', 'state.json')).equals(sourceStateBytes),
    true,
    'failed migration never changes source'
  );
  const rollbackManifest = fs
    .readdirSync(path.join(failedTarget, 'data', 'migrations'))
    .find((item) => item.endsWith('.manifest.json'));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(failedTarget, 'data', 'migrations', rollbackManifest), 'utf8')).status,
    'rolled_back'
  );

  const freshState = structuredClone(migrated.state);
  freshState.mcp_clients = [];
  fs.mkdirSync(path.join(fresh, 'data'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'data', 'state.json'), `${JSON.stringify(freshState, null, 2)}\n`);
  const freshAccepted = await release.acceptVolumeMigrationV18({ mode: 'fresh', targetRoot: fresh });
  assert.equal(freshAccepted.mode, 'fresh');
  assert.equal((await release.validateV18ReleaseTarget(fresh)).schema_version, 17);

  console.log('V1.8 release volume flow tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function sequenceClock(start) {
  let value = new Date(start).getTime();
  return () => new Date(value++);
}
