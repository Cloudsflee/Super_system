import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject, repositorySnapshot } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4583);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v12-github-security-'));
const repo = path.join(home, 'repo');
fs.mkdirSync(repo);
spawnSync('git', ['init'], { cwd: repo });
spawnSync('git', ['config', 'user.email', 'security@example.test'], { cwd: repo });
spawnSync('git', ['config', 'user.name', 'Security Fixture'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# Security\n');
spawnSync('git', ['add', '.'], { cwd: repo });
spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });
const sourceBefore = repositorySnapshot(repo);
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test', AIWS_BYPASS_SETUP: '1', AIWS_PUBLIC_BASE_URL: 'http://localhost:4317' }, stdio: ['ignore', 'pipe', 'pipe'] });

await waitForServer();
try {
  await api('/setup/mode', 'PUT', { mode: 'byo' });
  await api('/github/app-config/manual', 'POST', { app_id: '101' }, 400, 'missing_fields');

  const manifest = await api('/github/manifest/start', 'POST', {});
  await api('/github/manifest/callback', 'POST', { adapter: 'test' }, 400, 'manifest_state_required');
  await api('/github/manifest/callback', 'POST', { adapter: 'test', state: 'wrong' }, 400, 'manifest_state_mismatch');
  await api('/github/manifest/callback', 'POST', { adapter: 'test', state: manifest.state });
  await api('/github/manifest/callback', 'POST', { adapter: 'test', state: manifest.state }, 409, 'manifest_callback_already_used');

  const device = await startDevice();
  const pending = await pollDevice(device, { test_status: 'authorization_pending' }, 202);
  assert.equal(pending.error, 'authorization_pending');
  const slow = await pollDevice(device, { test_status: 'slow_down' }, 202);
  assert.equal(slow.interval, pending.interval + 5);
  assert.equal((await pollDevice(device, { test_status: 'success' })).connected, true);
  await pollDevice(device, { test_status: 'success' }, 409, 'device_request_not_pending');

  const expired = await startDevice();
  await pollDevice(expired, { test_status: 'expired_token' }, 410, 'expired_token');
  await pollDevice(expired, { test_status: 'success' }, 409, 'device_request_not_pending');
  await pollDevice(await startDevice(), { test_status: 'access_denied' }, 403, 'access_denied');
  await pollDevice(await startDevice(), { test_status: 'incorrect_device_code' }, 400, 'incorrect_device_code');

  const discovery = await api('/github/installations/discover', 'POST', { adapter: 'test', repositories: [{ id: 7001, name: 'workspace', full_name: 'aiws/workspace', private: true, permissions: { pull: true, push: false, admin: false } }] });
  assert.equal(discovery.installed, true);
  await api('/github/installations/9001/repositories', 'PUT', { repository_ids: ['7001'] });
  const project = await createConfirmedProject({ baseUrl: `http://127.0.0.1:${port}`, title: 'Permission Fixture', source: repo, workflowNodes: [{ type: 'execution', title: 'Permission Node' }] });
  await api(`/projects/${project.project.id}/repository-binding`, 'PUT', { installation_id: '9001', repository_id: '7001', adapter: 'test' }, 403, 'access_required');
  const permission = await api('/github/permissions/check', 'POST', { project_id: project.project.id, operation: 'git_push' }, 403);
  assert.equal(permission.github_allowed, false);

  const removedPayload = { action: 'removed', installation: { id: 9001 }, repositories_removed: [{ id: 7001 }] };
  await webhook('bad-signature', 'installation_repositories', removedPayload, 'sha256=bad', 401, 'invalid_webhook_signature');
  const accepted = await webhook('repository-removed', 'installation_repositories', removedPayload);
  assert.equal(accepted.accepted, true);
  await webhook('repository-removed', 'installation_repositories', removedPayload, 'sha256=bad', 401, 'invalid_webhook_signature');
  assert.equal((await webhook('repository-removed', 'installation_repositories', removedPayload)).duplicate, true);
  assert.equal((await api('/github/installations/9001/repositories')).length, 0);

  await webhook('installation-deleted', 'installation', { action: 'deleted', installation: { id: 9001 } });
  const installations = await api('/github/installations');
  assert.equal(installations.find((item) => item.installation_id === '9001').status, 'removed');
  assert.deepEqual(repositorySnapshot(repo), sourceBefore);
  console.log('v1.2 GitHub security integration tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.rmSync(home, { recursive: true, force: true });
}

async function startDevice() { return api('/github/device/start', 'POST', { adapter: 'test' }); }
async function pollDevice(device, extra, status = 200, error) { return api('/github/device/poll', 'POST', { adapter: 'test', request_id: device.request_id, ...extra }, status, error); }
async function webhook(delivery, event, body, signature, status = 202, error) {
  const payload = JSON.stringify(body);
  const signed = signature || `sha256=${createHmac('sha256', 'test-hook').update(payload).digest('hex')}`;
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-delivery': delivery, 'x-github-event': event, 'x-hub-signature-256': signed }, body: payload });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  if (error) assert.equal(data.error, error);
  return data;
}
async function api(route, method = 'GET', body, status = 200, error) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`);
  if (error) assert.equal(data.error, error);
  return data;
}
async function waitForServer() { for (let index = 0; index < 100; index++) { try { if ((await api('/health')).status === 'ok') return; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } } throw new Error('server did not start'); }
