import { generateKeyPairSync } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { DEFAULT_PARSER_LIMITS } from '../../apps/api/src/clean/parser-limits.mjs';
import { signParserJob, verifyParserReceipt } from '../../apps/api/src/clean/parser-protocol.mjs';
import { P7_PARSER_IMAGE_DIGEST } from '../../apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs';

export const TERMINAL_PARSER_STATES = new Set(['parsed', 'unsupported', 'invalid', 'resource_exceeded', 'failed', 'cancelled', 'external_result_unknown']);

export function createParserServiceIdentity() { return generateKeyPairSync('ed25519'); }
export function publicKey(identity) { return identity.publicKey.export({ type: 'spki', format: 'pem' }).toString(); }

export function signedParserJob({ identity, input, suffix, formatKey = 'text', mediaType = 'text/plain' } = {}) {
  const bytes = Buffer.from(input || []);
  const now = Date.now();
  const limits = { ...DEFAULT_PARSER_LIMITS };
  return signParserJob({
    schema_version: 'parser.job.v1', parser_job_id: `parser_job_${suffix}`,
    parser_run_ref: `parser_run_${suffix}`, project_ref: `project_${suffix}`,
    asset_version_ref: `asset_version_${suffix}`, input_sha256: sha256Hex(bytes),
    input_cas_sha256: sha256Hex(bytes), input_bytes: bytes.byteLength, media_type: mediaType,
    format_key: formatKey, format_sha256: 'a'.repeat(64), worker_image_digest: P7_PARSER_IMAGE_DIGEST,
    limits, limits_sha256: sha256Hex(canonicalJson(limits)), checkpoint_token_hash: 'b'.repeat(64),
    service_key_id: 'parser_service_probe', deadline_at: new Date(now + 120000).toISOString(),
    created_at: new Date(now).toISOString()
  }, identity.privateKey, { now, expectedImageDigest: P7_PARSER_IMAGE_DIGEST });
}

export async function waitForParser(adapter, jobId, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await adapter.status(jobId);
    if (TERMINAL_PARSER_STATES.has(String(value.status || ''))) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Object.assign(new Error('parser_probe_timeout'), { code: 'parser_probe_timeout' });
}

export function verifyParserTerminal(value, signed, expectedStatus = 'parsed') {
  if (value?.status !== expectedStatus || !value?.receipt || !value?.signature || !value?.signer_public_key) throw Object.assign(new Error('parser_probe_terminal_receipt_missing'), { code: 'parser_probe_terminal_receipt_missing' });
  return verifyParserReceipt(value.receipt, value.signature, value.signer_public_key, {
    expectedJobId: signed.job.parser_job_id, expectedJobHash: signed.job_sha256,
    expectedInputHash: signed.job.input_sha256, expectedFormatHash: signed.job.format_sha256,
    expectedLimitsHash: signed.job.limits_sha256, expectedCheckpointHash: signed.job.checkpoint_token_hash
  });
}

export function publicParserReceipt(receipt) {
  return {
    receipt_id: receipt.receipt_id, status: receipt.status, job_sha256: receipt.job_sha256,
    input_sha256: receipt.input_sha256, format_sha256: receipt.format_sha256,
    limits_sha256: receipt.limits_sha256, checkpoint_token_hash: receipt.checkpoint_token_hash,
    output_manifest_sha256: receipt.output_manifest_sha256, error_code: receipt.error_code
  };
}
