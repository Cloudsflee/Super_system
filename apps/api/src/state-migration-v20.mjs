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

export const STATE_SCHEMA_VERSION = 20;
export const V20_SOURCE_COLLECTIONS = Object.freeze(
  ALL_STATE_COLLECTIONS.filter((collection) => !CONTEXT_INTERNAL_COLLECTIONS.includes(collection))
);
export const V20_COLLECTIONS = Object.freeze([...V20_SOURCE_COLLECTIONS, ...CONTEXT_INTERNAL_COLLECTIONS]);
export const V20_RUNNER_IMAGE = 'aiws-codex-runner:2.0.0-codex-0.144.0';

export { canonicalStateHash, sha256 };

export function migrateState19To20(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
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
  validateState19({ ...structuredClone(state), schema_version: 19 });
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
