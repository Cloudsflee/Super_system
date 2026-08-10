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
  assert.equal(DATABASE_USER_VERSION, 2);
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

test('Runner renders only the selected Profile provider and has no legacy endpoint', () => {
  const openai = renderCodexConfig({ model: 'gpt-5.5' });
  assert.match(openai, /^model = "gpt-5\.5"/m);
  assert.match(openai, /^model_provider = "openai"/m);
  assert.doesNotMatch(openai, /model_providers\.|base_url|172\.93\.218\.157/);

  const custom = renderCodexConfig({ model: 'codex-r2', provider: 'fixture', baseUrl: 'https://provider.example/v1' });
  assert.match(custom, /^model_provider = "fixture"/m);
  assert.match(custom, /^\[model_providers\.fixture\]$/m);
  assert.match(custom, /^base_url = "https:\/\/provider\.example\/v1"$/m);
  assert.match(custom, /^wire_api = "responses"$/m);
  assert.match(custom, /^requires_openai_auth = false$/m);
  assert.match(custom, /^env_key = "OPENAI_API_KEY"$/m);
});
