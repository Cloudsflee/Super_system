import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalJson,
  canonicalStateHash,
  LEGACY_OFFICIAL_RUNNER_PATTERN
} from '../apps/api/src/state-migration-v15.mjs';
import { V16_LEGACY_OFFICIAL_RUNNER_PATTERN } from '../apps/api/src/state-migration-v16.mjs';
import { V17_LEGACY_OFFICIAL_RUNNER_PATTERN } from '../apps/api/src/state-migration-v17.mjs';
import { V18_LEGACY_OFFICIAL_RUNNER_PATTERN } from '../apps/api/src/state-migration-v18.mjs';

const RECEIPT_RELATIVE_PATH = 'data/migrations/v16-volume-migration.manifest.json';

export async function auditVolume(root) {
  const inventory = await volumeInventory(root);
  const state = await stateAudit(root);
  return {
    inventory: inventorySummary(inventory),
    state: { ...publicStateAudit(state), schema_migrations: state.schema_migrations.map(publicSchemaMigration) }
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

export function compareStateIdentities(source, target) {
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

export function comparePreservedFiles(sourceEntries, targetEntries) {
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

export function mutableMigrationPath(value) {
  return value === 'data/state.json' || /^codex-homes\/[^/]+\/config\.toml$/.test(value);
}

export function findLegacyRunnerReferences(value) {
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
export function findLegacyRunnerReferencesV17(value) {
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
export function findLegacyRunnerReferencesV18(value) {
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
export function findLegacyRunnerReferencesV19(value) {
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

export function findLegacyRunnerReferencesV20(value) {
  const pattern = /^aiws-codex-runner:1\.(?:[0-9]|10)\.0-codex-\d+\.\d+\.\d+$/;
  const found = [];
  for (const [index, profile] of (value?.codex_profiles || []).entries()) {
    inspect(profile?.image, `codex_profiles.${index}.image`);
    inspect(profile?.config?.image, `codex_profiles.${index}.config.image`);
  }
  for (const [index, integration] of (value?.integration_statuses || []).entries())
    if (integration?.key === 'codex_docker') inspect(integration.image, `integration_statuses.${index}.image`);
  return found.sort((left, right) => left.path.localeCompare(right.path));

  function inspect(current, field) {
    if (pattern.test(String(current || ''))) found.push({ path: field, image: current });
  }
}

export async function schemaMigrationManifests(root) {
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

export function publicStateAudit(value) {
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

export function publicSchemaMigration(value) {
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

export function inventorySummary(value) {
  return {
    hash: value.hash,
    files: value.files,
    directories: value.directories,
    symlinks: value.symlinks,
    total_bytes: value.total_bytes
  };
}

export function withoutInventoryEntries(value) {
  return { ...value, source_inventory: inventorySummary(value.source_inventory) };
}

export function keyInventory(entries, prefix) {
  return entries
    .filter((item) => item.path === prefix.slice(0, -1) || item.path.startsWith(prefix))
    .map((item) => item.path);
}

export function transientCodexPath(value) {
  const parts = value.split('/');
  return parts.length >= 3 && parts[0] === 'codex-homes' && parts[2] === 'tmp';
}

export function assertSafeSymlink(name, target) {
  if (!target || target.includes('\\') || target.includes('\0') || path.posix.isAbsolute(target))
    throw releaseError('volume_symlink_target_invalid', { path: name });
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
  if (resolved === '..' || resolved.startsWith('../'))
    throw releaseError('volume_symlink_target_outside', { path: name });
}

export function recordIdentity(item, index) {
  if (!item || typeof item !== 'object') return `@${index}`;
  if (item.id != null && String(item.id)) return String(item.id);
  if (item.key != null && String(item.key)) return `${item.key}:${item.profile_id || item.project_id || ''}`;
  return `@${index}`;
}

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeSha(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw releaseError('sha256_invalid');
  return normalized;
}

export function normalizeOptionalSha(value) {
  return value == null || value === '' || value === '-' ? null : normalizeSha(value);
}

export function withDocumentHash(value, field) {
  return { ...value, [field]: sha256(Buffer.from(canonicalJson(value))) };
}

export async function readHashedJson(file, field) {
  const value = JSON.parse(await fsp.readFile(file, 'utf8'));
  const expected = value[field];
  const unsigned = { ...value };
  delete unsigned[field];
  if (expected !== sha256(Buffer.from(canonicalJson(unsigned))))
    throw releaseError('release_manifest_hash_mismatch', { file: path.basename(file) });
  return value;
}

export async function atomicJsonWrite(file, value) {
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

export function pickCounts(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key] || 0]));
}

export function releaseError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
