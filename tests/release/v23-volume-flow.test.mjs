import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v23-release-')),
  source = path.join(root, 'aiws-data-v22'),
  target = path.join(root, 'aiws-data-v23');
process.env.AIWS_HOME = target;
process.env.NODE_ENV = 'test';

const { createLocalOwner, defaultCodexProfiles, defaultTools } = await import('../../packages/shared/index.mjs');
const { collections } = await import('../../apps/api/src/config.mjs');
const { emptyState } = await import('../../apps/api/src/state.mjs');
const { canonicalJsonHash, createState22Sentinel, normalizeState22Defaults, validateState22 } =
  await import('../../apps/api/src/state-migration-v22.mjs');
const { closeStateStore, initializeStateStore } = await import('../../apps/api/src/state-store.mjs');
const { createContextSearchIndex, contextSearchIndexSnapshotHash, serializeContextSearchIndex } =
  await import('../../packages/system-context/src/search-index.mjs');
const release = await import('../../docker/release-volume-v23.mjs');
const upgrade = await import('../../docker/v23-upgrade.mjs');

try {
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.mkdirSync(path.join(source, 'vault'), { recursive: true });
  const state = emptyState();
  state.schema_version = 22;
  const owner = createLocalOwner();
  state.users.push(owner.user);
  state.sessions.push(owner.session);
  state.instance_owner_user_id = owner.user.id;
  state.tools.push(...defaultTools(owner.user.id));
  state.codex_profiles.push(...defaultCodexProfiles(owner.user.id));
  normalizeState22Defaults(state, '2026-08-01T00:00:00.000Z');
  validateState22(state);

  const sourceDatabase = path.join(source, 'data', 'state-v22.sqlite');
  await initializeStateStore({
    databasePath: sourceDatabase,
    collections,
    store_schema_version: 22,
    state,
    sourceStateHash: null,
    migration: { migrated: false, from_version: 21, to_version: 22, migrated_at: '2026-08-01T00:00:00.000Z' }
  });
  await closeStateStore();
  const sentinel = createState22Sentinel({
    revision: 1,
    stateHash: canonicalJsonHash(state),
    migratedFrom: 21,
    migratedAt: '2026-08-01T00:00:00.000Z'
  });
  const sourceStateFile = path.join(source, 'data', 'state.json');
  fs.writeFileSync(sourceStateFile, `${JSON.stringify(sentinel, null, 2)}\n`);
  fs.writeFileSync(`${sourceStateFile}.tmp`, `${JSON.stringify({ ...sentinel, revision: 0 }, null, 2)}\n`);
  fs.writeFileSync(path.join(source, 'vault', 'fixture.enc'), 'V23_RELEASE_SECRET_MUST_NOT_REACH_RECEIPT');
  const sourceBytes = fs.readFileSync(sourceStateFile);
  fs.cpSync(source, target, { recursive: true });

  const migrationRoot = path.join(root, 'migration-volume');
  fs.mkdirSync(migrationRoot, { recursive: true });
  const cloneManifest = path.join(migrationRoot, 'clone.manifest.json');
  const clone = await release.verifyClonedVolumeV23({
    sourceRoot: source,
    targetRoot: target,
    manifestPath: cloneManifest,
    archiveSha256: 'f'.repeat(64),
    clock: () => new Date('2026-08-01T00:01:00.000Z')
  });
  assert.equal(clone.source_volume, 'aiws-data-v22');
  assert.equal(clone.target_volume, 'aiws-data-v23');
  assert.equal(clone.source_state.schema_version, 22);

  const stateApi = await import('../../apps/api/src/state.mjs?release-v23-target');
  await stateApi.ensureRuntime();
  await stateApi.checkpointAndCloseState();
  const indexPayload = serializeContextSearchIndex(createContextSearchIndex([]), {
    snapshotHash: contextSearchIndexSnapshotHash([])
  });
  fs.mkdirSync(path.join(target, 'data', '.context-index'), { recursive: true });
  fs.writeFileSync(
    path.join(target, 'data', '.context-index', 'minisearch-v2.json'),
    `${JSON.stringify(indexPayload, null, 2)}\n`
  );

  const accepted = await release.acceptVolumeMigrationV23({
    sourceRoot: source,
    targetRoot: target,
    cloneManifestPath: cloneManifest,
    archiveSha256: 'f'.repeat(64),
    migrationVolume: 'aiws-v23-migration-fixture',
    clock: () => new Date('2026-08-01T00:02:00.000Z')
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.target_state.schema_version, 23);
  assert.equal(accepted.sqlite_authoritative, true);
  assert.equal(accepted.target_state.integrity, 'ok');
  assert.equal(accepted.context_index.schema_version, 'aiws.context_index.v2');
  assert.deepEqual(accepted.preservation.allowed_removed_paths, ['data/state.json.tmp']);
  assert.equal(fs.readFileSync(sourceStateFile).equals(sourceBytes), true);

  const checked = await release.validateV23ReleaseTarget(target);
  assert.equal(checked.schema_version, 23);
  assert.equal(checked.writable, true);
  assert.equal(checked.source_preserved, true);
  const receiptText = fs.readFileSync(path.join(target, ...release.V23_RECEIPT_RELATIVE_PATH.split('/')), 'utf8');
  assert.equal(receiptText.includes('V23_RELEASE_SECRET_MUST_NOT_REACH_RECEIPT'), false);

  assert.equal(upgrade.V23_VERSION, '2.3.0');
  assert.equal(upgrade.V23_SCHEMA, 23);
  assert.equal(upgrade.V23_PROJECT, 'aiws-v23');
  assert.equal(upgrade.V22_PROJECT, 'aiws-v22');
  assert.equal(upgrade.V23_APP_IMAGE, 'aiws-app:2.3.0');
  assert.equal(upgrade.V23_RUNNER_IMAGE, 'aiws-codex-runner:2.3.0-codex-0.144.0');
  assert.equal(
    upgrade.v23RollbackAccepted(['container-id'], { status: 'ok', version: '2.2.0', schema_version: 22 }),
    true
  );
  assert.equal(
    upgrade.v23RollbackAccepted(['container-id'], { status: 'ok', version: '2.1.0', schema_version: 21 }),
    false
  );
} finally {
  await closeStateStore().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('V2.3 read-only V22 SQLite clone, schema migration, source retention and receipt redaction tests passed');
