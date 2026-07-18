import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4573);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-hierarchy-home-'));
const child = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test', AIWS_BYPASS_SETUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await waitForServer();
try {
  const project = await createConfirmedProject({ baseUrl: `http://127.0.0.1:${port}`, title: 'Hierarchy Project', goal: '验证层级会话与审批', workflowNodes: [{ type: 'research', title: '调研节点', goal: '收集证据' }] });
  let bundle = await api(`/projects/${project.project.id}`);
  const workstream = bundle.nodes.find((item) => item.role === 'workstream');
  const node = bundle.nodes.find((item) => item.role === 'task' && item.parent_node_id === workstream.id);
  const top = await api('/agent-sessions', { method: 'POST', body: { project_id: project.project.id, scope_type: 'project', scope_id: project.project.id, title: 'Top Codex' } });
  const childSession = await api('/agent-sessions', { method: 'POST', body: { project_id: project.project.id, workspace_id: node.workspace_id, scope_type: 'node', scope_id: node.id, parent_session_id: top.id, title: 'Node Codex' } });
  assert.equal(childSession.parent_session_id, top.id);
  const submission = await api(`/agent-sessions/${childSession.id}/submissions`, { method: 'POST', body: { title: '节点提交', summary: '完成摘要', node_id: node.id, evidence_refs: ['trace:hierarchy'] } });
  const directSubmission = await api(`/nodes/${node.id}/submissions`, { method: 'POST', body: { title: '界面提交', summary: '从复盘工作区提交顶层', evidence_refs: ['trace:workspace'] } });
  assert.ok(directSubmission.to_session_id);
  const nodeUpdate = await api(`/workflows/${project.workflow.id}/graph-proposals`, { method: 'POST', body: {
    parent_node_id: workstream.id, expected_revision: workstream.plan_revision,
    operations: [{ type: 'update_node', node_id: node.id, patch: { task_kind: 'code', execution_mode: 'codex', title: '执行任务', goal: '实现调研结论' } }]
  } });
  await api(`/change-proposals/${nodeUpdate.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${nodeUpdate.id}/apply`, { method: 'POST', body: {} });
  const updatedWorkspace = await api(`/nodes/${node.id}/workspace`);
  assert.equal(updatedWorkspace.contract.version, 2);
  assert.ok(updatedWorkspace.contract.allowed_tools.includes('codex_runner'));
  bundle = await api(`/projects/${project.project.id}`);
  const nextGraph = await api(`/workflows/${project.workflow.id}/graph-proposals`, { method: 'POST', body: {
    parent_node_id: workstream.id, expected_revision: bundle.nodes.find((item) => item.id === workstream.id).plan_revision,
    operations: [{ type: 'add_node', node: { id: 'analysis-task', role: 'task', task_kind: 'analysis', execution_mode: 'assist', title: '分析任务', goal: '消费调研提交', dependency_ids: [] } }]
  } });
  await api(`/change-proposals/${nextGraph.id}/approve`, { method: 'POST', body: {} });
  await api(`/change-proposals/${nextGraph.id}/apply`, { method: 'POST', body: {} });
  const nextNode = (await api(`/projects/${project.project.id}`)).nodes.find((item) => item.id === 'analysis-task');
  const context = await api(`/nodes/${nextNode.id}/context-pack/preview`, { method: 'POST', body: {} });
  assert.ok(context.content_json.submissions.some((item) => item.id === submission.id));
  assert.ok(context.content_json.submissions.some((item) => item.id === directSubmission.id));
  const rejectedProposal = await api('/change-proposals', { method: 'POST', body: { project_id: project.project.id, node_id: node.id, change_type: 'node_contract_patch', title: '拒绝变更', after: { allowed_tools: ['filesystem'] }, apply_action: { type: 'node_contract_patch' } } });
  const rejected = await api(`/change-proposals/${rejectedProposal.id}/reject`, { method: 'POST', body: { reason: '保持当前工具集' } });
  assert.equal(rejected.status, 'rejected');
  const approvedProposal = await api('/change-proposals', { method: 'POST', body: { project_id: project.project.id, node_id: node.id, change_type: 'node_contract_patch', title: '批准变更', after: { allowed_tools: ['filesystem', 'git', 'assist'] }, apply_action: { type: 'node_contract_patch' } } });
  await api(`/change-proposals/${approvedProposal.id}/approve`, { method: 'POST', body: {} });
  const applied = await api(`/change-proposals/${approvedProposal.id}/apply`, { method: 'POST', body: {} });
  assert.equal(applied.proposal.status, 'applied');
  console.log('hierarchy and proposal integration tests passed');
} finally { child.kill(); await new Promise((resolve) => setTimeout(resolve, 200)); fs.rmSync(home, { recursive: true, force: true }); }

async function api(pathname, options = {}) { const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'content-type': 'application/json' }, ...options, body: options.body ? JSON.stringify(options.body) : undefined }); const data = await response.json(); assert.ok(response.ok, `${pathname}: ${JSON.stringify(data)}`); return data; }
async function waitForServer() { for (let index = 0; index < 80; index++) { try { await api('/health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } throw new Error('server did not start'); }
