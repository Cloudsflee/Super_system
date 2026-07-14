import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrateState13To14, V14_COLLECTIONS } from './state-migration-v14.mjs';

export const STATE_SCHEMA_VERSION = 15;
export const V15_COLLECTIONS = Object.freeze([...V14_COLLECTIONS]);

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalStateHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function migrateState14To15(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion === STATE_SCHEMA_VERSION) {
    validateState15(source);
    return { state: structuredClone(source), migrated: false, from_version: 15, to_version: 15, repaired_shared_forks: 0 };
  }
  if (![12, 13, 14].includes(inputVersion)) throw migrationError('unsupported_state_schema', { schema_version: source.schema_version ?? null });

  const state = inputVersion === 14
    ? structuredClone(source)
    : migrateState13To14(source, { timestamp }).state;
  for (const collection of V15_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];

  const sessionsById = new Map((state.assist_sessions || []).map((item) => [item.id, item]));
  for (const session of state.assist_sessions || []) {
    if (session.version !== 3) continue;
    setDefault(session, 'forked_from_session_id', null);
    setDefault(session, 'forked_from_turn_id', null);
    setDefault(session, 'forked_from_codex_turn_id', null);
    setDefault(session, 'historical_shared_codex_thread_id', null);
    setDefault(session, 'native_thread_repair_required', false);
    setDefault(session, 'delete_batch_id', null);
    setDefault(session, 'deleted_at', null);
    setDefault(session, 'purge_after', null);
    setDefault(session, 'purge_stage', null);
    setDefault(session, 'purge_retry_at', null);
  }

  let repairedSharedForks = 0;
  for (const session of state.assist_sessions || []) {
    if (session.version !== 3 || !session.forked_from_session_id || !session.codex_thread_id) continue;
    const parent = sessionsById.get(session.forked_from_session_id);
    if (!parent?.codex_thread_id || parent.codex_thread_id !== session.codex_thread_id) continue;
    session.historical_shared_codex_thread_id = session.codex_thread_id;
    session.legacy_codex_thread_id ||= session.codex_thread_id;
    session.codex_thread_id = null;
    session.native_thread_repair_required = true;
    session.updated_at = timestamp;
    repairedSharedForks += 1;
  }

  for (const turn of state.assist_turns || []) setDefault(turn, 'codex_turn_id', null);
  for (const attachment of state.attachments || []) {
    const originalName = cleanFilename(attachment.original_filename || attachment.title || attachment.relative_path || attachment.label || attachment.kind || 'attachment');
    const declaredMime = cleanMime(attachment.client_mime_type || attachment.content_type) || 'application/octet-stream';
    const detectedMime = cleanMime(attachment.detected_mime_type || attachment.content_type) || declaredMime;
    setDefault(attachment, 'original_filename', originalName);
    setDefault(attachment, 'client_mime_type', declaredMime);
    setDefault(attachment, 'detected_mime_type', detectedMime);
    setDefault(attachment, 'preview_kind', previewKind(detectedMime, originalName));
    setDefault(attachment, 'storage_status', legacyStorageStatus(attachment));
    setDefault(attachment, 'content_deleted_at', null);
    setDefault(attachment, 'storage_error', null);
    setDefault(attachment, 'deleted_at', null);
  }

  state.schema_version = STATE_SCHEMA_VERSION;
  validateState15(state);
  return { state, migrated: true, from_version: inputVersion, to_version: 15, repaired_shared_forks: repairedSharedForks };
}

export function validateState15(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw migrationError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION) throw migrationError('state_schema_not_15', { schema_version: state.schema_version ?? null });
  for (const collection of V15_COLLECTIONS) if (!Array.isArray(state[collection])) throw migrationError('state_collection_invalid', { collection });
  for (const collection of ['assist_configurations', 'assist_change_batches', 'assist_checkpoints', 'assist_operations', 'runtime_user_inputs', 'host_bridge_devices', 'assist_sessions', 'assist_turns', 'attachments']) ensureUniqueIds(state[collection] || [], collection);

  const profileIds = new Set((state.codex_profiles || []).map((item) => item?.id));
  for (const item of state.assist_configurations) {
    if (!item?.base_profile_id || !profileIds.has(item.base_profile_id)) throw migrationError('assist_configuration_profile_missing', { id: item?.id || null, base_profile_id: item?.base_profile_id || null });
    for (const forbidden of ['api_key', 'access_token', 'refresh_token', 'credential', 'credential_ref', 'codex_home', 'base_url', 'endpoint']) {
      if (Object.hasOwn(item, forbidden)) throw migrationError('assist_configuration_contains_secret_or_runtime_field', { id: item.id, field: forbidden });
    }
  }
  const openBySession = new Set();
  for (const batch of state.assist_change_batches) {
    if (batch?.status !== 'open') continue;
    if (!batch.session_id || openBySession.has(batch.session_id)) throw migrationError('duplicate_open_change_batch', { session_id: batch?.session_id || null });
    openBySession.add(batch.session_id);
  }
  const sessionIds = new Set((state.assist_sessions || []).filter((item) => item.version === 3).map((item) => item.id));
  for (const session of (state.assist_sessions || []).filter((item) => item.version === 3)) {
    if (session.forked_from_session_id && !sessionIds.has(session.forked_from_session_id)) throw migrationError('assist_fork_parent_missing', { id: session.id, parent_id: session.forked_from_session_id });
    if (session.historical_shared_codex_thread_id && session.codex_thread_id === session.historical_shared_codex_thread_id) throw migrationError('assist_shared_thread_still_active', { id: session.id });
  }
  return state;
}

export async function migrateStateFileToV15(stateFile, {
  backupDirectory = path.join(path.dirname(stateFile), 'migrations'),
  clock = () => new Date(),
  beforeReplace,
  afterReplace
} = {}) {
  const original = await fsp.readFile(stateFile);
  const parsed = JSON.parse(original.toString('utf8'));
  const result = migrateState14To15(parsed, { timestamp: clock().toISOString() });
  if (!result.migrated) return { ...result, state_hash: canonicalStateHash(result.state), backup_path: null, manifest_path: null };

  await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = clock().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.json`);
  const manifestPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.manifest.json`);
  await writeExclusiveAndSync(backupPath, original);
  const backupDigest = sha256(original);
  const migratedBytes = Buffer.from(`${JSON.stringify(result.state, null, 2)}\n`, 'utf8');
  const tempPath = `${stateFile}.v15-${process.pid}-${Date.now()}.tmp`;
  const manifest = {
    migration: `aiws-state-${result.from_version}-to-15`, status: 'prepared',
    from_schema: result.from_version, to_schema: 15, created_at: clock().toISOString(),
    original_sha256: backupDigest, original_state_hash: canonicalStateHash(parsed),
    migrated_sha256: sha256(migratedBytes), migrated_state_hash: canonicalStateHash(result.state),
    repaired_shared_forks: result.repaired_shared_forks,
    backup_file: path.basename(backupPath), state_file: path.basename(stateFile)
  };
  await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  let replaced = false;
  try {
    await writeExclusiveAndSync(tempPath, migratedBytes);
    const reread = await fsp.readFile(tempPath);
    if (sha256(reread) !== manifest.migrated_sha256) throw migrationError('migrated_state_checksum_mismatch');
    validateState15(JSON.parse(reread.toString('utf8')));
    await beforeReplace?.({ stateFile, tempPath, backupPath, manifest });
    await replaceFile(tempPath, stateFile);
    replaced = true;
    await syncDirectory(path.dirname(stateFile));
    const installed = await fsp.readFile(stateFile);
    if (sha256(installed) !== manifest.migrated_sha256) throw migrationError('installed_state_checksum_mismatch');
    validateState15(JSON.parse(installed.toString('utf8')));
    await afterReplace?.({ stateFile, backupPath, manifest });
    manifest.status = 'committed'; manifest.committed_at = clock().toISOString();
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return { ...result, state_hash: manifest.migrated_state_hash, backup_path: backupPath, manifest_path: manifestPath, manifest };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    if (replaced) {
      const backup = await fsp.readFile(backupPath);
      if (sha256(backup) !== backupDigest) throw migrationError('migration_failed_and_backup_corrupt', { cause: String(error?.message || error) });
      const restoreTemp = `${stateFile}.restore-${process.pid}-${Date.now()}.tmp`;
      await writeExclusiveAndSync(restoreTemp, backup);
      await replaceFile(restoreTemp, stateFile);
      await syncDirectory(path.dirname(stateFile));
    }
    manifest.status = 'rolled_back'; manifest.failed_at = clock().toISOString(); manifest.error = safeErrorCode(error);
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch(() => undefined);
    throw error;
  }
}

function setDefault(target, key, value) { if (target[key] === undefined) target[key] = value; }
function cleanFilename(value) { return String(value || 'attachment').replace(/[\0\r\n]/g, '').replaceAll('\\', '/').split('/').at(-1).trim().slice(0, 255) || 'attachment'; }
function cleanMime(value) { const mime = String(value || '').trim().toLowerCase(); return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;[^\r\n]*)?$/.test(mime) ? mime.split(';')[0] : null; }
function legacyStorageStatus(item) { if (item.content_deleted_at || item.status === 'content_deleted') return 'deleted'; if (item.managed_path) return 'ready'; if (item.file_ref_id || item.relative_path) return 'external'; if (item.text != null) return 'inline'; return item.status === 'ready' ? 'metadata_only' : 'failed'; }
function previewKind(mime, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (/^image\//.test(mime)) return 'image';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^video\//.test(mime)) return 'video';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime.includes('wordprocessingml') || ext === '.docx') return 'docx';
  if (mime.includes('spreadsheetml') || ext === '.xlsx') return 'xlsx';
  if (mime.includes('presentationml') || ext === '.pptx') return 'metadata';
  if (/^text\//.test(mime) || /(?:json|javascript|typescript|xml|yaml|markdown|csv)/.test(mime)) return ext === '.md' || /markdown/.test(mime) ? 'markdown' : ext === '.csv' || /csv/.test(mime) ? 'csv' : ext === '.json' || /json/.test(mime) ? 'json' : 'text';
  return 'metadata';
}
function canonicalValue(value) { if (Array.isArray(value)) return value.map(canonicalValue); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])); return value; }
function ensureUniqueIds(items, collection) { const seen = new Set(); for (const item of items) { if (!item || typeof item !== 'object' || !String(item.id || '')) throw migrationError('state_record_id_missing', { collection }); if (seen.has(item.id)) throw migrationError('state_record_id_duplicate', { collection, id: item.id }); seen.add(item.id); } }
function migrationError(code, details = {}) { const error = new Error(code); error.code = code; error.details = details; return error; }
function safeErrorCode(error) { return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? String(error.code) : 'state_migration_failed'; }
async function writeExclusiveAndSync(file, bytes) { const handle = await fsp.open(file, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
async function atomicRewrite(file, bytes) { const temp = `${file}.${process.pid}.${Date.now()}.tmp`; await writeExclusiveAndSync(temp, bytes); await replaceFile(temp, file); await syncDirectory(path.dirname(file)); }
async function replaceFile(source, target) { for (let attempt = 0; ; attempt++) { try { await fsp.rename(source, target); return; } catch (error) { if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error; await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1)))); } } }
async function syncDirectory(directory) { if (process.platform === 'win32') return; const handle = await fsp.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
