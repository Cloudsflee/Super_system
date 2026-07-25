import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4567);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-api-home-'));
const child = spawn(process.execPath, ['apps/api/server.mjs'], {
  env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test', AIWS_BYPASS_SETUP: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
await waitForServer();
try {
  assert.equal((await api('/health')).status, 'ok');
  const project = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`,
    title: 'API Integration',
    goal: '验证项目、上下文、队列与 Digest',
    workflowNodes: [{ type: 'analysis', title: '分析节点', goal: '形成可追溯分析' }]
  });
  assert.equal(project.project.settings.token_budget, 12000);
  const node = (await api(`/projects/${project.project.id}`)).nodes.find((item) => item.role === 'task');
  const context = await api(`/nodes/${node.id}/context-pack/preview`, { method: 'POST', body: {} });
  assert.equal(context.quality_check.passed, true);
  await api(`/context-packs/${context.id}/confirm`, { method: 'POST', body: {} });
  await apiStatus(`/nodes/${node.id}/run`, { method: 'POST', body: { runner: 'codex_docker' } }, 409);
  const approvalId = await approveNodeRun(project.project.id, node.id);
  const started = await api(`/nodes/${node.id}/run/start`, {
    method: 'POST',
    body: { adapter: 'test', test_delay_ms: 300, runner: 'codex_docker', approval_id: approvalId }
  });
  const visibleRun = started.run;
  assert.equal(visibleRun.status, 'running');
  const cancelled = await api(`/runs/${visibleRun.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await waitForRunStatus(visibleRun.id, 'cancelled')).status, 'cancelled');
  await apiStatus(
    `/nodes/${node.id}/run`,
    { method: 'POST', body: { adapter: 'test', runner: 'codex_docker', approval_id: approvalId } },
    409
  );
  await api(`/nodes/${node.id}/workspace-data`, { method: 'PUT', body: { data: { decision: '保持接口边界' } } });
  const workspace = await api(`/nodes/${node.id}/workspace`);
  assert.equal(workspace.data.decision, '保持接口边界');
  const digest = await api(`/workspaces/${node.workspace_id}/digests`, { method: 'POST', body: {} });
  assert.equal(digest.version, 1);
  const trace = await api(`/runs/${visibleRun.id}/trace`);
  assert.ok(trace.some((item) => item.event_type === 'runner.cancelled'));
  console.log('integration api flow tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(home, { recursive: true, force: true });
}

async function api(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  assert.ok(response.ok, `${pathname}: ${JSON.stringify(data)}`);
  return data;
}
async function apiStatus(pathname, options, expected) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: JSON.stringify(options.body || {})
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${pathname}: ${JSON.stringify(data)}`);
  return data;
}
async function approveNodeRun(projectId, nodeId) {
  const proposal = await api('/change-proposals', {
    method: 'POST',
    body: {
      project_id: projectId,
      node_id: nodeId,
      change_type: 'node_run_write',
      title: '批准测试运行',
      after: { runner: 'codex_docker' },
      apply_action: { type: 'node_run_authorization', node_id: nodeId, runner: 'codex_docker' }
    }
  });
  await api(`/change-proposals/${proposal.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${proposal.id}/apply`, { method: 'POST', body: {} });
  return proposal.id;
}
async function waitForRunStatus(runId, status) {
  for (let index = 0; index < 40; index++) {
    const result = await api(`/runs/${runId}`);
    if (result.run.status === status) return result.run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run did not reach ${status}`);
}
async function waitForServer() {
  for (let index = 0; index < 80; index++) {
    try {
      await api('/health');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('server did not start');
}
