import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalStateHash,
  migrateState17To18,
  normalizeOfficialRunnerImagesV19,
  sha256,
  validateState18,
  V18_COLLECTIONS
} from './state-migration-v18.mjs';

export const STATE_SCHEMA_VERSION = 19;
export const V19_COLLECTIONS = Object.freeze([
  ...V18_COLLECTIONS,
  'repository_workspaces',
  'pull_request_intents',
  'asset_blobs',
  'asset_attestations',
  'workflow_executions',
  'task_executions',
  'execution_events',
  'repository_lines'
]);

export { canonicalStateHash, normalizeOfficialRunnerImagesV19, sha256 };

const EXECUTION_STATUSES = new Set([
  'pending',
  'ready',
  'queued',
  'running',
  'verifying',
  'awaiting_human',
  'completed',
  'failed',
  'cancelled',
  'superseded'
]);
const WORKFLOW_STATUSES = new Set(['running', 'paused', 'completed', 'failed', 'cancelled']);
const TERMINAL_EXECUTION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'superseded']);

export function migrateState18To19(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion === STATE_SCHEMA_VERSION) {
    const state = structuredClone(source);
    normalizeState19Defaults(state, timestamp);
    validateState19(state);
    return migrationResult(state, false, 19, timestamp);
  }

  const migrated18 =
    inputVersion === 18
      ? { state: structuredClone(source), from_version: 18 }
      : migrateState17To18(source, { timestamp });
  assertNoActiveLegacyExecution(migrated18.state);
  const state = migrated18.state;
  normalizeState19Defaults(state, timestamp, { migrating: true });
  state.schema_version = STATE_SCHEMA_VERSION;
  validateState19(state);
  return migrationResult(state, true, inputVersion, timestamp);
}

export function normalizeState19Defaults(state, timestamp = new Date().toISOString(), { migrating = false } = {}) {
  for (const collection of V19_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];
  normalizeAssetVersionDefaults(state.asset_versions, timestamp);
  normalizeAssetDefaults(state.assets);
  normalizeWorkflowRevisionDefaults(state.workflows);
  normalizeTaskExecutionDefaults(state, timestamp, migrating);
  if (migrating) state.migrated_to_schema_19_at = timestamp;
  return state;
}

function normalizeAssetVersionDefaults(versions, timestamp) {
  for (const version of versions) {
    const legacyBody = typeof version.body === 'string' ? version.body : '';
    version.payload_kind ||= legacyPayloadKind(version);
    version.media_type ||= version.payload_kind === 'json' ? 'application/json' : 'text/plain; charset=utf-8';
    version.content_sha256 ||= sha256(Buffer.from(legacyBody, 'utf8'));
    if (!Number.isSafeInteger(version.size_bytes) || version.size_bytes < 0)
      version.size_bytes = Buffer.byteLength(legacyBody, 'utf8');
    if (!Array.isArray(version.blob_refs)) version.blob_refs = [];
    if (!version.manifest || typeof version.manifest !== 'object' || Array.isArray(version.manifest)) {
      version.manifest = { schema_version: 'aiws.asset_manifest.v1', entries: [], legacy_inline: true };
    }
    if (version.repository_sha === undefined) version.repository_sha = null;
    if (!version.provenance || typeof version.provenance !== 'object' || Array.isArray(version.provenance)) {
      version.provenance = { source: 'legacy_state', migrated_at: timestamp };
    }
    if (!version.verification_status)
      version.verification_status = version.blob_refs.length ? 'verified' : 'legacy_unverified';
    if (version.immutable === undefined) version.immutable = true;
  }
}

function normalizeAssetDefaults(assets) {
  for (const asset of assets) {
    if (asset.current_version_id === undefined) asset.current_version_id = null;
    if (asset.attestation_status === undefined)
      asset.attestation_status = asset.status === 'confirmed' ? 'legacy_unverified' : 'none';
  }
}

function normalizeWorkflowRevisionDefaults(workflows) {
  for (const workflow of workflows) {
    if (!Number.isInteger(workflow.workflow_revision) || workflow.workflow_revision < 1)
      workflow.workflow_revision = Math.max(1, Number(workflow.version) || 1);
  }
}

function normalizeTaskExecutionDefaults(state, timestamp, migrating) {
  const migrationCutoff = migrating ? timestamp : state.migrated_to_schema_19_at;
  const managedTaskIds = new Set(state.task_executions.map((item) => item.task_id));
  for (const node of state.workflow_nodes.filter((item) => item.role === 'task')) {
    if (!Number.isInteger(node.execution_revision) || node.execution_revision < 1) node.execution_revision = 1;
    if (node.execution_evidence_status === undefined) {
      const createdAt = Date.parse(node.created_at || ''),
        cutoff = Date.parse(migrationCutoff || '');
      node.execution_evidence_status =
        migrationCutoff && !managedTaskIds.has(node.id) && (!Number.isFinite(createdAt) || createdAt <= cutoff)
          ? 'external_unverified'
          : 'managed';
    }
  }
}

export function validateState19(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw migrationError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION)
    throw migrationError('state_schema_not_19', { schema_version: state.schema_version ?? null });
  for (const collection of V19_COLLECTIONS)
    if (!Array.isArray(state[collection])) throw migrationError('state_collection_invalid', { collection });
  validateState18({ ...structuredClone(state), schema_version: 18 });
  for (const collection of V19_COLLECTIONS) ensureUniqueIds(state[collection], collection);

  const assetIds = new Set(state.assets.map((item) => item.id));
  const versionIds = new Set(state.asset_versions.map((item) => item.id));
  const workflowIds = new Set(state.workflows.map((item) => item.id));
  const nodeIds = new Set(state.workflow_nodes.map((item) => item.id));
  const workflowExecutionIds = new Set(state.workflow_executions.map((item) => item.id));
  const taskExecutionIds = new Set(state.task_executions.map((item) => item.id));
  const blobHashes = validateAssetBlobs(state.asset_blobs);
  validateAssetVersions(state.asset_versions, assetIds, blobHashes);
  validateAssetAttestations(state.asset_attestations, assetIds, versionIds);
  validateWorkflowExecutions(state.workflow_executions, workflowIds);
  validateTaskExecutions(state.task_executions, workflowExecutionIds, nodeIds);
  validateExecutionEvents(state.execution_events, workflowExecutionIds, taskExecutionIds);
  validateRepositoryLines(state.repository_lines, workflowExecutionIds, nodeIds);
  return state;
}

function validateAssetBlobs(blobs) {
  const blobHashes = new Set();
  for (const blob of blobs) {
    if (!validSha(blob.sha256) || blob.id !== `blob_${blob.sha256}`)
      throw migrationError('asset_blob_identity_invalid', { id: blob.id });
    if (!Number.isSafeInteger(blob.size_bytes) || blob.size_bytes < 0)
      throw migrationError('asset_blob_size_invalid', { id: blob.id });
    if (!safeRelativePath(blob.storage_path)) throw migrationError('asset_blob_path_invalid', { id: blob.id });
    if (blobHashes.has(blob.sha256)) throw migrationError('asset_blob_sha_duplicate', { sha256: blob.sha256 });
    blobHashes.add(blob.sha256);
  }
  return blobHashes;
}

function validateAssetVersions(versions, assetIds, blobHashes) {
  for (const version of versions) {
    if (!assetIds.has(version.asset_id)) throw migrationError('asset_version_asset_missing', { id: version.id });
    if (!validSha(version.content_sha256) || !Number.isSafeInteger(version.size_bytes) || version.size_bytes < 0)
      throw migrationError('asset_version_content_identity_invalid', { id: version.id });
    if (!['verified', 'legacy_unverified', 'external_unverified', 'corrupt'].includes(version.verification_status))
      throw migrationError('asset_version_verification_status_invalid', { id: version.id });
    if (version.immutable !== true) throw migrationError('asset_version_mutable_forbidden', { id: version.id });
    if (
      !Array.isArray(version.blob_refs) ||
      !version.manifest ||
      typeof version.manifest !== 'object' ||
      Array.isArray(version.manifest)
    )
      throw migrationError('asset_version_manifest_invalid', { id: version.id });
    if (
      version.verification_status === 'verified' &&
      version.blob_refs.some((ref) => !blobHashes.has(typeof ref === 'string' ? ref : ref?.sha256))
    )
      throw migrationError('asset_version_blob_missing', { id: version.id });
  }
}

function validateAssetAttestations(attestations, assetIds, versionIds) {
  for (const attestation of attestations) {
    if (!versionIds.has(attestation.asset_version_id) || !assetIds.has(attestation.asset_id))
      throw migrationError('asset_attestation_target_missing', { id: attestation.id });
    if (!['human', 'trusted_verifier'].includes(attestation.attestor_type))
      throw migrationError('asset_attestation_actor_invalid', { id: attestation.id });
    if (!['accepted', 'rejected', 'revoked'].includes(attestation.decision))
      throw migrationError('asset_attestation_decision_invalid', { id: attestation.id });
    if (attestation.confirmation_policy === 'system_evidence' && attestation.attestor_type !== 'trusted_verifier')
      throw migrationError('system_evidence_trusted_verifier_required', { id: attestation.id });
  }
}

function validateWorkflowExecutions(executions, workflowIds) {
  for (const execution of executions) {
    if (!workflowIds.has(execution.workflow_id) || !WORKFLOW_STATUSES.has(execution.status))
      throw migrationError('workflow_execution_invalid', { id: execution.id });
    if (!Number.isInteger(execution.workflow_revision) || execution.workflow_revision < 1)
      throw migrationError('workflow_execution_revision_invalid', { id: execution.id });
  }
}

function validateTaskExecutions(executions, workflowExecutionIds, nodeIds) {
  for (const execution of executions) {
    if (
      !workflowExecutionIds.has(execution.workflow_execution_id) ||
      !nodeIds.has(execution.task_id) ||
      !EXECUTION_STATUSES.has(execution.status)
    )
      throw migrationError('task_execution_invalid', { id: execution.id });
    if (
      !Number.isInteger(execution.attempt) ||
      execution.attempt < 1 ||
      !Number.isInteger(execution.task_revision) ||
      execution.task_revision < 1
    )
      throw migrationError('task_execution_revision_invalid', { id: execution.id });
    if (execution.lease && typeof execution.lease !== 'object')
      throw migrationError('task_execution_lease_invalid', { id: execution.id });
  }
}

function validateExecutionEvents(events, workflowExecutionIds, taskExecutionIds) {
  const eventKeys = new Set();
  for (const event of events) {
    if (
      !workflowExecutionIds.has(event.workflow_execution_id) ||
      (event.task_execution_id && !taskExecutionIds.has(event.task_execution_id))
    )
      throw migrationError('execution_event_scope_missing', { id: event.id });
    const key = `${event.workflow_execution_id}:${event.sequence}`;
    if (!Number.isInteger(event.sequence) || event.sequence < 1 || eventKeys.has(key))
      throw migrationError('execution_event_sequence_invalid', { id: event.id });
    eventKeys.add(key);
  }
}

function validateRepositoryLines(lines, workflowExecutionIds, nodeIds) {
  for (const line of lines) {
    if (!workflowExecutionIds.has(line.workflow_execution_id) || !nodeIds.has(line.workstream_id))
      throw migrationError('repository_line_scope_missing', { id: line.id });
    if (!['active', 'integrating', 'merged', 'failed', 'cancelled'].includes(line.status))
      throw migrationError('repository_line_status_invalid', { id: line.id });
    if (!safeRef(line.base_ref) || !safeRef(line.branch))
      throw migrationError('repository_line_ref_invalid', { id: line.id });
  }
}

export async function migrateStateFileToV19(
  stateFile,
  {
    backupDirectory = path.join(path.dirname(stateFile), 'migrations'),
    clock = () => new Date(),
    beforeReplace,
    afterReplace
  } = {}
) {
  const original = await fsp.readFile(stateFile);
  const parsed = JSON.parse(original.toString('utf8'));
  const result = migrateState18To19(parsed, { timestamp: clock().toISOString() });
  if (!result.migrated)
    return { ...result, state_hash: canonicalStateHash(result.state), backup_path: null, manifest_path: null };

  await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = clock().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.json`);
  const manifestPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.manifest.json`);
  await writeExclusiveAndSync(backupPath, original);
  const migratedBytes = Buffer.from(`${JSON.stringify(result.state, null, 2)}\n`, 'utf8');
  const tempPath = `${stateFile}.v19-${process.pid}-${Date.now()}.tmp`;
  const manifest = {
    migration: `aiws-state-${result.from_version}-to-19`,
    status: 'prepared',
    from_schema: result.from_version,
    to_schema: 19,
    created_at: clock().toISOString(),
    original_sha256: sha256(original),
    original_state_hash: canonicalStateHash(parsed),
    migrated_sha256: sha256(migratedBytes),
    migrated_state_hash: canonicalStateHash(result.state),
    backup_file: path.basename(backupPath),
    state_file: path.basename(stateFile),
    legacy_asset_versions: result.legacy_asset_versions
  };
  await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  let replaced = false;
  try {
    await writeExclusiveAndSync(tempPath, migratedBytes);
    validateState19(JSON.parse((await fsp.readFile(tempPath)).toString('utf8')));
    await beforeReplace?.({ stateFile, tempPath, backupPath, manifest });
    await replaceFile(tempPath, stateFile);
    replaced = true;
    validateState19(JSON.parse((await fsp.readFile(stateFile)).toString('utf8')));
    await afterReplace?.({ stateFile, backupPath, manifest });
    Object.assign(manifest, { status: 'committed', committed_at: clock().toISOString() });
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return {
      ...result,
      state_hash: manifest.migrated_state_hash,
      backup_path: backupPath,
      manifest_path: manifestPath,
      manifest
    };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    if (replaced) await atomicRewrite(stateFile, original);
    Object.assign(manifest, { status: 'rolled_back', failed_at: clock().toISOString(), error: safeErrorCode(error) });
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch(() => undefined);
    throw error;
  }
}

function assertNoActiveLegacyExecution(state) {
  const activeRuns = (state.node_runs || []).filter((item) => ['queued', 'running', 'verifying'].includes(item.status));
  const activeDeliveries = (state.deliveries || []).filter((item) =>
    ['queued', 'running', 'verifying'].includes(item.status)
  );
  if (activeRuns.length || activeDeliveries.length)
    throw migrationError('state_migration_active_execution', {
      node_run_ids: activeRuns.map((item) => item.id),
      delivery_ids: activeDeliveries.map((item) => item.id)
    });
}
function legacyPayloadKind(version) {
  if (version.body && /^[\s\r\n]*[\[{]/.test(version.body)) {
    try {
      JSON.parse(version.body);
      return 'json';
    } catch {}
  }
  return 'text';
}
function migrationResult(state, migrated, fromVersion, timestamp) {
  return {
    state,
    migrated,
    from_version: fromVersion,
    to_version: 19,
    migrated_at: timestamp,
    legacy_asset_versions: state.asset_versions
      .filter((item) => item.verification_status === 'legacy_unverified')
      .map((item) => item.id)
  };
}
function validSha(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}
function safeRelativePath(value) {
  const text = String(value || '').replaceAll('\\', '/');
  return Boolean(text) && !text.startsWith('/') && !/^[A-Za-z]:/.test(text) && !text.split('/').includes('..');
}
function safeRef(value) {
  return /^[A-Za-z0-9._/-]{1,240}$/.test(String(value || '')) && !String(value).includes('..');
}
function ensureUniqueIds(items, collection) {
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || !String(item.id || ''))
      throw migrationError('state_record_id_missing', { collection });
    if (seen.has(item.id)) throw migrationError('state_record_id_duplicate', { collection, id: item.id });
    seen.add(item.id);
  }
}
function migrationError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
function safeErrorCode(error) {
  return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? String(error.code) : 'state_migration_failed';
}
async function writeExclusiveAndSync(file, bytes) {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function atomicRewrite(file, bytes) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeExclusiveAndSync(temp, bytes);
  await replaceFile(temp, file);
}
async function replaceFile(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}
