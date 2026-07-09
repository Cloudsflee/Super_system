import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const port = 4567;
const testHome = `${process.cwd()}/.ai-workspace-test-integration`;
fs.rmSync(testHome, { recursive: true, force: true });
const env = { ...process.env, AIWS_PORT: String(port), AIWS_HOME: testHome, NODE_ENV: 'test' };
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
await waitForServer(port);
try {
  const health = await api('/health');
  assert.equal(health.status, 'ok');
  const project = await api('/projects', { method: 'POST', body: { title: 'Integration Project', goal: '跑通 Project Workflow NodeRun Asset Digest Git PR', role: 'tester' } });
  const assist = await api('/assist/sessions', { method: 'POST', body: { target_type: 'project_wizard', target_id: project.project.id, project_id: project.project.id, user_prompt: '帮我确认目标' } });
  assert.ok(assist.result.memory_manifest, 'assist has memory manifest');
  assert.ok(assist.result.sufficiency_check, 'assist has sufficiency check');
  await api(`/assist/sessions/${assist.id}/apply`, { method: 'POST', body: {} });
  const wf = await api('/workflows/recommend', { method: 'POST', body: { project_id: project.project.id } });
  assert.equal(wf.nodes.length, 5);
  const confirmed = await api(`/workflows/${wf.workflow.id}/confirm`, { method: 'POST', body: {} });
  const node = confirmed.nodes[3];
  const ctrAssist = await api('/assist/sessions', { method: 'POST', body: { target_type: 'node_contract', target_id: node.id, node_id: node.id, project_id: project.project.id, user_prompt: '生成验收标准' } });
  assert.ok(ctrAssist.result.options.length >= 2);
  await api(`/assist/sessions/${ctrAssist.id}/apply`, { method: 'POST', body: { node_id: node.id } });
  const ctx = await api(`/nodes/${node.id}/context-pack/preview`, { method: 'POST', body: {} });
  assert.equal(ctx.quality_check.passed, true);
  assert.ok(ctx.memory_manifest.included.length >= 1);
  await api(`/context-packs/${ctx.id}/confirm`, { method: 'POST', body: {} });
  const workspace = await api(`/workspaces/${node.workspace_id}`);
  assert.ok(workspace.context_packs.length >= 1);
  const queued = await api(`/nodes/${node.id}/run`, { method: 'POST', body: { runner: 'mock', enqueue_only: true } });
  assert.equal(queued.run.status, 'queued');
  const cancelled = await api(`/runs/${queued.run.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelled.status, 'cancelled');
  const run = await api(`/nodes/${node.id}/run`, { method: 'POST', body: { runner: 'mock', mock_write: false } });
  assert.equal(run.run.status, 'succeeded');
  assert.ok(run.assets.length >= 1);
  await api(`/asset-candidates/${run.assets[0].id}/confirm`, { method: 'POST', body: {} });
  const digest = await api(`/workspaces/${node.workspace_id}/digests`, { method: 'POST', body: {} });
  assert.equal(digest.version, 1);
  const diff = await api(`/runs/${run.run.id}/git/diff`, { method: 'POST', body: {} });
  assert.ok(diff.file_ref.id);
  const pr = await api(`/runs/${run.run.id}/github/pr`, { method: 'POST', body: {} });
  assert.equal(pr.github_connected, false);
  const trace = await api(`/runs/${run.run.id}/trace`);
  for (const event of ['node_run.started', 'runner.invoked', 'runner.completed', 'asset_candidate.created']) assert.ok(trace.some((t) => t.event_type === event), `trace contains ${event}`);
  const cancelledTrace = await api(`/runs/${queued.run.id}/trace`);
  assert.ok(cancelledTrace.some((t) => t.event_type === 'runner.cancelled'));
  console.log('integration api flow tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(testHome, { recursive: true, force: true });
}

async function api(path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'content-type': 'application/json' }, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function waitForServer(port) {
  for (let i = 0; i < 80; i++) {
    try { await api('/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}
