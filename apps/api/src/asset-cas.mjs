import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { id, now } from '../../../packages/shared/index.mjs';
import { CAS_DIR } from './config.mjs';

const SHA256 = /^[a-f0-9]{64}$/;

export async function writeCasBlob(
  input,
  { casRoot = CAS_DIR, mediaType = 'application/octet-stream', expectedSha256 = null } = {}
) {
  const bytes = toBuffer(input),
    sha256 = digest(bytes);
  if (expectedSha256 && expectedSha256 !== sha256)
    throw casError('cas_expected_hash_mismatch', { expected_sha256: expectedSha256, actual_sha256: sha256 });
  const storagePath = blobStoragePath(sha256),
    target = resolveCasPath(casRoot, storagePath);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = await fsp.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const existing = await verifyFile(target, sha256, bytes.length, { missing: true });
    if (!existing.ok && !existing.missing) throw casError('cas_existing_blob_tampered', { sha256, ...existing });
    if (existing.missing) await replaceFile(temp, target);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
  const verified = await verifyFile(target, sha256, bytes.length);
  if (!verified.ok) throw casError('cas_write_verification_failed', verified);
  return {
    id: `blob_${sha256}`,
    sha256,
    size_bytes: bytes.length,
    media_type: cleanMediaType(mediaType),
    storage_path: storagePath,
    created_at: now()
  };
}

export async function registerCasBlob(state, input, options = {}) {
  const written = await writeCasBlob(input, options);
  const existing = state.asset_blobs.find((item) => item.sha256 === written.sha256);
  if (existing) {
    if (existing.size_bytes !== written.size_bytes || existing.storage_path !== written.storage_path)
      throw casError('cas_blob_record_conflict', { sha256: written.sha256 });
    return existing;
  }
  state.asset_blobs.push(written);
  return written;
}

export async function readCasBlob(blobOrSha, { state = null, casRoot = CAS_DIR, verify = true } = {}) {
  const blob = resolveBlobRecord(blobOrSha, state),
    file = resolveCasPath(casRoot, blob.storage_path);
  const bytes = await fsp.readFile(file).catch((error) => {
    throw casError(error.code === 'ENOENT' ? 'cas_blob_missing' : 'cas_blob_read_failed', { sha256: blob.sha256 });
  });
  if (verify) {
    const actual = digest(bytes);
    if (actual !== blob.sha256 || bytes.length !== blob.size_bytes)
      throw casError('cas_blob_tampered', {
        sha256: blob.sha256,
        actual_sha256: actual,
        expected_size: blob.size_bytes,
        actual_size: bytes.length
      });
  }
  return bytes;
}

export async function verifyCasBlob(blobOrSha, options = {}) {
  try {
    const bytes = await readCasBlob(blobOrSha, { ...options, verify: true });
    return { ok: true, sha256: digest(bytes), size_bytes: bytes.length };
  } catch (error) {
    return { ok: false, error: error.code || error.message, details: error.details || null };
  }
}

export async function putAssetPayload(state, payload, { casRoot = CAS_DIR } = {}) {
  const normalized = normalizePayload(payload),
    entries = [],
    blobRefs = [];
  for (const entry of normalized.entries) {
    const blob = await registerCasBlob(state, entry.bytes, { casRoot, mediaType: entry.media_type });
    entries.push({
      path: entry.path,
      sha256: blob.sha256,
      size_bytes: blob.size_bytes,
      media_type: blob.media_type,
      role: entry.role
    });
    blobRefs.push({ sha256: blob.sha256, role: entry.role, path: entry.path });
  }
  const manifest = {
    schema_version: 'aiws.asset_manifest.v1',
    payload_kind: normalized.payload_kind,
    media_type: normalized.media_type,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    metadata: structuredClone(normalized.metadata || {})
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const singlePayload = entries.length === 1 && entries[0].role === 'payload';
  let contentSha256 = entries[0]?.sha256 || digest(manifestBytes),
    sizeBytes = entries[0]?.size_bytes || 0;
  if (!singlePayload) {
    const manifestBlob = await registerCasBlob(state, manifestBytes, {
      casRoot,
      mediaType: 'application/vnd.aiws.asset-manifest+json'
    });
    blobRefs.unshift({ sha256: manifestBlob.sha256, role: 'manifest', path: 'manifest.json' });
    contentSha256 = manifestBlob.sha256;
    sizeBytes = entries.reduce((sum, entry) => sum + entry.size_bytes, 0);
  }
  return {
    payload_kind: normalized.payload_kind,
    media_type: normalized.media_type,
    content_sha256: contentSha256,
    size_bytes: sizeBytes,
    blob_refs: blobRefs,
    manifest,
    verification_status: 'verified',
    immutable: true
  };
}

export async function verifyAssetVersionPayload(state, version, { casRoot = CAS_DIR } = {}) {
  if (!version || version.verification_status !== 'verified' || version.immutable !== true)
    return { ok: false, reasons: [{ code: 'asset_version_not_verified' }] };
  const reasons = [];
  for (const reference of version.blob_refs || []) {
    const sha256 = typeof reference === 'string' ? reference : reference.sha256;
    const blob = state.asset_blobs.find((item) => item.sha256 === sha256);
    if (!blob) {
      reasons.push({ code: 'asset_blob_record_missing', sha256 });
      continue;
    }
    const check = await verifyCasBlob(blob, { casRoot });
    if (!check.ok) reasons.push({ code: check.error, sha256 });
  }
  const primary =
    (version.blob_refs || []).find((item) => (typeof item === 'string' ? null : item.role) === 'manifest') ||
    (version.blob_refs || [])[0];
  const primarySha = typeof primary === 'string' ? primary : primary?.sha256;
  if (!primarySha || primarySha !== version.content_sha256)
    reasons.push({
      code: 'asset_version_primary_hash_mismatch',
      expected_sha256: version.content_sha256,
      actual_sha256: primarySha || null
    });
  if (version.manifest?.entries?.some((entry) => !safeManifestPath(entry.path)))
    reasons.push({ code: 'asset_manifest_path_invalid' });
  return { ok: reasons.length === 0, reasons };
}

export async function materializeAssetVersion(state, version, targetRoot, { casRoot = CAS_DIR } = {}) {
  const verified = await verifyAssetVersionPayload(state, version, { casRoot });
  if (!verified.ok) throw casError('asset_version_integrity_failed', { reasons: verified.reasons });
  const root = path.resolve(targetRoot);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const files = [];
  for (const entry of version.manifest.entries || []) {
    if (!safeManifestPath(entry.path)) throw casError('asset_manifest_path_invalid', { path: entry.path });
    const target = resolveWithin(root, entry.path),
      blob = state.asset_blobs.find((item) => item.sha256 === entry.sha256);
    const bytes = await readCasBlob(blob, { casRoot });
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const handle = await fsp.open(target, 'wx', 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actual = await fsp.readFile(target);
    if (digest(actual) !== entry.sha256) throw casError('asset_mount_hash_mismatch', { path: entry.path });
    await fsp.chmod(target, 0o400).catch(() => undefined);
    files.push({
      path: entry.path,
      absolute_path: target,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
      media_type: entry.media_type
    });
  }
  return { root, read_only: true, content_sha256: version.content_sha256, files };
}

export function createAssetRecord({
  projectId,
  workspaceId = null,
  taskId = null,
  taskExecutionId = null,
  assetType,
  title,
  summary = '',
  outputKey = null,
  actorId
}) {
  const created = now();
  return {
    id: id('ast'),
    project_id: projectId,
    workspace_id: workspaceId,
    node_id: taskId,
    run_id: taskExecutionId,
    task_execution_id: taskExecutionId,
    asset_type: assetType,
    title,
    summary,
    status: 'candidate',
    scope: 'project',
    evidence_refs: [],
    tags: [],
    output_key: outputKey,
    current_version_id: null,
    attestation_status: 'none',
    created_by_user_id: actorId,
    confirmed_by_user_id: null,
    created_at: created,
    updated_at: created
  };
}

export async function createImmutableAssetVersion(
  state,
  {
    asset,
    payload,
    title = asset?.title || '',
    summary = asset?.summary || '',
    evidenceRefs = [],
    repositorySha = null,
    provenance = {},
    actorId = null,
    outputKey = asset?.output_key || null,
    casRoot = CAS_DIR
  }
) {
  if (!asset || !state.assets.some((item) => item.id === asset.id)) throw casError('asset_not_persisted');
  const stored = await putAssetPayload(state, payload, { casRoot });
  const versionNumber =
    state.asset_versions
      .filter((item) => item.asset_id === asset.id)
      .reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1;
  const version = {
    id: id('av'),
    asset_id: asset.id,
    version: versionNumber,
    title,
    summary,
    body: null,
    ...stored,
    repository_sha: repositorySha || null,
    provenance: { ...structuredClone(provenance), created_by_user_id: actorId, created_at: now() },
    output_key: outputKey,
    evidence_refs: [...new Set(evidenceRefs)],
    confirmed_by_user_id: null,
    created_at: now()
  };
  state.asset_versions.push(version);
  Object.assign(asset, {
    title,
    summary,
    current_version_id: version.id,
    status: 'candidate',
    attestation_status: 'none',
    updated_at: now()
  });
  return version;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}
export function blobStoragePath(sha256) {
  if (!SHA256.test(String(sha256 || ''))) throw casError('cas_sha256_invalid');
  return path.posix.join('sha256', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}
export function resolveCasPath(casRoot, storagePath) {
  return resolveWithin(path.resolve(casRoot), storagePath);
}
export function safeManifestPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  return (
    Boolean(normalized) &&
    normalized.length <= 500 &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:/.test(normalized) &&
    !normalized.split('/').some((part) => !part || part === '.' || part === '..') &&
    !normalized.includes('\0')
  );
}

function normalizePayload(payload) {
  const source = payload && typeof payload === 'object' && !Buffer.isBuffer(payload) ? payload : { content: payload };
  const payloadKind = String(source.payload_kind || source.kind || inferPayloadKind(source)).trim();
  const mediaType = cleanMediaType(source.media_type || inferredMediaType(payloadKind));
  const rawFiles = Array.isArray(source.files) ? source.files : Array.isArray(source.entries) ? source.entries : null;
  if (rawFiles && (rawFiles.length > 0 || ['file_set', 'git_bundle'].includes(payloadKind))) {
    const raw = rawFiles;
    if (!raw.length) throw casError('asset_payload_files_empty');
    const seen = new Set(),
      entries = raw.map((entry, index) => {
        const entryPath = String(entry?.path || `file-${index + 1}`);
        if (!safeManifestPath(entryPath) || seen.has(entryPath))
          throw casError('asset_manifest_path_invalid', { path: entryPath });
        seen.add(entryPath);
        return {
          path: entryPath,
          role: String(entry.role || 'file'),
          media_type: cleanMediaType(entry.media_type || 'application/octet-stream'),
          bytes: toBuffer(entry.content ?? entry.bytes ?? '')
        };
      });
    return { payload_kind: payloadKind || 'file_set', media_type: mediaType, entries, metadata: source.metadata || {} };
  }
  let bytes;
  if (payloadKind === 'json' || ['test_report', 'external_snapshot'].includes(payloadKind))
    bytes = Buffer.from(
      canonicalJson(parseStructuredContent(source.content ?? source.value ?? source.report ?? {})),
      'utf8'
    );
  else bytes = toBuffer(source.content ?? source.body ?? source.value ?? '');
  return {
    payload_kind: payloadKind || 'text',
    media_type: mediaType,
    entries: [{ path: defaultPayloadName(payloadKind, mediaType), role: 'payload', media_type: mediaType, bytes }],
    metadata: source.metadata || {}
  };
}
function inferPayloadKind(source) {
  if (source.files || source.entries) return 'file_set';
  if (source.content && typeof source.content === 'object' && !Buffer.isBuffer(source.content)) return 'json';
  return 'text';
}
function inferredMediaType(kind) {
  return ['json', 'test_report', 'external_snapshot'].includes(kind)
    ? 'application/json'
    : kind === 'text'
      ? 'text/plain; charset=utf-8'
      : 'application/octet-stream';
}
function defaultPayloadName(kind, mediaType) {
  if (mediaType.includes('json')) return kind === 'test_report' ? 'test-report.json' : 'payload.json';
  if (mediaType.startsWith('text/')) return 'payload.txt';
  return 'payload.bin';
}
function parseStructuredContent(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(canonicalJson(value), 'utf8');
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function cleanMediaType(value) {
  const text = String(value || 'application/octet-stream')
    .trim()
    .slice(0, 200);
  if (!/^[\w.+-]+\/[\w.+-]+(?:\s*;[^\r\n]*)?$/.test(text)) throw casError('asset_media_type_invalid');
  return text;
}
function resolveBlobRecord(value, state) {
  if (value && typeof value === 'object') return value;
  const sha256 = String(value || '');
  if (!SHA256.test(sha256)) throw casError('cas_sha256_invalid');
  const record = state?.asset_blobs?.find((item) => item.sha256 === sha256);
  if (!record) throw casError('cas_blob_record_missing', { sha256 });
  return record;
}
function resolveWithin(root, relative) {
  const target = path.resolve(root, String(relative || ''));
  const difference = path.relative(root, target);
  if (difference.startsWith('..') || path.isAbsolute(difference))
    throw casError('cas_path_outside_root', { path: relative });
  return target;
}
async function verifyFile(file, sha256, size, { missing = false } = {}) {
  try {
    const bytes = await fsp.readFile(file);
    const actual = digest(bytes);
    return { ok: bytes.length === size && actual === sha256, actual_sha256: actual, actual_size: bytes.length };
  } catch (error) {
    if (missing && error.code === 'ENOENT') return { ok: false, missing: true };
    throw error;
  }
}
async function replaceFile(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (error.code === 'EEXIST') {
        await fsp.rm(source, { force: true });
        return;
      }
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])])
    );
  return value;
}
function casError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
