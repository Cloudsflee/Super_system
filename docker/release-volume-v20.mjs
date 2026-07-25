import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../apps/api/src/state-migration-v15.mjs';
import { validateState19 } from '../apps/api/src/state-migration-v19.mjs';
import { V20_SOURCE_COLLECTIONS, validateState20 } from '../apps/api/src/state-migration-v20.mjs';
import {
  contextHash,
  contextIndexableNodes,
  contextSearchIndexSnapshotHash
} from '../packages/system-context/src/index.mjs';
import {
  atomicJsonWrite,
  comparePreservedFiles,
  findLegacyRunnerReferencesV20,
  inventorySummary,
  keyInventory,
  normalizeSha,
  pickCounts,
  publicSchemaMigration,
  publicStateAudit,
  readHashedJson,
  releaseError,
  stateAudit,
  volumeInventory,
  withDocumentHash,
  withoutInventoryEntries
} from './release-volume-validation.mjs';

export const V20_SOURCE_VOLUME = 'aiws-data-v19';
export const V20_TARGET_VOLUME = 'aiws-data-v20';
export const V20_RECEIPT_RELATIVE_PATH = 'data/migrations/v20-volume-migration.manifest.json';

export async function verifyClonedVolumeV20({
  sourceRoot,
  targetRoot,
  manifestPath,
  archiveSha256,
  sourceVolume = V20_SOURCE_VOLUME,
  targetVolume = V20_TARGET_VOLUME,
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
  if (sourceState.schema_version !== 19)
    throw releaseError('source_state_schema_not_19', { schema_version: sourceState.schema_version });
  validateState19(sourceState.parsed_state);
  const manifest = {
    version: 1,
    migration: 'aiws-volume-v19-to-v20',
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

export async function acceptVolumeMigrationV20({
  targetRoot,
  sourceRoot,
  cloneManifestPath,
  archiveSha256,
  migrationVolume = null,
  sourceVolume = V20_SOURCE_VOLUME,
  targetVolume = V20_TARGET_VOLUME,
  clock = () => new Date()
}) {
  if (!sourceRoot || !cloneManifestPath) throw releaseError('migrated_acceptance_source_required');
  const cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
  if (cloneManifest.status !== 'clone_verified' || cloneManifest.migration !== 'aiws-volume-v19-to-v20')
    throw releaseError('clone_manifest_not_verified');
  if (cloneManifest.source_volume !== sourceVolume || cloneManifest.target_volume !== targetVolume)
    throw releaseError('clone_manifest_volume_mismatch');
  if (normalizeSha(archiveSha256) !== cloneManifest.archive_sha256) throw releaseError('clone_archive_hash_mismatch');

  const sourceState = await stateAudit(sourceRoot),
    sourceInventory = await volumeInventory(sourceRoot),
    targetState = await stateAudit(targetRoot);
  if (sourceState.schema_version !== 19)
    throw releaseError('source_state_schema_not_19', { schema_version: sourceState.schema_version });
  validateState19(sourceState.parsed_state);
  if (
    sourceState.state_sha256 !== cloneManifest.source_state.state_sha256 ||
    sourceInventory.hash !== cloneManifest.source_inventory.hash
  )
    throw releaseError('source_changed_after_clone');
  validateState20(targetState.parsed_state);
  compareV20SourceIdentities(sourceState, targetState);
  const legacyRunnerReferences = findLegacyRunnerReferencesV20(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  const schemaMigration =
    targetState.schema_migrations.find(
      (item) =>
        item.from_schema === 19 &&
        item.to_schema === 20 &&
        item.status === 'committed' &&
        item.original_sha256 === sourceState.state_sha256
    ) || null;
  if (!schemaMigration) throw releaseError('schema_19_to_20_manifest_missing');
  const projection = await auditV20Projection(targetRoot, targetState.parsed_state);
  const targetInventory = await volumeInventory(targetRoot),
    preservation = comparePreservedFiles(cloneManifest.source_inventory.entries, targetInventory.entries),
    receipt = {
      version: 1,
      migration: 'aiws-volume-v19-to-v20',
      status: 'accepted',
      accepted: true,
      accepted_at: clock().toISOString(),
      mode: 'migrated',
      source_volume: sourceVolume,
      target_volume: targetVolume,
      migration_volume: migrationVolume,
      archive_sha256: cloneManifest.archive_sha256,
      source_state: publicStateAudit(sourceState),
      target_state: publicStateAudit(targetState),
      schema_migration: publicSchemaMigration(schemaMigration),
      clone_inventory_hash: cloneManifest.cloned_inventory_hash,
      target_inventory: inventorySummary(targetInventory),
      preservation,
      projection,
      vault_files: keyInventory(targetInventory.entries, 'vault/'),
      codex_home_files: keyInventory(targetInventory.entries, 'codex-homes/'),
      source_preserved: true,
      health_verified: true,
      legacy_runner_references: []
    };
  const receiptPath = path.join(targetRoot, ...V20_RECEIPT_RELATIVE_PATH.split('/'));
  await atomicJsonWrite(receiptPath, withDocumentHash(receipt, 'receipt_sha256'));
  return { ...receipt, receipt_path: V20_RECEIPT_RELATIVE_PATH };
}

export async function validateV20ReleaseTarget(targetRoot, expectedTargetVolume = V20_TARGET_VOLUME) {
  const receipt = await readHashedJson(
    path.join(targetRoot, ...V20_RECEIPT_RELATIVE_PATH.split('/')),
    'receipt_sha256'
  );
  if (
    receipt.accepted !== true ||
    receipt.status !== 'accepted' ||
    receipt.mode !== 'migrated' ||
    receipt.source_volume !== V20_SOURCE_VOLUME ||
    receipt.target_volume !== expectedTargetVolume ||
    receipt.migration !== 'aiws-volume-v19-to-v20' ||
    receipt.source_preserved !== true
  )
    throw releaseError('migration_acceptance_missing');
  const targetState = await stateAudit(targetRoot);
  validateState20(targetState.parsed_state);
  const legacyRunnerReferences = findLegacyRunnerReferencesV20(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  for (const collection of V20_SOURCE_COLLECTIONS) {
    const expected = receipt.source_state?.record_ids?.[collection];
    if (!expected) continue;
    const actualIds = new Set(targetState.record_ids[collection] || []),
      missing = expected.filter((id) => !actualIds.has(id));
    if (missing.length) throw releaseError('accepted_record_ids_missing', { collection, missing });
  }
  if (
    !targetState.schema_migrations.some(
      (item) =>
        item.from_schema === 19 &&
        item.to_schema === 20 &&
        item.status === 'committed' &&
        item.original_sha256 === receipt.schema_migration?.original_sha256
    )
  )
    throw releaseError('accepted_schema_manifest_missing');
  const projection = await auditV20Projection(targetRoot, targetState.parsed_state);
  return {
    accepted: true,
    mode: receipt.mode,
    schema_version: targetState.schema_version,
    state_sha256: targetState.state_sha256,
    state_canonical_hash: targetState.state_canonical_hash,
    receipt_sha256: receipt.receipt_sha256,
    source_preserved: true,
    projection,
    core_counts: pickCounts(targetState.collection_counts, [
      'projects',
      'workflows',
      'workflow_nodes',
      'context_nodes',
      'context_document_versions',
      'context_edges',
      'context_projection_jobs'
    ]),
    legacy_runner_references: []
  };
}

async function auditV20Projection(targetRoot, state) {
  const coverage = state.context_projection_coverage;
  const sourceRecords = V20_SOURCE_COLLECTIONS.reduce((total, collection) => total + state[collection].length, 0);
  if (
    !coverage ||
    Number(coverage.source_records) !== sourceRecords ||
    Number(coverage.projected_records) !== sourceRecords ||
    !Array.isArray(coverage.warnings) ||
    coverage.warnings.length
  )
    throw releaseError('context_projection_coverage_invalid', { coverage, source_records: sourceRecords });
  const versionById = new Map(state.context_document_versions.map((version) => [version.id, version]));
  const activeNodes = state.context_nodes.filter((node) => node.status === 'active');
  const currentVersions = [];
  for (const node of activeNodes) {
    const version = versionById.get(node.current_version_id);
    if (
      !version ||
      version.node_id !== node.id ||
      version.source_hash !== node.source_hash ||
      version.immutable !== true ||
      version.content_sha256 !== version.markdown_hash
    )
      throw releaseError('context_projection_current_version_invalid', { node_id: node.id });
    currentVersions.push(version);
  }
  const unfinishedJobs = state.context_projection_jobs.filter((job) =>
    ['pending', 'running', 'failed'].includes(job.status)
  );
  if (unfinishedJobs.length)
    throw releaseError('context_projection_jobs_incomplete', {
      jobs: unfinishedJobs.slice(0, 50).map((job) => ({ id: job.id, status: job.status, error_code: job.error_code }))
    });
  const casRoot = path.resolve(targetRoot, 'cas');
  for (const version of currentVersions) {
    const storagePath = String(version.cas_ref?.storage_path || '').replaceAll('\\', '/');
    if (!storagePath || storagePath.startsWith('/') || storagePath.split('/').includes('..'))
      throw releaseError('context_projection_cas_path_invalid', { version_id: version.id });
    const file = path.resolve(casRoot, ...storagePath.split('/')),
      relative = path.relative(casRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw releaseError('context_projection_cas_path_invalid', { version_id: version.id });
    const bytes = await pathBytes(file, version.id);
    if (
      bytes.length !== Number(version.size_bytes) ||
      contextHash(bytes) !== version.content_sha256 ||
      version.cas_ref.sha256 !== version.content_sha256
    )
      throw releaseError('context_projection_cas_integrity_invalid', { version_id: version.id });
  }
  const indexFile = path.join(targetRoot, 'data', '.context-index', 'minisearch-v1.json');
  let index;
  try {
    index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
  } catch {
    throw releaseError('context_index_invalid');
  }
  const indexedNodes = contextIndexableNodes(state.context_nodes),
    expectedSnapshot = contextSearchIndexSnapshotHash(indexedNodes);
  if (index.schema_version !== 'aiws.context_index.v1' || index.snapshot_hash !== expectedSnapshot || !index.index)
    throw releaseError('context_index_snapshot_invalid');
  return {
    source_records: sourceRecords,
    nodes: state.context_nodes.length,
    active_nodes: activeNodes.length,
    current_documents: currentVersions.length,
    completed_jobs: state.context_projection_jobs.filter((job) => job.status === 'completed').length,
    superseded_jobs: state.context_projection_jobs.filter((job) => job.status === 'superseded').length,
    warnings: 0,
    index_schema: index.schema_version,
    index_snapshot_hash: index.snapshot_hash,
    indexed_nodes: indexedNodes.length
  };
}

function compareV20SourceIdentities(source, target) {
  for (const collection of V20_SOURCE_COLLECTIONS) {
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

async function pathBytes(file, versionId) {
  try {
    return await fsp.readFile(file);
  } catch {
    throw releaseError('context_projection_cas_missing', { version_id: versionId });
  }
}
