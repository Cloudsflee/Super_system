import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject, repositorySnapshot } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4585);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v12-assist-'));
const repo = path.join(home, 'repo');
fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'README.md'), '# Assist\n'); spawnSync('git', ['init'], { cwd: repo });
spawnSync('git', ['config', 'user.email', 'assist@example.test'], { cwd: repo }); spawnSync('git', ['config', 'user.name', 'Assist Fixture'], { cwd: repo });
spawnSync('git', ['add', '.'], { cwd: repo }); spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });
const sourceBefore = repositorySnapshot(repo);
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test', AIWS_BYPASS_SETUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });

await waitForServer();
try {
  const created = await createConfirmedProject({ baseUrl: `http://127.0.0.1:${port}`, title: 'Assist Fixture', source: repo, workflowNodes: [{ type: 'execution', title: 'Assist Node' }] });
  const node = (await api(`/projects/${created.project.id}`)).nodes[0];

  const failed = await createSession(created.project.id, 'project', created.project.id);
  await api(`/assist/v2/sessions/${failed.id}/messages`, 'POST', { content: 'fail without an active profile' }, 202);
  assert.equal((await waitForStatus(failed.id, 'failed')).error, 'active_codex_profile_required');
  await api(`/assist/v2/sessions/${failed.id}/retry`, 'POST', { adapter: 'test', test_response: { message: 'retry succeeded', actions: [] } }, 202);
  const retried = await waitForStatus(failed.id, 'completed');
  assert.equal(retried.id, failed.id);
  assert.ok(retried.messages.some((item) => item.content === 'retry succeeded'));

  const cancelled = await createSession(created.project.id, 'project', created.project.id);
  await api(`/assist/v2/sessions/${cancelled.id}/messages`, 'POST', { adapter: 'test', content: 'cancel me', test_response: { message: 'must not complete', actions: [] } }, 202);
  await api(`/assist/v2/sessions/${cancelled.id}/cancel`, 'POST', {});
  const cancelledState = await waitForStatus(cancelled.id, 'cancelled');
  assert.equal(cancelledState.messages.some((item) => item.content === 'must not complete'), false);
  await api(`/assist/v2/sessions/${cancelled.id}/messages`, 'POST', { adapter: 'test', content: 'start again', test_response: { message: 'new run completed', actions: [] } }, 202);
  assert.equal((await waitForStatus(cancelled.id, 'completed')).messages.some((item) => item.content === 'new run completed'), true);

  const viewContext = { surface: { fields: [{ id: 'fixture.name', label: 'Name' }], filters: [], tabs: [] } };
  const session = await createSession(created.project.id, 'node', node.id, viewContext);
  assert.ok(session.parent_session_id, 'node scope keeps a project parent session');
  await api(`/assist/v2/sessions/${session.id}/messages`, 'POST', { adapter: 'test', content: 'actions', view_context: viewContext, test_response: { message: 'actions ready', actions: [
    { name: 'fill_field', label: 'Fill', args: { field_id: 'fixture.name', value: 'Codex' } },
    { name: 'save_file', label: 'Save', args: { path: 'README.md', content: '# Saved by Assist\n' } },
    { name: 'update_contract', label: 'Update Contract', args: { node_goal: 'Reviewed goal' } },
    { name: 'navigate', label: 'Reject selector', args: { path: '/projects', selector: '#root' } },
    { name: 'navigate', label: 'Reject script', args: { path: '/projects', script: 'alert(1)' } },
    { name: 'navigate', label: 'Reject URL', args: { path: '/projects', url: 'https://example.invalid' } },
    { name: 'arbitrary_action', label: 'Reject unknown action', args: {} }
  ] } }, 202);
  const completed = await waitForStatus(session.id, 'completed');
  assert.deepEqual(completed.actions.map((item) => item.name).sort(), ['fill_field', 'save_file', 'update_contract']);

  const fullText = await fetch(`http://127.0.0.1:${port}/assist/v2/sessions/${session.id}/events`).then((response) => response.text());
  const events = parseSse(fullText);
  assert.ok(events.length >= 6);
  assert.deepEqual(events.map((item) => item.id), [...events.map((item) => item.id)].sort((a, b) => a - b));
  assert.equal(events.at(-1).data.type, 'completed');
  const cursor = events[1].id;
  const replayText = await fetch(`http://127.0.0.1:${port}/assist/v2/sessions/${session.id}/events`, { headers: { 'Last-Event-ID': String(cursor) } }).then((response) => response.text());
  assert.deepEqual(parseSse(replayText).map((item) => item.id), events.filter((item) => item.id > cursor).map((item) => item.id));

  const fill = completed.actions.find((item) => item.name === 'fill_field');
  const recorded = await api(`/assist/v2/sessions/${session.id}/actions/${fill.id}/result`, 'POST', { ok: true, result: { handled: true } });
  assert.equal(recorded.status, 'completed');
  const save = completed.actions.find((item) => item.name === 'save_file');
  const saved = await api(`/assist/v2/sessions/${session.id}/actions/${save.id}/confirm`, 'POST', {});
  assert.equal(saved.result.source, 'assist_confirmed');

  const structural = completed.actions.find((item) => item.name === 'update_contract');
  const confirmations = await Promise.all([rawPost(`/assist/v2/sessions/${session.id}/actions/${structural.id}/confirm`), rawPost(`/assist/v2/sessions/${session.id}/actions/${structural.id}/confirm`)]);
  assert.deepEqual(confirmations.map((item) => item.status).sort((a, b) => a - b), [200, 409]);
  const proposals = await api(`/change-proposals?project_id=${created.project.id}`);
  assert.equal(proposals.filter((item) => item.title === 'Update Contract').length, 1);
  assert.deepEqual(repositorySnapshot(repo), sourceBefore);
  console.log('v1.2 Assist stream and action integration tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.rmSync(home, { recursive: true, force: true });
}

async function createSession(projectId, scopeType, scopeId, viewContext = {}) { return api('/assist/v2/sessions', 'POST', { project_id: projectId, scope_type: scopeType, scope_id: scopeId, view_context: viewContext }, 201); }
async function waitForStatus(id, status) { let latest; for (let index = 0; index < 250; index++) { latest = await api(`/assist/v2/sessions/${id}`); if (latest.status === status) return latest; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error(`Assist session did not reach ${status}; latest=${latest?.status}:${latest?.error || ''}`); }
async function rawPost(route) { const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: response.status, data: await response.json() }; }
function parseSse(text) { return text.split(/\n\n+/).filter((block) => block.includes('data: ')).map((block) => { const lines = block.split('\n'); assert.ok(lines.some((line) => line === 'event: assist')); const id = Number(lines.find((line) => line.startsWith('id: ')).slice(4)); const data = JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6)); assert.equal(data.id, id); return { id, data }; }); }
async function api(route, method = 'GET', body, status = 200) { const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`); return data; }
async function waitForServer() { for (let index = 0; index < 100; index++) { try { if ((await api('/health')).status === 'ok') return; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } } throw new Error('server did not start'); }
