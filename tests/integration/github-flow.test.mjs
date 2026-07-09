import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4571;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-github-home-'));
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: testHome, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
await waitForServer(port);
try {
  const account = await api('/integrations/github/connect-token', { method: 'POST', body: { token: 'env:GITHUB_TOKEN', login: 'aiws-mock' } });
  assert.equal(account.account.status, 'connected');
  assert.notEqual(account.credential_ref.encrypted_value, 'env:GITHUB_TOKEN');
  const status = await api('/integrations/github/status');
  assert.equal(status.connected, true);
  const project = await api('/projects', { method: 'POST', body: { title: 'GitHub Fixture', goal: '验证 GitHub mock PR' } });
  const wf = await api('/workflows/recommend', { method: 'POST', body: { project_id: project.project.id } });
  const confirmed = await api(`/workflows/${wf.workflow.id}/confirm`, { method: 'POST', body: {} });
  const node = confirmed.nodes[3];
  const run = await api(`/nodes/${node.id}/run`, { method: 'POST', body: { runner: 'mock', mock_write: false } });
  await api(`/runs/${run.run.id}/git/diff`, { method: 'POST', body: {} });
  const pr = await api(`/runs/${run.run.id}/github/pr`, { method: 'POST', body: { pr_url: 'https://github.com/mock/repo/pull/1' } });
  assert.equal(pr.github_connected, true);
  assert.equal(pr.code_change.status, 'pr_created');
  assert.match(pr.code_change.pr_url, /github\.com/);
  const trace = await api(`/runs/${run.run.id}/trace`);
  assert.ok(trace.some((item) => item.event_type === 'git.pr.created'));
  console.log('github mock integration tests passed');
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
