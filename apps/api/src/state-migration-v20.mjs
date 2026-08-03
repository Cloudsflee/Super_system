import { cloneStateValue as structuredClone } from './state-clone.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  CONTEXT_INTERNAL_COLLECTIONS,
  reconcileContextProjectionState,
  validateContextState
} from '../../../packages/system-context/src/index.mjs';
import { collections as ALL_STATE_COLLECTIONS } from './config.mjs';
import {
  canonicalStateHash,
  migrateState18To19,
  normalizeState19Defaults,
  sha256,
  validateState19
} from './state-migration-v19.mjs';

const POST_V20_COLLECTIONS = new Set([
  'outcome_requirements',
  'outcome_evaluations',
  'outcome_waivers',
  'execution_stage_checkpoints'
]);
const PRE_V23_COLLECTIONS = new Set(['quality_review_runs', 'quality_review_reports', 'quality_review_events']);

export const STATE_SCHEMA_VERSION = 20;
export const V20_SOURCE_COLLECTIONS = Object.freeze(
  ALL_STATE_COLLECTIONS.filter(
    (collection) =>
      !CONTEXT_INTERNAL_COLLECTIONS.includes(collection) &&
      !POST_V20_COLLECTIONS.has(collection) &&
      !PRE_V23_COLLECTIONS.has(collection)
  )
);
export const V20_COLLECTIONS = Object.freeze([...V20_SOURCE_COLLECTIONS, ...CONTEXT_INTERNAL_COLLECTIONS]);
export const V20_RUNNER_IMAGE = 'aiws-codex-runner:2.0.0-codex-0.144.0';

export { canonicalStateHash, sha256 };

export function migrateState19To20(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion > STATE_SCHEMA_VERSION)
    throw migrationError('state_schema_newer_than_runtime', { schema_version: inputVersion });
  const migrated19 =
    inputVersion === 20
      ? { state: structuredClone(source), from_version: 20, migrated: false }
      : migrateState18To19(source, { timestamp });
  const state = migrated19.state;
  normalizeState20Defaults(state, timestamp, { migrating: inputVersion !== 20 });
  state.schema_version = STATE_SCHEMA_VERSION;
  validateState20(state);
  return {
    state,
    migrated: inputVersion !== 20,
    from_version: inputVersion,
    to_version: 20,
    migrated_at: timestamp,
    context_projection_jobs: state.context_projection_jobs.filter((item) => item.status === 'pending').length
  };
}

export function normalizeState20Defaults(state, timestamp = new Date().toISOString(), { migrating = false } = {}) {
  for (const collection of V20_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];
  normalizeState19Defaults(state, timestamp);
  normalizeOfficialRunnerImagesV20(state, { timestamp });
  normalizeOutcomeEvidenceRelationsV20(state);
  normalizeTaskHandoffDefaultsV20(state);
  reconcileContextProjectionState(state, { sourceCollections: V20_SOURCE_COLLECTIONS, timestamp });
  if (migrating) state.migrated_to_schema_20_at = timestamp;
  return state;
}

export function normalizeOutcomeEvidenceRelationsV20(state) {
  let changed = false;
  for (const relation of state.asset_relations || []) {
    if (relation.relation_type !== 'derived_from') continue;
    const targetVersion = (state.asset_versions || []).find((item) => item.id === relation.target_asset_version_id),
      targetAsset = (state.assets || []).find(
        (item) => item.id === (relation.target_asset_id || targetVersion?.asset_id)
      );
    if (!targetAsset || !/WorkstreamOutcome/i.test(targetAsset.asset_type)) continue;
    relation.relation_type = 'evidenced_by';
    changed = true;
  }
  return { changed };
}

export function normalizeTaskHandoffDefaultsV20(state) {
  let changed = false;
  const cleanRecord = (record, field) => {
    changed = cleanIdField(record, field) || changed;
  };
  for (const execution of state.task_executions || []) {
    cleanRecord(execution, 'consumed_inputs');
    cleanRecord(execution, 'consumed_context_document_versions');
    cleanRecord(execution, 'context_selection_ids');
    cleanRecord(execution, 'declared_consumed_inputs');
    cleanRecord(execution, 'structurally_verified_inputs');
    cleanRecord(execution, 'declared_context_document_versions');
    cleanRecord(execution, 'structurally_verified_context_document_versions');
    cleanRecord(execution, 'accepted_effect_claim_ids');
    cleanRecord(execution, 'accepted_contribution_ids');
    changed = cleanDispositionField(execution, 'input_dispositions', 'version_id') || changed;
    changed = cleanDispositionField(execution, 'context_dispositions', 'document_version_id') || changed;
    changed = cleanDispositionField(execution, 'structurally_verified_input_dispositions', 'version_id') || changed;
    changed =
      cleanDispositionField(execution, 'structurally_verified_context_dispositions', 'document_version_id') || changed;
    changed = cleanStatusField(execution, 'effect_claim_statuses', cleanEffectClaimStatuses) || changed;
    changed = cleanStatusField(execution, 'contribution_statuses', cleanContributionStatuses) || changed;
    changed = cleanAuthorityStatus(execution) || changed;
    for (const binding of execution.output_bindings || []) cleanRecord(binding, 'accepted_effect_claim_ids');
    changed = cleanEffectRecord(execution, 'input_effects', 'input_key') || changed;
    changed = cleanEffectRecord(execution, 'context_effects', 'document_version_id') || changed;
  }
  for (const version of state.asset_versions || []) {
    if (!version.provenance || typeof version.provenance !== 'object') continue;
    cleanRecord(version.provenance, 'consumed_inputs');
    cleanRecord(version.provenance, 'consumed_context_document_versions');
    cleanRecord(version.provenance, 'context_selection_ids');
    cleanRecord(version.provenance, 'declared_consumed_inputs');
    cleanRecord(version.provenance, 'structurally_verified_inputs');
    cleanRecord(version.provenance, 'declared_context_document_versions');
    cleanRecord(version.provenance, 'structurally_verified_context_document_versions');
    cleanRecord(version.provenance, 'accepted_effect_claim_ids');
    cleanRecord(version.provenance, 'accepted_contribution_ids');
    changed = cleanDispositionField(version.provenance, 'input_dispositions', 'version_id') || changed;
    changed = cleanDispositionField(version.provenance, 'context_dispositions', 'document_version_id') || changed;
    changed =
      cleanDispositionField(version.provenance, 'structurally_verified_input_dispositions', 'version_id') || changed;
    changed =
      cleanDispositionField(version.provenance, 'structurally_verified_context_dispositions', 'document_version_id') ||
      changed;
    changed = cleanStatusField(version.provenance, 'effect_claim_statuses', cleanEffectClaimStatuses) || changed;
    changed = cleanStatusField(version.provenance, 'contribution_statuses', cleanContributionStatuses) || changed;
    changed = cleanAuthorityStatus(version.provenance) || changed;
    changed = cleanEffectRecord(version.provenance, 'input_effects', 'input_key') || changed;
    changed = cleanEffectRecord(version.provenance, 'context_effects', 'document_version_id') || changed;
  }
  changed = cleanAuthorityReferences(state) || changed;
  changed = cleanRunnerHandoffs(state) || changed;
  return { changed };
}

function cleanAuthorityReferences(state) {
  let changed = false;
  for (const attestation of state.asset_attestations || []) {
    changed = cleanIdField(attestation, 'accepted_effect_claim_ids') || changed;
    changed = cleanStatusField(attestation, 'effect_acceptance_results', cleanEffectAcceptanceResults) || changed;
  }
  for (const relation of state.asset_relations || []) {
    changed = cleanIdField(relation, 'criterion_ids') || changed;
    changed = cleanIdField(relation, 'source_receipts') || changed;
    changed = cleanIdField(relation, 'output_evidence_refs') || changed;
    changed = cleanOptionalTextField(relation, 'effect_claim_id') || changed;
    changed = cleanOptionalTextField(relation, 'attestation_id') || changed;
  }
  return changed;
}

function cleanRunnerHandoffs(state) {
  let changed = false;
  for (const run of state.node_runs || []) {
    const result = run.result_json;
    if (['aiws.task_runner_result.v3', 'aiws.task_runner_result.v4'].includes(result?.schema_version)) {
      changed = cleanEffectRecord(result, 'input_effects', 'input_key') || changed;
      changed = cleanEffectRecord(result, 'context_effects', 'document_version_id') || changed;
      continue;
    }
    if (!result || result.schema_version !== 'aiws.task_runner_result.v2') continue;
    changed = cleanIdField(result, 'consumed_input_versions') || changed;
    changed = cleanIdField(result, 'consumed_context_document_versions') || changed;
    for (const output of result.outputs || []) {
      changed = cleanIdField(output, 'consumed_input_versions') || changed;
      changed = cleanIdField(output, 'consumed_context_document_versions') || changed;
    }
  }
  return changed;
}

function cleanIdField(record, field) {
  const before = Array.isArray(record?.[field]) ? record[field] : [],
    after = cleanIds(before);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  record[field] = after;
  return true;
}

function cleanEffectRecord(record, field, idKey) {
  if (!Array.isArray(record?.[field])) return false;
  const before = record[field],
    after = before
      .filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item[idKey] === 'string' &&
          item[idKey].trim() &&
          ['basis', 'constraint', 'comparison', 'verification', 'contradiction', 'reference'].includes(item.effect) &&
          typeof item.statement === 'string' &&
          item.statement.trim() &&
          Array.isArray(item.output_keys)
      )
      .map((item) => ({
        [idKey]: item[idKey].trim(),
        ...(idKey === 'input_key' ? { version_ids: cleanIds(item.version_ids) } : {}),
        ...(typeof item.contribution_id === 'string' && item.contribution_id.trim()
          ? { contribution_id: item.contribution_id.trim() }
          : {}),
        ...(typeof item.claim_id === 'string' && item.claim_id.trim() ? { claim_id: item.claim_id.trim() } : {}),
        effect: item.effect,
        output_keys: cleanIds(item.output_keys),
        ...(Array.isArray(item.criterion_ids) ? { criterion_ids: cleanIds(item.criterion_ids) } : {}),
        statement: item.statement.trim(),
        evidence_refs: cleanIds(item.evidence_refs),
        ...(Array.isArray(item.source_receipts) ? { source_receipts: cleanIds(item.source_receipts) } : {}),
        ...(item.verification_status === 'structurally_verified'
          ? { verification_status: 'structurally_verified' }
          : {})
      }))
      .sort((left, right) =>
        `${left[idKey]}:${left.effect}:${left.output_keys.join(',')}`.localeCompare(
          `${right[idKey]}:${right.effect}:${right.output_keys.join(',')}`
        )
      );
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  record[field] = after;
  return true;
}

function cleanDispositionField(record, field, idKey) {
  if (!Array.isArray(record?.[field])) return false;
  const before = record[field],
    after = cleanDispositions(before, idKey);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  record[field] = after;
  return true;
}

function cleanStatusField(record, field, cleaner) {
  if (!Array.isArray(record?.[field])) return false;
  const before = record[field],
    after = cleaner(before);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  record[field] = after;
  return true;
}

function cleanEffectClaimStatuses(values) {
  return (Array.isArray(values) ? values : [])
    .filter(
      (item) =>
        item &&
        typeof item.claim_id === 'string' &&
        item.claim_id.trim() &&
        ['structurally_verified', 'accepted'].includes(item.status)
    )
    .map((item) => ({
      claim_id: item.claim_id.trim(),
      source_type: item.source_type === 'context' ? 'context' : 'input',
      input_key: typeof item.input_key === 'string' && item.input_key.trim() ? item.input_key.trim() : null,
      document_version_id:
        typeof item.document_version_id === 'string' && item.document_version_id.trim()
          ? item.document_version_id.trim()
          : null,
      contribution_id:
        typeof item.contribution_id === 'string' && item.contribution_id.trim() ? item.contribution_id.trim() : null,
      output_keys: cleanIds(item.output_keys),
      criterion_ids: cleanIds(item.criterion_ids),
      status: item.status
    }))
    .sort((left, right) => left.claim_id.localeCompare(right.claim_id));
}

function cleanEffectAcceptanceResults(values) {
  return (Array.isArray(values) ? values : [])
    .filter(
      (item) =>
        item &&
        typeof item.claim_id === 'string' &&
        item.claim_id.trim() &&
        item.status === 'accepted' &&
        typeof item.output_key === 'string' &&
        item.output_key.trim()
    )
    .map((item) => ({
      claim_id: item.claim_id.trim(),
      status: 'accepted',
      source_type: item.source_type === 'context' ? 'context' : 'input',
      input_key: typeof item.input_key === 'string' && item.input_key.trim() ? item.input_key.trim() : null,
      document_version_id:
        typeof item.document_version_id === 'string' && item.document_version_id.trim()
          ? item.document_version_id.trim()
          : null,
      contribution_id:
        typeof item.contribution_id === 'string' && item.contribution_id.trim() ? item.contribution_id.trim() : null,
      source_receipts: cleanIds(item.source_receipts),
      output_key: item.output_key.trim(),
      output_version_id:
        typeof item.output_version_id === 'string' && item.output_version_id.trim()
          ? item.output_version_id.trim()
          : null,
      output_content_sha256:
        typeof item.output_content_sha256 === 'string' && item.output_content_sha256.trim()
          ? item.output_content_sha256.trim()
          : null,
      criterion_ids: cleanIds(item.criterion_ids),
      output_evidence_refs: cleanIds(item.output_evidence_refs),
      attestor_type: item.attestor_type === 'trusted_verifier' ? 'trusted_verifier' : 'human',
      attestor_id: typeof item.attestor_id === 'string' && item.attestor_id.trim() ? item.attestor_id.trim() : null
    }))
    .sort((left, right) => left.claim_id.localeCompare(right.claim_id));
}

function cleanContributionStatuses(values) {
  return (Array.isArray(values) ? values : [])
    .filter(
      (item) =>
        item &&
        typeof item.contribution_id === 'string' &&
        item.contribution_id.trim() &&
        ['structurally_verified', 'accepted'].includes(item.status)
    )
    .map((item) => ({
      contribution_id: item.contribution_id.trim(),
      status: item.status,
      output_keys: cleanIds(item.output_keys),
      criterion_ids: cleanIds(item.criterion_ids),
      version_ids: cleanIds(item.version_ids),
      claim_ids: cleanIds(item.claim_ids),
      accepted_claim_ids: cleanIds(item.accepted_claim_ids),
      accepted_criterion_ids: cleanIds(item.accepted_criterion_ids),
      missing_criterion_ids: cleanIds(item.missing_criterion_ids),
      source_receipts: cleanIds(item.source_receipts),
      evidence_refs: cleanIds(item.evidence_refs)
    }))
    .sort((left, right) => left.contribution_id.localeCompare(right.contribution_id));
}

function cleanAuthorityStatus(record) {
  if (!Object.hasOwn(record || {}, 'authority_status')) return false;
  const before = record.authority_status,
    after = ['declared', 'structurally_verified', 'accepted'].includes(before) ? before : null;
  if (before === after) return false;
  if (after) record.authority_status = after;
  else delete record.authority_status;
  return true;
}

function cleanOptionalTextField(record, field) {
  if (!Object.hasOwn(record || {}, field)) return false;
  const before = record[field],
    after = typeof before === 'string' && before.trim() ? before.trim() : null;
  if (before === after) return false;
  if (after) record[field] = after;
  else delete record[field];
  return true;
}

function cleanIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ].sort();
}

function cleanDispositions(values, idKey) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .filter(
      (item) =>
        item &&
        typeof item[idKey] === 'string' &&
        item[idKey].trim() &&
        ['used', 'not_used'].includes(item.disposition) &&
        (item.disposition === 'used' || String(item.reason || '').trim())
    )
    .map((item) => ({
      [idKey]: item[idKey].trim(),
      disposition: item.disposition,
      reason: String(item.reason || '').trim() || null
    }))
    .filter((item) => {
      if (seen.has(item[idKey])) return false;
      seen.add(item[idKey]);
      return true;
    })
    .sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

export function normalizeOfficialRunnerImagesV20(state, { timestamp = new Date().toISOString() } = {}) {
  let changed = false;
  const changedProfileIds = new Set();
  const official = /^aiws-codex-runner:(?:1\.(?:[0-9]|10)\.0|2\.0\.0)-codex-0\.144\.0$/;
  for (const profile of state.codex_profiles || []) {
    if (official.test(String(profile.image || '')) && profile.image !== V20_RUNNER_IMAGE) {
      profile.image = V20_RUNNER_IMAGE;
      profile.updated_at = timestamp;
      if (profile.id) changedProfileIds.add(profile.id);
      changed = true;
    }
    if (official.test(String(profile.config?.image || '')) && profile.config.image !== V20_RUNNER_IMAGE) {
      profile.config.image = V20_RUNNER_IMAGE;
      profile.updated_at = timestamp;
      if (profile.id) changedProfileIds.add(profile.id);
      changed = true;
    }
  }
  for (const integration of state.integration_statuses || []) {
    if (
      integration.key === 'codex_docker' &&
      official.test(String(integration.image || '')) &&
      integration.image !== V20_RUNNER_IMAGE
    ) {
      integration.image = V20_RUNNER_IMAGE;
      integration.updated_at = timestamp;
      changed = true;
    }
    if (integration.key === 'codex_probe' && changedProfileIds.has(integration.profile_id)) {
      integration.status = 'stale';
      integration.updated_at = timestamp;
      changed = true;
    }
  }
  return { changed, image: V20_RUNNER_IMAGE, profile_ids: [...changedProfileIds].sort() };
}

export function validateState20(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw migrationError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION)
    throw migrationError('state_schema_not_20', { schema_version: state.schema_version ?? null });
  for (const collection of V20_COLLECTIONS)
    if (!Array.isArray(state[collection])) throw migrationError('state_collection_invalid', { collection });
  validateState19({ ...state, schema_version: 19 });
  validateContextState(state, { sourceCollections: V20_SOURCE_COLLECTIONS });
  return state;
}

export async function migrateStateFileToV20(
  stateFile,
  {
    backupDirectory = path.join(path.dirname(stateFile), 'migrations'),
    clock = () => new Date(),
    beforeReplace,
    afterReplace
  } = {}
) {
  const original = await fsp.readFile(stateFile),
    parsed = JSON.parse(original.toString('utf8')),
    result = migrateState19To20(parsed, { timestamp: clock().toISOString() });
  if (!result.migrated)
    return { ...result, state_hash: canonicalStateHash(result.state), backup_path: null, manifest_path: null };

  await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = clock().toISOString().replace(/[:.]/g, '-'),
    backupPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.json`),
    manifestPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.manifest.json`),
    migratedBytes = Buffer.from(`${JSON.stringify(result.state, null, 2)}\n`, 'utf8'),
    tempPath = `${stateFile}.v20-${process.pid}-${Date.now()}.tmp`,
    manifest = {
      migration: `aiws-state-${result.from_version}-to-20`,
      status: 'prepared',
      from_schema: result.from_version,
      to_schema: 20,
      created_at: clock().toISOString(),
      original_sha256: sha256(original),
      original_state_hash: canonicalStateHash(parsed),
      migrated_sha256: sha256(migratedBytes),
      migrated_state_hash: canonicalStateHash(result.state),
      backup_file: path.basename(backupPath),
      state_file: path.basename(stateFile),
      context_projection_jobs: result.context_projection_jobs
    };
  await writeExclusiveAndSync(backupPath, original);
  await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  let replaced = false;
  try {
    await writeExclusiveAndSync(tempPath, migratedBytes);
    validateState20(JSON.parse((await fsp.readFile(tempPath)).toString('utf8')));
    await beforeReplace?.({ stateFile, tempPath, backupPath, manifest });
    await replaceFile(tempPath, stateFile);
    replaced = true;
    validateState20(JSON.parse((await fsp.readFile(stateFile)).toString('utf8')));
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
    Object.assign(manifest, {
      status: 'rolled_back',
      failed_at: clock().toISOString(),
      error: safeErrorCode(error)
    });
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch(() => undefined);
    throw error;
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
