import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4573;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v11-home-'));
const emptyGithubConfig = path.join(testHome, 'empty-github-app.json');
fs.writeFileSync(emptyGithubConfig, '{"github":{}}', 'utf8');
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: testHome, AIWS_GITHUB_APP_CONFIG: emptyGithubConfig, NODE_ENV: 'test', GITHUB_OAUTH_CLIENT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
await waitForServer(port);
try {
  const missingOauth = await api('/integrations/github/oauth/device/start', { method: 'POST', body: {} }, 400);
  assert.equal(missingOauth.error, 'configuration_required');
  const device = await api('/integrations/github/oauth/device/start', { method: 'POST', body: { mock: true } });
  assert.ok(device.user_code);
  const pending = await api('/integrations/github/oauth/device/poll', { method: 'POST', body: { mock_status: 'pending' } }, 202);
  assert.equal(pending.error, 'authorization_pending');
  const oauth = await api('/integrations/github/oauth/device/poll', { method: 'POST', body: { device_code: device.device_code, login: 'v11-user' } });
  assert.equal(oauth.connected, true);

  const codex = await api('/integrations/codex/status');
  assert.equal(codex.mode, 'docker-per-run');
  const built = await api('/integrations/codex/docker/build', { method: 'POST', body: { mock: true } });
  assert.equal(built.image, 'aiws-codex-runner:local');
  const cc = await api('/integrations/cc-switch/sync', { method: 'POST', body: { dry_run: true } });
  assert.equal(cc.status, 'synced');
  const profiles = await api('/codex/profiles');
  assert.ok(profiles.some((profile) => profile.kind === 'docker'));
  assert.ok(profiles.some((profile) => profile.kind === 'cc_switch'));
  const appliedProfile = await api(`/codex/profiles/${profiles.find((profile) => profile.kind === 'docker').id}/apply`, { method: 'POST', body: {} });
  assert.equal(appliedProfile.is_active, true);

  const project = await api('/projects', { method: 'POST', body: { title: 'V1.1 Project', goal: '验证层级 Codex 与审批' } });
  const wf = await api('/workflows/recommend', { method: 'POST', body: { project_id: project.project.id } });
  const confirmed = await api(`/workflows/${wf.workflow.id}/confirm`, { method: 'POST', body: {} });
  const node = confirmed.nodes[1];
  const topSession = await api('/agent-sessions', { method: 'POST', body: { project_id: project.project.id, scope_type: 'project', scope_id: project.project.id, title: 'Top Codex' } });
  const nodeSession = await api('/agent-sessions', { method: 'POST', body: { project_id: project.project.id, workspace_id: node.workspace_id, scope_type: 'node', scope_id: node.id, parent_session_id: topSession.id, title: 'Node Codex' } });
  assert.equal(nodeSession.parent_session_id, topSession.id);
  const submission = await api(`/agent-sessions/${nodeSession.id}/submissions`, { method: 'POST', body: { title: '节点提交', summary: 'sub 完成摘要', node_id: node.id, evidence_refs: ['trace:v11'] } });
  assert.equal(submission.to_session_id, topSession.id);
  const ctx = await api(`/nodes/${confirmed.nodes[2].id}/context-pack/preview`, { method: 'POST', body: {} });
  assert.ok(ctx.content_json.submissions.some((item) => item.id === submission.id));

  const proposal = await api('/change-proposals', { method: 'POST', body: { project_id: project.project.id, workspace_id: node.workspace_id, node_id: node.id, change_type: 'node_contract_patch', title: 'V1.1 审批', after: { allowed_tools: ['filesystem', 'git', 'mock_runner'] }, apply_action: { type: 'node_contract_patch' } } });
  assert.equal(proposal.status, 'pending');
  const rejected = await api(`/change-proposals/${proposal.id}/reject`, { method: 'POST', body: { reason: 'test reject' } });
  assert.equal(rejected.status, 'rejected');
  await api(`/change-proposals/${proposal.id}/apply`, { method: 'POST', body: {} }, 400);
  const proposal2 = await api('/change-proposals', { method: 'POST', body: { project_id: project.project.id, workspace_id: node.workspace_id, node_id: node.id, change_type: 'node_contract_patch', title: 'V1.1 审批 apply', after: { allowed_tools: ['filesystem', 'git', 'mock_runner'] }, apply_action: { type: 'node_contract_patch' } } });
  await api(`/change-proposals/${proposal2.id}/approve`, { method: 'POST', body: {} });
  const applied = await api(`/change-proposals/${proposal2.id}/apply`, { method: 'POST', body: {} });
  assert.equal(applied.proposal.status, 'applied');
  const review = await api('/review');
  assert.ok(review.change_proposals.length >= 2);
  assert.ok(review.agent_sessions.length >= 2);
  assert.ok(review.submissions.length >= 1);
  console.log('v1.1 integration tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(testHome, { recursive: true, force: true });
}

async function api(pathname, options = {}, expected = null) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'content-type': 'application/json' }, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json();
  if (expected === null) assert.ok(res.status >= 200 && res.status < 300, `${pathname}: ${JSON.stringify(data)}`);
  else assert.equal(res.status, expected, `${pathname}: ${JSON.stringify(data)}`);
  return data;
}
async function waitForServer(portNumber) {
  for (let i = 0; i < 80; i++) { try { await api('/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
}
