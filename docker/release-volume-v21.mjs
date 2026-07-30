import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../apps/api/src/state-migration-v15.mjs';
import { validateState20 } from '../apps/api/src/state-migration-v20.mjs';
import {
  V21_OUTCOME_COLLECTIONS,
  V21_SOURCE_COLLECTIONS,
  validateState21
} from '../apps/api/src/state-migration-v21.mjs';
import {
  contextHash,
  contextIndexableNodes,
  contextSearchIndexSnapshotHash
} from '../packages/system-context/src/index.mjs';
import {
  atomicJsonWrite,
  comparePreservedFiles,
  findLegacyRunnerReferencesV21,
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

export const V21_SOURCE_VOLUME = 'aiws-data-v20';
export const V21_TARGET_VOLUME = 'aiws-data-v21';
export const V21_RECEIPT_RELATIVE_PATH = 'data/migrations/v21-volume-migration.manifest.json';

export async function verifyClonedVolumeV21({
  sourceRoot,
  targetRoot,
  manifestPath,
  archiveSha256,
  sourceVolume = V21_SOURCE_VOLUME,
  targetVolume = V21_TARGET_VOLUME,
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
  if (sourceState.schema_version !== 20)
    throw releaseError('source_state_schema_not_20', { schema_version: sourceState.schema_version });
  validateState20(sourceState.parsed_state);
  const manifest = {
    version: 1,
    migration: 'aiws-volume-v20-to-v21',
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

export async function acceptVolumeMigrationV21({
  targetRoot,
  sourceRoot,
  cloneManifestPath,
  archiveSha256,
  migrationVolume = null,
  sourceVolume = V21_SOURCE_VOLUME,
  targetVolume = V21_TARGET_VOLUME,
  clock = () => new Date()
}) {
  if (!sourceRoot || !cloneManifestPath) throw releaseError('migrated_acceptance_source_required');
  const cloneManifest = await readHashedJson(cloneManifestPath, 'manifest_sha256');
  if (cloneManifest.status !== 'clone_verified' || cloneManifest.migration !== 'aiws-volume-v20-to-v21')
    throw releaseError('clone_manifest_not_verified');
  if (cloneManifest.source_volume !== sourceVolume || cloneManifest.target_volume !== targetVolume)
    throw releaseError('clone_manifest_volume_mismatch');
  if (normalizeSha(archiveSha256) !== cloneManifest.archive_sha256) throw releaseError('clone_archive_hash_mismatch');

  const sourceState = await stateAudit(sourceRoot),
    sourceInventory = await volumeInventory(sourceRoot),
    targetState = await stateAudit(targetRoot);
  if (sourceState.schema_version !== 20)
    throw releaseError('source_state_schema_not_20', { schema_version: sourceState.schema_version });
  validateState20(sourceState.parsed_state);
  if (
    sourceState.state_sha256 !== cloneManifest.source_state.state_sha256 ||
    sourceInventory.hash !== cloneManifest.source_inventory.hash
  )
    throw releaseError('source_changed_after_clone');
  validateState21(targetState.parsed_state);
  compareV21SourceIdentities(sourceState, targetState);
  const legacyRunnerReferences = findLegacyRunnerReferencesV21(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  const schemaMigration =
    targetState.schema_migrations.find(
      (item) =>
        item.from_schema === 20 &&
        item.to_schema === 21 &&
        item.status === 'committed' &&
        item.original_sha256 === sourceState.state_sha256
    ) || null;
  if (!schemaMigration) throw releaseError('schema_20_to_21_manifest_missing');
  const projection = await auditV21Projection(targetRoot, targetState.parsed_state);
  const outcomes = auditV21Outcomes(targetState.parsed_state);
  const targetInventory = await volumeInventory(targetRoot),
    preservation = comparePreservedFiles(cloneManifest.source_inventory.entries, targetInventory.entries, {
      mutablePaths: ['data/.context-index/minisearch-v1.json']
    }),
    receipt = {
      version: 1,
      migration: 'aiws-volume-v20-to-v21',
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
      outcomes,
      vault_files: keyInventory(targetInventory.entries, 'vault/'),
      codex_home_files: keyInventory(targetInventory.entries, 'codex-homes/'),
      source_preserved: true,
      health_verified: true,
      legacy_runner_references: []
    };
  const receiptPath = path.join(targetRoot, ...V21_RECEIPT_RELATIVE_PATH.split('/'));
  await atomicJsonWrite(receiptPath, withDocumentHash(receipt, 'receipt_sha256'));
  return { ...receipt, receipt_path: V21_RECEIPT_RELATIVE_PATH };
}

export async function validateV21ReleaseTarget(
  targetRoot,
  expectedTargetVolume = V21_TARGET_VOLUME,
  { deferProjection = false } = {}
) {
  const receipt = await readHashedJson(
    path.join(targetRoot, ...V21_RECEIPT_RELATIVE_PATH.split('/')),
    'receipt_sha256'
  );
  if (
    receipt.accepted !== true ||
    receipt.status !== 'accepted' ||
    receipt.mode !== 'migrated' ||
    receipt.source_volume !== V21_SOURCE_VOLUME ||
    receipt.target_volume !== expectedTargetVolume ||
    receipt.migration !== 'aiws-volume-v20-to-v21' ||
    receipt.source_preserved !== true
  )
    throw releaseError('migration_acceptance_missing');
  const targetState = await stateAudit(targetRoot);
  validateState21(targetState.parsed_state);
  const legacyRunnerReferences = findLegacyRunnerReferencesV21(targetState.parsed_state);
  if (legacyRunnerReferences.length)
    throw releaseError('legacy_runner_references_remain', { references: legacyRunnerReferences });
  for (const collection of preservedV20Collections()) {
    const expected = receipt.source_state?.record_ids?.[collection];
    if (!expected) continue;
    const actualIds = new Set(targetState.record_ids[collection] || []),
      missing = expected.filter((id) => !actualIds.has(id));
    if (missing.length) throw releaseError('accepted_record_ids_missing', { collection, missing });
  }
  if (
    !targetState.schema_migrations.some(
      (item) =>
        item.from_schema === 20 &&
        item.to_schema === 21 &&
        item.status === 'committed' &&
        item.original_sha256 === receipt.schema_migration?.original_sha256
    )
  )
    throw releaseError('accepted_schema_manifest_missing');
  const projection = deferProjection
    ? { deferred: true, reason: 'release_refresh_required' }
    : await auditV21Projection(targetRoot, targetState.parsed_state);
  const outcomes = auditV21Outcomes(targetState.parsed_state);
  return {
    accepted: true,
    mode: receipt.mode,
    schema_version: targetState.schema_version,
    state_sha256: targetState.state_sha256,
    state_canonical_hash: targetState.state_canonical_hash,
    receipt_sha256: receipt.receipt_sha256,
    source_preserved: true,
    projection,
    outcomes,
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

async function auditV21Projection(targetRoot, state) {
  const coverage = state.context_projection_coverage;
  const sourceRecords = V21_SOURCE_COLLECTIONS.reduce((total, collection) => total + state[collection].length, 0);
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

function compareV21SourceIdentities(source, target) {
  for (const collection of preservedV20Collections()) {
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

function preservedV20Collections() {
  const generated = new Set(V21_OUTCOME_COLLECTIONS);
  return V21_SOURCE_COLLECTIONS.filter((collection) => !generated.has(collection));
}

function auditV21Outcomes(state) {
  const terminal = state.workflow_executions.filter((item) =>
      ['completed', 'failed', 'cancelled'].includes(item.status)
    ),
    active = state.workflow_executions.filter((item) => ['running', 'paused'].includes(item.status)),
    requirementCounts = new Map();
  for (const requirement of state.outcome_requirements)
    requirementCounts.set(
      requirement.workflow_execution_id,
      Number(requirementCounts.get(requirement.workflow_execution_id) || 0) + 1
    );
  const missingContracts = active.filter(
    (execution) => !execution.outcome_contract_hash || !requirementCounts.get(execution.id)
  );
  if (missingContracts.length)
    throw releaseError('outcome_contract_coverage_invalid', {
      workflow_execution_ids: missingContracts.map((item) => item.id)
    });
  const invalidLegacy = terminal.filter(
    (execution) =>
      execution.completion_status === 'legacy_unassessed' &&
      state.outcome_evaluations.some((item) => item.workflow_execution_id === execution.id)
  );
  if (invalidLegacy.length)
    throw releaseError('legacy_unassessed_evaluation_invalid', {
      workflow_execution_ids: invalidLegacy.map((item) => item.id)
    });
  return {
    workflow_executions: state.workflow_executions.length,
    active: active.length,
    active_with_contract: active.filter((item) => item.outcome_contract_hash && requirementCounts.get(item.id)).length,
    legacy_unassessed: terminal.filter((item) => item.completion_status === 'legacy_unassessed').length,
    requirements: state.outcome_requirements.length,
    evaluations: state.outcome_evaluations.length,
    waivers: state.outcome_waivers.length,
    checkpoints: state.execution_stage_checkpoints.length
  };
}

async function pathBytes(file, versionId) {
  try {
    return await fsp.readFile(file);
  } catch {
    throw releaseError('context_projection_cas_missing', { version_id: versionId });
  }
}
