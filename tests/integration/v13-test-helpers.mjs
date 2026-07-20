import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'aiws');
  const ccSwitch = path.join(root, 'cc-switch');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ccSwitch, { recursive: true });
  return { root, home, ccSwitch };
}

export async function startApi({ port, home, ccSwitch, env = {} }) {
  let log = '';
  const child = spawn(process.execPath, ['apps/api/server.mjs'], {
    env: {
      ...process.env,
      AIWS_PORT: String(port),
      AIWS_HOME: home,
      CC_SWITCH_CONFIG_DIR: ccSwitch,
      NODE_ENV: 'test',
      AIWS_BYPASS_SETUP: '1',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  await waitForServer(port, () => log, child);
  return {
    child,
    log: () => log,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]);
    }
  };
}

export async function api(port, route, method = 'GET', body, expected = 200, errorCode) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...await projectCreateHeaders(baseUrl, route, method) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  if (errorCode) assert.equal(data.error, errorCode, `${method} ${route} error`);
  return data;
}

export function sourceSnapshot(root, ignoreNames = new Set()) {
  const files = [];
  visit(root, '');
  const digest = crypto.createHash('sha256');
  for (const item of files) digest.update(`${item.path}\0${item.sha256}\0${item.mtimeMs}\n`);
  return { digest: digest.digest('hex'), files };

  function visit(directory, relative) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignoreNames.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(full, child);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        files.push({ path: child, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), mtimeMs: stat.mtimeMs });
      }
    }
  }
}

export function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

export async function createConfirmedProject({ baseUrl, title, goal = '', source = null, workflowNodes, answers = {}, beforeConfirm }) {
  const codeSource = normalizeSource(source);
  const draft = await request(baseUrl, '/projects', 'POST', { title, goal });
  const intake = await request(baseUrl, `/projects/${draft.project.id}/intake`, 'PUT', {
    mode: codeSource ? 'existing' : 'brainstorm',
    code_source: codeSource,
    answers: { goal, ...answers }
  });
  const imported = codeSource ? await request(baseUrl, `/projects/${draft.project.id}/imports`, 'POST', { operation_key: `fixture-${draft.project.id}` }) : null;
  if (beforeConfirm) await beforeConfirm({ draft, intake, imported });
  const confirmed = await request(baseUrl, `/projects/${draft.project.id}/onboarding/confirm`, 'POST', { workflow_nodes: hierarchyFixtureNodes(workflowNodes, { title, goal }) });
  return { ...confirmed, draft, intake, imported, managedRepo: confirmed.project.repo_path };
}

export function repositorySnapshot(repo) {
  return {
    tree: sourceSnapshot(repo, new Set(['.git'])),
    head: git(repo, ['rev-parse', '--verify', 'HEAD']),
    status: git(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    remotes: git(repo, ['remote', '-v'])
  };
}

async function waitForServer(port, getLog, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`API exited before ready (${child.exitCode}):\n${getLog()}`);
    try { if ((await api(port, '/health')).status === 'ok') return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`API did not start:\n${getLog()}`);
}

async function request(baseUrl, route, method, body) {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: { 'content-type': 'application/json', ...await projectCreateHeaders(baseUrl, route, method) }, body: JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}
async function projectCreateHeaders(baseUrl, route, method) {
  if (method !== 'POST' || route !== '/projects') return {};
  const account = await fetch(`${baseUrl}/account/me`).then((response) => response.json());
  return { 'x-aiws-user-id': account.user.id, 'x-aiws-scopes': 'project:create' };
}
function normalizeSource(source) {
  if (!source) return null;
  if (typeof source === 'object') return source;
  return { type: fs.existsSync(path.join(source, '.git')) ? 'local_git' : 'local_directory', path: source };
}
function hierarchyFixtureNodes(nodes, { title, goal }) {
  const source = nodes === undefined ? [{ id: 'fixture-primary-outcome', type: 'execution', title: `${title}成果`, goal: goal || `完成 ${title}` }] : nodes;
  if (source.some((node) => node?.role === 'workstream' || node?.role === 'task' || Array.isArray(node?.tasks))) return source;
  const ids = source.map((node, index) => String(node?.id || `fixture-workstream-${index + 1}`));
  return source.map((node, index) => {
    const workstreamId = ids[index], outcome = String(node?.goal || node?.title || `完成成果 ${index + 1}`);
    const rawTitle = String(node?.title || `成果 ${index + 1}`), titleValue = ['需求分析', '设计', '编码', '测试', '复盘', '上线', 'analysis', 'design', 'coding', 'testing', 'review', 'deployment'].includes(rawTitle.toLowerCase()) ? `${rawTitle}成果` : rawTitle;
    const dependencyIds = Array.isArray(node?.dependency_ids)
      ? node.dependency_ids
      : (node?.dependency_indexes || []).map((dependencyIndex) => ids[dependencyIndex]).filter(Boolean);
    const taskKind = ({ goal_definition: 'analysis', research: 'research', analysis: 'analysis', execution: 'code', retrospective: 'review' })[node?.type] || 'manual';
    return {
      id: workstreamId, role: 'workstream', title: titleValue, goal: outcome, outcome, category: 'deliverable',
      acceptance_criteria: [`可验证交付：${outcome}`], boundary: { deliverable: outcome }, dependency_ids: dependencyIds,
      tasks: [{
        id: `${workstreamId}-task`, role: 'task', title: `${titleValue}任务`, goal: outcome, task_kind: taskKind,
        execution_mode: ['code', 'test', 'deploy'].includes(taskKind) ? 'codex' : taskKind === 'manual' ? 'manual' : 'assist', dependency_ids: []
      }]
    };
  });
}
function git(repo, args) { const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
