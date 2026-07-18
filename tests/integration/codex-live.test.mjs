import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

if (process.env.RUN_CODEX_LIVE_TESTS !== '1') {
  console.log('codex live tests skipped; set RUN_CODEX_LIVE_TESTS=1 to run');
  process.exit(0);
}

assert.equal(process.env.AIWS_TEST_CODEX_CONFIRM, 'dedicated-read-only', 'dedicated Codex confirmation is required');
const serviceBaseUrl = normalizeBaseUrl(process.env.AIWS_TEST_LIVE_BASE_URL);

if (serviceBaseUrl) await runServiceProbe(serviceBaseUrl);
else await runDedicatedHomeProbe();

async function runServiceProbe(baseUrl) {
  const status = await serviceJson(baseUrl, 'GET', '/api/codex/status');
  assert.equal(status.docker?.ok, true, 'Docker service must be available');
  assert.equal(status.image?.ready, true, `Codex Runner image must be ready: ${status.image?.error_code || 'unknown'}`);
  assert.equal(status.authenticated, true, 'Docker service Codex credential must be configured');
  assert.equal(status.active_profile?.kind, 'docker', 'active service profile must use Docker isolation');
  assert.equal(status.active_profile?.credential_configured, true, 'active service profile credential must be configured');

  const probe = await serviceJson(baseUrl, 'POST', '/api/codex/probe', {});
  assert.equal(probe.status, 'ready');
  assert.equal(probe.detail?.ok, true);
  assert.equal(probe.detail?.phase, 'inference');
  assert.ok((probe.detail?.checks || []).length >= 7, 'probe must report all isolation and inference phases');
  assert.ok(probe.detail.checks.every((item) => item.status === 'passed'), 'all service probe phases must pass');
  assert.equal(probe.detail?.process?.timed_out, false);
  assert.doesNotMatch(JSON.stringify({ status, probe }), /(?:api[_-]?key|private[_-]?key|authorization|access[_-]?token|refresh[_-]?token)["']?\s*:/i, 'service response must not expose credentials');
  console.log(`Codex service-backed live probe passed (profile=${status.active_profile.id}, image=${status.image.name})`);
}

async function runDedicatedHomeProbe() {
  assert.ok(process.env.AIWS_TEST_CODEX_HOME, 'AIWS_TEST_CODEX_HOME or AIWS_TEST_LIVE_BASE_URL is required');
  process.env.CODEX_HOME = path.resolve(process.env.AIWS_TEST_CODEX_HOME);
  assert.ok(fs.existsSync(process.env.CODEX_HOME), 'dedicated Codex home must exist');
  const { CodexRunner } = await import('../../packages/runner-adapters/src/index.mjs');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-codex-live-'));
  const promptFile = path.join(tmp, 'prompt.md');
  const schemaFile = path.join(tmp, 'schema.json');
  fs.writeFileSync(promptFile, 'Return JSON for aiws.node_run_result.v1 with status partial or succeeded. Do not edit files.', 'utf8');
  fs.writeFileSync(schemaFile, JSON.stringify({ type: 'object', required: ['status', 'summary', 'changed_files', 'asset_candidates', 'test_results', 'next_actions'], properties: { status: { type: 'string' }, summary: { type: 'string' }, changed_files: { type: 'array' }, asset_candidates: { type: 'array' }, test_results: { type: 'array' }, next_actions: { type: 'array' } } }), 'utf8');
  const before = snapshot(tmp);
  try {
    const result = await new CodexRunner({ timeoutMs: Number(process.env.CODEX_LIVE_TIMEOUT_MS || 45000) }).run({ cwd: tmp, promptFile, outputSchemaFile: schemaFile, fallback: { changed_files: [], asset_candidates: [], test_results: [], next_actions: [] } });
    assert.ok(['succeeded', 'partial', 'failed'].includes(result.status));
    assert.ok(result.summary);
    assert.deepEqual(result.changed_files, []);
    assert.deepEqual(snapshot(tmp), before, 'read-only Codex live workspace must remain unchanged');
    console.log(`Codex dedicated-home live test completed with status=${result.status}`);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

function snapshot(root) { return fs.readdirSync(root).sort().map((name) => { const file = path.join(root, name), stat = fs.statSync(file); return { name, size: stat.size, mtimeMs: stat.mtimeMs, content: stat.isFile() ? fs.readFileSync(file, 'base64') : null }; }); }

function normalizeBaseUrl(value) {
  if (!String(value || '').trim()) return null;
  const url = new URL(value);
  assert.ok(['http:', 'https:'].includes(url.protocol), 'AIWS_TEST_LIVE_BASE_URL must use HTTP(S)');
  assert.equal(url.username || url.password, '', 'AIWS_TEST_LIVE_BASE_URL must not contain credentials');
  return url.href.replace(/\/$/, '');
}

async function serviceJson(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.CODEX_LIVE_TIMEOUT_MS || 150000))
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Codex service ${method} ${route} failed (${response.status}): ${data.error || data.message || 'unknown_error'}`);
  return data;
}
