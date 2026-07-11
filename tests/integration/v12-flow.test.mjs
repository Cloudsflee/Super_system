import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject, repositorySnapshot } from './v13-test-helpers.mjs';

const port = 4582;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v12-home-'));
const repo = path.join(home, 'repo');
fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'README.md'), '# Workspace\n', 'utf8');
spawnSync('git', ['init'], { cwd: repo });
spawnSync('git', ['config', 'user.email', 'v12@example.test'], { cwd: repo });
spawnSync('git', ['config', 'user.name', 'V12 Fixture'], { cwd: repo });
spawnSync('git', ['add', '.'], { cwd: repo });
spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });
const sourceBefore = repositorySnapshot(repo);
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test', AIWS_PUBLIC_BASE_URL: 'http://localhost:4317', AIWS_HOSTED_GITHUB_APP_ID: '2026', AIWS_HOSTED_GITHUB_CLIENT_ID: 'Iv1.hosted', AIWS_HOSTED_GITHUB_CLIENT_SECRET: 'hosted-client-secret', AIWS_HOSTED_GITHUB_APP_SLUG: 'aiws-hosted', AIWS_HOSTED_GITHUB_PRIVATE_KEY: 'test-hosted-private-key', AIWS_HOSTED_GITHUB_WEBHOOK_SECRET: 'hosted-webhook-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.on('data', (chunk) => { serverLog += chunk; });

await waitForServer();
try {
  const stateFile = path.join(home, 'data', 'state.json');
  const legacyState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  legacyState.connected_accounts.push({ id: 'legacy-demo', user_id: legacyState.users[0].id, provider: 'github', login: 'aiws-oauth-demo', status: 'connected' });
  fs.writeFileSync(stateFile, JSON.stringify(legacyState), 'utf8');
  const initial = await api('/setup/status');
  assert.equal(initial.complete, false);
  assert.equal(initial.steps.github.checks.account_connected, false);
  const defaults = await api('/github/app-config/defaults');
  assert.match(defaults.client_id, /^Iv/);
  await api('/setup/mode', { method: 'PUT', body: { mode: 'hosted' } });
  const hosted = await api('/setup/status');
  assert.equal(hosted.steps.github.checks.app_configured, true);
  const hostedDevice = await api('/github/device/start', { method: 'POST', body: { adapter: 'test' } });
  await api('/github/device/poll', { method: 'POST', body: { adapter: 'test', request_id: hostedDevice.request_id } });
  await api('/github/installations/start', { method: 'POST', body: { adapter: 'test', installation_id: 'hosted-9001' } });
  await api('/github/installations/hosted-9001/repositories', { method: 'PUT', body: { repository_ids: ['7001'] } });
  assert.equal((await api('/setup/status')).steps.github.ready, true);
  const callbackPage = await fetch(`http://127.0.0.1:${port}/integrations/github/install/setup?installation_id=9001`, { headers: { accept: 'text/html' } });
  assert.equal(callbackPage.status, 200);
  assert.match(await callbackPage.text(), /<div id="root"><\/div>/);
  await api('/projects', { method: 'POST', body: { title: 'blocked' } }, 403);
  await api('/setup/mode', { method: 'PUT', body: { mode: 'byo' } });
  const switched = await api('/setup/status');
  assert.equal(switched.mode, 'byo');
  assert.equal(switched.steps.github.checks.account_connected, false);
  assert.equal(switched.steps.github.installation_count, 0);
  const manifest = await api('/github/manifest/start', { method: 'POST', body: {} });
  assert.equal(manifest.manifest.setup_url, 'http://localhost:4317/integrations/github/install/setup');
  assert.equal(manifest.manifest.public, true);
  assert.equal(manifest.manifest.hook_attributes.active, false);
  const secrets = { client_secret: 'client-secret-v12-unique', private_key: 'private-key-v12-unique', webhook_secret: 'webhook-secret-v12-unique' };
  const publicConfig = await api('/github/app-config/validate', { method: 'POST', body: { adapter: 'test', app_id: '101', client_id: 'Iv1.test', ...secrets } });
  for (const secret of Object.values(secrets)) assert.equal(JSON.stringify(publicConfig).includes(secret), false, `API masks ${secret}`);
  const device = await api('/github/device/start', { method: 'POST', body: { adapter: 'test' } });
  await api('/github/device/poll', { method: 'POST', body: { adapter: 'test', request_id: device.request_id } });
  await api('/github/installations/start', { method: 'POST', body: { adapter: 'test' } });
  const repositorySelection = await api('/setup/status');
  assert.equal(repositorySelection.steps.github.status, 'repository_selection_required');
  assert.equal(repositorySelection.steps.github.installation_count, 1);
  await api('/github/installations/9001/repositories', { method: 'PUT', body: { repository_ids: ['7001'] } });
  await api('/codex/docker/build', { method: 'POST', body: { adapter: 'test' } });
  await api('/codex/auth/api-key', { method: 'POST', body: { provider: 'openai', api_key: 'sk-v12-unique-api-key' } });
  const ccSwitch = await api('/codex/cc-switch/sync', { method: 'POST', body: { adapter: 'test' } });
  assert.equal(ccSwitch.sources.length, 2);
  assert.equal(ccSwitch.sources.every((item) => item.commit === 'test-adapter'), true);
  const profile = await api('/codex/profiles', { method: 'POST', body: { name: 'V1.2 Test', provider: 'openai', model: 'gpt-test', reasoning: 'high', timeout_ms: 10000, mounts: [] } });
  await api('/codex/probe', { method: 'POST', body: { adapter: 'test', profile_id: profile.id } });
  const completed = await api('/setup/complete', { method: 'POST', body: {} });
  assert.equal(completed.complete, true);

  const created = await createConfirmedProject({ baseUrl: `http://127.0.0.1:${port}`, title: 'V1.2 Project', goal: '验证真实工作空间', source: repo, workflowNodes: [{ type: 'execution', title: '实现功能', goal: '修改并验证代码' }] });
  let bundle = await api(`/projects/${created.project.id}`);
  assert.equal(bundle.nodes.length, 1);
  const node = bundle.nodes[0];
  const workspace = await api(`/nodes/${node.id}/workspace`);
  assert.equal(workspace.node.type, 'execution');
  await api(`/nodes/${node.id}/workspace-data`, { method: 'PUT', body: { data: { notes: 'real state' } } });
  await api(`/projects/${created.project.id}/files/content`, { method: 'PUT', body: { node_id: node.id, path: 'README.md', content: '# Updated\n' } });
  const file = await api(`/projects/${created.project.id}/files/content?path=README.md`);
  assert.equal(file.content, '# Updated\n');
  const template = await api(`/workflows/${created.workflow.id}/proposals`, { method: 'POST', body: { action: 'apply_template' } });
  await api(`/change-proposals/${template.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${template.id}/apply`, { method: 'POST', body: {} });
  bundle = await api(`/projects/${created.project.id}`);
  for (const type of ['goal_definition', 'research', 'analysis', 'execution', 'retrospective']) {
    const typedNode = bundle.nodes.find((item) => item.type === type);
    assert.ok(typedNode, `${type} renderer has a persisted node workspace`);
    await api(`/nodes/${typedNode.id}/workspace-data`, { method: 'PUT', body: { data: { renderer_type: type, persisted: true } } });
    const restoredWorkspace = await api(`/nodes/${typedNode.id}/workspace`);
    assert.deepEqual(restoredWorkspace.data, { renderer_type: type, persisted: true });
  }
  const goalNode = bundle.nodes.find((item) => item.type === 'goal_definition');
  const analysisNode = bundle.nodes.find((item) => item.type === 'analysis');
  const connect = await api(`/workflows/${created.workflow.id}/proposals`, { method: 'POST', body: { action: 'connect_nodes', source_id: goalNode.id, target_id: analysisNode.id } });
  await api(`/change-proposals/${connect.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${connect.id}/apply`, { method: 'POST', body: {} });
  assert.equal((await api(`/projects/${created.project.id}`)).nodes.find((item) => item.id === analysisNode.id).dependencies.some((item) => item.node_id === goalNode.id), true);
  const positions = bundle.nodes.map((item, index) => ({ id: item.id, position: { x: index * 50, y: index * 25 } }));
  await api(`/workflows/${created.workflow.id}/layout`, { method: 'PUT', body: { nodes: positions } });
  assert.deepEqual((await api(`/projects/${created.project.id}`)).nodes.find((item) => item.id === goalNode.id).position, positions.find((item) => item.id === goalNode.id).position);
  const removedNode = bundle.nodes.find((item) => item.type === 'retrospective');
  const remove = await api(`/workflows/${created.workflow.id}/proposals`, { method: 'POST', body: { action: 'remove_node', node_id: removedNode.id } });
  await api(`/change-proposals/${remove.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${remove.id}/apply`, { method: 'POST', body: {} });
  assert.equal((await api(`/projects/${created.project.id}`)).nodes.some((item) => item.id === removedNode.id), false);
  await api(`/projects/${created.project.id}/files/content?path=..%2Foutside.txt`, {}, 403);
  await api(`/nodes/${node.id}/run`, { method: 'POST', body: { runner: 'mock' } }, 400);

  const session = await api('/assist/v2/sessions', { method: 'POST', body: { project_id: created.project.id, scope_type: 'node', scope_id: node.id, view_context: { route: `/projects/${created.project.id}/nodes/${node.id}` } } });
  await api(`/assist/v2/sessions/${session.id}/messages`, { method: 'POST', body: { adapter: 'test', content: '更新契约并选择节点', test_response: { message: '已形成可审查动作。', actions: [{ name: 'select_node', label: '选择执行节点', args: { node_id: node.id } }, { name: 'update_contract', label: '更新 Contract', args: { node_goal: '新目标' } }, { name: 'navigate', label: '非法动作', args: { selector: '#root', path: '/projects' } }] } } });
  const events = await fetch(`http://127.0.0.1:${port}/assist/v2/sessions/${session.id}/events`).then((response) => response.text());
  assert.match(events, /event: assist/);
  assert.match(events, /completed/);
  const detailed = await api(`/assist/v2/sessions/${session.id}`);
  assert.equal(detailed.actions.length, 2);
  assert.ok(detailed.agent_session_id);
  const restored = await api(`/assist/v2/sessions?project_id=${created.project.id}&scope_type=node&scope_id=${node.id}&limit=1`);
  assert.equal(restored[0].id, session.id);
  const hierarchy = await api(`/agent-sessions?scope_type=node&scope_id=${node.id}`);
  assert.equal(hierarchy.some((item) => item.id === detailed.agent_session_id && item.parent_session_id), true);
  const contractAction = detailed.actions.find((item) => item.name === 'update_contract');
  const decided = await api(`/assist/v2/sessions/${session.id}/actions/${contractAction.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(decided.status, 'confirmed');
  assert.ok(decided.result.id.startsWith('cpr_'));
  const tools = await api('/tools');
  assert.equal(tools.some((item) => item.name === 'mock_runner'), false);

  const payload = JSON.stringify({ action: 'removed', installation: { id: 9001 }, repositories_removed: [{ id: 7001 }] });
  const signature = `sha256=${createHmac('sha256', secrets.webhook_secret).update(payload).digest('hex')}`;
  const webhookHeaders = { 'content-type': 'application/json', 'x-github-delivery': 'delivery-v12', 'x-github-event': 'installation_repositories', 'x-hub-signature-256': signature };
  const accepted = await fetch(`http://127.0.0.1:${port}/github/webhook`, { method: 'POST', headers: webhookHeaders, body: payload });
  assert.equal(accepted.status, 202);
  const duplicate = await fetch(`http://127.0.0.1:${port}/github/webhook`, { method: 'POST', headers: webhookHeaders, body: payload }).then((response) => response.json());
  assert.equal(duplicate.duplicate, true);
  await api('/projects', {}, 403);
  await api('/demo/full-chain', {}, 404);
  const rawState = fs.readFileSync(path.join(home, 'data', 'state.json'), 'utf8');
  const artifactText = readTree(path.join(home, 'artifacts'));
  for (const secret of [...Object.values(secrets), 'sk-v12-unique-api-key', 'test-access-token']) {
    assert.equal(rawState.includes(secret), false, `state/Trace masks ${secret}`);
    assert.equal(artifactText.includes(secret), false, `artifact masks ${secret}`);
    assert.equal(serverLog.includes(secret), false, `logs mask ${secret}`);
  }
  assert.deepEqual(repositorySnapshot(repo), sourceBefore);
  console.log('v1.2 integration tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(home, { recursive: true, force: true });
}

async function api(pathname, options = {}, expected = null) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'content-type': 'application/json' }, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (expected === null) assert.ok(response.ok, `${pathname}: ${JSON.stringify(data)}`); else assert.equal(response.status, expected, `${pathname}: ${JSON.stringify(data)}`);
  return data;
}
async function waitForServer() { for (let index = 0; index < 100; index++) { try { await api('/health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } throw new Error('server did not start'); }
function readTree(dir) { if (!fs.existsSync(dir)) return ''; return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? readTree(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')).join('\n'); }
