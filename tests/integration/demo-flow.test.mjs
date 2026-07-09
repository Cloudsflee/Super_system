import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4570;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-demo-home-'));
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: testHome, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
await waitForServer(port);
try {
  const demo = await api('/demo/full-chain', { method: 'POST', body: {} });
  assert.equal(demo.nodes.length, 5);
  assert.ok(demo.decision.confirmed_by_user_id, 'decision has actor');
  assert.ok(demo.asset.confirmed_by_user_id, 'asset has actor');
  assert.ok(demo.digest.confirmed_by_user_id, 'digest has actor');
  assert.ok(demo.code_change.created_by_user_id, 'code change has actor');
  assert.ok(demo.context_pack.memory_manifest.included.some((item) => item.source_type === 'decision'), 'decision enters context memory');
  const execNode = demo.nodes.find((node) => node.type === 'execution');
  const nextCtx = await api(`/nodes/${execNode.id}/context-pack/preview`, { method: 'POST', body: {} });
  assert.ok(nextCtx.content_json.latest_digest?.id === demo.digest.id, 'next context includes latest digest');
  assert.ok(nextCtx.content_json.confirmed_assets.some((asset) => asset.id === demo.asset.id), 'next context includes confirmed asset');
  const review = await api('/review');
  assert.ok(review.decisions.some((decision) => decision.id === demo.decision.id));
  assert.ok(review.code_changes.some((change) => change.id === demo.code_change.id));
  console.log('demo full-chain tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(testHome, { recursive: true, force: true });
}

async function api(pathname, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'content-type': 'application/json' }, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function waitForServer(portNumber) {
  for (let i = 0; i < 80; i++) { try { await api('/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
}
