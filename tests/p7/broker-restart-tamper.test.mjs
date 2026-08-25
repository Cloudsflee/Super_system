import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { BrokerParserAdapter } from '../../apps/api/src/clean/parser-adapters.mjs';
import { DEFAULT_PARSER_LIMITS } from '../../apps/api/src/clean/parser-limits.mjs';
import { signParserJob, verifyParserReceipt } from '../../apps/api/src/clean/parser-protocol.mjs';
import { P7_PARSER_IMAGE_DIGEST } from '../../apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs';
import { start } from '../../apps/runner-broker/clean-server.mjs';

const SECRET = 'p7-broker-test-secret';
const RUNNER_DIGEST = `sha256:${'1'.repeat(64)}`;

test('Clean Broker verifies parser envelopes, persists signed receipts and rehashes public outputs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p7-broker-'));
  const service = generateKeyPairSync('ed25519');
  const input = Buffer.from('broker parser fixture');
  const signed = parserJob(service, input, 'transport');
  const servicePublicKey = pem(service.publicKey);
  const broker = await start({
    port: 0, secret: SECRET, stateRoot: root, runnerDigest: RUNNER_DIGEST,
    parserDigest: P7_PARSER_IMAGE_DIGEST, servicePublicKey,
    parserExecute: async (_job, context) => ({ status: 'parsed', outputs: [{ kind: 'text', bytes: context.input, media_type: 'text/plain', metadata: { parser: 'fixture' } }] })
  });
  const adapter = new BrokerParserAdapter({ baseUrl: broker.url, secret: SECRET });
  try {
    const submitted = await adapter.submit(signed.job, { jobSignature: signed.signature, servicePublicKey, input });
    const completed = await pollStatus(adapter, submitted.job_id);
    assert.equal(completed.status, 'parsed');
    const verified = verifyParserReceipt(completed.receipt, completed.signature, completed.signer_public_key, {
      expectedJobId: signed.job.parser_job_id,
      expectedJobHash: signed.job_sha256,
      expectedInputHash: signed.job.input_sha256,
      expectedFormatHash: signed.job.format_sha256,
      expectedLimitsHash: signed.job.limits_sha256,
      expectedCheckpointHash: signed.job.checkpoint_token_hash
    });
    assert.match(verified.receipt_sha256, /^[a-f0-9]{64}$/);
    assert.equal(completed.outputs[0].content_sha256, sha256Hex(input));

    const replay = await adapter.submit(signed.job, { jobSignature: signed.signature, servicePublicKey, input });
    assert.equal(replay.job_id, submitted.job_id);
    await assert.rejects(
      () => adapter.submit({ ...signed.job, input_sha256: 'f'.repeat(64) }, { jobSignature: signed.signature, servicePublicKey, input }),
      (error) => error.code === 'parser_job_signature_invalid'
    );

    const stored = broker.parserJobs.get(submitted.job_id);
    fs.writeFileSync(path.join(stored.output_root, stored.outputs[0].file), 'tampered output');
    await assert.rejects(() => adapter.status(submitted.job_id), (error) => error.code === 'parser_output_tamper');
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Clean Broker crash restart reconciles an unprovable parser result without retrying it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p7-broker-restart-'));
  const service = generateKeyPairSync('ed25519');
  const input = Buffer.from('restart parser fixture');
  const signed = parserJob(service, input, 'restart');
  const servicePublicKey = pem(service.publicKey);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = await start({
    port: 0, secret: SECRET, stateRoot: root, runnerDigest: RUNNER_DIGEST,
    parserDigest: P7_PARSER_IMAGE_DIGEST, servicePublicKey, parserExecute: async () => blocked
  });
  let second;
  try {
    const firstAdapter = new BrokerParserAdapter({ baseUrl: first.url, secret: SECRET });
    const submitted = await firstAdapter.submit(signed.job, { jobSignature: signed.signature, servicePublicKey, input });
    const journal = path.join(root, 'parser-jobs', submitted.job_id, 'journal.json');
    await waitFor(() => fs.existsSync(journal) && JSON.parse(fs.readFileSync(journal, 'utf8')).status === 'running');
    await new Promise((resolve, reject) => first.server.close((error) => error ? reject(error) : resolve()));

    second = await start({
      port: 0, secret: SECRET, stateRoot: root, runnerDigest: RUNNER_DIGEST,
      parserDigest: P7_PARSER_IMAGE_DIGEST, servicePublicKey,
      execFileImpl: async () => { throw Object.assign(new Error('container unavailable'), { code: 'ENOENT' }); }
    });
    const reconciled = await new BrokerParserAdapter({ baseUrl: second.url, secret: SECRET }).status(submitted.job_id);
    assert.equal(reconciled.status, 'external_result_unknown');
    assert.equal(reconciled.receipt.error_code, 'parser_external_result_unknown');
    assert.equal(reconciled.receipt.input_sha256, signed.job.input_sha256);
    assert.equal(reconciled.receipt.format_sha256, signed.job.format_sha256);
    assert.equal(reconciled.receipt.limits_sha256, signed.job.limits_sha256);
    assert.equal(reconciled.receipt.checkpoint_token_hash, signed.job.checkpoint_token_hash);
    assert.equal(first.parserJobs.get(submitted.job_id).status, 'running');

    release({ status: 'failed', error_code: 'fixture_shutdown', outputs: [] });
    await waitFor(() => first.parserJobs.get(submitted.job_id).status === 'failed');
  } finally {
    release?.({ status: 'failed', error_code: 'fixture_shutdown', outputs: [] });
    if (second) await second.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function parserJob(pair, input, suffix) {
  const now = Date.now();
  const limits = { ...DEFAULT_PARSER_LIMITS };
  return signParserJob({
    schema_version: 'parser.job.v1', parser_job_id: `parser_job_${suffix}`,
    parser_run_ref: `parser_run_${suffix}`, project_ref: `project_${suffix}`,
    asset_version_ref: `asset_version_${suffix}`, input_sha256: sha256Hex(input),
    input_cas_sha256: sha256Hex(input), input_bytes: input.length, media_type: 'text/plain',
    format_key: 'text', format_sha256: 'a'.repeat(64), worker_image_digest: P7_PARSER_IMAGE_DIGEST,
    limits, limits_sha256: sha256Hex(canonicalJson(limits)), checkpoint_token_hash: 'b'.repeat(64),
    service_key_id: 'parser_service_fixture', deadline_at: new Date(now + 120000).toISOString(),
    created_at: new Date(now).toISOString()
  }, pair.privateKey, { now, expectedImageDigest: P7_PARSER_IMAGE_DIGEST });
}

function pem(key) { return key.export({ type: 'spki', format: 'pem' }).toString(); }
async function pollStatus(adapter, id) { let value; await waitFor(async () => { value = await adapter.status(id); return !['queued', 'running'].includes(value.status); }); return value; }
async function waitFor(predicate, timeout = 3000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('p7_wait_timeout'); }
