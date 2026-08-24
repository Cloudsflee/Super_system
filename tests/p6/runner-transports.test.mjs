import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { BrokerRunnerAdapter, buildDockerRunnerArgs } from '../../apps/api/src/clean/runner-adapters.mjs';
import { signRunnerJobSpec, verifyRunnerReceipt } from '../../apps/api/src/clean/runner-protocol.mjs';
import { start as startBroker } from '../../apps/runner-broker/clean-server.mjs';
import { BridgeProtocol } from '../../apps/windows-native-bridge/src/protocol.mjs';

test('Clean Broker authenticates transport, rejects nonce replay and signs a Docker receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-clean-broker-')); const secret = 'p6-clean-broker-secret'; const digest = `sha256:${'b'.repeat(64)}`;
  const broker = await startBroker({ host: '127.0.0.1', port: 0, secret, runnerDigest: digest, stateRoot: root, spawnImpl: fakeDockerSpawn, execFileImpl: async () => ({ stdout: '27.2.0\n', stderr: '' }) });
  try {
    const adapter = new BrokerRunnerAdapter({ baseUrl: broker.url, secret }); const probe = await adapter.probe(); assert.equal(probe.status, 'ready'); assert.equal(probe.runner_digest, digest);
    const key = generateKeyPairSync('ed25519'); const signed = signRunnerJobSpec(specimen({ image_digest: digest }), key.privateKey);
    const submitted = await adapter.submit(signed.spec, { specSignature: signed.signature, servicePublicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    const terminal = await waitUntil(async () => { const value = await adapter.status(submitted.job_id); return value.receipt ? value : null; });
    assert.equal(terminal.status, 'succeeded');
    assert.equal(verifyRunnerReceipt(terminal.receipt, terminal.signature, terminal.signer_public_key, { expectedJobSpecId: signed.spec.job_spec_id, expectedJobSpecHash: signed.spec_sha256 }).receipt.status, 'succeeded');
    const persisted = fs.readFileSync(path.join(root, 'jobs', `${submitted.job_id}.json`), 'utf8'); assert.doesNotMatch(persisted, /p6-clean-broker-secret/);

    const raw = '{}'; const timestamp = String(Date.now()); const nonce = 'p6_nonce_replay_123456'; const bodyHash = hash(raw); const signature = createHmac('sha256', secret).update(`GET\n/internal/v2/probe\n${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
    const headers = { 'content-type': 'application/json', 'x-aiws-timestamp': timestamp, 'x-aiws-nonce': nonce, 'x-aiws-body-sha256': bodyHash, 'x-aiws-signature': signature };
    assert.equal((await fetch(`${broker.url}/internal/v2/probe`, { headers })).status, 200);
    const replay = await fetch(`${broker.url}/internal/v2/probe`, { headers }); assert.equal(replay.status, 409); assert.equal((await replay.json()).error.code, 'broker_nonce_replay');

    const args = buildDockerRunnerArgs(signed.spec, { image: digest });
    for (const expected of ['--cap-drop', 'ALL', '--read-only', 'no-new-privileges:true', '--pids-limit', '--tmpfs']) assert.ok(args.includes(expected));
    assert.equal(args[args.length - 1], digest);
  } finally { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows Bridge validates the shared spec and returns signed terminal and cancellation receipts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-bridge-runner-'));
  try {
    const protocol = new BridgeProtocol({ stateRoot: root }); const service = generateKeyPairSync('ed25519'); const publicKey = service.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const first = signRunnerJobSpec(specimen({ job_spec_id: 'job_bridge_success', runner_profile_ref: 'profile_bridge', image_digest: '' }), service.privateKey);
    const submitted = protocol.submitJob({ spec: first.spec, signature: first.signature, service_public_key: publicKey });
    const terminal = await waitUntil(() => { const value = protocol.jobStatus(submitted.job_id); return value.receipt ? value : null; });
    assert.equal(verifyRunnerReceipt(terminal.receipt, terminal.signature, terminal.signer_public_key, { expectedJobSpecId: first.spec.job_spec_id, expectedJobSpecHash: first.spec_sha256 }).receipt.status, 'succeeded');

    const second = signRunnerJobSpec(specimen({ job_spec_id: 'job_bridge_cancel', task_ref: 'task_cancel', runner_profile_ref: 'profile_bridge', image_digest: '' }), service.privateKey);
    const queued = protocol.submitJob({ spec: second.spec, signature: second.signature, service_public_key: publicKey }); const cancelled = protocol.cancelJob(queued.job_id);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(verifyRunnerReceipt(cancelled.receipt, cancelled.signature, cancelled.signer_public_key, { expectedJobSpecId: second.spec.job_spec_id, expectedJobSpecHash: second.spec_sha256 }).receipt.status, 'cancelled');
    assert.throws(() => protocol.submitJob({ spec: { ...second.spec, output_paths: ['C:\\host'] }, signature: second.signature, service_public_key: publicKey }), (error) => error.code === 'runner_path_invalid');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function specimen(overrides = {}) {
  const now = Date.now();
  return {
    schema_version: 'runner.job-spec.v2', job_spec_id: 'job_broker_fixture', execution_ref: 'execution_fixture', generation: 1,
    task_ref: 'task_fixture', attempt: 1, runner_profile_ref: 'profile_fixture', runner_profile_revision: 1,
    runner_profile_hash: 'a'.repeat(64), image_digest: `sha256:${'b'.repeat(64)}`, deadline_at: new Date(now + 60_000).toISOString(),
    capabilities: ['network:none', 'workspace:read'], resource_profile: 'light', execution_mode: 'read', input_refs: [],
    input_paths: ['README.md'], output_paths: [], check_ids: [], workspace_ref: 'workspace_fixture', workspace_hash: 'c'.repeat(64),
    context_pack_ref: 'context_fixture', context_pack_hash: 'd'.repeat(64), service_key_id: 'runner_key_fixture', created_at: new Date(now).toISOString(),
    ...overrides
  };
}

function fakeDockerSpawn() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242; child.exitCode = null;
  child.kill = () => { if (child.exitCode == null) { child.exitCode = 143; child.emit('exit', 143); } };
  queueMicrotask(() => { if (child.exitCode == null) { child.stdout.end('docker runner completed\n'); child.stderr.end(); child.exitCode = 0; child.emit('exit', 0); } });
  return child;
}

async function waitUntil(read, timeout = 5000) { const started = Date.now(); while (Date.now() - started < timeout) { const value = await read(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('wait_until_timeout'); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
