import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4568;
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-git-repo-'));
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-git-home-'));
run('git', ['init'], repo);
run('git', ['config', 'user.email', 'aiws@example.test'], repo);
run('git', ['config', 'user.name', 'AIWS Tester'], repo);
fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
run('git', ['add', 'README.md'], repo);
run('git', ['commit', '-m', 'init'], repo);

const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: testHome, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
await waitForServer(port);
try {
  const project = await api('/projects', { method: 'POST', body: { title: 'Git Fixture', goal: '验证真实 git branch diff commit', repo_path: repo } });
  const wf = await api('/workflows/recommend', { method: 'POST', body: { project_id: project.project.id } });
  const confirmed = await api(`/workflows/${wf.workflow.id}/confirm`, { method: 'POST', body: {} });
  const node = confirmed.nodes[3];
  const runResult = await api(`/nodes/${node.id}/run`, { method: 'POST', body: { runner: 'mock', mock_write: true } });
  const branch = await api(`/runs/${runResult.run.id}/git/branch`, { method: 'POST', body: {} });
  assert.equal(branch.command_result.ok, true);
  fs.appendFileSync(path.join(repo, 'README.md'), `\nrun ${runResult.run.id}\n`, 'utf8');
  const diff = await api(`/runs/${runResult.run.id}/git/diff`, { method: 'POST', body: {} });
  assert.ok(diff.changed_files.some((f) => f.path === 'README.md' || f.path.startsWith('.aiws-demo/')));
  const commit = await api(`/runs/${runResult.run.id}/git/commit`, { method: 'POST', body: { message: 'test: aiws git flow' } });
  assert.equal(commit.command_result.ok, true, commit.command_result.stderr);
  assert.match(commit.code_change.head_commit, /^[a-f0-9]{40}$/);
  const review = await api('/review');
  assert.ok(review.assets.some((a) => a.asset_type === 'CodeChangeAsset'));
  console.log('git integration tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(testHome, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
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
