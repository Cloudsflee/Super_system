import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4569);
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-tools-home-'));
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: testHome, NODE_ENV: 'test', AIWS_BYPASS_SETUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await waitForServer(port);
try {
  const cli = await api('/tools', { method: 'POST', body: { name: 'node', type: 'cli', config: { command: 'node', health_args: ['--version'] }, capabilities: ['node'] } });
  const cliHealth = await api(`/tools/${cli.id}/health`, { method: 'POST', body: {} });
  assert.equal(cliHealth.health_status, 'healthy');
  const mcp = await api('/tools', { method: 'POST', body: { name: 'fixture_stdio_mcp', type: 'mcp_stdio', config: { command: 'node', health_args: ['--version'] }, capabilities: ['mcp'] } });
  const mcpHealth = await api(`/tools/${mcp.id}/health`, { method: 'POST', body: {} });
  assert.equal(mcpHealth.health_status, 'healthy');
  const project = await createConfirmedProject({ baseUrl: `http://127.0.0.1:${port}`, title: 'Tool Injection', goal: '验证工具进入 Context Pack', workflowNodes: [{ type: 'execution', title: '工具注入', goal: '验证 Context Pack 工具' }] });
  const node = (await api(`/projects/${project.project.id}`)).nodes.find((item) => item.role === 'task');
  assert.ok(node, 'confirmed workflow exposes an executable Task');
  const contract = await api('/change-proposals', { method: 'POST', body: { project_id: project.project.id, node_id: node.id, change_type: 'node_contract_patch', title: '添加工具', after: { allowed_tools: ['filesystem', 'git', 'codex_runner', 'node', 'mcp'] }, apply_action: { type: 'node_contract_patch' } } });
  await api(`/change-proposals/${contract.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${contract.id}/apply`, { method: 'POST', body: {} });
  const ctx = await api(`/nodes/${node.id}/context-pack/preview`, { method: 'POST', body: {} });
  assert.ok(ctx.content_json.available_tools.some((tool) => tool.name === 'node'));
  assert.ok(ctx.content_json.available_tools.some((tool) => tool.name === 'fixture_stdio_mcp'));
  console.log('tool registry integration tests passed');
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
