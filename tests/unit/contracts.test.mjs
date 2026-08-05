import assert from 'node:assert/strict';
import test from 'node:test';
import { API_PREFIX, COMMAND_NAMES, DATABASE_USER_VERSION, SSE_FIELDS } from '../../packages/contracts/src/index.mjs';
import { loadConfig } from '../../apps/api/src/config.mjs';

test('contracts pin the public version and event shape', () => {
  assert.equal(API_PREFIX, '/api/v1');
  assert.equal(DATABASE_USER_VERSION, 1);
  assert.ok(COMMAND_NAMES.includes('execution.start'));
  assert.deepEqual(SSE_FIELDS, ['cursor', 'type', 'execution_id', 'task_id', 'data', 'created_at']);
});

test('production app configuration requires a nonzero Runner digest and HMAC secret', () => {
  const digest = `sha256:${'3'.repeat(64)}`;
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /runner_digest_required/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', AIWS_RUNNER_DIGEST: digest }), /broker_hmac_secret_required/);
  assert.equal(loadConfig({ NODE_ENV: 'production', AIWS_RUNNER_DIGEST: digest, AIWS_BROKER_HMAC_SECRET: 'x'.repeat(32) }).runnerDigest, digest);
});
