import { createPublicKey, sign, timingSafeEqual, verify } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

export const RUNNER_JOB_SPEC_VERSION = 'runner.job-spec.v2';
export const RUNNER_RECEIPT_VERSION = 'runner.receipt.v2';
export const RUNNER_STAGES = Object.freeze(['prepare', 'context', 'run', 'check', 'review', 'finalize', 'deliver']);
export const RUNNER_RESOURCE_PROFILES = Object.freeze({
  light: Object.freeze({ cpus: 1, memory_bytes: 1024 ** 3, pids: 256, tmpfs_bytes: 256 * 1024 ** 2 }),
  standard: Object.freeze({ cpus: 2, memory_bytes: 4 * 1024 ** 3, pids: 512, tmpfs_bytes: 1024 ** 3 })
});

const JOB_KEYS = new Set([
  'schema_version', 'job_spec_id', 'execution_ref', 'generation', 'task_ref', 'attempt',
  'runner_profile_ref', 'runner_profile_revision', 'runner_profile_hash', 'image_digest',
  'deadline_at', 'capabilities', 'resource_profile', 'execution_mode', 'input_refs',
  'input_paths', 'output_paths', 'check_ids', 'workspace_ref', 'workspace_hash',
  'context_pack_ref', 'context_pack_hash', 'service_key_id', 'created_at'
]);
const RECEIPT_KEYS = new Set([
  'schema_version', 'receipt_id', 'job_spec_id', 'job_spec_hash', 'runner_profile_ref',
  'runner_job_ref', 'status', 'exit_code', 'stdout_sha256', 'stderr_sha256',
  'output_sha256', 'stdout_bytes', 'stderr_bytes', 'output_bytes', 'output_paths',
  'error_code', 'started_at', 'finished_at'
]);
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z][A-Za-z0-9_.~-]{0,255}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'external_result_unknown']);
const CAPABILITIES = new Set(['workspace:read', 'workspace:write', 'network:none', 'network:model', 'check:node_test', 'check:git_diff_check']);
const CHECKS = new Set(['node_test', 'git_diff_check']);

export function validateRunnerJobSpec(value, { now = Date.now(), expectedImageDigest = null } = {}) {
  assertRecord(value, 'runner_job_spec_invalid');
  rejectUnknown(value, JOB_KEYS, 'runner_job_spec_invalid');
  if (value.schema_version !== RUNNER_JOB_SPEC_VERSION) fail('runner_job_spec_invalid', 'runner job specification version is invalid');
  for (const field of ['job_spec_id', 'execution_ref', 'task_ref', 'runner_profile_ref', 'workspace_ref', 'context_pack_ref', 'service_key_id']) assertOpaque(value[field], field);
  assertInteger(value.generation, 1, Number.MAX_SAFE_INTEGER, 'generation');
  assertInteger(value.attempt, 1, 3, 'attempt');
  assertInteger(value.runner_profile_revision, 1, Number.MAX_SAFE_INTEGER, 'runner_profile_revision');
  assertHash(value.runner_profile_hash, 'runner_profile_hash');
  assertHash(value.workspace_hash, 'workspace_hash');
  assertHash(value.context_pack_hash, 'context_pack_hash');
  const digest = String(value.image_digest || '');
  if (digest && !DIGEST.test(digest)) fail('runner_digest_invalid', 'runner image digest is invalid');
  if (expectedImageDigest && digest !== expectedImageDigest) fail('runner_digest_mismatch', 'runner image digest does not match the profile');
  if (!['read', 'write'].includes(value.execution_mode)) fail('runner_job_spec_invalid', 'execution mode is invalid');
  if (!Object.hasOwn(RUNNER_RESOURCE_PROFILES, value.resource_profile)) fail('runner_resource_profile_invalid', 'runner resource profile is invalid');
  const deadline = Date.parse(String(value.deadline_at || ''));
  const current = typeof now === 'function' ? Number(now()) : Number(now);
  if (!Number.isFinite(deadline) || deadline <= current || deadline > current + 15 * 60 * 1000) fail('runner_deadline_invalid', 'runner deadline must be within fifteen minutes');
  if (!Number.isFinite(Date.parse(String(value.created_at || '')))) fail('runner_job_spec_invalid', 'runner created timestamp is invalid');
  const inputPaths = pathList(value.input_paths, 'input_paths');
  const outputPaths = pathList(value.output_paths, 'output_paths');
  const capabilities = stringSet(value.capabilities, 16, CAPABILITIES, 'capabilities');
  const checkIds = stringSet(value.check_ids, 16, CHECKS, 'check_ids');
  if (value.execution_mode === 'write' && !capabilities.includes('workspace:write')) fail('runner_capability_denied', 'write task lacks workspace capability');
  const inputRefs = Array.isArray(value.input_refs) ? value.input_refs : [];
  if (inputRefs.length > 64) fail('runner_quota_exceeded', 'input reference limit exceeded');
  const normalizedRefs = inputRefs.map((item) => {
    assertRecord(item, 'runner_job_spec_invalid');
    rejectUnknown(item, new Set(['type', 'ref', 'revision', 'hash']), 'runner_job_spec_invalid');
    assertOpaque(item.type, 'input_ref.type');
    if (item.type === 'task_contract') {
      if (!/^task-contract:[A-Za-z][A-Za-z0-9_.~-]{0,159}:[A-Za-z][A-Za-z0-9_.~-]{0,159}:[1-3]$/.test(String(item.ref || ''))) fail('runner_job_spec_invalid', 'task contract reference is invalid');
    } else assertOpaque(item.ref, 'input_ref.ref');
    assertInteger(item.revision, 0, Number.MAX_SAFE_INTEGER, 'input_ref.revision'); assertHash(item.hash, 'input_ref.hash');
    return { type: String(item.type), ref: String(item.ref), revision: Number(item.revision), hash: String(item.hash) };
  });
  const normalized = {
    ...value,
    generation: Number(value.generation), attempt: Number(value.attempt),
    runner_profile_revision: Number(value.runner_profile_revision),
    capabilities, input_refs: normalizedRefs, input_paths: inputPaths,
    output_paths: outputPaths, check_ids: checkIds,
    image_digest: digest
  };
  if (Buffer.byteLength(canonicalJson(normalized)) > 512 * 1024) fail('runner_quota_exceeded', 'runner job specification is too large');
  return Object.freeze(normalized);
}

export function signRunnerJobSpec(value, privateKey, options = {}) {
  const spec = validateRunnerJobSpec(value, options);
  const json = canonicalJson(spec);
  return Object.freeze({ spec, spec_json: json, spec_sha256: sha256Hex(json), signature: sign(null, Buffer.from(json), privateKey).toString('base64url') });
}

export function verifyRunnerJobSpec(value, signature, publicKey, options = {}) {
  const spec = validateRunnerJobSpec(value, options);
  const json = canonicalJson(spec);
  let bytes;
  try { bytes = Buffer.from(String(signature || ''), 'base64url'); } catch { fail('runner_signature_invalid', 'runner job signature is invalid'); }
  if (!verify(null, Buffer.from(json), publicKeyObject(publicKey), bytes)) fail('runner_signature_invalid', 'runner job signature is invalid');
  return { spec, spec_json: json, spec_sha256: sha256Hex(json) };
}

export function validateRunnerReceipt(value, { expectedJobSpecId = null, expectedJobSpecHash = null } = {}) {
  assertRecord(value, 'runner_receipt_invalid');
  rejectUnknown(value, RECEIPT_KEYS, 'runner_receipt_invalid');
  if (value.schema_version !== RUNNER_RECEIPT_VERSION) fail('runner_receipt_invalid', 'runner receipt version is invalid');
  for (const field of ['receipt_id', 'job_spec_id', 'runner_profile_ref', 'runner_job_ref']) assertOpaque(value[field], field);
  assertHash(value.job_spec_hash, 'job_spec_hash');
  if (expectedJobSpecId && value.job_spec_id !== expectedJobSpecId) fail('runner_receipt_mismatch', 'runner receipt job reference changed');
  if (expectedJobSpecHash && !safeEqual(value.job_spec_hash, expectedJobSpecHash)) fail('runner_receipt_mismatch', 'runner receipt job hash changed');
  if (!TERMINAL.has(value.status)) fail('runner_receipt_invalid', 'runner receipt status is invalid');
  if (value.exit_code != null && (!Number.isInteger(Number(value.exit_code)) || Number(value.exit_code) < -1 || Number(value.exit_code) > 255)) fail('runner_receipt_invalid', 'runner exit code is invalid');
  for (const field of ['stdout_sha256', 'stderr_sha256', 'output_sha256']) if (value[field] && !HASH.test(String(value[field]))) fail('runner_receipt_invalid', `${field} is invalid`);
  assertInteger(value.stdout_bytes, 0, 2 * 1024 * 1024, 'stdout_bytes');
  assertInteger(value.stderr_bytes, 0, 2 * 1024 * 1024, 'stderr_bytes');
  if (Number(value.stdout_bytes) + Number(value.stderr_bytes) > 2 * 1024 * 1024) fail('runner_output_too_large', 'runner output exceeds two MiB');
  assertInteger(value.output_bytes, 0, 10 * 1024 * 1024, 'output_bytes');
  const started = Date.parse(String(value.started_at || '')); const finished = Date.parse(String(value.finished_at || ''));
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) fail('runner_receipt_invalid', 'runner receipt timestamps are invalid');
  return Object.freeze({
    ...value,
    exit_code: value.exit_code == null ? null : Number(value.exit_code),
    stdout_bytes: Number(value.stdout_bytes), stderr_bytes: Number(value.stderr_bytes), output_bytes: Number(value.output_bytes),
    output_paths: pathList(value.output_paths, 'output_paths'), error_code: String(value.error_code || '').slice(0, 120)
  });
}

export function signRunnerReceipt(value, privateKey, options = {}) {
  const receipt = validateRunnerReceipt(value, options);
  const json = canonicalJson(receipt);
  return Object.freeze({ receipt, receipt_json: json, receipt_sha256: sha256Hex(json), signature: sign(null, Buffer.from(json), privateKey).toString('base64url') });
}

export function verifyRunnerReceipt(value, signature, publicKey, options = {}) {
  const receipt = validateRunnerReceipt(value, options);
  const json = canonicalJson(receipt);
  let bytes;
  try { bytes = Buffer.from(String(signature || ''), 'base64url'); } catch { fail('runner_receipt_signature_invalid', 'runner receipt signature is invalid'); }
  if (!verify(null, Buffer.from(json), publicKeyObject(publicKey), bytes)) fail('runner_receipt_signature_invalid', 'runner receipt signature is invalid');
  return { receipt, receipt_json: json, receipt_sha256: sha256Hex(json) };
}

function pathList(value, field) {
  if (!Array.isArray(value) || value.length > 64) fail('runner_path_invalid', `${field} must contain at most 64 paths`);
  const result = value.map((item) => relativePath(item, field));
  if (new Set(result).size !== result.length) fail('runner_path_invalid', `${field} contains duplicate paths`);
  const sorted = [...result].sort();
  for (let index = 1; index < sorted.length; index += 1) if (sorted[index].startsWith(`${sorted[index - 1]}/`)) fail('runner_path_invalid', `${field} contains overlapping paths`);
  return result;
}

function relativePath(value, field) {
  const raw = String(value || '');
  if (!raw || raw.length > 512 || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || /[\0\r\n]/.test(raw)) fail('runner_path_invalid', `${field} contains an invalid path`);
  const segments = raw.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) fail('runner_path_invalid', `${field} escapes the managed workspace`);
  return segments.join('/');
}

function stringSet(value, maximum, allowlist, field) {
  if (!Array.isArray(value) || value.length > maximum) fail('runner_job_spec_invalid', `${field} is invalid`);
  const result = value.map(String);
  if (new Set(result).size !== result.length || result.some((item) => !allowlist.has(item))) fail('runner_capability_denied', `${field} contains a value outside the allowlist`);
  return result.sort();
}

function assertRecord(value, code) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, 'runner payload must be an object'); }
function rejectUnknown(value, allowed, code) { for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `runner payload field is not allowed: ${key}`); }
function assertOpaque(value, field) { if (!OPAQUE.test(String(value || ''))) fail('runner_job_spec_invalid', `${field} must be an opaque reference`); }
function assertHash(value, field) { if (!HASH.test(String(value || ''))) fail('runner_job_spec_invalid', `${field} must be a SHA-256 hash`); }
function assertInteger(value, minimum, maximum, field) { const number = Number(value); if (!Number.isInteger(number) || number < minimum || number > maximum) fail('runner_quota_exceeded', `${field} is outside the allowed bounds`); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function publicKeyObject(value) { return value?.type === 'public' ? value : createPublicKey(value); }
function fail(code, message) { throw new PlatformError(code, message, {}, code.includes('mismatch') ? 409 : 422); }
