import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { API_PREFIX, COMMAND_NAMES, DATABASE_USER_VERSION, SSE_FIELDS } from '../../packages/contracts/src/index.mjs';
import { loadConfig } from '../../apps/api/src/config.mjs';
import { renderCodexConfig } from '../../apps/runner-broker/src/codex-config.mjs';

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

test('Codex Secret Bundle accepts only the fixed API-key profile and stays in memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-secret-bundle-'));
  const file = path.join(root, 'codex.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ provider: 'openai', profile: 'default', model: 'codex-mini-latest', api_key: 'fixture-secret-value' }), 'utf8');
    const config = loadConfig({ AIWS_CODEX_SECRET_FILE: file, AIWS_CODEX_MODEL: 'codex-mini-latest' });
    assert.deepEqual(config.codexCredential, { ref: 'cred_codex_default', profile: 'default', provider: 'openai', model: 'codex-mini-latest', auth: 'fixture-secret-value' });
    fs.writeFileSync(file, JSON.stringify({ provider: 'unsupported', api_key: 'fixture-secret-value' }), 'utf8');
    assert.throws(() => loadConfig({ AIWS_CODEX_SECRET_FILE: file, AIWS_CODEX_MODEL: 'codex-mini-latest' }), /codex_secret_invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Runner renders the legacy custom Responses provider with the registered model', () => {
  const config = renderCodexConfig({ model: 'gpt-5.5' });
  assert.match(config, /^model = "gpt-5\.5"/m);
  assert.match(config, /^model_provider = "custom"/m);
  assert.match(config, /^base_url = "http:\/\/172\.93\.218\.157:8080\/v1"/m);
  assert.match(config, /^wire_api = "responses"/m);
  assert.match(config, /^requires_openai_auth = false$/m);
  assert.match(config, /^env_key = "OPENAI_API_KEY"$/m);
});
