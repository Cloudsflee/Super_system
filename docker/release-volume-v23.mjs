import fsp from 'node:fs/promises';
import path from 'node:path';

import { collections } from '../apps/api/src/config.mjs';
import { readLegacySqliteState } from '../apps/api/src/state-runtime-v23.mjs';
import { isState22Sentinel, validateState22 } from '../apps/api/src/state-migration-v22.mjs';
import {
  canonicalJson,
  canonicalJsonHash,
  isState23Sentinel,
  migrateState22To23,
  stateRecordIdentity,
  validateState23,
  V23_SPECIALIZED_COLLECTIONS
} from '../apps/api/src/state-migration-v23.mjs';
import { closeStateStore, initializeStateStore, stateStoreHealth } from '../apps/api/src/state-store.mjs';
import { loadContextSearchIndex } from '../packages/system-context/src/index.mjs';
import {
  atomicJsonWrite,
  comparePreservedFiles,
  inventorySummary,
  keyInventory,
  normalizeSha,
  publicStateAudit,
  readHashedJson,
  releaseError,
  sha256,
  stateAudit,
  volumeInventory,
  withDocumentHash,
  withoutInventoryEntries
} from './release-volume-validation.mjs';

export const V23_SOURCE_VOLUME = 'aiws-data-v22';
export const V23_TARGET_VOLUME = 'aiws-data-v23';
export const V23_RECEIPT_RELATIVE_PATH = 'data/migrations/v23-volume-migration.manifest.json';

export async function verifyClonedVolumeV23({
  sourceRoot,
  targetRoot,
  manifestPath,
  archiveSha256,
  sourceVolume = V23_SOURCE_VOLUME,
  targetVolume = V23_TARGET_VOLUME,
  clock = () => new Date()
}) {
  const sourceInventory = await volumeInventory(sourceRoot),
    targetInventory = await volumeInventory(targetRoot);
  if (
    sourceInventory.hash !== targetInventory.hash ||
    canonicalJson(sourceInventory.entries) !== canonicalJson(targetInventory.entries)
  )
    throw releaseError('cloned_volume_inventory_mismatch', {
      source_hash: sourceInventory.hash,
      target_hash: targetInventory.hash
    });
  const sourceState = await auditV22SourceState(sourceRoot);
  if (sourceState.schema_version !== 22)
    throw releaseError('source_state_schema_not_22', { schema_version: sourceState.schema_version });
  validateState22(sourceState.parsed_state);
  orderedCollectionIdentities(sourceState.parsed_state);
  const manifest = {
    version: 1,
    migration: 'aiws-volume-v22-to-v23-sqlite',
    status: 'clone_verified',
    created_at: clock().toISOString(),
    source_volume: sourceVolume,
    target_volume: targetVolume,
    archive_sha256: normalizeSha(archiveSha256),
    source_state: publicStateAudit(sourceState),
    source_ordered_identities_sha256: canonicalJsonHash(orderedCollectionIdentities(sourceState.parsed_state)),
    source_inventory: sourceInventory,
    cloned_inventory_hash: targetInventory.hash
  };
  await atomicJsonWrite(manifestPath, withDocumentHash(manifest, 'manifest_sha256'));
  return withoutInventoryEntries(manifest);
}

export async function acceptVolumeMigrationV23({
  targetRoot,
  sourceRoot,
  cloneManifestPath,
  archiveSha256,
  migrationVolume = null,
  sourceVolume = V23_SOURCE_VOLUME,
  targetVolume = V23_TARGET_VOLUME,
  clock = () => new Date()
}) {
  if (!sourceRoot || !cloneManifestPath) throw releaseError('migrated_acceptance_source_required');
  const cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
  assertCloneManifest(cloneManifest, { archiveSha256, sourceVolume, targetVolume });

  const sourceState = await auditV22SourceState(sourceRoot),
    sourceInventory = await volumeInventory(sourceRoot);
  if (sourceState.schema_version !== 22)
    throw releaseError('source_state_schema_not_22', { schema_version: sourceState.schema_version });
  validateState22(sourceState.parsed_state);
  if (
    sourceState.state_sha256 !== cloneManifest.source_state.state_sha256 ||
    sourceInventory.hash !== cloneManifest.source_inventory.hash
  )
    throw releaseError('source_changed_after_clone');

  const target = await auditSqliteTarget(targetRoot, sourceState.state_canonical_hash),
    sourceIdentities = orderedCollectionIdentities(sourceState.parsed_state),
    targetIdentities = orderedCollectionIdentities(target.state);
  verifyMigrationProof(sourceState.parsed_state, target);
  compareImportedIdentities(sourceIdentities, targetIdentities);
  if (canonicalJsonHash(sourceIdentities) !== cloneManifest.source_ordered_identities_sha256)
    throw releaseError('source_identity_order_changed_after_clone');
  const index = await auditContextIndex(targetRoot),
    targetInventory = await volumeInventory(targetRoot),
    preservation = comparePreservedFiles(cloneManifest.source_inventory.entries, targetInventory.entries, {
      // The V2.3 rebuild writes the v2 index in place. Keep both index
      // generations mutable so a V2.2 source that already has either file
      // can be reconciled without weakening checks for unrelated files.
      mutablePaths: ['data/.context-index/minisearch-v1.json', 'data/.context-index/minisearch-v2.json'],
      removablePaths: ['data/state.json.tmp']
    }),
    receipt = {
      version: 1,
      migration: 'aiws-volume-v22-to-v23-sqlite',
      status: 'accepted',
      accepted: true,
      accepted_at: clock().toISOString(),
      mode: 'migrated',
      source_volume: sourceVolume,
      target_volume: targetVolume,
      migration_volume: migrationVolume,
      archive_sha256: cloneManifest.archive_sha256,
      source_state: publicStateAudit(sourceState),
      source_ordered_identities_sha256: canonicalJsonHash(sourceIdentities),
      target_state: publicSqliteAudit(target),
      clone_inventory_hash: cloneManifest.cloned_inventory_hash,
      target_inventory: inventorySummary(targetInventory),
      preservation,
      context_index: index,
      vault_files: keyInventory(targetInventory.entries, 'vault/'),
      codex_home_files: keyInventory(targetInventory.entries, 'codex-homes/'),
      source_preserved: true,
      sqlite_authoritative: true,
      health_verified: false,
      legacy_runner_references: findLegacyOfficialRunnerReferences(target.state)
    };
  if (receipt.legacy_runner_references.length)
    throw releaseError('legacy_runner_references_remain', { references: receipt.legacy_runner_references });
  const receiptPath = path.join(targetRoot, ...V23_RECEIPT_RELATIVE_PATH.split('/'));
  await atomicJsonWrite(receiptPath, withDocumentHash(receipt, 'receipt_sha256'));
  return { ...receipt, receipt_path: V23_RECEIPT_RELATIVE_PATH };
}

export async function validateV23ReleaseTarget(targetRoot, expectedTargetVolume = V23_TARGET_VOLUME) {
  const receipt = await readHashedJson(
    path.join(targetRoot, ...V23_RECEIPT_RELATIVE_PATH.split('/')),
    'receipt_sha256'
  );
  if (
    receipt.version !== 1 ||
    receipt.accepted !== true ||
    receipt.status !== 'accepted' ||
    receipt.mode !== 'migrated' ||
    receipt.source_volume !== V23_SOURCE_VOLUME ||
    receipt.target_volume !== expectedTargetVolume ||
    receipt.migration !== 'aiws-volume-v22-to-v23-sqlite' ||
    receipt.source_preserved !== true ||
    receipt.sqlite_authoritative !== true
  )
    throw releaseError('migration_acceptance_missing');
  const target = await auditSqliteTarget(targetRoot, receipt.source_state.state_canonical_hash),
    index = await auditContextIndex(targetRoot);
  assertAcceptedMigrationProof(receipt, target);
  if (findLegacyOfficialRunnerReferences(target.state).length) throw releaseError('legacy_runner_references_remain');
  return {
    accepted: true,
    mode: receipt.mode,
    schema_version: 23,
    revision: target.revision,
    integrity: target.health.integrity,
    writable: target.health.writable,
    migration_complete: target.health.migration_complete,
    receipt_sha256: receipt.receipt_sha256,
    source_preserved: true,
    sqlite_authoritative: true,
    context_index: index,
    collection_counts: target.collection_counts,
    legacy_runner_references: []
  };
}

/**
 * V2.2 has already moved its authoritative state out of state.json.  A V2.3
 * cutover must therefore inspect state-v22.sqlite when the source contains a
 * V2.2 sentinel; treating the sentinel itself as the source state would make
 * the migration appear to contain no records.  The JSON fallback is retained
 * for older development fixtures which still contain a materialized schema-22
 * state file.
 */
async function auditV22SourceState(root) {
  const stateFile = path.join(root, 'data', 'state.json'),
    databasePath = path.join(root, 'data', 'state-v22.sqlite');
  let stateFileValue = null,
    stateFileBytes = null;
  try {
    stateFileBytes = await fsp.readFile(stateFile);
    stateFileValue = JSON.parse(stateFileBytes.toString('utf8'));
  } catch (error) {
    throw releaseError('source_state_invalid', { cause: error.code || error.message });
  }

  let state,
    authoritativeBytes = stateFileBytes;
  if (isState22Sentinel(stateFileValue)) {
    try {
      state = await readLegacySqliteState(databasePath);
      authoritativeBytes = await fsp.readFile(databasePath);
    } catch (error) {
      throw releaseError('source_state_database_invalid', {
        database: path.basename(databasePath),
        cause: error.code || error.message
      });
    }
  } else if (Number(stateFileValue?.schema_version) === 22 && Array.isArray(stateFileValue.users)) {
    state = stateFileValue;
  } else {
    throw releaseError('source_state_schema_not_22', { schema_version: stateFileValue?.schema_version });
  }
  if (Number(state?.schema_version) !== 22) throw releaseError('source_state_schema_not_22');
  validateState22(state);
  const collectionNames = collections.filter((name) => Array.isArray(state[name])),
    collectionCounts = Object.fromEntries(collectionNames.map((name) => [name, state[name].length])),
    recordIds = Object.fromEntries(
      collectionNames.map((name) => [name, state[name].map((record) => stateRecordIdentity(name, record)).sort()])
    );
  return {
    schema_version: 22,
    state_bytes: authoritativeBytes.length,
    state_sha256: sha256(authoritativeBytes),
    state_canonical_hash: canonicalJsonHash(state),
    collection_counts: collectionCounts,
    record_ids: recordIds,
    record_ids_sha256: sha256(Buffer.from(canonicalJson(recordIds))),
    legacy_runner_references: findLegacyOfficialRunnerReferences(state),
    schema_migrations: [],
    parsed_state: state
  };
}

function assertAcceptedMigrationProof(receipt, target) {
  const migration = target.migration,
    accepted = receipt.target_state;
  if (
    migration?.from_version !== 22 ||
    migration?.to_version !== 23 ||
    migration?.source_state_hash !== receipt.source_state.state_canonical_hash ||
    migration?.source_state_hash !== accepted?.source_state_hash ||
    migration?.migrated_state_hash !== accepted?.migrated_state_hash ||
    !migration?.migrated_at
  )
    throw releaseError('accepted_migration_proof_changed');
}

async function auditSqliteTarget(targetRoot, sourceStateHash) {
  const stateFile = path.join(targetRoot, 'data', 'state.json'),
    databasePath = path.join(targetRoot, 'data', 'state-v23.sqlite');
  let sentinel;
  try {
    sentinel = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  } catch {
    throw releaseError('state23_sentinel_invalid');
  }
  if (!isState23Sentinel(sentinel)) throw releaseError('state23_sentinel_invalid');
  let initialized;
  try {
    initialized = await initializeStateStore({
      databasePath,
      collections,
      store_schema_version: 23,
      state: null,
      sourceStateHash,
      migration: null
    });
    const health = await stateStoreHealth(),
      state = initialized.state;
    validateState23(state);
    if (!health.healthy || !health.writable || !health.migration_complete || health.integrity !== 'ok')
      throw releaseError('state23_sqlite_health_invalid', { health });
    if (initialized.source_state_hash !== sourceStateHash)
      throw releaseError('state23_source_hash_mismatch', {
        expected: sourceStateHash,
        actual: initialized.source_state_hash
      });
    const identities = orderedCollectionIdentities(state);
    return {
      state,
      health,
      revision: initialized.revision,
      migration: initialized.migration,
      canonical_state_hash: canonicalJsonHash(state),
      collection_counts: Object.fromEntries(collections.map((name) => [name, state[name].length])),
      ordered_identities_sha256: canonicalJsonHash(identities)
    };
  } finally {
    await closeStateStore();
  }
}

async function auditContextIndex(targetRoot) {
  const file = path.join(targetRoot, 'data', '.context-index', 'minisearch-v2.json');
  let payload;
  try {
    payload = JSON.parse(await fsp.readFile(file, 'utf8'));
    loadContextSearchIndex(payload);
  } catch {
    throw releaseError('context_index_v2_invalid');
  }
  if (
    payload.schema_version !== 'aiws.context_index.v2' ||
    !/^[a-f0-9]{64}$/.test(String(payload.snapshot_hash || '')) ||
    Object.hasOwn(payload, 'rebuilt_at')
  )
    throw releaseError('context_index_v2_invalid');
  return {
    schema_version: payload.schema_version,
    snapshot_hash: payload.snapshot_hash,
    tokenizer_version: payload.tokenizer_version,
    index_options_version: payload.index_options_version
  };
}

function orderedCollectionIdentities(state) {
  return Object.fromEntries(
    collections.map((collection) => [
      collection,
      state[collection].map((record) => stateRecordIdentity(collection, record))
    ])
  );
}

function compareImportedIdentities(source, target) {
  for (const collection of collections) {
    if (V23_SPECIALIZED_COLLECTIONS.includes(collection)) continue;
    const expected = source[collection],
      actual = target[collection];
    let cursor = 0;
    for (const identity of actual) if (identity === expected[cursor]) cursor += 1;
    if (cursor !== expected.length)
      throw releaseError('migrated_record_identity_order_mismatch', {
        collection,
        source_count: expected.length,
        target_count: actual.length
      });
  }
}

function verifyMigrationProof(source, target) {
  const migration = target.migration,
    timestamp = migration?.migrated_at;
  if (
    migration?.from_version !== 22 ||
    migration?.to_version !== 23 ||
    migration?.source_state_hash !== canonicalJsonHash(source) ||
    !timestamp
  )
    throw releaseError('state23_migration_proof_invalid');
  const expected = migrateState22To23(structuredClone(source), { timestamp }).state,
    expectedHash = canonicalJsonHash(expected);
  if (migration.migrated_state_hash !== expectedHash)
    throw releaseError('state23_migration_hash_mismatch', {
      expected: expectedHash,
      actual: migration.migrated_state_hash
    });
}

function publicSqliteAudit(value) {
  return {
    schema_version: 23,
    revision: value.revision,
    integrity: value.health.integrity,
    writable: value.health.writable,
    migration_complete: value.health.migration_complete,
    source_state_hash: value.migration?.source_state_hash || null,
    migrated_state_hash: value.migration?.migrated_state_hash || null,
    canonical_state_hash: value.canonical_state_hash,
    collection_counts: value.collection_counts,
    ordered_identities_sha256: value.ordered_identities_sha256
  };
}

function assertCloneManifest(manifest, { archiveSha256, sourceVolume, targetVolume }) {
  if (manifest.status !== 'clone_verified' || manifest.migration !== 'aiws-volume-v22-to-v23-sqlite')
    throw releaseError('clone_manifest_not_verified');
  if (manifest.source_volume !== sourceVolume || manifest.target_volume !== targetVolume)
    throw releaseError('clone_manifest_volume_mismatch');
  if (normalizeSha(archiveSha256) !== manifest.archive_sha256) throw releaseError('clone_archive_hash_mismatch');
}

export function findLegacyOfficialRunnerReferences(value) {
  const pattern = /^aiws-codex-runner:(?:1\.(?:[0-9]|10)\.0|2\.[0-2]\.0)-codex-\d+\.\d+\.\d+$/;
  const found = [];
  for (const [index, profile] of (value?.codex_profiles || []).entries()) {
    inspect(profile?.image, `codex_profiles.${index}.image`);
    inspect(profile?.config?.image, `codex_profiles.${index}.config.image`);
  }
  for (const [index, integration] of (value?.integration_statuses || []).entries())
    if (integration?.key === 'codex_docker') inspect(integration.image, `integration_statuses.${index}.image`);
  return found.sort((left, right) => left.path.localeCompare(right.path));

  function inspect(current, field) {
    if (pattern.test(String(current || ''))) found.push({ path: field, image: current });
  }
}
