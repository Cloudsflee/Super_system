import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { createCleanCommandRegistry } from '../../apps/api/src/clean/registry.mjs';
import { CLEAN_P7_TABLE_OWNERS, validateCleanOwnership } from '../../apps/api/src/clean/ownership.mjs';
import { signParserJob, signParserReceipt, verifyParserJob, verifyParserReceipt } from '../../apps/api/src/clean/parser-protocol.mjs';
import { DEFAULT_PARSER_LIMITS } from '../../apps/parser-worker/parser-engine.mjs';
import { P7_PARSER_IMAGE_DIGEST } from '../../apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs';
import { close, open } from './helpers.mjs';

test('P7 registry, ownership and transport inventory are bidirectional', () => {
  const registry = createCleanCommandRegistry({ targetVersion: 7 });
  const p7 = registry.entries.filter((entry) => entry.phase === 'p7');
  assert.equal(p7.length, 32);
  assert.equal(new Set(p7.map((entry) => entry.command_id)).size, 32);
  assert.equal(validateCleanOwnership({ tables: Object.keys(CLEAN_P7_TABLE_OWNERS), registry }).valid, true);
  for (const id of ['asset.content', 'asset.tombstone', 'quality.decision', 'outcome.waiver.create', 'outcome.waiver.revoke']) {
    const entry = registry.get(id);
    assert.equal(entry.mcp.exposed, false);
    assert.deepEqual(entry.transport_allowlist, ['rest', 'web']);
  }
});

test('REST-only P7 commands are rejected at MCP and Gateway dispatch boundaries', async () => {
  const state = await open();
  try {
    for (const transport of ['mcp', 'gateway']) {
      await assert.rejects(
        () => state.runtime.dispatcher.dispatch('quality.decision', {}, state.principal, { transport }),
        (error) => error.code === 'transport_not_allowed' && error.status === 403
      );
    }
    await assert.rejects(
      () => state.runtime.mcp.dispatch('outcome.waiver.create', {}, state.principal),
      (error) => error.code === 'transport_not_allowed'
    );
    const allowed = await state.runtime.dispatcher.dispatch('parser.format.list', {}, state.principal, { transport: 'mcp' });
    assert.equal(allowed.command_id, 'parser.format.list');
    assert.equal(allowed.result.formats.length, 21);
  } finally { await close(state); }
});

test('Parser job and receipt signatures bind digest, input, limits, checkpoint and manifest', () => {
  const service = generateKeyPairSync('ed25519');
  const worker = generateKeyPairSync('ed25519');
  const now = Date.now();
  const input = Buffer.from('signed parser fixture');
  const limits = { ...DEFAULT_PARSER_LIMITS };
  const job = { schema_version: 'parser.job.v1', parser_job_id: 'parser_job_fixture', parser_run_ref: 'parser_run_fixture', project_ref: 'project_fixture', asset_version_ref: 'asset_version_fixture', input_sha256: sha256Hex(input), input_cas_sha256: sha256Hex(input), input_bytes: input.length, media_type: 'text/plain', format_key: 'text', format_sha256: 'a'.repeat(64), worker_image_digest: P7_PARSER_IMAGE_DIGEST, limits, limits_sha256: sha256Hex(canonicalJson(limits)), checkpoint_token_hash: 'b'.repeat(64), service_key_id: 'parser_service_fixture', deadline_at: new Date(now + 120000).toISOString(), created_at: new Date(now).toISOString() };
  const signedJob = signParserJob(job, service.privateKey, { now: () => now, expectedImageDigest: P7_PARSER_IMAGE_DIGEST });
  assert.equal(verifyParserJob(job, signedJob.signature, service.publicKey, { now: () => now, expectedImageDigest: P7_PARSER_IMAGE_DIGEST }).job_sha256, signedJob.job_sha256);
  assert.throws(() => verifyParserJob({ ...job, input_sha256: 'c'.repeat(64) }, signedJob.signature, service.publicKey, { now: () => now, expectedImageDigest: P7_PARSER_IMAGE_DIGEST }), (error) => error.code === 'parser_job_signature_invalid');
  const manifest = { schema_version: 'evidence.asset.v2', outputs: [{ kind: 'parsed', content_sha256: sha256Hex(input), byte_length: input.length, media_type: 'text/plain', metadata_sha256: sha256Hex(canonicalJson({})) }] };
  const receipt = { schema_version: 'parser.receipt.v1', receipt_id: 'parser_receipt_fixture', parser_job_id: job.parser_job_id, parser_run_ref: job.parser_run_ref, job_sha256: signedJob.job_sha256, status: 'parsed', input_sha256: job.input_sha256, format_sha256: job.format_sha256, limits_sha256: job.limits_sha256, checkpoint_token_hash: job.checkpoint_token_hash, output_manifest: manifest, output_manifest_sha256: sha256Hex(canonicalJson(manifest)), error_code: '', started_at: new Date(now).toISOString(), finished_at: new Date(now + 1).toISOString() };
  const signedReceipt = signParserReceipt(receipt, worker.privateKey);
  assert.equal(verifyParserReceipt(receipt, signedReceipt.signature, worker.publicKey, { expectedJobId: job.parser_job_id, expectedJobHash: signedJob.job_sha256 }).receipt_sha256, signedReceipt.receipt_sha256);
  assert.throws(() => verifyParserReceipt({ ...receipt, limits_sha256: 'd'.repeat(64) }, signedReceipt.signature, worker.publicKey), (error) => error.code === 'parser_receipt_signature_invalid');
});
