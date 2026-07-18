import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject, repositorySnapshot } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4571);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-github-home-'));
const repo = path.join(home, 'repo');
fs.mkdirSync(repo);
spawnSync('git', ['init'], { cwd: repo });
spawnSync('git', ['config', 'user.email', 'github@example.test'], { cwd: repo });
spawnSync('git', ['config', 'user.name', 'GitHub Fixture'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# GitHub\n');
spawnSync('git', ['add', '.'], { cwd: repo });
spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });
const sourceBefore = repositorySnapshot(repo);
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test', AIWS_BYPASS_SETUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await waitForServer();
try {
  await api('/setup/mode', { method: 'PUT', body: { mode: 'byo' } });
  await api('/github/app-config/validate', { method: 'POST', body: { adapter: 'test', app_id: '101', client_id: 'Iv1.fixture', client_secret: 'fixture-client', private_key: 'fixture-private', webhook_secret: 'fixture-hook' } });
  const device = await api('/github/device/start', { method: 'POST', body: { adapter: 'test' } });
  await api('/github/device/poll', { method: 'POST', body: { adapter: 'test', request_id: device.request_id } });
  const discovery = await api('/github/installations/discover', { method: 'POST', body: { adapter: 'test' } });
  assert.equal(discovery.installed, true);
  assert.equal(discovery.installations[0].installation_id, '9001');
  await api('/github/installations/9001/repositories', { method: 'PUT', body: { repository_ids: ['7001'] } });
  const project = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`, title: 'GitHub Fixture', goal: '验证 PR adapter',
    workflowNodes: [{ type: 'execution', title: 'GitHub 执行节点', goal: '提交 PR' }],
    beforeConfirm: ({ draft }) => api(`/projects/${draft.project.id}/repository-binding`, { method: 'PUT', body: { installation_id: '9001', repository_id: '7001', adapter: 'test' } })
  });
  const managedRepo = project.managedRepo;
  spawnSync('git', ['config', 'user.email', 'github@example.test'], { cwd: managedRepo });
  spawnSync('git', ['config', 'user.name', 'GitHub Fixture'], { cwd: managedRepo });
  fs.writeFileSync(path.join(managedRepo, 'README.md'), '# GitHub managed checkout\n');
  spawnSync('git', ['add', '.'], { cwd: managedRepo }); spawnSync('git', ['commit', '-m', 'init'], { cwd: managedRepo });
  const node = (await api(`/projects/${project.project.id}`)).nodes.find((item) => item.role === 'task');
  const approvalId = await approveNodeRun(project.project.id, node.id);
  const run = await api(`/nodes/${node.id}/run`, { method: 'POST', body: { adapter: 'test', runner: 'codex_docker', approval_id: approvalId } });
  await api(`/runs/${run.run.id}/git/branch`, { method: 'POST', body: {} });
  fs.appendFileSync(path.join(managedRepo, 'README.md'), 'change\n');
  await api(`/runs/${run.run.id}/git/diff`, { method: 'POST', body: {} });
  const commitApproval = await approveGitAction(project.project.id, node.id, run.run.id, 'git_commit_authorization');
  await api(`/runs/${run.run.id}/git/commit`, { method: 'POST', body: { message: 'test: prepare GitHub PR', approval_id: commitApproval } });
  const publishApproval = await approveGitAction(project.project.id, node.id, run.run.id, 'git_publish_authorization');
  const pr = await api(`/runs/${run.run.id}/github/pr`, { method: 'POST', body: { adapter: 'test', approval_id: publishApproval } });
  assert.equal(pr.github_connected, true);
  assert.equal(pr.repository_bound, true);
  assert.equal(pr.code_change.status, 'pr_created');
  assert.match(pr.code_change.pr_url, /github\.com\/aiws\/workspace\/pull\/1/);
  const trace = await api(`/runs/${run.run.id}/trace`);
  assert.ok(trace.some((item) => item.event_type === 'git.pr.created'));
  assert.deepEqual(repositorySnapshot(repo), sourceBefore);
  console.log('github adapter integration tests passed');
} finally { child.kill(); await new Promise((resolve) => setTimeout(resolve, 200)); fs.rmSync(home, { recursive: true, force: true }); }

async function api(pathname, options = {}) { const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'content-type': 'application/json' }, ...options, body: options.body ? JSON.stringify(options.body) : undefined }); const data = await response.json(); assert.ok(response.ok, `${pathname}: ${JSON.stringify(data)}`); return data; }
async function approveNodeRun(projectId, nodeId) { const proposal = await api('/change-proposals', { method: 'POST', body: { project_id: projectId, node_id: nodeId, change_type: 'node_run_write', title: '批准 GitHub 测试运行', after: { runner: 'codex_docker' }, apply_action: { type: 'node_run_authorization', node_id: nodeId, runner: 'codex_docker' } } }); await api(`/change-proposals/${proposal.id}/approve`, { method: 'POST', body: {} }); await api(`/change-proposals/${proposal.id}/apply`, { method: 'POST', body: {} }); return proposal.id; }
async function approveGitAction(projectId, nodeId, runId, type) { const proposal = await api('/change-proposals', { method: 'POST', body: { project_id: projectId, node_id: nodeId, change_type: type, title: `批准 ${type}`, after: { run_id: runId }, apply_action: { type, run_id: runId } } }); await api(`/change-proposals/${proposal.id}/approve`, { method: 'POST', body: {} }); await api(`/change-proposals/${proposal.id}/apply`, { method: 'POST', body: {} }); return proposal.id; }
async function waitForServer() { for (let index = 0; index < 80; index++) { try { await api('/health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } throw new Error('server did not start'); }
