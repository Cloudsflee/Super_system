import assert from 'node:assert/strict';
import test from 'node:test';
import { validateJobSpec, buildDockerArgs } from '../../apps/runner-broker/src/job-spec.mjs';
import { createReplayGuard, makeSignature } from '../../apps/runner-broker/src/signature.mjs';
import { brokerConfig } from '../../apps/runner-broker/server.mjs';

const digest = `sha256:${'1'.repeat(64)}`;
const valid = () => ({
  task_id: 'analyze', execution_id: 'exe_12345678abcdef', project_id: 'prj_12345678abcdef',
  workspace_subpath: 'projects/prj_12345678abcdef', image_digest: digest, execution_mode: 'read',
  resource_profile: 'standard', network_profile: 'none', input_paths: ['brief.md'], output_paths: ['analysis.md'],
  deadline_at: new Date(Date.now() + 60_000).toISOString()
});

test('job spec rejects arbitrary command, host path, and digest drift', () => {
  assert.equal(validateJobSpec(valid(), { dataRoot: '/var/lib/aiws', runnerDigest: digest }).network_profile, 'none');
  assert.throws(() => validateJobSpec({ ...valid(), command: 'sh' }, { runnerDigest: digest }), /not allowed/);
  assert.throws(() => validateJobSpec({ ...valid(), workspace_subpath: '../../host' }, { runnerDigest: digest }), /escapes/);
  assert.throws(() => validateJobSpec({ ...valid(), image_digest: `sha256:${'2'.repeat(64)}` }, { runnerDigest: digest }), /digest/);
  const args = buildDockerArgs(validateJobSpec(valid(), { runnerDigest: digest }), { dataVolume: 'aiws-data-v3', runnerImage: 'runner@' + digest });
  assert.ok(args.includes('--cap-drop') && args.includes('ALL') && args.includes('--read-only'));
  assert.ok(args.includes('aiws.owner=aiws-v3'));
});

test('docker broker configuration requires a real digest, pinned image, and HMAC secret', () => {
  const base = { NODE_ENV: 'production', AIWS_BROKER_EXECUTOR: 'docker', AIWS_BROKER_HMAC_SECRET: 'x'.repeat(32) };
  assert.throws(() => brokerConfig(base), /runner_digest_required/);
  assert.throws(() => brokerConfig({ ...base, AIWS_RUNNER_DIGEST: `sha256:${'0'.repeat(64)}` }), /runner_digest_required/);
  assert.throws(() => brokerConfig({ ...base, AIWS_RUNNER_DIGEST: digest, AIWS_RUNNER_IMAGE: 'runner:latest' }), /runner_image_must_be_digest_pinned/);
  assert.equal(brokerConfig({ ...base, AIWS_RUNNER_DIGEST: digest, AIWS_RUNNER_IMAGE: `runner@${digest}` }).runnerDigest, digest);
});

test('broker signature expires and rejects nonce replay', () => {
  const secret = 'test-secret';
  const clock = { value: 100_000 };
  const guard = createReplayGuard({ clock: () => clock.value });
  const body = '{}';
  const timestamp = String(clock.value);
  const nonce = 'nonce-1';
  const headers = { 'x-aiws-timestamp': timestamp, 'x-aiws-nonce': nonce, 'x-aiws-signature': makeSignature(secret, 'POST', '/internal/v1/jobs', body, timestamp, nonce) };
  assert.equal(guard.verify(headers, 'POST', '/internal/v1/jobs', body, secret), true);
  assert.throws(() => guard.verify(headers, 'POST', '/internal/v1/jobs', body, secret), /replay/);
  clock.value += 31_000;
  const expired = { ...headers, 'x-aiws-nonce': 'nonce-2', 'x-aiws-signature': makeSignature(secret, 'POST', '/internal/v1/jobs', body, timestamp, 'nonce-2') };
  assert.throws(() => guard.verify(expired, 'POST', '/internal/v1/jobs', body, secret), /expired/);
});
