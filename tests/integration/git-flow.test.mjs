import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject, repositorySnapshot } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4568);
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-git-repo-'));
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-git-home-'));
run('git', ['init'], repo);
run('git', ['config', 'user.email', 'aiws@example.test'], repo);
run('git', ['config', 'user.name', 'AIWS Tester'], repo);
fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
run('git', ['add', 'README.md'], repo);
run('git', ['commit', '-m', 'init'], repo);
const sourceBefore = repositorySnapshot(repo);

const child = spawn(process.execPath, ['apps/api/server.mjs'], {
  env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: testHome, NODE_ENV: 'test', AIWS_BYPASS_SETUP: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
await waitForServer(port);
try {
  const project = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`,
    title: 'Git Fixture',
    goal: '验证真实 git branch diff commit',
    source: repo,
    workflowNodes: [{ type: 'execution', title: 'Git 执行节点', goal: '验证 branch diff commit' }]
  });
  const managedRepo = project.managedRepo;
  run('git', ['config', 'user.email', 'aiws@example.test'], managedRepo);
  run('git', ['config', 'user.name', 'AIWS Tester'], managedRepo);
  const node = (await api(`/projects/${project.project.id}`)).nodes.find((item) => item.role === 'task');
  const approvalId = await approveNodeRun(project.project.id, node.id);
  await apiStatus(
    `/nodes/${node.id}/run`,
    { method: 'POST', body: { adapter: 'test', runner: 'codex', approval_id: approvalId } },
    409,
    'node_run_approval_scope_mismatch'
  );
  const runResult = await api(`/nodes/${node.id}/run`, {
    method: 'POST',
    body: { adapter: 'test', runner: 'codex_docker', approval_id: approvalId }
  });
  assert.equal(runResult.run.status, 'succeeded');
  const branch = await api(`/runs/${runResult.run.id}/git/branch`, { method: 'POST', body: {} });
  assert.equal(branch.command_result.ok, true);
  assert.notEqual(branch.code_change.base_branch, branch.branch);
  fs.appendFileSync(path.join(managedRepo, 'README.md'), `\nrun ${runResult.run.id}\n`, 'utf8');
  const diff = await api(`/runs/${runResult.run.id}/git/diff`, { method: 'POST', body: {} });
  assert.ok(diff.changed_files.some((f) => f.path === 'README.md'));
  await apiStatus(
    `/runs/${runResult.run.id}/git/commit`,
    { method: 'POST', body: { message: 'must be approved' } },
    409,
    'git_action_approval_required'
  );
  const commitApproval = await approveGitAction(
    project.project.id,
    node.id,
    runResult.run.id,
    'git_commit_authorization'
  );
  const commit = await api(`/runs/${runResult.run.id}/git/commit`, {
    method: 'POST',
    body: { message: 'test: aiws git flow', approval_id: commitApproval }
  });
  assert.equal(commit.command_result.ok, true, commit.command_result.stderr);
  assert.match(commit.code_change.head_commit, /^[a-f0-9]{40}$/);
  await apiStatus(
    `/runs/${runResult.run.id}/git/commit`,
    { method: 'POST', body: { message: 'cannot reuse', approval_id: commitApproval } },
    409,
    'git_action_approval_consumed'
  );
  const review = await api('/review');
  assert.ok(review.assets.some((a) => a.asset_type === 'CodeChangeAsset'));
  assert.deepEqual(repositorySnapshot(repo), sourceBefore);
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
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}
async function apiStatus(pathname, options, expected, error) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: JSON.stringify(options.body || {})
  });
  const data = await res.json();
  assert.equal(res.status, expected, `${pathname}: ${JSON.stringify(data)}`);
  assert.equal(data.error, error);
  return data;
}
async function approveNodeRun(projectId, nodeId) {
  const proposal = await api('/change-proposals', {
    method: 'POST',
    body: {
      project_id: projectId,
      node_id: nodeId,
      change_type: 'node_run_write',
      title: '批准 Git 测试运行',
      after: { runner: 'codex_docker' },
      apply_action: { type: 'node_run_authorization', node_id: nodeId, runner: 'codex_docker' }
    }
  });
  await api(`/change-proposals/${proposal.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${proposal.id}/apply`, { method: 'POST', body: {} });
  return proposal.id;
}
async function approveGitAction(projectId, nodeId, runId, type) {
  const proposal = await api('/change-proposals', {
    method: 'POST',
    body: {
      project_id: projectId,
      node_id: nodeId,
      change_type: type,
      title: `批准 ${type}`,
      after: { run_id: runId },
      apply_action: { type, run_id: runId }
    }
  });
  await api(`/change-proposals/${proposal.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${proposal.id}/apply`, { method: 'POST', body: {} });
  return proposal.id;
}
async function waitForServer(portNumber) {
  for (let i = 0; i < 80; i++) {
    try {
      await api('/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
}
