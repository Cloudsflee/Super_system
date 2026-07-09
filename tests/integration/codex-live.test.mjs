import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CodexRunner } from '../../packages/runner-adapters/src/index.mjs';

if (process.env.RUN_CODEX_LIVE_TESTS !== '1') {
  console.log('codex live tests skipped; set RUN_CODEX_LIVE_TESTS=1 to run');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-codex-live-'));
const promptFile = path.join(tmp, 'prompt.md');
const schemaFile = path.join(tmp, 'schema.json');
fs.writeFileSync(promptFile, 'Return JSON for aiws.node_run_result.v1 with status partial or succeeded. Do not edit files.', 'utf8');
fs.writeFileSync(schemaFile, JSON.stringify({ type: 'object', required: ['status', 'summary', 'changed_files', 'asset_candidates', 'test_results', 'next_actions'], properties: { status: { type: 'string' }, summary: { type: 'string' }, changed_files: { type: 'array' }, asset_candidates: { type: 'array' }, test_results: { type: 'array' }, next_actions: { type: 'array' } } }), 'utf8');
try {
  const result = await new CodexRunner({ timeoutMs: Number(process.env.CODEX_LIVE_TIMEOUT_MS || 45000) }).run({ cwd: tmp, promptFile, outputSchemaFile: schemaFile, fallback: { changed_files: [], asset_candidates: [], test_results: [], next_actions: [] } });
  assert.ok(['succeeded', 'partial', 'failed'].includes(result.status));
  assert.ok(result.summary);
  console.log(`Codex live test completed with status=${result.status}`);
} finally {
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
