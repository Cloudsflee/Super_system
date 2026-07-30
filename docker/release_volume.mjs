#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, validateState15 } from '../apps/api/src/state-migration-v15.mjs';
import { validateState16 } from '../apps/api/src/state-migration-v16.mjs';
import { validateState17 } from '../apps/api/src/state-migration-v17.mjs';
import { validateState18 } from '../apps/api/src/state-migration-v18.mjs';
import { validateState19 } from '../apps/api/src/state-migration-v19.mjs';
import {
  atomicJsonWrite,
  auditVolume,
  comparePreservedFiles,
  compareStateIdentities,
  findLegacyRunnerReferencesV17,
  findLegacyRunnerReferencesV18,
  findLegacyRunnerReferencesV19,
  inventorySummary,
  keyInventory,
  normalizeOptionalSha,
  normalizeSha,
  pickCounts,
  publicSchemaMigration,
  publicStateAudit,
  readHashedJson,
  releaseError,
  removeLegacySchemaBackups,
  stateAudit,
  volumeInventory,
  withDocumentHash,
  withoutInventoryEntries
} from './release-volume-validation.mjs';
import {
  V20_SOURCE_VOLUME,
  V20_TARGET_VOLUME,
  acceptVolumeMigrationV20,
  validateV20ReleaseTarget,
  verifyClonedVolumeV20
} from './release-volume-v20.mjs';
import { executeV21ReleaseCommand } from './release-volume-v21-cli.mjs';

export {
  V20_RECEIPT_RELATIVE_PATH,
  V20_SOURCE_VOLUME,
  V20_TARGET_VOLUME,
  acceptVolumeMigrationV20,
  validateV20ReleaseTarget,
  verifyClonedVolumeV20
} from './release-volume-v20.mjs';
export {
  V21_RECEIPT_RELATIVE_PATH,
  V21_SOURCE_VOLUME,
  V21_TARGET_VOLUME,
  acceptVolumeMigrationV21,
  validateV21ReleaseTarget,
  verifyClonedVolumeV21
} from './release-volume-v21.mjs';
export { auditVolume, removeLegacySchemaBackups, stateAudit, volumeInventory };

export const SOURCE_VOLUME = 'aiws-data-v14';
export const TARGET_VOLUME = 'aiws-data-v16';
export const RECEIPT_RELATIVE_PATH = 'data/migrations/v16-volume-migration.manifest.json';
export const V17_SOURCE_VOLUME = 'aiws-data-v16';
export const V17_TARGET_VOLUME = 'aiws-data-v17';
export const V17_RECEIPT_RELATIVE_PATH = 'data/migrations/v17-volume-migration.manifest.json';
export const V18_SOURCE_VOLUME = 'aiws-data-v17';
export const V18_TARGET_VOLUME = 'aiws-data-v18';
export const V18_RECEIPT_RELATIVE_PATH = 'data/migrations/v18-volume-migration.manifest.json';
export const V19_SOURCE_VOLUME = 'aiws-data-v18';
export const V19_TARGET_VOLUME = 'aiws-data-v19';
export const V19_RECEIPT_RELATIVE_PATH = 'data/migrations/v19-volume-migration.manifest.json';

export function selectTargetVolume({ targetExists, targetEmpty, sourceExists, sourceEmpty }) {
  if (targetExists && !targetEmpty) return 'reuse';
  if (sourceExists && !sourceEmpty) return 'clone';
  return 'fresh';
}

export function requireConfirmation(confirmed, code = 'purge_legacy_requires_confirm') {
  if (confirmed !== true) throw releaseError(code);
  return true;
}

export async function verifyClonedVolume({
  sourceRoot,
  targetRoot,
  manifestPath,
  archiveSha256,
  sourceVolume = SOURCE_VOLUME,
  targetVolume = TARGET_VOLUME,
  clock = () => new Date()
}) {
  const sourceInventory = await volumeInventory(sourceRoot);
  const targetInventory = await volumeInventory(targetRoot);
  if (
    sourceInventory.hash !== targetInventory.hash ||
    canonicalJson(sourceInventory.entries) !== canonicalJson(targetInventory.entries)
  ) {
    throw releaseError('cloned_volume_inventory_mismatch', {
      source_hash: sourceInventory.hash,
      target_hash: targetInventory.hash
    });
  }
  const sourceState = await stateAudit(sourceRoot);
  if (sourceState.schema_version !== 14)
    throw releaseError('source_state_schema_not_14', { schema_version: sourceState.schema_version });
  const manifest = {
    version: 1,
    migration: 'aiws-volume-v14-to-v16',
    status: 'clone_verified',
    created_at: clock().toISOString(),
    source_volume: sourceVolume,
    target_volume: targetVolume,
    archive_sha256: normalizeSha(archiveSha256),
    source_state: publicStateAudit(sourceState),
    source_inventory: sourceInventory,
    cloned_inventory_hash: targetInventory.hash
  };
  await atomicJsonWrite(manifestPath, withDocumentHash(manifest, 'manifest_sha256'));
  return withoutInventoryEntries(manifest);
}

export async function acceptVolumeMigration({
  mode,
  targetRoot,
  sourceRoot = null,
  cloneManifestPath = null,
  archiveSha256 = null,
  migrationVolume = null,
  sourceVolume = SOURCE_VOLUME,
  targetVolume = TARGET_VOLUME,
  clock = () => new Date()
}) {
  if (!['migrated', 'fresh', 'discarded_unmigratable'].includes(mode))
    throw releaseError('release_acceptance_mode_invalid', { mode });
  const targetState = await stateAudit(targetRoot);
  validateState15(targetState.parsed_state);
  if (targetState.legacy_runner_references.length)
    throw releaseError('legacy_runner_references_remain', { references: targetState.legacy_runner_references });

  let cloneManifest = null;
  let sourceState = null;
  let sourceInventory = null;
  let preservation = null;
  let schemaMigration = null;
  if (mode === 'migrated') {
    if (!sourceRoot || !cloneManifestPath) throw releaseError('migrated_acceptance_source_required');
    cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
    if (cloneManifest.status !== 'clone_verified') throw releaseError('clone_manifest_not_verified');
    if (cloneManifest.source_volume !== sourceVolume || cloneManifest.target_volume !== targetVolume)
      throw releaseError('clone_manifest_volume_mismatch');
    if (normalizeSha(archiveSha256) !== cloneManifest.archive_sha256) throw releaseError('clone_archive_hash_mismatch');
    sourceState = await stateAudit(sourceRoot);
    sourceInventory = await volumeInventory(sourceRoot);
    if (
      sourceState.state_sha256 !== cloneManifest.source_state.state_sha256 ||
      sourceInventory.hash !== cloneManifest.source_inventory.hash
    ) {
      throw releaseError('source_changed_after_clone');
    }
    compareStateIdentities(sourceState, targetState);
    const targetInventory = await volumeInventory(targetRoot);
    preservation = comparePreservedFiles(cloneManifest.source_inventory.entries, targetInventory.entries);
    schemaMigration =
      targetState.schema_migrations.find(
        (item) =>
          item.from_schema === 14 &&
          item.to_schema === 15 &&
          item.status === 'committed' &&
          item.original_sha256 === sourceState.state_sha256
      ) || null;
    if (!schemaMigration) throw releaseError('schema_14_to_15_manifest_missing');
  } else if (mode === 'discarded_unmigratable' && cloneManifestPath) {
    cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
    sourceState = cloneManifest.source_state;
  }

  const targetInventory = await volumeInventory(targetRoot);
  const acceptedAt = clock().toISOString();
  const receipt = {
    version: 1,
    migration: 'aiws-volume-v14-to-v16',
    status: 'accepted',
    accepted: true,
    accepted_at: acceptedAt,
    mode,
    source_volume: sourceVolume,
    target_volume: targetVolume,
    migration_volume: migrationVolume || null,
    archive_sha256: cloneManifest?.archive_sha256 || normalizeOptionalSha(archiveSha256),
    source_state: sourceState ? publicStateAudit(sourceState) : null,
    target_state: publicStateAudit(targetState),
    schema_migration: schemaMigration ? publicSchemaMigration(schemaMigration) : null,
    clone_inventory_hash: cloneManifest?.cloned_inventory_hash || null,
    target_inventory: inventorySummary(targetInventory),
    preservation,
    vault_files: keyInventory(targetInventory.entries, 'vault/'),
    codex_home_files: keyInventory(targetInventory.entries, 'codex-homes/'),
    health_verified: true,
    legacy_runner_references: []
  };
  const receiptPath = path.join(targetRoot, ...RECEIPT_RELATIVE_PATH.split('/'));
  await atomicJsonWrite(receiptPath, withDocumentHash(receipt, 'receipt_sha256'));
  return { ...receipt, receipt_path: RECEIPT_RELATIVE_PATH };
}

export async function validatePurgeTarget(targetRoot, expectedTargetVolume = TARGET_VOLUME) {
  const receiptPath = path.join(targetRoot, ...RECEIPT_RELATIVE_PATH.split('/'));
  const receipt = await readHashedJson(receiptPath, 'receipt_sha256');
  if (receipt.accepted !== true || receipt.status !== 'accepted' || receipt.target_volume !== expectedTargetVolume)
    throw releaseError('migration_acceptance_missing');
  const targetState = await stateAudit(targetRoot);
  validateState15(targetState.parsed_state);
  if (targetState.legacy_runner_references.length)
    throw releaseError('legacy_runner_references_remain', { references: targetState.legacy_runner_references });
  for (const collection of ['projects', 'assist_sessions', 'assist_turns', 'codex_profiles']) {
    const expected = receipt.source_state?.record_ids?.[collection];
    if (!expected || receipt.mode !== 'migrated') continue;
    const actual = targetState.record_ids[collection] || [];
    const actualIds = new Set(actual);
    const missing = expected.filter((id) => !actualIds.has(id));
    if (missing.length) throw releaseError('accepted_record_ids_missing', { collection, missing });
  }
  if (receipt.mode === 'migrated') {
    const expected = receipt.schema_migration;
    const found = targetState.schema_migrations.some(
      (item) =>
        item.from_schema === 14 &&
        item.to_schema === 15 &&
        item.status === 'committed' &&
        item.original_sha256 === expected?.original_sha256
    );
    if (!found) throw releaseError('accepted_schema_manifest_missing');
  }
  return {
    accepted: true,
    mode: receipt.mode,
    schema_version: targetState.schema_version,
    state_sha256: targetState.state_sha256,
    state_canonical_hash: targetState.state_canonical_hash,
    receipt_sha256: receipt.receipt_sha256,
    core_counts: pickCounts(targetState.collection_counts, [
      'projects',
      'assist_sessions',
      'assist_turns',
      'codex_profiles'
    ]),
    legacy_runner_references: []
  };
}

export async function verifyClonedVolumeV17({
  sourceRoot,
  targetRoot,
  manifestPath,
  archiveSha256,
  sourceVolume = V17_SOURCE_VOLUME,
  targetVolume = V17_TARGET_VOLUME,
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
  const sourceState = await stateAudit(sourceRoot);
  if (sourceState.schema_version !== 15)
    throw releaseError('source_state_schema_not_15', { schema_version: sourceState.schema_version });
  validateState15(sourceState.parsed_state);
  const manifest = {
    version: 1,
    migration: 'aiws-volume-v16-to-v17',
    status: 'clone_verified',
    created_at: clock().toISOString(),
    source_volume: sourceVolume,
    target_volume: targetVolume,
    archive_sha256: normalizeSha(archiveSha256),
    source_state: publicStateAudit(sourceState),
    source_inventory: sourceInventory,
    cloned_inventory_hash: targetInventory.hash
  };
  await atomicJsonWrite(manifestPath, withDocumentHash(manifest, 'manifest_sha256'));
  return withoutInventoryEntries(manifest);
}

export async function acceptVolumeMigrationV17({
  mode,
  targetRoot,
  sourceRoot = null,
  cloneManifestPath = null,
  archiveSha256 = null,
  migrationVolume = null,
  sourceVolume = V17_SOURCE_VOLUME,
  targetVolume = V17_TARGET_VOLUME,
  clock = () => new Date()
}) {
  if (!['migrated', 'fresh', 'discarded_unmigratable'].includes(mode))
    throw releaseError('release_acceptance_mode_invalid', { mode });
  const targetState = await stateAudit(targetRoot);
  validateState16(targetState.parsed_state);
  const legacyRunnerReferences = findLegacyRunnerReferencesV17(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  let cloneManifest = null,
    sourceState = null,
    sourceInventory = null,
    preservation = null,
    schemaMigration = null;
  if (mode === 'migrated') {
    if (!sourceRoot || !cloneManifestPath) throw releaseError('migrated_acceptance_source_required');
    cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
    if (cloneManifest.status !== 'clone_verified' || cloneManifest.migration !== 'aiws-volume-v16-to-v17')
      throw releaseError('clone_manifest_not_verified');
    if (cloneManifest.source_volume !== sourceVolume || cloneManifest.target_volume !== targetVolume)
      throw releaseError('clone_manifest_volume_mismatch');
    if (normalizeSha(archiveSha256) !== cloneManifest.archive_sha256) throw releaseError('clone_archive_hash_mismatch');
    sourceState = await stateAudit(sourceRoot);
    sourceInventory = await volumeInventory(sourceRoot);
    if (sourceState.schema_version !== 15)
      throw releaseError('source_state_schema_not_15', { schema_version: sourceState.schema_version });
    if (
      sourceState.state_sha256 !== cloneManifest.source_state.state_sha256 ||
      sourceInventory.hash !== cloneManifest.source_inventory.hash
    )
      throw releaseError('source_changed_after_clone');
    compareStateIdentities(sourceState, targetState);
    preservation = comparePreservedFiles(
      cloneManifest.source_inventory.entries,
      (await volumeInventory(targetRoot)).entries
    );
    schemaMigration =
      targetState.schema_migrations.find(
        (item) =>
          item.from_schema === 15 &&
          item.to_schema === 16 &&
          item.status === 'committed' &&
          item.original_sha256 === sourceState.state_sha256
      ) || null;
    if (!schemaMigration) throw releaseError('schema_15_to_16_manifest_missing');
  } else if (mode === 'discarded_unmigratable' && cloneManifestPath) {
    cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
    sourceState = cloneManifest.source_state;
  }
  const targetInventory = await volumeInventory(targetRoot),
    receipt = {
      version: 1,
      migration: 'aiws-volume-v16-to-v17',
      status: 'accepted',
      accepted: true,
      accepted_at: clock().toISOString(),
      mode,
      source_volume: sourceVolume,
      target_volume: targetVolume,
      migration_volume: migrationVolume || null,
      archive_sha256: cloneManifest?.archive_sha256 || normalizeOptionalSha(archiveSha256),
      source_state: sourceState ? publicStateAudit(sourceState) : null,
      target_state: publicStateAudit(targetState),
      schema_migration: schemaMigration ? publicSchemaMigration(schemaMigration) : null,
      clone_inventory_hash: cloneManifest?.cloned_inventory_hash || null,
      target_inventory: inventorySummary(targetInventory),
      preservation,
      vault_files: keyInventory(targetInventory.entries, 'vault/'),
      codex_home_files: keyInventory(targetInventory.entries, 'codex-homes/'),
      health_verified: true,
      legacy_runner_references: []
    };
  const receiptPath = path.join(targetRoot, ...V17_RECEIPT_RELATIVE_PATH.split('/'));
  await atomicJsonWrite(receiptPath, withDocumentHash(receipt, 'receipt_sha256'));
  return { ...receipt, receipt_path: V17_RECEIPT_RELATIVE_PATH };
}

export async function validateV17ReleaseTarget(targetRoot, expectedTargetVolume = V17_TARGET_VOLUME) {
  const receipt = await readHashedJson(
    path.join(targetRoot, ...V17_RECEIPT_RELATIVE_PATH.split('/')),
    'receipt_sha256'
  );
  if (
    receipt.accepted !== true ||
    receipt.status !== 'accepted' ||
    receipt.target_volume !== expectedTargetVolume ||
    receipt.migration !== 'aiws-volume-v16-to-v17'
  )
    throw releaseError('migration_acceptance_missing');
  const targetState = await stateAudit(targetRoot);
  validateState16(targetState.parsed_state);
  const legacyRunnerReferences = findLegacyRunnerReferencesV17(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  for (const collection of ['projects', 'assist_sessions', 'assist_turns', 'codex_profiles', 'project_briefs']) {
    const expected = receipt.source_state?.record_ids?.[collection];
    if (!expected || receipt.mode !== 'migrated') continue;
    const actualIds = new Set(targetState.record_ids[collection] || []),
      missing = expected.filter((id) => !actualIds.has(id));
    if (missing.length) throw releaseError('accepted_record_ids_missing', { collection, missing });
  }
  if (
    receipt.mode === 'migrated' &&
    !targetState.schema_migrations.some(
      (item) =>
        item.from_schema === 15 &&
        item.to_schema === 16 &&
        item.status === 'committed' &&
        item.original_sha256 === receipt.schema_migration?.original_sha256
    )
  )
    throw releaseError('accepted_schema_manifest_missing');
  return {
    accepted: true,
    mode: receipt.mode,
    schema_version: targetState.schema_version,
    state_sha256: targetState.state_sha256,
    state_canonical_hash: targetState.state_canonical_hash,
    receipt_sha256: receipt.receipt_sha256,
    core_counts: pickCounts(targetState.collection_counts, [
      'projects',
      'assist_sessions',
      'assist_turns',
      'codex_profiles',
      'project_briefs',
      'workflow_drafts',
      'brief_templates'
    ]),
    legacy_runner_references: []
  };
}

export async function verifyClonedVolumeV18({
  sourceRoot,
  targetRoot,
  manifestPath,
  archiveSha256,
  sourceVolume = V18_SOURCE_VOLUME,
  targetVolume = V18_TARGET_VOLUME,
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
  const sourceState = await stateAudit(sourceRoot);
  if (sourceState.schema_version !== 16)
    throw releaseError('source_state_schema_not_16', { schema_version: sourceState.schema_version });
  validateState16(sourceState.parsed_state);
  const manifest = {
    version: 1,
    migration: 'aiws-volume-v17-to-v18',
    status: 'clone_verified',
    created_at: clock().toISOString(),
    source_volume: sourceVolume,
    target_volume: targetVolume,
    archive_sha256: normalizeSha(archiveSha256),
    source_state: publicStateAudit(sourceState),
    source_inventory: sourceInventory,
    cloned_inventory_hash: targetInventory.hash
  };
  await atomicJsonWrite(manifestPath, withDocumentHash(manifest, 'manifest_sha256'));
  return withoutInventoryEntries(manifest);
}

export async function acceptVolumeMigrationV18({
  mode,
  targetRoot,
  sourceRoot = null,
  cloneManifestPath = null,
  archiveSha256 = null,
  migrationVolume = null,
  sourceVolume = V18_SOURCE_VOLUME,
  targetVolume = V18_TARGET_VOLUME,
  clock = () => new Date()
}) {
  if (!['migrated', 'fresh', 'discarded_unmigratable'].includes(mode))
    throw releaseError('release_acceptance_mode_invalid', { mode });
  const targetState = await stateAudit(targetRoot);
  validateState17(targetState.parsed_state);
  const legacyRunnerReferences = findLegacyRunnerReferencesV18(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  let cloneManifest = null,
    sourceState = null,
    sourceInventory = null,
    preservation = null,
    schemaMigration = null;
  if (mode === 'migrated') {
    if (!sourceRoot || !cloneManifestPath) throw releaseError('migrated_acceptance_source_required');
    cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
    if (cloneManifest.status !== 'clone_verified' || cloneManifest.migration !== 'aiws-volume-v17-to-v18')
      throw releaseError('clone_manifest_not_verified');
    if (cloneManifest.source_volume !== sourceVolume || cloneManifest.target_volume !== targetVolume)
      throw releaseError('clone_manifest_volume_mismatch');
    if (normalizeSha(archiveSha256) !== cloneManifest.archive_sha256) throw releaseError('clone_archive_hash_mismatch');
    sourceState = await stateAudit(sourceRoot);
    sourceInventory = await volumeInventory(sourceRoot);
    if (sourceState.schema_version !== 16)
      throw releaseError('source_state_schema_not_16', { schema_version: sourceState.schema_version });
    if (
      sourceState.state_sha256 !== cloneManifest.source_state.state_sha256 ||
      sourceInventory.hash !== cloneManifest.source_inventory.hash
    )
      throw releaseError('source_changed_after_clone');
    compareStateIdentities(sourceState, targetState);
    preservation = comparePreservedFiles(
      cloneManifest.source_inventory.entries,
      (await volumeInventory(targetRoot)).entries
    );
    schemaMigration =
      targetState.schema_migrations.find(
        (item) =>
          item.from_schema === 16 &&
          item.to_schema === 17 &&
          item.status === 'committed' &&
          item.original_sha256 === sourceState.state_sha256
      ) || null;
    if (!schemaMigration) throw releaseError('schema_16_to_17_manifest_missing');
  } else if (mode === 'discarded_unmigratable' && cloneManifestPath) {
    cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
    sourceState = cloneManifest.source_state;
  }
  const targetInventory = await volumeInventory(targetRoot),
    receipt = {
      version: 1,
      migration: 'aiws-volume-v17-to-v18',
      status: 'accepted',
      accepted: true,
      accepted_at: clock().toISOString(),
      mode,
      source_volume: sourceVolume,
      target_volume: targetVolume,
      migration_volume: migrationVolume || null,
      archive_sha256: cloneManifest?.archive_sha256 || normalizeOptionalSha(archiveSha256),
      source_state: sourceState ? publicStateAudit(sourceState) : null,
      target_state: publicStateAudit(targetState),
      schema_migration: schemaMigration ? publicSchemaMigration(schemaMigration) : null,
      clone_inventory_hash: cloneManifest?.cloned_inventory_hash || null,
      target_inventory: inventorySummary(targetInventory),
      preservation,
      vault_files: keyInventory(targetInventory.entries, 'vault/'),
      codex_home_files: keyInventory(targetInventory.entries, 'codex-homes/'),
      health_verified: true,
      legacy_runner_references: []
    };
  const receiptPath = path.join(targetRoot, ...V18_RECEIPT_RELATIVE_PATH.split('/'));
  await atomicJsonWrite(receiptPath, withDocumentHash(receipt, 'receipt_sha256'));
  return { ...receipt, receipt_path: V18_RECEIPT_RELATIVE_PATH };
}

export async function validateV18ReleaseTarget(targetRoot, expectedTargetVolume = V18_TARGET_VOLUME) {
  const receipt = await readHashedJson(
    path.join(targetRoot, ...V18_RECEIPT_RELATIVE_PATH.split('/')),
    'receipt_sha256'
  );
  if (
    receipt.accepted !== true ||
    receipt.status !== 'accepted' ||
    receipt.target_volume !== expectedTargetVolume ||
    receipt.migration !== 'aiws-volume-v17-to-v18'
  )
    throw releaseError('migration_acceptance_missing');
  const targetState = await stateAudit(targetRoot);
  validateState17(targetState.parsed_state);
  const legacyRunnerReferences = findLegacyRunnerReferencesV18(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  for (const collection of [
    'projects',
    'assist_sessions',
    'assist_turns',
    'codex_profiles',
    'project_briefs',
    'workflow_drafts',
    'brief_templates'
  ]) {
    const expected = receipt.source_state?.record_ids?.[collection];
    if (!expected || receipt.mode !== 'migrated') continue;
    const actualIds = new Set(targetState.record_ids[collection] || []),
      missing = expected.filter((id) => !actualIds.has(id));
    if (missing.length) throw releaseError('accepted_record_ids_missing', { collection, missing });
  }
  if (
    receipt.mode === 'migrated' &&
    !targetState.schema_migrations.some(
      (item) =>
        item.from_schema === 16 &&
        item.to_schema === 17 &&
        item.status === 'committed' &&
        item.original_sha256 === receipt.schema_migration?.original_sha256
    )
  )
    throw releaseError('accepted_schema_manifest_missing');
  return {
    accepted: true,
    mode: receipt.mode,
    schema_version: targetState.schema_version,
    state_sha256: targetState.state_sha256,
    state_canonical_hash: targetState.state_canonical_hash,
    receipt_sha256: receipt.receipt_sha256,
    core_counts: pickCounts(targetState.collection_counts, [
      'projects',
      'assist_sessions',
      'assist_turns',
      'codex_profiles',
      'project_briefs',
      'workflow_drafts',
      'brief_templates',
      'mcp_clients'
    ]),
    legacy_runner_references: []
  };
}

export async function verifyClonedVolumeV19({
  sourceRoot,
  targetRoot,
  manifestPath,
  archiveSha256,
  sourceVolume = V19_SOURCE_VOLUME,
  targetVolume = V19_TARGET_VOLUME,
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
  const sourceState = await stateAudit(sourceRoot);
  if (sourceState.schema_version !== 17)
    throw releaseError('source_state_schema_not_17', { schema_version: sourceState.schema_version });
  validateState17(sourceState.parsed_state);
  const manifest = {
    version: 1,
    migration: 'aiws-volume-v18-to-v19',
    status: 'clone_verified',
    created_at: clock().toISOString(),
    source_volume: sourceVolume,
    target_volume: targetVolume,
    archive_sha256: normalizeSha(archiveSha256),
    source_state: publicStateAudit(sourceState),
    source_inventory: sourceInventory,
    cloned_inventory_hash: targetInventory.hash
  };
  await atomicJsonWrite(manifestPath, withDocumentHash(manifest, 'manifest_sha256'));
  return withoutInventoryEntries(manifest);
}

export async function acceptVolumeMigrationV19({
  mode,
  targetRoot,
  sourceRoot = null,
  cloneManifestPath = null,
  archiveSha256 = null,
  migrationVolume = null,
  sourceVolume = V19_SOURCE_VOLUME,
  targetVolume = V19_TARGET_VOLUME,
  clock = () => new Date()
}) {
  if (!['migrated', 'fresh', 'discarded_unmigratable'].includes(mode))
    throw releaseError('release_acceptance_mode_invalid', { mode });
  const targetState = await stateAudit(targetRoot);
  validateState18(targetState.parsed_state);
  const legacyRunnerReferences = findLegacyRunnerReferencesV19(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  let cloneManifest = null,
    sourceState = null,
    sourceInventory = null,
    preservation = null,
    schemaMigration = null;
  if (mode === 'migrated') {
    if (!sourceRoot || !cloneManifestPath) throw releaseError('migrated_acceptance_source_required');
    cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
    if (cloneManifest.status !== 'clone_verified' || cloneManifest.migration !== 'aiws-volume-v18-to-v19')
      throw releaseError('clone_manifest_not_verified');
    if (cloneManifest.source_volume !== sourceVolume || cloneManifest.target_volume !== targetVolume)
      throw releaseError('clone_manifest_volume_mismatch');
    if (normalizeSha(archiveSha256) !== cloneManifest.archive_sha256) throw releaseError('clone_archive_hash_mismatch');
    sourceState = await stateAudit(sourceRoot);
    sourceInventory = await volumeInventory(sourceRoot);
    if (sourceState.schema_version !== 17)
      throw releaseError('source_state_schema_not_17', { schema_version: sourceState.schema_version });
    if (
      sourceState.state_sha256 !== cloneManifest.source_state.state_sha256 ||
      sourceInventory.hash !== cloneManifest.source_inventory.hash
    )
      throw releaseError('source_changed_after_clone');
    compareStateIdentities(sourceState, targetState);
    preservation = comparePreservedFiles(
      cloneManifest.source_inventory.entries,
      (await volumeInventory(targetRoot)).entries
    );
    schemaMigration =
      targetState.schema_migrations.find(
        (item) =>
          item.from_schema === 17 &&
          item.to_schema === 18 &&
          item.status === 'committed' &&
          item.original_sha256 === sourceState.state_sha256
      ) || null;
    if (!schemaMigration) throw releaseError('schema_17_to_18_manifest_missing');
  } else if (mode === 'discarded_unmigratable' && cloneManifestPath) {
    cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
    sourceState = cloneManifest.source_state;
  }
  const targetInventory = await volumeInventory(targetRoot),
    receipt = {
      version: 1,
      migration: 'aiws-volume-v18-to-v19',
      status: 'accepted',
      accepted: true,
      accepted_at: clock().toISOString(),
      mode,
      source_volume: sourceVolume,
      target_volume: targetVolume,
      migration_volume: migrationVolume || null,
      archive_sha256: cloneManifest?.archive_sha256 || normalizeOptionalSha(archiveSha256),
      source_state: sourceState ? publicStateAudit(sourceState) : null,
      target_state: publicStateAudit(targetState),
      schema_migration: schemaMigration ? publicSchemaMigration(schemaMigration) : null,
      clone_inventory_hash: cloneManifest?.cloned_inventory_hash || null,
      target_inventory: inventorySummary(targetInventory),
      preservation,
      vault_files: keyInventory(targetInventory.entries, 'vault/'),
      codex_home_files: keyInventory(targetInventory.entries, 'codex-homes/'),
      health_verified: true,
      legacy_runner_references: []
    };
  const receiptPath = path.join(targetRoot, ...V19_RECEIPT_RELATIVE_PATH.split('/'));
  await atomicJsonWrite(receiptPath, withDocumentHash(receipt, 'receipt_sha256'));
  return { ...receipt, receipt_path: V19_RECEIPT_RELATIVE_PATH };
}

export async function validateV19ReleaseTarget(targetRoot, expectedTargetVolume = V19_TARGET_VOLUME) {
  const receipt = await readHashedJson(
    path.join(targetRoot, ...V19_RECEIPT_RELATIVE_PATH.split('/')),
    'receipt_sha256'
  );
  if (
    receipt.accepted !== true ||
    receipt.status !== 'accepted' ||
    receipt.target_volume !== expectedTargetVolume ||
    receipt.migration !== 'aiws-volume-v18-to-v19'
  )
    throw releaseError('migration_acceptance_missing');
  const targetState = await stateAudit(targetRoot);
  validateState18(targetState.parsed_state);
  const legacyRunnerReferences = findLegacyRunnerReferencesV19(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  for (const collection of [
    'projects',
    'workflows',
    'workflow_nodes',
    'workspaces',
    'node_contracts',
    'node_runs',
    'assets',
    'traces',
    'assist_sessions',
    'assist_turns',
    'codex_profiles',
    'project_briefs',
    'workflow_drafts',
    'brief_templates',
    'mcp_clients'
  ]) {
    const expected = receipt.source_state?.record_ids?.[collection];
    if (!expected || receipt.mode !== 'migrated') continue;
    const actualIds = new Set(targetState.record_ids[collection] || []),
      missing = expected.filter((id) => !actualIds.has(id));
    if (missing.length) throw releaseError('accepted_record_ids_missing', { collection, missing });
  }
  if (
    receipt.mode === 'migrated' &&
    !targetState.schema_migrations.some(
      (item) =>
        item.from_schema === 17 &&
        item.to_schema === 18 &&
        item.status === 'committed' &&
        item.original_sha256 === receipt.schema_migration?.original_sha256
    )
  )
    throw releaseError('accepted_schema_manifest_missing');
  return {
    accepted: true,
    mode: receipt.mode,
    schema_version: targetState.schema_version,
    state_sha256: targetState.state_sha256,
    state_canonical_hash: targetState.state_canonical_hash,
    receipt_sha256: receipt.receipt_sha256,
    core_counts: pickCounts(targetState.collection_counts, [
      'projects',
      'workflows',
      'workflow_nodes',
      'assist_sessions',
      'workflow_generations',
      'repository_connections',
      'repository_targets',
      'delivery_policies',
      'deliveries',
      'workflow_migration_batches',
      'workflow_migration_jobs'
    ]),
    legacy_runner_references: []
  };
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  const modern = await executeModernReleaseCommand(command, args);
  let result;
  if (modern.matched) result = modern.result;
  else if (command === 'audit') result = await auditVolume(required(args[0], 'volume_root_required'));
  else if (command === 'clone-verify')
    result = await verifyClonedVolume({
      sourceRoot: required(args[0], 'source_root_required'),
      targetRoot: required(args[1], 'target_root_required'),
      manifestPath: required(args[2], 'clone_manifest_path_required'),
      archiveSha256: required(args[3], 'archive_sha_required'),
      sourceVolume: args[4] || SOURCE_VOLUME,
      targetVolume: args[5] || TARGET_VOLUME
    });
  else if (command === 'accept')
    result = await acceptVolumeMigration({
      mode: required(args[0], 'acceptance_mode_required'),
      targetRoot: required(args[1], 'target_root_required'),
      sourceRoot: optional(args[2]),
      cloneManifestPath: optional(args[3]),
      archiveSha256: optional(args[4]),
      migrationVolume: optional(args[5]),
      sourceVolume: args[6] || SOURCE_VOLUME,
      targetVolume: args[7] || TARGET_VOLUME
    });
  else if (command === 'check-purge')
    result = await validatePurgeTarget(required(args[0], 'target_root_required'), args[1] || TARGET_VOLUME);
  else if (command === 'clone-verify-v17')
    result = await verifyClonedVolumeV17({
      sourceRoot: required(args[0], 'source_root_required'),
      targetRoot: required(args[1], 'target_root_required'),
      manifestPath: required(args[2], 'clone_manifest_path_required'),
      archiveSha256: required(args[3], 'archive_sha_required'),
      sourceVolume: args[4] || V17_SOURCE_VOLUME,
      targetVolume: args[5] || V17_TARGET_VOLUME
    });
  else if (command === 'accept-v17')
    result = await acceptVolumeMigrationV17({
      mode: required(args[0], 'acceptance_mode_required'),
      targetRoot: required(args[1], 'target_root_required'),
      sourceRoot: optional(args[2]),
      cloneManifestPath: optional(args[3]),
      archiveSha256: optional(args[4]),
      migrationVolume: optional(args[5]),
      sourceVolume: args[6] || V17_SOURCE_VOLUME,
      targetVolume: args[7] || V17_TARGET_VOLUME
    });
  else if (command === 'check-v17')
    result = await validateV17ReleaseTarget(required(args[0], 'target_root_required'), args[1] || V17_TARGET_VOLUME);
  else if (command === 'clone-verify-v18')
    result = await verifyClonedVolumeV18({
      sourceRoot: required(args[0], 'source_root_required'),
      targetRoot: required(args[1], 'target_root_required'),
      manifestPath: required(args[2], 'clone_manifest_path_required'),
      archiveSha256: required(args[3], 'archive_sha_required'),
      sourceVolume: args[4] || V18_SOURCE_VOLUME,
      targetVolume: args[5] || V18_TARGET_VOLUME
    });
  else if (command === 'accept-v18')
    result = await acceptVolumeMigrationV18({
      mode: required(args[0], 'acceptance_mode_required'),
      targetRoot: required(args[1], 'target_root_required'),
      sourceRoot: optional(args[2]),
      cloneManifestPath: optional(args[3]),
      archiveSha256: optional(args[4]),
      migrationVolume: optional(args[5]),
      sourceVolume: args[6] || V18_SOURCE_VOLUME,
      targetVolume: args[7] || V18_TARGET_VOLUME
    });
  else if (command === 'check-v18')
    result = await validateV18ReleaseTarget(required(args[0], 'target_root_required'), args[1] || V18_TARGET_VOLUME);
  else throw releaseError('release_volume_usage');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function executeModernReleaseCommand(command, args) {
  if (command === 'clone-verify-v19')
    return {
      matched: true,
      result: await verifyClonedVolumeV19({
        sourceRoot: required(args[0], 'source_root_required'),
        targetRoot: required(args[1], 'target_root_required'),
        manifestPath: required(args[2], 'clone_manifest_path_required'),
        archiveSha256: required(args[3], 'archive_sha_required'),
        sourceVolume: args[4] || V19_SOURCE_VOLUME,
        targetVolume: args[5] || V19_TARGET_VOLUME
      })
    };
  if (command === 'accept-v19')
    return {
      matched: true,
      result: await acceptVolumeMigrationV19({
        mode: required(args[0], 'acceptance_mode_required'),
        targetRoot: required(args[1], 'target_root_required'),
        sourceRoot: optional(args[2]),
        cloneManifestPath: optional(args[3]),
        archiveSha256: optional(args[4]),
        migrationVolume: optional(args[5]),
        sourceVolume: args[6] || V19_SOURCE_VOLUME,
        targetVolume: args[7] || V19_TARGET_VOLUME
      })
    };
  if (command === 'check-v19')
    return {
      matched: true,
      result: await validateV19ReleaseTarget(required(args[0], 'target_root_required'), args[1] || V19_TARGET_VOLUME)
    };
  if (command === 'clone-verify-v20')
    return {
      matched: true,
      result: await verifyClonedVolumeV20({
        sourceRoot: required(args[0], 'source_root_required'),
        targetRoot: required(args[1], 'target_root_required'),
        manifestPath: required(args[2], 'clone_manifest_path_required'),
        archiveSha256: required(args[3], 'archive_sha_required'),
        sourceVolume: args[4] || V20_SOURCE_VOLUME,
        targetVolume: args[5] || V20_TARGET_VOLUME
      })
    };
  if (command === 'accept-v20')
    return {
      matched: true,
      result: await acceptVolumeMigrationV20({
        targetRoot: required(args[0], 'target_root_required'),
        sourceRoot: required(args[1], 'source_root_required'),
        cloneManifestPath: required(args[2], 'clone_manifest_path_required'),
        archiveSha256: required(args[3], 'archive_sha_required'),
        migrationVolume: optional(args[4]),
        sourceVolume: args[5] || V20_SOURCE_VOLUME,
        targetVolume: args[6] || V20_TARGET_VOLUME
      })
    };
  if (command === 'check-v20')
    return {
      matched: true,
      result: await validateV20ReleaseTarget(required(args[0], 'target_root_required'), args[1] || V20_TARGET_VOLUME, {
        deferProjection: args[2] === 'defer-projection'
      })
    };
  const v21 = await executeV21ReleaseCommand(command, args);
  if (v21.matched) return v21;
  if (command === 'purge-schema-backups')
    return {
      matched: true,
      result: { removed: await removeLegacySchemaBackups(required(args[0], 'target_root_required')) }
    };
  return { matched: false, result: null };
}

function required(value, code) {
  if (!value || value === '-') throw releaseError(code);
  return value;
}

function optional(value) {
  return !value || value === '-' ? null : value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli().catch((error) => {
    process.stderr.write(
      `${error.code || 'release_volume_failed'}${Object.keys(error.details || {}).length ? ` ${JSON.stringify(error.details)}` : ''}\n`
    );
    process.exitCode = 1;
  });
}
