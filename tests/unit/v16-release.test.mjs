import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { V14_COLLECTIONS } from '../../apps/api/src/state-migration-v14.mjs';
import { migrateState14To15 } from '../../apps/api/src/state-migration-v15.mjs';
import {
  acceptVolumeMigration,
  auditVolume,
  removeLegacySchemaBackups,
  requireConfirmation,
  selectTargetVolume,
  stateAudit,
  validatePurgeTarget,
  verifyClonedVolume
} from '../../docker/release_volume.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v16-release-'));
const source = path.join(root, 'source');
const target = path.join(root, 'target');
const discarded = path.join(root, 'discarded');
const migration = path.join(root, 'migration');
const cloneManifest = path.join(migration, 'clone.manifest.json');
const archiveSha = 'a'.repeat(64);

try {
  assert.equal(selectTargetVolume({ targetExists: false, targetEmpty: true, sourceExists: true, sourceEmpty: false }), 'clone');
  assert.equal(selectTargetVolume({ targetExists: true, targetEmpty: false, sourceExists: true, sourceEmpty: false }), 'reuse');
  assert.equal(selectTargetVolume({ targetExists: true, targetEmpty: true, sourceExists: false, sourceEmpty: true }), 'fresh');
  assert.throws(() => requireConfirmation(false), /purge_legacy_requires_confirm/);
  assert.equal(requireConfirmation(true), true);

  seedSource(source);
  const publicAudit = await auditVolume(source);
  assert.equal(Object.hasOwn(publicAudit.state, 'parsed_state'), false, 'volume audit never returns parsed state contents');
  fs.cpSync(source, target, { recursive: true });
  fs.mkdirSync(migration, { recursive: true });
  const clone = await verifyClonedVolume({ sourceRoot: source, targetRoot: target, manifestPath: cloneManifest, archiveSha256: archiveSha });
  assert.equal(clone.status, 'clone_verified');
  assert.equal(clone.source_state.schema_version, 14);

  const originalAudit = await stateAudit(source);
  const sourceState = JSON.parse(fs.readFileSync(path.join(source, 'data', 'state.json'), 'utf8'));
  const migrated = migrateState14To15(sourceState, { timestamp: '2026-07-14T01:00:00.000Z' });
  fs.writeFileSync(path.join(target, 'data', 'state.json'), `${JSON.stringify(migrated.state, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'data', 'migrations', 'state-schema14-test.manifest.json'), `${JSON.stringify({
    status: 'committed', from_schema: 14, to_schema: 15,
    original_sha256: originalAudit.state_sha256,
    original_state_hash: originalAudit.state_canonical_hash,
    migrated_sha256: (await stateAudit(target)).state_sha256,
    migrated_state_hash: (await stateAudit(target)).state_canonical_hash,
    repaired_shared_forks: 0,
    normalized_runner_profiles: ['profile-official'],
    staled_runner_probes: 1
  }, null, 2)}\n`);

  const receipt = await acceptVolumeMigration({ mode: 'migrated', sourceRoot: source, targetRoot: target, cloneManifestPath: cloneManifest, archiveSha256: archiveSha, migrationVolume: 'migration-test' });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.target_state.schema_version, 15);
  assert.deepEqual(receipt.target_state.collection_counts.projects, 1);
  assert.equal(receipt.schema_migration.original_sha256, originalAudit.state_sha256);
  assert.equal((await validatePurgeTarget(target)).accepted, true);

  const acceptedStateFile = path.join(target, 'data', 'state.json');
  const acceptedState = JSON.parse(fs.readFileSync(acceptedStateFile, 'utf8'));
  for (const [collection, id] of [['projects', 'project-post-migration'], ['assist_sessions', 'assist-post-migration'], ['assist_turns', 'turn-post-migration'], ['codex_profiles', 'profile-post-migration']]) {
    acceptedState[collection].push({ ...acceptedState[collection].at(-1), id });
  }
  fs.writeFileSync(acceptedStateFile, `${JSON.stringify(acceptedState, null, 2)}\n`);
  assert.equal((await validatePurgeTarget(target)).accepted, true, 'post-migration records do not invalidate the receipt');
  const withoutMigratedSession = { ...acceptedState, assist_sessions: acceptedState.assist_sessions.filter((item) => item.id !== 'assist-one') };
  fs.writeFileSync(acceptedStateFile, `${JSON.stringify(withoutMigratedSession, null, 2)}\n`);
  await assert.rejects(() => validatePurgeTarget(target), /accepted_record_ids_missing/);
  fs.writeFileSync(acceptedStateFile, `${JSON.stringify(acceptedState, null, 2)}\n`);

  fs.writeFileSync(path.join(target, 'idempotent-sentinel.txt'), 'keep');
  assert.equal(selectTargetVolume({ targetExists: true, targetEmpty: false, sourceExists: true, sourceEmpty: false }), 'reuse');
  assert.equal(fs.readFileSync(path.join(target, 'idempotent-sentinel.txt'), 'utf8'), 'keep');

  const sourceShaBeforeFailure = (await stateAudit(source)).state_sha256;
  const invalidTarget = path.join(root, 'invalid-target');
  fs.cpSync(source, invalidTarget, { recursive: true });
  await assert.rejects(() => acceptVolumeMigration({ mode: 'migrated', sourceRoot: source, targetRoot: invalidTarget, cloneManifestPath: cloneManifest, archiveSha256: archiveSha }), /state_schema_not_15/);
  assert.equal((await stateAudit(source)).state_sha256, sourceShaBeforeFailure, 'failed target acceptance leaves source unchanged');

  fs.mkdirSync(path.join(discarded, 'data'), { recursive: true });
  const blank = migrateState14To15(emptySchema14()).state;
  fs.writeFileSync(path.join(discarded, 'data', 'state.json'), `${JSON.stringify(blank, null, 2)}\n`);
  const discardedReceipt = await acceptVolumeMigration({ mode: 'discarded_unmigratable', targetRoot: discarded });
  assert.equal(discardedReceipt.mode, 'discarded_unmigratable');
  assert.equal((await validatePurgeTarget(discarded)).schema_version, 15);

  const removed = await removeLegacySchemaBackups(target);
  assert.deepEqual(removed, ['state-schema13-old.json']);
  assert.equal(fs.existsSync(path.join(target, 'data', 'migrations', 'state-schema14-test.manifest.json')), true, 'migration manifests are retained');

  const powershell = fs.readFileSync(path.join(process.cwd(), 'scripts', 'aiws.ps1'), 'utf8');
  const posix = fs.readFileSync(path.join(process.cwd(), 'scripts', 'aiws.sh'), 'utf8');
  for (const script of [powershell, posix]) {
    assert.ok(script.includes('aiws-data-v16'), 'V1.6 remains the read-only V1.7 migration source');
    assert.ok(script.includes('aiws-data-v17'), 'active scripts target the independent V1.7 volume');
    assert.ok(script.includes('v17-release.mjs'));
    assert.ok(script.includes('purge-legacy'));
    assert.ok(script.toLowerCase().includes('discard-unmigratable'));
    assert.ok(script.includes('purge_legacy_requires_confirm'));
  }
  console.log('V1.6 release volume unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function seedSource(directory) {
  fs.mkdirSync(path.join(directory, 'data', 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'vault'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'codex-homes', 'profile-official'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'vault', 'credential.enc'), 'encrypted-sentinel');
  fs.writeFileSync(path.join(directory, 'codex-homes', 'profile-official', 'config.toml'), 'model = "unit"\n');
  fs.writeFileSync(path.join(directory, 'data', 'migrations', 'state-schema13-old.json'), '{}\n');
  const state = emptySchema14();
  state.projects = [{ id: 'project-one', title: 'Project' }];
  state.assist_sessions = [{ id: 'assist-one', version: 3, forked_from_session_id: null, codex_thread_id: 'thread-one' }];
  state.assist_turns = [{ id: 'turn-one', session_id: 'assist-one' }];
  state.codex_profiles = [
    { id: 'profile-official', image: 'aiws-codex-runner:1.4.0-codex-0.144.0', base_url: 'https://unit.example/v1', credential_ref: 'vault-ref' },
    { id: 'profile-custom', image: 'registry.example/codex:custom', base_url: 'https://custom.example/v1' }
  ];
  state.integration_statuses = [{ key: 'codex_probe', profile_id: 'profile-official', status: 'ready' }];
  fs.writeFileSync(path.join(directory, 'data', 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

function emptySchema14() {
  return { schema_version: 14, ...Object.fromEntries(V14_COLLECTIONS.map((name) => [name, []])) };
}
