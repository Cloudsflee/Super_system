import { createPublicKey, sign, timingSafeEqual, verify } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { DEFAULT_PARSER_LIMITS } from './parser-limits.mjs';

export const PARSER_JOB_VERSION = 'parser.job.v1';
export const PARSER_RECEIPT_VERSION = 'parser.receipt.v1';
export const EVIDENCE_ASSET_VERSION = 'evidence.asset.v2';

const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z][A-Za-z0-9_.~-]{0,255}$/;
const TERMINAL = new Set(['parsed', 'unsupported', 'invalid', 'resource_exceeded', 'failed', 'cancelled', 'external_result_unknown']);
const JOB_KEYS = new Set([
  'schema_version', 'parser_job_id', 'parser_run_ref', 'project_ref', 'asset_version_ref',
  'input_sha256', 'input_cas_sha256', 'input_bytes', 'media_type', 'format_key',
  'format_sha256', 'worker_image_digest', 'limits', 'limits_sha256',
  'checkpoint_token_hash', 'service_key_id', 'deadline_at', 'created_at'
]);
const RECEIPT_KEYS = new Set([
  'schema_version', 'receipt_id', 'parser_job_id', 'parser_run_ref', 'job_sha256',
  'status', 'input_sha256', 'format_sha256', 'limits_sha256', 'checkpoint_token_hash',
  'output_manifest', 'output_manifest_sha256', 'error_code', 'started_at', 'finished_at'
]);
const OUTPUT_KEYS = new Set(['kind', 'content_sha256', 'byte_length', 'media_type', 'metadata_sha256']);

export function validateParserJob(value, { now = Date.now(), expectedImageDigest = null } = {}) {
  record(value, 'parser_job_invalid'); unknown(value, JOB_KEYS, 'parser_job_invalid');
  if (value.schema_version !== PARSER_JOB_VERSION) fail('parser_job_invalid', 'parser job version is invalid');
  for (const field of ['parser_job_id', 'parser_run_ref', 'project_ref', 'asset_version_ref', 'format_key', 'service_key_id']) opaque(value[field], field);
  hash(value.input_sha256, 'input_sha256'); hash(value.input_cas_sha256, 'input_cas_sha256'); hash(value.format_sha256, 'format_sha256');
  hash(value.limits_sha256, 'limits_sha256'); hash(value.checkpoint_token_hash, 'checkpoint_token_hash');
  if (!DIGEST.test(String(value.worker_image_digest || ''))) fail('parser_digest_invalid', 'parser image digest is invalid');
  if (expectedImageDigest && !safeEqual(value.worker_image_digest, expectedImageDigest)) fail('parser_digest_mismatch', 'parser image digest changed');
  integer(value.input_bytes, 0, DEFAULT_PARSER_LIMITS.max_input_bytes, 'input_bytes');
  const mediaType = String(value.media_type || ''); if (!mediaType || mediaType.length > 160 || /[\r\n]/.test(mediaType)) fail('parser_job_invalid', 'parser media type is invalid');
  const limits = parserLimits(value.limits); const limitsJson = canonicalJson(limits);
  if (!safeEqual(sha256Hex(limitsJson), value.limits_sha256)) fail('parser_limits_mismatch', 'parser limits hash changed');
  const deadline = Date.parse(String(value.deadline_at || '')); const current = typeof now === 'function' ? Number(now()) : Number(now);
  if (!Number.isFinite(deadline) || deadline <= current || deadline > current + DEFAULT_PARSER_LIMITS.deadline_seconds * 1000) fail('parser_deadline_invalid', 'parser deadline is outside the fixed bound');
  if (!Number.isFinite(Date.parse(String(value.created_at || '')))) fail('parser_job_invalid', 'parser created timestamp is invalid');
  const normalized = { ...value, input_bytes: Number(value.input_bytes), media_type: mediaType, limits };
  if (Buffer.byteLength(canonicalJson(normalized)) > 64 * 1024) fail('parser_job_invalid', 'parser job envelope is too large');
  return Object.freeze(normalized);
}

export function signParserJob(value, privateKey, options = {}) {
  const job = validateParserJob(value, options); const jobJson = canonicalJson(job);
  return Object.freeze({ job, job_json: jobJson, job_sha256: sha256Hex(jobJson), signature: sign(null, Buffer.from(jobJson), privateKey).toString('base64url') });
}

export function verifyParserJob(value, signature, publicKey, options = {}) {
  const job = validateParserJob(value, options); const jobJson = canonicalJson(job); const bytes = signatureBytes(signature, 'parser_job_signature_invalid');
  if (!verify(null, Buffer.from(jobJson), publicKeyObject(publicKey), bytes)) fail('parser_job_signature_invalid', 'parser job signature is invalid', 403);
  return { job, job_json: jobJson, job_sha256: sha256Hex(jobJson) };
}

export function validateParserReceipt(value, options = {}) {
  record(value, 'parser_receipt_invalid'); unknown(value, RECEIPT_KEYS, 'parser_receipt_invalid');
  if (value.schema_version !== PARSER_RECEIPT_VERSION) fail('parser_receipt_invalid', 'parser receipt version is invalid');
  for (const field of ['receipt_id', 'parser_job_id', 'parser_run_ref']) opaque(value[field], field);
  for (const field of ['job_sha256', 'input_sha256', 'format_sha256', 'limits_sha256', 'checkpoint_token_hash', 'output_manifest_sha256']) hash(value[field], field);
  if (options.expectedJobId && value.parser_job_id !== options.expectedJobId) fail('parser_receipt_mismatch', 'parser job reference changed', 409);
  for (const [field, expected] of [['job_sha256', options.expectedJobHash], ['input_sha256', options.expectedInputHash], ['format_sha256', options.expectedFormatHash], ['limits_sha256', options.expectedLimitsHash], ['checkpoint_token_hash', options.expectedCheckpointHash]]) {
    if (expected && !safeEqual(value[field], expected)) fail('parser_receipt_mismatch', `${field} changed`, 409);
  }
  if (!TERMINAL.has(String(value.status || ''))) fail('parser_receipt_invalid', 'parser receipt status is invalid');
  const outputManifest = validateOutputManifest(value.output_manifest);
  if (!safeEqual(value.output_manifest_sha256, sha256Hex(canonicalJson(outputManifest)))) fail('parser_manifest_mismatch', 'parser output manifest hash changed', 409);
  if (value.status !== 'parsed' && outputManifest.outputs.length) fail('parser_receipt_invalid', 'non-parsed receipt contains outputs');
  if (value.status === 'parsed' && !outputManifest.outputs.length) fail('parser_receipt_invalid', 'parsed receipt has no output');
  const started = Date.parse(String(value.started_at || '')); const finished = Date.parse(String(value.finished_at || ''));
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished - started > (DEFAULT_PARSER_LIMITS.deadline_seconds + 5) * 1000) fail('parser_receipt_invalid', 'parser receipt timestamps are invalid');
  return Object.freeze({ ...value, status: String(value.status), output_manifest: outputManifest, error_code: String(value.error_code || '').slice(0, 120) });
}

export function signParserReceipt(value, privateKey, options = {}) {
  const receipt = validateParserReceipt(value, options); const receiptJson = canonicalJson(receipt);
  return Object.freeze({ receipt, receipt_json: receiptJson, receipt_sha256: sha256Hex(receiptJson), signature: sign(null, Buffer.from(receiptJson), privateKey).toString('base64url') });
}

export function verifyParserReceipt(value, signature, publicKey, options = {}) {
  const receipt = validateParserReceipt(value, options); const receiptJson = canonicalJson(receipt); const bytes = signatureBytes(signature, 'parser_receipt_signature_invalid');
  if (!verify(null, Buffer.from(receiptJson), publicKeyObject(publicKey), bytes)) fail('parser_receipt_signature_invalid', 'parser receipt signature is invalid', 403);
  return { receipt, receipt_json: receiptJson, receipt_sha256: sha256Hex(receiptJson) };
}

export function validateParserOutputs(outputs, manifest) {
  if (!Array.isArray(outputs) || outputs.length !== manifest.outputs.length) fail('parser_output_mismatch', 'parser output count changed', 409);
  let total = 0;
  return outputs.map((value, index) => {
    record(value, 'parser_output_invalid');
    const allowed = new Set(['kind', 'content_base64', 'content_sha256', 'byte_length', 'media_type', 'metadata']); unknown(value, allowed, 'parser_output_invalid');
    let bytes; try { bytes = Buffer.from(String(value.content_base64 || ''), 'base64'); } catch { fail('parser_output_invalid', 'parser output encoding is invalid'); }
    if (bytes.toString('base64').replace(/=+$/, '') !== String(value.content_base64 || '').replace(/=+$/, '')) fail('parser_output_invalid', 'parser output encoding is invalid');
    total += bytes.byteLength; if (total > DEFAULT_PARSER_LIMITS.max_expanded_bytes) fail('parser_output_too_large', 'parser output quota exceeded');
    const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata) ? value.metadata : {};
    const expected = manifest.outputs[index]; const actual = { kind: String(value.kind || ''), content_sha256: sha256Hex(bytes), byte_length: bytes.byteLength, media_type: String(value.media_type || ''), metadata_sha256: sha256Hex(canonicalJson(metadata)) };
    if (canonicalJson(actual) !== canonicalJson(expected)) fail('parser_output_mismatch', 'parser output does not match its manifest', 409);
    return { ...actual, bytes, metadata };
  });
}

function validateOutputManifest(value) {
  record(value, 'parser_manifest_invalid'); unknown(value, new Set(['schema_version', 'outputs']), 'parser_manifest_invalid');
  if (value.schema_version !== EVIDENCE_ASSET_VERSION || !Array.isArray(value.outputs) || value.outputs.length > DEFAULT_PARSER_LIMITS.max_images + 4) fail('parser_manifest_invalid', 'parser output manifest is invalid');
  let total = 0;
  const outputs = value.outputs.map((item) => { record(item, 'parser_manifest_invalid'); unknown(item, OUTPUT_KEYS, 'parser_manifest_invalid'); const kind = String(item.kind || ''); if (!OPAQUE.test(kind)) fail('parser_manifest_invalid', 'parser output kind is invalid'); hash(item.content_sha256, 'content_sha256'); hash(item.metadata_sha256, 'metadata_sha256'); integer(item.byte_length, 0, DEFAULT_PARSER_LIMITS.max_expanded_bytes, 'byte_length'); const mediaType = String(item.media_type || ''); if (!mediaType || mediaType.length > 160 || /[\r\n]/.test(mediaType)) fail('parser_manifest_invalid', 'parser output media type is invalid'); total += Number(item.byte_length); return { kind, content_sha256: String(item.content_sha256), byte_length: Number(item.byte_length), media_type: mediaType, metadata_sha256: String(item.metadata_sha256) }; });
  if (total > DEFAULT_PARSER_LIMITS.max_expanded_bytes) fail('parser_output_too_large', 'parser output quota exceeded');
  return Object.freeze({ schema_version: EVIDENCE_ASSET_VERSION, outputs: Object.freeze(outputs) });
}

function parserLimits(value) {
  record(value, 'parser_limits_invalid'); const allowed = new Set(Object.keys(DEFAULT_PARSER_LIMITS)); unknown(value, allowed, 'parser_limits_invalid'); const result = {};
  for (const [key, maximum] of Object.entries(DEFAULT_PARSER_LIMITS)) { integer(value[key], 1, maximum, key); result[key] = Number(value[key]); }
  return Object.freeze(result);
}
function record(value, code) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, 'parser payload must be an object'); }
function unknown(value, allowed, code) { for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `parser payload field is not allowed: ${key}`); }
function opaque(value, field) { if (!OPAQUE.test(String(value || ''))) fail('parser_job_invalid', `${field} must be an opaque reference`); }
function hash(value, field) { if (!HASH.test(String(value || ''))) fail('parser_job_invalid', `${field} must be a SHA-256 hash`); }
function integer(value, minimum, maximum, field) { const number = Number(value); if (!Number.isInteger(number) || number < minimum || number > maximum) fail('parser_quota_exceeded', `${field} is outside the allowed bounds`); }
function signatureBytes(value, code) { try { return Buffer.from(String(value || ''), 'base64url'); } catch { fail(code, 'parser signature is invalid', 403); } }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function publicKeyObject(value) { return value?.type === 'public' ? value : createPublicKey(value); }
function fail(code, message, status = 422) { throw new PlatformError(code, message, {}, status); }
