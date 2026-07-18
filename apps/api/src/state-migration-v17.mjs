import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalStateHash, migrateState15To16, sha256, validateState16, V16_COLLECTIONS } from './state-migration-v16.mjs';

export const STATE_SCHEMA_VERSION = 17;
export const V17_COLLECTIONS = Object.freeze([...V16_COLLECTIONS, 'mcp_clients']);
export { canonicalStateHash, sha256 };

export const V17_LEGACY_OFFICIAL_RUNNER_PATTERN = /^aiws-codex-runner:1\.[0-7]\.0-codex-\d+\.\d+\.\d+$/;
export const V18_RUNNER_IMAGE = 'aiws-codex-runner:1.8.0-codex-0.144.0';
const CLIENT_STATUSES = new Set(['active', 'revoked', 'expired']);

export function migrateState16To17(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion === STATE_SCHEMA_VERSION) {
    const state = structuredClone(source);
    normalizeV17RecordDefaults(state);
    validateState17(state);
    return { state, migrated: false, from_version: 17, to_version: 17, created_mcp_clients: 0, normalized_runner_profiles: [], staled_runner_probes: 0 };
  }
  if (![12, 13, 14, 15, 16].includes(inputVersion)) throw migrationError('unsupported_state_schema', { schema_version: source.schema_version ?? null });
  const state = inputVersion === 16 ? structuredClone(source) : migrateState15To16(source, { timestamp }).state;
  for (const collection of V17_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];
  normalizeV17RecordDefaults(state);
  const runner = normalizeOfficialRunnerImagesV18(state, { timestamp });
  state.schema_version = STATE_SCHEMA_VERSION;
  validateState17(state);
  return {
    state,
    migrated: true,
    from_version: inputVersion,
    to_version: 17,
    created_mcp_clients: 0,
    normalized_runner_profiles: runner.profile_ids,
    staled_runner_probes: runner.staled_probe_count
  };
}

export function normalizeOfficialRunnerImagesV18(state, { targetImage = V18_RUNNER_IMAGE, timestamp = new Date().toISOString() } = {}) {
  const changedProfiles = new Set(), changedFields = [];
  for (const profile of Array.isArray(state?.codex_profiles) ? state.codex_profiles : []) {
    for (const [container, field] of [[profile, 'image'], [profile?.config, 'image']]) {
      if (!container || !V17_LEGACY_OFFICIAL_RUNNER_PATTERN.test(String(container[field] || '')) || container[field] === targetImage) continue;
      changedFields.push({ profile_id: profile.id || null, field: container === profile ? 'image' : 'config.image', from: container[field], to: targetImage });
      container[field] = targetImage;
      if (profile.id) changedProfiles.add(profile.id);
    }
  }
  for (const integration of Array.isArray(state?.integration_statuses) ? state.integration_statuses : []) {
    if (integration?.key !== 'codex_docker' || !V17_LEGACY_OFFICIAL_RUNNER_PATTERN.test(String(integration.image || '')) || integration.image === targetImage) continue;
    changedFields.push({ profile_id: null, field: 'integration_statuses.codex_docker.image', from: integration.image, to: targetImage });
    integration.image = targetImage;
  }
  let staledProbeCount = 0;
  for (const probe of Array.isArray(state?.integration_statuses) ? state.integration_statuses : []) {
    if (probe?.key !== 'codex_probe' || !changedProfiles.has(probe.profile_id)) continue;
    probe.status = 'stale'; probe.updated_at = timestamp; staledProbeCount += 1;
  }
  return { changed: changedFields.length > 0, profile_ids: [...changedProfiles].sort(), changed_fields: changedFields, staled_probe_count: staledProbeCount };
}

export function validateState17(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw migrationError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION) throw migrationError('state_schema_not_17', { schema_version: state.schema_version ?? null });
  for (const collection of V17_COLLECTIONS) if (!Array.isArray(state[collection])) throw migrationError('state_collection_invalid', { collection });
  validateState16({ ...state, schema_version: 16 });
  ensureUniqueIds(state.mcp_clients, 'mcp_clients');
  const userIds = new Set((state.users || []).map((user) => user.id));
  for (const client of state.mcp_clients) {
    validateMcpClient(client);
    if (client.subject_user_id && !userIds.has(client.subject_user_id)) throw migrationError('mcp_client_subject_user_missing', { id: client.id, subject_user_id: client.subject_user_id });
  }
  return state;
}

export async function migrateStateFileToV17(stateFile, {
  backupDirectory = path.join(path.dirname(stateFile), 'migrations'), clock = () => new Date(), beforeReplace, afterReplace
} = {}) {
  const original = await fsp.readFile(stateFile);
  const parsed = JSON.parse(original.toString('utf8'));
  const result = migrateState16To17(parsed, { timestamp: clock().toISOString() });
  if (!result.migrated) return { ...result, state_hash: canonicalStateHash(result.state), backup_path: null, manifest_path: null };
  await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = clock().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.json`);
  const manifestPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.manifest.json`);
  await writeExclusiveAndSync(backupPath, original);
  const backupDigest = sha256(original);
  const migratedBytes = Buffer.from(`${JSON.stringify(result.state, null, 2)}\n`, 'utf8');
  const tempPath = `${stateFile}.v17-${process.pid}-${Date.now()}.tmp`;
  const manifest = {
    migration: `aiws-state-${result.from_version}-to-17`, status: 'prepared', from_schema: result.from_version, to_schema: 17,
    created_at: clock().toISOString(), original_sha256: backupDigest, original_state_hash: canonicalStateHash(parsed),
    migrated_sha256: sha256(migratedBytes), migrated_state_hash: canonicalStateHash(result.state),
    created_mcp_clients: 0, normalized_runner_profiles: result.normalized_runner_profiles, staled_runner_probes: result.staled_runner_probes,
    backup_file: path.basename(backupPath), state_file: path.basename(stateFile)
  };
  await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  let replaced = false;
  try {
    await writeExclusiveAndSync(tempPath, migratedBytes);
    const reread = await fsp.readFile(tempPath);
    if (sha256(reread) !== manifest.migrated_sha256) throw migrationError('migrated_state_checksum_mismatch');
    validateState17(JSON.parse(reread.toString('utf8')));
    await beforeReplace?.({ stateFile, tempPath, backupPath, manifest });
    await replaceFile(tempPath, stateFile); replaced = true;
    await syncDirectory(path.dirname(stateFile));
    const installed = await fsp.readFile(stateFile);
    if (sha256(installed) !== manifest.migrated_sha256) throw migrationError('installed_state_checksum_mismatch');
    validateState17(JSON.parse(installed.toString('utf8')));
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
      await writeExclusiveAndSync(restoreTemp, backup); await replaceFile(restoreTemp, stateFile); await syncDirectory(path.dirname(stateFile));
    }
    manifest.status = 'rolled_back'; manifest.failed_at = clock().toISOString(); manifest.error = safeErrorCode(error);
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch(() => undefined);
    throw error;
  }
}

function normalizeV17RecordDefaults(state) {
  if (!Array.isArray(state.mcp_clients)) state.mcp_clients = [];
  const users = new Set((state.users || []).map((user) => user.id));
  for (const client of state.mcp_clients) {
    if (client.subject_user_id === undefined) client.subject_user_id = users.has(client.created_by) ? client.created_by : null;
  }
}

function validateMcpClient(client) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) throw migrationError('mcp_client_invalid');
  if (!String(client.name || '').trim() || String(client.name).length > 120) throw migrationError('mcp_client_name_invalid', { id: client.id });
  if (!/^[A-Za-z0-9_-]{6,24}$/.test(String(client.token_prefix || ''))) throw migrationError('mcp_client_token_prefix_invalid', { id: client.id });
  if (!/^[a-f0-9]{64}$/.test(String(client.token_hash || ''))) throw migrationError('mcp_client_token_hash_invalid', { id: client.id });
  if (!Array.isArray(client.scopes) || client.scopes.some((scope) => !/^[a-z][a-z0-9-]*:(?:read|write|decide|admin|execute)$/.test(String(scope)))) throw migrationError('mcp_client_scopes_invalid', { id: client.id });
  if (!Array.isArray(client.project_allowlist) || client.project_allowlist.some((id) => typeof id !== 'string' || !id)) throw migrationError('mcp_client_project_allowlist_invalid', { id: client.id });
  if (!CLIENT_STATUSES.has(client.status)) throw migrationError('mcp_client_status_invalid', { id: client.id });
  if (client.expires_at !== null && !validTimestamp(client.expires_at)) throw migrationError('mcp_client_expiry_invalid', { id: client.id });
  if (!Number.isInteger(client.concurrent_limit) || client.concurrent_limit < 1 || client.concurrent_limit > 32) throw migrationError('mcp_client_concurrent_limit_invalid', { id: client.id });
  if (!Number.isInteger(client.rate_limit_per_minute) || client.rate_limit_per_minute < 1 || client.rate_limit_per_minute > 6000) throw migrationError('mcp_client_rate_limit_invalid', { id: client.id });
  if (client.subject_user_id !== null && (typeof client.subject_user_id !== 'string' || !client.subject_user_id)) throw migrationError('mcp_client_subject_user_invalid', { id: client.id });
  for (const forbidden of ['token', 'plain_token', 'plaintext_token', 'secret', 'access_token']) if (Object.hasOwn(client, forbidden)) throw migrationError('mcp_client_plaintext_token_forbidden', { id: client.id, field: forbidden });
}

function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(new Date(value).getTime()); }
function ensureUniqueIds(items, collection) { const seen = new Set(); for (const item of items) { if (!item || typeof item !== 'object' || !String(item.id || '')) throw migrationError('state_record_id_missing', { collection }); if (seen.has(item.id)) throw migrationError('state_record_id_duplicate', { collection, id: item.id }); seen.add(item.id); } }
function migrationError(code, details = {}) { const error = new Error(code); error.code = code; error.details = details; return error; }
function safeErrorCode(error) { return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? String(error.code) : 'state_migration_failed'; }
async function writeExclusiveAndSync(file, bytes) { const handle = await fsp.open(file, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
async function atomicRewrite(file, bytes) { const temp = `${file}.${process.pid}.${Date.now()}.tmp`; await writeExclusiveAndSync(temp, bytes); await replaceFile(temp, file); await syncDirectory(path.dirname(file)); }
async function replaceFile(source, target) { for (let attempt = 0; ; attempt += 1) { try { await fsp.rename(source, target); return; } catch (error) { if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error; await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1)))); } } }
async function syncDirectory(directory) { if (process.platform === 'win32') return; const handle = await fsp.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
