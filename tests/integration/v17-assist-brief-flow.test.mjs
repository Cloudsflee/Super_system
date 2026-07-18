import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v17-flow-'), port = 4617, baseUrl = `http://127.0.0.1:${port}`;
let server;

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const created = await api(port, '/projects', 'POST', { title: 'V1.7 Brief', goal: '验证 Brief V2 与工作流草稿' }, 201);
  assert.equal(created.brief.content.schema_version, 2);
  assert.equal(created.brief.content.sections.length, 9);
  assert.equal(created.workflow_draft.revision, 1);
  assert.equal(created.assist_session.clarification_policy, 'ask');
  const projectId = created.project.id, sessionId = created.assist_session.id;

  const initial = await api(port, `/projects/${projectId}/onboarding`);
  assert.equal(Array.isArray(initial.workflow_draft.nodes), true);
  const initialNodeIds = initial.workflow_draft.nodes.map((node) => node.id);
  await api(port, `/projects/${projectId}/intake`, 'PUT', { mode: 'brainstorm', answers: { goal: '验证 V1.7', features: ['Brief V2', 'WorkflowDraft'], acceptance_criteria: ['API 通过'] } });
  const afterIntake = await api(port, `/projects/${projectId}/onboarding`);
  assert.deepEqual(afterIntake.workflow_draft.nodes.map((node) => node.id), initialNodeIds, 'intake updates keep stable node ids');
  assert.equal(afterIntake.workflow_draft.revision, initial.workflow_draft.revision + 1, 'regenerated workflow invalidates stale revisions');
  assert.equal(afterIntake.workflow_draft.user_modified_at, null);
  await api(port, `/projects/${projectId}/workflow-draft`, 'PATCH', { expected_revision: initial.workflow_draft.revision, operations: [{ type: 'update_node', node_id: 'missing-stale-node', patch: { title: 'stale' } }] }, 409, 'workflow_draft_revision_conflict');

  const policy = await api(port, `/assist/v3/sessions/${sessionId}`, 'PATCH', { clarification_policy: 'auto_recommend' });
  assert.equal(policy.clarification_policy, 'auto_recommend');
  const inherited = await api(port, '/assist/v3/sessions', 'POST', { project_id: projectId, scope_type: 'project', scope_id: projectId, parent_session_id: sessionId, title: 'Inherited policy' }, 201);
  assert.equal(inherited.clarification_policy, 'auto_recommend');
  await api(port, `/assist/v3/sessions/${sessionId}`, 'PATCH', { clarification_policy: 'unknown' }, 400, 'assist_clarification_policy_invalid');

  const capabilitySurface = '&surface_id=project-onboarding&surface_revision=surface-r1';
  const defaultCatalog = await api(port, `/assist/v3/capabilities?project_id=${encodeURIComponent(projectId)}&route=${encodeURIComponent(`/projects/${projectId}/onboarding`)}&collaboration_mode=default${capabilitySurface}`);
  assert.equal(defaultCatalog.descriptors.length >= 15, true);
  assert.equal(defaultCatalog.current.find((item) => item.capability_id === 'project.brief.section.update').available, true);
  const forgedCatalog = await api(port, `/assist/v3/capabilities?project_id=${encodeURIComponent(projectId)}&route=${encodeURIComponent('/projects/another-project/onboarding')}&collaboration_mode=default${capabilitySurface}`);
  assert.equal(forgedCatalog.current.find((item) => item.capability_id === 'project.brief.section.update').reason, 'project_scope_mismatch');
  const planCatalog = await api(port, `/assist/v3/capabilities?project_id=${encodeURIComponent(projectId)}&route=${encodeURIComponent(`/projects/${projectId}/onboarding`)}&collaboration_mode=plan${capabilitySurface}`);
  assert.equal(planCatalog.current.filter((item) => item.available && planCatalog.descriptors.find((descriptor) => descriptor.id === item.capability_id)?.mutation).length, 0);

  const briefBefore = afterIntake.brief;
  const briefUpdated = await api(port, `/projects/${projectId}/briefs/${briefBefore.id}`, 'PATCH', { expected_revision: briefBefore.revision, operations: [{ type: 'add_section', section: { type: 'table', title: '验收矩阵', columns: ['项目', '状态'], rows: [['Schema', 'ready']] } }] });
  assert.equal(briefUpdated.revision, briefBefore.revision + 1);
  assert.equal(briefUpdated.content.sections.at(-1).type, 'table');
  await api(port, `/projects/${projectId}/briefs/${briefBefore.id}`, 'PATCH', { expected_revision: briefBefore.revision, operations: [{ type: 'set_title', title: 'stale' }] }, 409, 'project_brief_revision_conflict');

  const draftBefore = afterIntake.workflow_draft;
  const draftUpdated = await api(port, `/projects/${projectId}/workflow-draft`, 'PATCH', { expected_revision: draftBefore.revision, nodes: [{
    id: 'v17-outcome', role: 'workstream', title: 'V1.7 验收成果', outcome: '形成可验收的迁移与 UI 结果', category: 'deliverable',
    acceptance_criteria: ['迁移和 UI 检查通过'], boundary: { deliverable: 'V1.7 验收包' }, dependency_ids: [],
    tasks: [
      { id: 'v17-analysis', role: 'task', title: '分析迁移结果', task_kind: 'analysis', execution_mode: 'assist', dependency_ids: [] },
      { id: 'v17-review', role: 'task', title: '评审迁移和 UI', task_kind: 'review', execution_mode: 'assist', dependency_ids: ['v17-analysis'] }
    ]
  }] });
  assert.equal(draftUpdated.revision, draftBefore.revision + 1);
  assert.ok(draftUpdated.user_modified_at);
  assert.equal(draftUpdated.nodes.find((node) => node.id === 'v17-review').dependency_ids[0], 'v17-analysis');
  assert.deepEqual((await api(port, `/projects/${projectId}/workflow-draft`)).nodes.map((node) => node.id), draftUpdated.nodes.map((node) => node.id), 'refresh returns the persisted draft');
  await api(port, `/projects/${projectId}/workflow-draft`, 'PATCH', { expected_revision: draftUpdated.revision, operations: [{ type: 'delete_node', node_id: 'v17-analysis' }] }, 409, 'workflow_node_delete_confirmation_required');

  await api(port, '/brief-templates', 'POST', { title: 'Unconfirmed', sections: [] }, 409, 'brief_template_adoption_confirmation_required');
  const template = await api(port, '/brief-templates', 'POST', { confirmed: true, title: '权威产品简报', domain: 'product', publisher: 'Example Publisher', retrieved_at: '2026-07-01T00:00:00.000Z', applicability: '桌面应用', limitations: '不含部署审批', sources: ['https://example.com/brief-template'], sections: [{ semantic_key: 'goal', title: '核心目标', type: 'markdown', markdown: '模板目标' }, { title: '质量属性', type: 'list', items: ['可靠性'] }] }, 201);
  const listedTemplates = await api(port, '/brief-templates');
  assert.equal(listedTemplates.items.some((item) => item.id === template.id && item.publisher === 'Example Publisher'), true);
  const applied = await api(port, `/projects/${projectId}/briefs/${briefBefore.id}/apply-template`, 'POST', { template_id: template.id, expected_revision: briefUpdated.revision });
  assert.equal(applied.content.goal, briefUpdated.content.goal);
  assert.equal(applied.content.template_ref.template_id, template.id);
  assert.equal(applied.content.sections.some((section) => section.title === '质量属性'), true);

  const reference = await api(port, `/assist/v3/sessions/${sessionId}/attachments`, 'POST', { kind: 'url', url: 'https://example.com/requirements', title: '需求来源' }, 201);
  assert.equal(reference.url, 'https://example.com/requirements'); assert.equal(reference.model_policy, 'injectable');
  await api(port, `/assist/v3/sessions/${sessionId}/attachments`, 'POST', { kind: 'url', url: 'http://127.0.0.1/secret' }, 400, 'unsafe_attachment_url');

  await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', { expected_brief_revision: applied.revision - 1, expected_workflow_revision: draftUpdated.revision }, 409, 'project_brief_revision_conflict');
  await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', { expected_brief_revision: applied.revision }, 400, 'project_confirmation_revisions_required');
  const confirmed = await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', { expected_brief_revision: applied.revision, expected_workflow_revision: draftUpdated.revision, workflow_nodes: [{ id: 'forged-node', type: 'execution', title: '不得激活', goal: '绕过持久草稿', dependency_ids: [] }] });
  assert.equal(confirmed.project.status, 'active'); assert.equal(confirmed.nodes.length, draftUpdated.nodes.length);
  assert.equal(confirmed.nodes.some((node) => node.id === 'forged-node'), false);
  await api(port, `/projects/${projectId}/workflow-draft`, 'PATCH', { expected_revision: draftUpdated.revision, operations: [{ type: 'update_node', node_id: draftUpdated.nodes[0].id, patch: { title: '不得绕过提案' } }] }, 409, 'workflow_draft_activated');
  const activatedCatalog = await api(port, `/assist/v3/capabilities?project_id=${encodeURIComponent(projectId)}&route=${encodeURIComponent(`/projects/${projectId}/onboarding`)}&collaboration_mode=default${capabilitySurface}`);
  assert.equal(activatedCatalog.current.find((item) => item.capability_id === 'project.workflow_draft.node.update').reason, 'resource_unavailable');
  const nodeId = confirmed.nodes.find((item) => item.role === 'task').id, workspaceId = confirmed.project.current_workspace_id;
  const agentParent = await api(port, '/agent-sessions', 'POST', { project_id: projectId, scope_type: 'project', title: 'Lifecycle parent' }, 201);
  const agentChild = await api(port, '/agent-sessions', 'POST', { project_id: projectId, scope_type: 'node', scope_id: nodeId, parent_session_id: agentParent.id, title: 'Lifecycle child' }, 201);
  const legacySession = await api(port, '/assist/v2/sessions', 'POST', { project_id: projectId, scope_type: 'project' }, 201);
  const other = await api(port, '/projects', 'POST', { title: 'Parent scope isolation' }, 201);
  await api(port, '/assist/v2/sessions', 'POST', { project_id: other.project.id, scope_type: 'project', parent_session_id: legacySession.id }, 409, 'assist_parent_project_mismatch');
  const otherAgent = await api(port, '/agent-sessions', 'POST', { project_id: other.project.id, scope_type: 'project', title: 'Other project parent' }, 201);
  await api(port, '/agent-sessions', 'POST', { project_id: projectId, scope_type: 'node', scope_id: nodeId, parent_session_id: otherAgent.id }, 409, 'parent_agent_session_required');
  await api(port, '/agent-sessions', 'POST', { project_id: other.project.id, workspace_id: workspaceId, scope_type: 'project' }, 404, 'workspace_not_found');
  await api(port, `/agent-sessions/${otherAgent.id}/submissions`, 'POST', { summary: 'cross-project node must fail', node_id: nodeId, to_session_id: otherAgent.id }, 404, 'node_not_found');
  await api(port, '/change-proposals', 'POST', { project_id: other.project.id, workspace_id: workspaceId, change_type: 'record_only', apply_action: { type: 'record_only' } }, 404, 'workspace_not_found');
  await api(port, '/change-proposals', 'POST', { project_id: other.project.id, node_id: nodeId, change_type: 'record_only', apply_action: { type: 'record_only' } }, 404, 'node_not_found');
  const legacyProposal = await api(port, '/change-proposals', 'POST', { project_id: projectId, change_type: 'record_only', title: 'Lifecycle proposal', apply_action: { type: 'record_only' } }, 201);
  const lifecycleContext = await api(port, `/nodes/${nodeId}/context-pack/preview`, 'POST', {}, 201);
  await api(port, `/assist/v2/sessions/${legacySession.id}/messages`, 'POST', { adapter: 'test', content: 'hold lifecycle gate', test_response: { delay_ms: 300, message: 'done', actions: [] } }, 202);
  await api(port, `/projects/${projectId}/trash`, 'POST', {}, 423, 'project_in_use');
  await waitForLegacySession(legacySession.id, 'completed');

  await api(port, `/assist/v3/sessions/${sessionId}`, 'PATCH', { clarification_policy: 'ask' });
  const defaultTurn = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', { adapter: 'test', content: 'Default ask turn', collaboration_mode: 'default', test_response: { message: 'default complete' } }, 202);
  const defaultDone = await waitForTurn(defaultTurn.id);
  assert.equal(defaultDone.collaboration_mode, 'default'); assert.equal(defaultDone.code_access, 'workspace_write');
  const planTurn = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', { adapter: 'test', content: 'Plan ask turn', collaboration_mode: 'plan', test_response: { message: 'plan complete' } }, 202);
  const planDone = await waitForTurn(planTurn.id);
  assert.equal(planDone.collaboration_mode, 'plan'); assert.equal(planDone.code_access, 'read_only'); assert.equal(planDone.code_read_only_reason, 'plan_mode');
  await api(port, `/assist/v3/sessions/${sessionId}`, 'PATCH', { clarification_policy: 'auto_recommend' });
  const autoDefault = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', { adapter: 'test', content: 'Default auto turn', collaboration_mode: 'default', test_response: { message: 'auto default complete' } }, 202);
  assert.equal((await waitForTurn(autoDefault.id)).collaboration_mode, 'default');
  const autoPlan = await api(port, `/assist/v3/sessions/${sessionId}/turns`, 'POST', { adapter: 'test', content: 'Plan auto turn', collaboration_mode: 'plan', test_response: { message: 'auto plan complete', files: [{ path: 'PLAN-MUST-NOT-WRITE.txt', content: 'forbidden' }] } }, 202);
  const autoPlanDone = await waitForTurn(autoPlan.id);
  assert.equal(autoPlanDone.status, 'failed'); assert.equal(fs.existsSync(path.join(confirmed.project.repo_path, 'PLAN-MUST-NOT-WRITE.txt')), false);

  const sessionDetail = await api(port, `/assist/v3/sessions/${sessionId}`), batchId = sessionDetail.change_batch?.id;
  assert.ok(batchId, 'workspace-write turns create a persistent change batch');
  await restartWithLifecycleOperation({ id: 'plop-restart-audit', type: 'trash', started_at: new Date().toISOString() });
  await api(port, `/projects/${projectId}/onboarding`, 'GET', undefined, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/projects/${projectId}/workflow-draft`, 'GET', undefined, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/projects/${projectId}/intake`, 'PUT', { mode: 'brainstorm' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/projects/${projectId}/imports`, 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/projects/${projectId}/onboarding/confirm`, 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/projects/${projectId}/managed-workspace/migrate`, 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/projects/${projectId}/briefs/${briefBefore.id}`, 'PATCH', { expected_revision: applied.revision, operations: [{ type: 'set_title', title: 'blocked' }] }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/projects/${projectId}/workflow-draft`, 'PATCH', { expected_revision: draftUpdated.revision, operations: [{ type: 'update_node', node_id: draftUpdated.nodes[0].id, patch: { title: 'blocked' } }] }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/assist/v3/sessions/${sessionId}`, 'PATCH', { title: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  assert.equal((await api(port, `/assist/v3/sessions?project_id=${projectId}&deleted=include`)).length, 0);
  await api(port, `/assist/v3/sessions/${sessionId}/attachments`, 'POST', { kind: 'text', text: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/assist/v3/sessions/${sessionId}/goal`, 'PUT', { objective: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/projects/${projectId}/files/content`, 'PUT', { path: 'BLOCKED.txt', content: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/nodes/${nodeId}/workspace-data`, 'PUT', { data: { blocked: true } }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/nodes/${nodeId}/context-pack/preview`, 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/context-packs/${lifecycleContext.id}/confirm`, 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/workspaces/${workspaceId}/digests`, 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(port, '/agent-sessions', 'POST', { project_id: projectId, scope_type: 'project' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/agent-sessions/${agentChild.id}/submissions`, 'POST', { summary: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/nodes/${nodeId}/submissions`, 'POST', { summary: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, '/assist/v2/sessions', 'POST', { project_id: projectId, scope_type: 'project' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/assist/v2/sessions/${legacySession.id}/messages`, 'POST', { content: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, '/change-proposals', 'POST', { project_id: projectId, title: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/change-proposals/${legacyProposal.id}/approve`, 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/approvals/proposal/${legacyProposal.id}/decision`, 'POST', { decision: 'reject', revision: legacyProposal.revision, target_hash: legacyProposal.target_hash }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, '/asset-candidates/asset-lifecycle-blocked/reject', 'POST', {}, 423, 'project_lifecycle_operation_in_progress');
  await api(port, '/assist/v3/terminal-sessions', 'POST', { project_id: projectId, assist_session_id: sessionId, runtime: 'host_dev' }, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/assist/v3/turns/${defaultDone.id}/review`, 'GET', undefined, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/assist/v3/change-batches/${batchId}/review`, 'GET', undefined, 423, 'project_lifecycle_operation_in_progress');
  await api(port, `/assist/v3/change-batches/${batchId}/review/apply`, 'POST', { target_hash: 'blocked' }, 423, 'project_lifecycle_operation_in_progress');
  assert.equal(fs.existsSync(path.join(confirmed.project.repo_path, 'BLOCKED.txt')), false);
  await restartWithLifecycleOperation(null);

  const blockedOrigin = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://cross-origin.example' } });
  assert.equal(blockedOrigin.status, 403); assert.equal((await blockedOrigin.json()).error, 'local_origin_required');
  assert.equal(blockedOrigin.headers.get('access-control-allow-origin'), null);
  const localOrigin = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(localOrigin.status, 200); assert.equal(localOrigin.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const account = await api(port, '/account/me'); assert.equal(Object.hasOwn(account.session, 'session_token_hash'), false);
  const reviewState = await api(port, '/review'); assert.equal(Object.hasOwn(reviewState, 'codex_profiles'), false); assert.equal(Object.hasOwn(reviewState, 'integrations'), false);
  const malformed = await fetch(`${baseUrl}/projects/%E0%A4%A`); assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error, 'invalid_url_encoding');
  const health = await api(port, '/health'); assert.equal(health.schema_version, 18);
  console.log('V1.7 Assist, Brief, and Workflow integration tests passed');
} finally {
  await server?.stop(); cleanup(fixture.root);
}

async function waitForTurn(id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const turn = await api(port, `/assist/v3/turns/${id}`);
    if (['completed', 'failed', 'stopped', 'interrupted'].includes(turn.status)) return turn;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`turn_timeout:${id}`);
}

async function waitForLegacySession(id, status) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const session = await api(port, `/assist/v2/sessions/${id}`);
    if (session.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`legacy_session_timeout:${id}:${status}`);
}

async function restartWithLifecycleOperation(operation) {
  await server.stop();
  const stateFile = path.join(fixture.home, 'data', 'state.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const project = state.projects.find((item) => item.title === 'V1.7 Brief');
  if (!project) throw new Error('restart fixture project missing');
  project.lifecycle_operation = operation;
  if (operation && !state.assets.some((item) => item.id === 'asset-lifecycle-blocked')) state.assets.push({ id: 'asset-lifecycle-blocked', project_id: project.id, status: 'candidate', title: 'Lifecycle candidate', evidence_refs: ['fixture'], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
}
