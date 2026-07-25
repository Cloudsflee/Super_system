import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const STATE_SCHEMA_VERSION = 14;
export const V14_COLLECTIONS = Object.freeze([
  'assist_configurations',
  'assist_change_batches',
  'assist_checkpoints',
  'assist_operations',
  'runtime_user_inputs',
  'host_bridge_devices'
]);

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalStateHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function migrateState13To14(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion === STATE_SCHEMA_VERSION) {
    validateState14(source);
    return { state: structuredClone(source), migrated: false, from_version: 14, to_version: 14 };
  }
  if (![12, 13].includes(inputVersion))
    throw migrationError('unsupported_state_schema', { schema_version: source.schema_version ?? null });

  const state = structuredClone(source);
  for (const collection of V14_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];

  const knownConfigurations = new Set(
    state.assist_configurations.map((item) => item?.legacy_profile_id).filter(Boolean)
  );
  for (const profile of Array.isArray(state.codex_profiles) ? state.codex_profiles : []) {
    if (!profile?.assist_configuration || knownConfigurations.has(profile.id)) continue;
    const baseProfileId = String(profile.base_profile_id || '').trim();
    if (!baseProfileId) continue;
    state.assist_configurations.push({
      id: deterministicLegacyId('acfg', profile.id),
      name: cleanText(profile.name, 100) || 'Imported Assist configuration',
      base_profile_id: baseProfileId,
      model: cleanText(profile.model, 200) || null,
      reasoning: cleanText(profile.reasoning, 64) || null,
      legacy_profile_id: profile.id,
      migrated_from: 'v1.4_codex_profile',
      created_by_user_id: profile.created_by_user_id || null,
      created_at: profile.created_at || timestamp,
      updated_at: timestamp
    });
    knownConfigurations.add(profile.id);
  }

  for (const intent of Array.isArray(state.ui_action_intents) ? state.ui_action_intents : []) {
    if (intent.ledger_version) continue;
    intent.ledger_version = 'v1.4_history';
    intent.undoable = false;
    intent.migrated_at = timestamp;
  }

  for (const session of Array.isArray(state.assist_sessions) ? state.assist_sessions : []) {
    if (session.version !== 3) continue;
    if (session.codex_thread_id && session.native_thread_generation == null) {
      session.legacy_codex_thread_id = session.codex_thread_id;
      session.native_thread_generation = 1;
    } else if (session.native_thread_generation == null) {
      session.native_thread_generation = 2;
    }
    if (session.runtime_profile_id === undefined) session.runtime_profile_id = null;
    if (session.runtime_affinity_key === undefined) session.runtime_affinity_key = null;
    if (session.active_change_batch_id === undefined) session.active_change_batch_id = null;
  }

  state.schema_version = STATE_SCHEMA_VERSION;
  validateState14(state);
  return { state, migrated: true, from_version: inputVersion, to_version: 14 };
}

export function validateState14(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw migrationError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION)
    throw migrationError('state_schema_not_14', { schema_version: state.schema_version ?? null });
  for (const collection of V14_COLLECTIONS)
    if (!Array.isArray(state[collection])) throw migrationError('state_collection_invalid', { collection });
  ensureUniqueIds(state.assist_configurations, 'assist_configurations');
  ensureUniqueIds(state.assist_change_batches, 'assist_change_batches');
  ensureUniqueIds(state.assist_checkpoints, 'assist_checkpoints');
  ensureUniqueIds(state.assist_operations, 'assist_operations');
  ensureUniqueIds(state.runtime_user_inputs, 'runtime_user_inputs');
  ensureUniqueIds(state.host_bridge_devices, 'host_bridge_devices');

  const profileIds = new Set((state.codex_profiles || []).map((item) => item?.id));
  for (const item of state.assist_configurations) {
    if (!item?.base_profile_id || !profileIds.has(item.base_profile_id))
      throw migrationError('assist_configuration_profile_missing', {
        id: item?.id || null,
        base_profile_id: item?.base_profile_id || null
      });
    for (const forbidden of [
      'api_key',
      'access_token',
      'refresh_token',
      'credential',
      'credential_ref',
      'codex_home',
      'base_url',
      'endpoint'
    ]) {
      if (Object.hasOwn(item, forbidden))
        throw migrationError('assist_configuration_contains_secret_or_runtime_field', {
          id: item.id,
          field: forbidden
        });
    }
  }
  const openBySession = new Set();
  for (const batch of state.assist_change_batches) {
    if (batch?.status !== 'open') continue;
    if (!batch.session_id || openBySession.has(batch.session_id))
      throw migrationError('duplicate_open_change_batch', { session_id: batch?.session_id || null });
    openBySession.add(batch.session_id);
  }
  return state;
}

export async function migrateStateFileToV14(
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
  const result = migrateState13To14(parsed, { timestamp: clock().toISOString() });
  if (!result.migrated)
    return { ...result, state_hash: canonicalStateHash(result.state), backup_path: null, manifest_path: null };

  await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = clock().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.json`);
  const manifestPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.manifest.json`);
  await writeExclusiveAndSync(backupPath, original);
  const backupDigest = sha256(original);
  const migratedText = `${JSON.stringify(result.state, null, 2)}\n`;
  const migratedBytes = Buffer.from(migratedText, 'utf8');
  const tempPath = `${stateFile}.v14-${process.pid}-${Date.now()}.tmp`;
  const manifest = {
    migration: `aiws-state-${result.from_version}-to-14`,
    status: 'prepared',
    from_schema: result.from_version,
    to_schema: 14,
    created_at: clock().toISOString(),
    original_sha256: backupDigest,
    original_state_hash: canonicalStateHash(parsed),
    migrated_sha256: sha256(migratedBytes),
    migrated_state_hash: canonicalStateHash(result.state),
    backup_file: path.basename(backupPath),
    state_file: path.basename(stateFile)
  };
  await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  let replaced = false;
  try {
    await writeExclusiveAndSync(tempPath, migratedBytes);
    const reread = await fsp.readFile(tempPath);
    if (sha256(reread) !== manifest.migrated_sha256) throw migrationError('migrated_state_checksum_mismatch');
    validateState14(JSON.parse(reread.toString('utf8')));
    await beforeReplace?.({ stateFile, tempPath, backupPath, manifest });
    await replaceFile(tempPath, stateFile);
    replaced = true;
    await syncDirectory(path.dirname(stateFile));
    const installed = await fsp.readFile(stateFile);
    if (sha256(installed) !== manifest.migrated_sha256) throw migrationError('installed_state_checksum_mismatch');
    validateState14(JSON.parse(installed.toString('utf8')));
    await afterReplace?.({ stateFile, backupPath, manifest });
    manifest.status = 'committed';
    manifest.committed_at = clock().toISOString();
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
    if (replaced) {
      const currentBackup = await fsp.readFile(backupPath);
      if (sha256(currentBackup) !== backupDigest)
        throw migrationError('migration_failed_and_backup_corrupt', { cause: String(error?.message || error) });
      const restoreTemp = `${stateFile}.restore-${process.pid}-${Date.now()}.tmp`;
      await writeExclusiveAndSync(restoreTemp, currentBackup);
      await replaceFile(restoreTemp, stateFile);
      await syncDirectory(path.dirname(stateFile));
    }
    manifest.status = 'rolled_back';
    manifest.failed_at = clock().toISOString();
    manifest.error = safeErrorCode(error);
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch(() => undefined);
    throw error;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  return value;
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

function deterministicLegacyId(prefix, value) {
  return `${prefix}_${createHash('sha256').update(String(value)).digest('hex').slice(0, 18)}`;
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
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
  await syncDirectory(path.dirname(file));
}

async function replaceFile(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
