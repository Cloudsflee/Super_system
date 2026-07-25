#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  canonicalJson,
  canonicalStateHash,
  LEGACY_OFFICIAL_RUNNER_PATTERN,
  validateState15
} from '../apps/api/src/state-migration-v15.mjs';
import { validateState16, V16_LEGACY_OFFICIAL_RUNNER_PATTERN } from '../apps/api/src/state-migration-v16.mjs';
import { validateState17, V17_LEGACY_OFFICIAL_RUNNER_PATTERN } from '../apps/api/src/state-migration-v17.mjs';
import { validateState18, V18_LEGACY_OFFICIAL_RUNNER_PATTERN } from '../apps/api/src/state-migration-v18.mjs';

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

export async function auditVolume(root) {
  const inventory = await volumeInventory(root);
  const state = await stateAudit(root);
  return {
    inventory: inventorySummary(inventory),
    state: { ...publicStateAudit(state), schema_migrations: state.schema_migrations.map(publicSchemaMigration) }
  };
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

export async function removeLegacySchemaBackups(targetRoot) {
  const directory = path.join(targetRoot, 'data', 'migrations');
  if (!fs.existsSync(directory)) return [];
  const removed = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.name.endsWith('.manifest.json') ||
      !/^state-schema(?:[0-9]|1[0-4])-.+\.json$/.test(entry.name)
    )
      continue;
    const file = path.join(directory, entry.name);
    await fsp.rm(file, { force: true });
    removed.push(entry.name);
  }
  return removed.sort();
}

export async function volumeInventory(root) {
  const absoluteRoot = path.resolve(root);
  const entries = [];
  await walk(absoluteRoot, '');
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    hash: sha256(Buffer.from(canonicalJson(entries))),
    files: entries.filter((item) => item.type === 'file').length,
    directories: entries.filter((item) => item.type === 'directory').length,
    symlinks: entries.filter((item) => item.type === 'symlink').length,
    total_bytes: entries.reduce((total, item) => total + (item.size || 0), 0),
    entries
  };

  async function walk(directory, relativeDirectory) {
    const children = await fsp.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (transientCodexPath(relative)) continue;
      const absolute = path.join(directory, child.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        const target = await fsp.readlink(absolute);
        assertSafeSymlink(relative, target);
        entries.push({ path: relative, type: 'symlink', target });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        await walk(absolute, relative);
      } else if (stat.isFile()) {
        entries.push({ path: relative, type: 'file', size: stat.size, sha256: await fileSha256(absolute) });
      } else {
        throw releaseError('volume_member_type_invalid', { path: relative });
      }
    }
  }
}

export async function stateAudit(root) {
  const stateFile = path.join(root, 'data', 'state.json');
  const bytes = await fsp.readFile(stateFile);
  const state = JSON.parse(bytes.toString('utf8'));
  const collectionNames = Object.keys(state)
    .filter((key) => Array.isArray(state[key]))
    .sort();
  const collectionCounts = Object.fromEntries(collectionNames.map((key) => [key, state[key].length]));
  const recordIds = Object.fromEntries(
    collectionNames.map((key) => [key, state[key].map(recordIdentity).filter(Boolean).sort()])
  );
  return {
    schema_version: Number(state.schema_version),
    state_bytes: bytes.length,
    state_sha256: sha256(bytes),
    state_canonical_hash: canonicalStateHash(state),
    collection_counts: collectionCounts,
    record_ids: recordIds,
    record_ids_sha256: sha256(Buffer.from(canonicalJson(recordIds))),
    legacy_runner_references: findLegacyRunnerReferences(state),
    schema_migrations: await schemaMigrationManifests(root),
    parsed_state: state
  };
}

function compareStateIdentities(source, target) {
  for (const collection of Object.keys(source.collection_counts)) {
    if (source.collection_counts[collection] !== target.collection_counts[collection])
      throw releaseError('migrated_collection_count_mismatch', {
        collection,
        source: source.collection_counts[collection],
        target: target.collection_counts[collection]
      });
    if (canonicalJson(source.record_ids[collection]) !== canonicalJson(target.record_ids[collection]))
      throw releaseError('migrated_record_ids_mismatch', { collection });
  }
}

function comparePreservedFiles(sourceEntries, targetEntries) {
  const target = new Map(targetEntries.map((item) => [item.path, item]));
  const changedAllowed = [];
  let verified = 0;
  for (const expected of sourceEntries) {
    const actual = target.get(expected.path);
    if (!actual) throw releaseError('migrated_file_missing', { path: expected.path });
    if (mutableMigrationPath(expected.path)) {
      if (actual.type !== expected.type) throw releaseError('migrated_file_type_changed', { path: expected.path });
      if (canonicalJson(actual) !== canonicalJson(expected)) changedAllowed.push(expected.path);
    } else if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw releaseError('migrated_file_changed', { path: expected.path });
    } else verified += 1;
  }
  return { source_members_verified: verified, allowed_changed_paths: changedAllowed.sort(), missing_paths: [] };
}

function mutableMigrationPath(value) {
  return value === 'data/state.json' || /^codex-homes\/[^/]+\/config\.toml$/.test(value);
}

function findLegacyRunnerReferences(value) {
  const found = [];
  visit(value, []);
  return found.sort((left, right) => left.path.localeCompare(right.path));
  function visit(current, parts) {
    if (typeof current === 'string') {
      if (LEGACY_OFFICIAL_RUNNER_PATTERN.test(current)) found.push({ path: parts.join('.'), image: current });
      return;
    }
    if (Array.isArray(current)) return current.forEach((item, index) => visit(item, [...parts, String(index)]));
    if (current && typeof current === 'object')
      for (const [key, item] of Object.entries(current)) visit(item, [...parts, key]);
  }
}
function findLegacyRunnerReferencesV17(value) {
  const found = [];
  visit(value, []);
  return found.sort((left, right) => left.path.localeCompare(right.path));
  function visit(current, parts) {
    if (typeof current === 'string') {
      if (V16_LEGACY_OFFICIAL_RUNNER_PATTERN.test(current)) found.push({ path: parts.join('.'), image: current });
      return;
    }
    if (Array.isArray(current)) return current.forEach((item, index) => visit(item, [...parts, String(index)]));
    if (current && typeof current === 'object')
      for (const [key, item] of Object.entries(current)) visit(item, [...parts, key]);
  }
}
function findLegacyRunnerReferencesV18(value) {
  const found = [];
  visit(value, []);
  return found.sort((left, right) => left.path.localeCompare(right.path));
  function visit(current, parts) {
    if (typeof current === 'string') {
      if (V17_LEGACY_OFFICIAL_RUNNER_PATTERN.test(current)) found.push({ path: parts.join('.'), image: current });
      return;
    }
    if (Array.isArray(current)) return current.forEach((item, index) => visit(item, [...parts, String(index)]));
    if (current && typeof current === 'object')
      for (const [key, item] of Object.entries(current)) visit(item, [...parts, key]);
  }
}
function findLegacyRunnerReferencesV19(value) {
  const found = [];
  visit(value, []);
  return found.sort((left, right) => left.path.localeCompare(right.path));
  function visit(current, parts) {
    if (typeof current === 'string') {
      if (V18_LEGACY_OFFICIAL_RUNNER_PATTERN.test(current)) found.push({ path: parts.join('.'), image: current });
      return;
    }
    if (Array.isArray(current)) return current.forEach((item, index) => visit(item, [...parts, String(index)]));
    if (current && typeof current === 'object')
      for (const [key, item] of Object.entries(current)) visit(item, [...parts, key]);
  }
}

async function schemaMigrationManifests(root) {
  const directory = path.join(root, 'data', 'migrations');
  if (!fs.existsSync(directory)) return [];
  const manifests = [];
  for (const name of (await fsp.readdir(directory))
    .filter((item) => item.endsWith('.manifest.json') && item !== path.basename(RECEIPT_RELATIVE_PATH))
    .sort()) {
    try {
      const value = JSON.parse(await fsp.readFile(path.join(directory, name), 'utf8'));
      if (Number.isFinite(Number(value.from_schema)) && Number.isFinite(Number(value.to_schema)))
        manifests.push({ file: name, ...value });
    } catch {
      throw releaseError('schema_migration_manifest_invalid', { file: name });
    }
  }
  return manifests;
}

function publicStateAudit(value) {
  return {
    schema_version: value.schema_version,
    state_bytes: value.state_bytes,
    state_sha256: value.state_sha256,
    state_canonical_hash: value.state_canonical_hash,
    collection_counts: value.collection_counts,
    record_ids: value.record_ids,
    record_ids_sha256: value.record_ids_sha256,
    legacy_runner_references: value.legacy_runner_references
  };
}

function publicSchemaMigration(value) {
  return {
    file: value.file,
    status: value.status,
    from_schema: value.from_schema,
    to_schema: value.to_schema,
    original_sha256: value.original_sha256,
    original_state_hash: value.original_state_hash,
    migrated_sha256: value.migrated_sha256,
    migrated_state_hash: value.migrated_state_hash,
    repaired_shared_forks: value.repaired_shared_forks,
    normalized_runner_profiles: value.normalized_runner_profiles || [],
    staled_runner_probes: value.staled_runner_probes || 0,
    migrated_briefs: value.migrated_briefs || 0,
    created_workflow_drafts: value.created_workflow_drafts || 0,
    created_mcp_clients: value.created_mcp_clients || 0,
    legacy_workflow_ids: value.legacy_workflow_ids || [],
    repository_connection_ids: value.repository_connection_ids || [],
    legacy_assist_session_ids: value.legacy_assist_session_ids || []
  };
}

function inventorySummary(value) {
  return {
    hash: value.hash,
    files: value.files,
    directories: value.directories,
    symlinks: value.symlinks,
    total_bytes: value.total_bytes
  };
}

function withoutInventoryEntries(value) {
  return { ...value, source_inventory: inventorySummary(value.source_inventory) };
}

function keyInventory(entries, prefix) {
  return entries
    .filter((item) => item.path === prefix.slice(0, -1) || item.path.startsWith(prefix))
    .map((item) => item.path);
}

function transientCodexPath(value) {
  const parts = value.split('/');
  return parts.length >= 3 && parts[0] === 'codex-homes' && parts[2] === 'tmp';
}

function assertSafeSymlink(name, target) {
  if (!target || target.includes('\\') || target.includes('\0') || path.posix.isAbsolute(target))
    throw releaseError('volume_symlink_target_invalid', { path: name });
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
  if (resolved === '..' || resolved.startsWith('../'))
    throw releaseError('volume_symlink_target_outside', { path: name });
}

function recordIdentity(item, index) {
  if (!item || typeof item !== 'object') return `@${index}`;
  if (item.id != null && String(item.id)) return String(item.id);
  if (item.key != null && String(item.key)) return `${item.key}:${item.profile_id || item.project_id || ''}`;
  return `@${index}`;
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeSha(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw releaseError('sha256_invalid');
  return normalized;
}

function normalizeOptionalSha(value) {
  return value == null || value === '' || value === '-' ? null : normalizeSha(value);
}

function withDocumentHash(value, field) {
  return { ...value, [field]: sha256(Buffer.from(canonicalJson(value))) };
}

async function readHashedJson(file, field) {
  const value = JSON.parse(await fsp.readFile(file, 'utf8'));
  const expected = value[field];
  const unsigned = { ...value };
  delete unsigned[field];
  if (expected !== sha256(Buffer.from(canonicalJson(unsigned))))
    throw releaseError('release_manifest_hash_mismatch', { file: path.basename(file) });
  return value;
}

async function atomicJsonWrite(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, file);
}

function pickCounts(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key] || 0]));
}

function releaseError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

async function cli() {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'audit') result = await auditVolume(required(args[0], 'volume_root_required'));
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
  else if (command === 'clone-verify-v19')
    result = await verifyClonedVolumeV19({
      sourceRoot: required(args[0], 'source_root_required'),
      targetRoot: required(args[1], 'target_root_required'),
      manifestPath: required(args[2], 'clone_manifest_path_required'),
      archiveSha256: required(args[3], 'archive_sha_required'),
      sourceVolume: args[4] || V19_SOURCE_VOLUME,
      targetVolume: args[5] || V19_TARGET_VOLUME
    });
  else if (command === 'accept-v19')
    result = await acceptVolumeMigrationV19({
      mode: required(args[0], 'acceptance_mode_required'),
      targetRoot: required(args[1], 'target_root_required'),
      sourceRoot: optional(args[2]),
      cloneManifestPath: optional(args[3]),
      archiveSha256: optional(args[4]),
      migrationVolume: optional(args[5]),
      sourceVolume: args[6] || V19_SOURCE_VOLUME,
      targetVolume: args[7] || V19_TARGET_VOLUME
    });
  else if (command === 'check-v19')
    result = await validateV19ReleaseTarget(required(args[0], 'target_root_required'), args[1] || V19_TARGET_VOLUME);
  else if (command === 'purge-schema-backups')
    result = { removed: await removeLegacySchemaBackups(required(args[0], 'target_root_required')) };
  else throw releaseError('release_volume_usage');
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
