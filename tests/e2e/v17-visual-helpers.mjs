import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function prepareDraftBrief(api, projectId) {
  const answers = {
    goal: '交付可验证的 V1.7 工作空间',
    users: ['本地项目负责人'],
    features: ['Assist 协作', 'Brief V2 编辑', '工作流草稿'],
    scope_in: ['Assist 协作', 'Brief V2 编辑', '工作流草稿'],
    scope_out: ['正式环境发布'],
    constraints: ['本地优先', '变更可撤销'],
    milestones: ['完成 V1.7 验收'],
    acceptance_criteria: ['桌面与移动端均无溢出'],
    risks: ['迁移失败时恢复 V1.6'],
    open_questions: ['正式模板来源']
  };
  await api(`/projects/${projectId}/intake`, 'PUT', { mode: 'brainstorm', answers });
  const persisted = await api(`/projects/${projectId}/onboarding`);
  for (const [key, value] of Object.entries(answers))
    assert.deepEqual(persisted.intake.answers[key], value, `${key} persisted through API`);
  assert.equal(persisted.workflow_draft.nodes.length, 0, 'failed generation keeps the workflow draft blank');
  return persisted;
}

export async function verifyBriefPersistence(page, baseUrl, projectId) {
  const response = await page.request.get(`${baseUrl}/projects/${projectId}/onboarding`),
    data = await response.json();
  assert.equal(response.status(), 200);
  for (const value of [
    '交付可验证的 V1.7 工作空间',
    '本地项目负责人',
    'Assist 协作',
    '正式环境发布',
    '本地优先',
    '完成 V1.7 验收',
    '桌面与移动端均无溢出',
    '迁移失败时恢复 V1.6',
    '正式模板来源'
  ])
    assert.match(JSON.stringify(data), new RegExp(value));
  await page.goto(`${baseUrl}/projects/${projectId}/onboarding`);
  await page.locator('.brief-workspace').waitFor();
  const text = await page.locator('.brief-workspace').textContent();
  for (const value of ['交付可验证的 V1.7 工作空间', '本地项目负责人', 'Assist 协作', '正式环境发布'])
    assert.match(text || '', new RegExp(value));
}

export async function configureGithubAndDocker(api) {
  await api('/setup/mode', 'PUT', { mode: 'byo' });
  await api('/github/app-config/validate', 'POST', {
    adapter: 'test',
    app_id: '101',
    client_id: 'Iv1.browser',
    client_secret: 'browser-client',
    private_key: 'browser-private',
    webhook_secret: 'browser-hook'
  });
  const device = await api('/github/device/start', 'POST', { adapter: 'test' });
  await api('/github/device/poll', 'POST', { adapter: 'test', request_id: device.request_id });
  await api('/github/installations/start', 'POST', { adapter: 'test' });
  await api('/github/installations/9001/repositories', 'PUT', { repository_ids: ['7001'] });
  await api('/codex/docker/build', 'POST', { adapter: 'test' });
}

export function seedV17AssistVisualState({ stateFile, assistSessionId, visualTurnId }) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    at = new Date(0).toISOString();
  const rootSession = state.assist_sessions.find((item) => item.id === assistSessionId);
  rootSession.native_goal_snapshot = {
    objective: 'Ship V1.7',
    status: 'active',
    tokenBudget: 99999,
    tokensUsed: 42000,
    timeUsedSeconds: 3600
  };
  state.assist_sessions.push({
    ...rootSession,
    id: 'asst_e2e_deleted_branch',
    title: 'Deleted visual branch',
    parent_session_id: assistSessionId,
    forked_from_session_id: assistSessionId,
    forked_from_turn_id: visualTurnId,
    codex_thread_id: null,
    pinned: false,
    lifecycle: 'deleted',
    delete_batch_id: 'adel_e2e_visual',
    deleted_at: at,
    purge_after: new Date(Date.now() + 86400000).toISOString()
  });
  state.runtime_user_inputs.push({
    id: 'rui_e2e_v17',
    session_id: assistSessionId,
    turn_id: visualTurnId,
    item_id: 'scope-question',
    status: 'pending',
    contains_secret: false,
    questions: [
      {
        id: 'scope',
        header: '范围确认',
        question: '采用哪个交付范围？',
        isOther: true,
        allow_note: true,
        options: [
          { label: '安全范围', description: '保留回滚路径并先完成可逆改动', recommended: true },
          { label: '完整范围', description: '一次完成所有候选改动', recommended: false }
        ]
      }
    ],
    created_at: at,
    updated_at: at
  });
  const workflow = state.workflows.find((item) => item.project_id === rootSession.project_id),
    proposalId = 'cpr_e2e_v17_workflow';
  state.change_proposals.push({
    id: proposalId,
    project_id: rootSession.project_id,
    workspace_id: workflow.workspace_id,
    node_id: null,
    workflow_id: workflow.id,
    change_type: 'workflow_graph_patch',
    title: '优化正式工作流',
    summary: '等待用户审查后应用',
    before_json: { workflow_id: workflow.id, revision: workflow.version },
    after_json: { workflow_id: workflow.id, revision: workflow.version + 1 },
    impact: ['工作流结构'],
    risks: [],
    evidence_refs: [],
    apply_action: { type: 'workflow_graph_patch', workflow_id: workflow.id },
    status: 'pending',
    attention_state: 'queued',
    revision: 1,
    target_hash: 'e2e-workflow-target',
    destructive: false,
    created_at: at,
    updated_at: at
  });
  state.assist_operations.push({
    id: 'aop_e2e_v17',
    session_id: assistSessionId,
    turn_id: visualTurnId,
    tool_call_id: 'call-e2e-v17',
    tool: 'aiws_project.workflow_graph_patch',
    execution_layer: 'server',
    project_id: rootSession.project_id,
    capability_id: 'project.workflow.graph.patch',
    action: 'patch',
    result_kind: 'change_proposal',
    proposal_id: proposalId,
    proposal_status: 'pending',
    route: `/projects/${rootSession.project_id}/workflow`,
    surface_id: `workflow-${workflow.id}`,
    surface_revision: `${workflow.id}:v${workflow.version}`,
    browser_instance_id: null,
    target_id: workflow.id,
    target_label: workflow.title,
    summary: `已创建工作流变更提案 · ${workflow.title}`,
    input_schema: { type: 'object' },
    locator: {
      route: `/projects/${rootSession.project_id}/workflow`,
      project_id: rootSession.project_id,
      surface_id: `workflow-${workflow.id}`,
      surface_revision: `${workflow.id}:v${workflow.version}`,
      target_id: workflow.id,
      target_label: workflow.title
    },
    requested_value: null,
    allowed_values: null,
    before_value: null,
    after_value: null,
    current_value: null,
    before_hash: 'before-e2e',
    after_hash: 'after-e2e',
    current_hash: 'before-e2e',
    status: 'committed',
    risk: 'low',
    revision: 2,
    inverse_of: null,
    forced: false,
    conflict: null,
    committed_at: at,
    created_at: at,
    updated_at: at
  });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export async function captureBriefWorkspace(page, { output, viewport, assertViewport }) {
  const workspace = page.locator('.brief-workspace');
  await workspace.waitFor();
  await assertViewport(page);
  assert.equal(await page.locator('.workflow-draft-node').count(), 0);
  assert.equal(await page.getByText(/0 个独立工作单元/).count(), 1);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.onboarding-stage')).opacity === '1');
  await page.screenshot({ path: path.join(output, `brief-editor-${viewport.name}.png`), fullPage: true });
  if (viewport.width > 620) {
    assert.equal(await page.getByRole('button', { name: '添加工作流节点' }).count(), 1);
    return;
  }
  const tabs = page.getByRole('navigation', { name: '简报工作区视图' });
  assert.equal(await tabs.getByRole('button').count(), 3);
  await tabs.getByRole('button', { name: '大纲' }).click();
  assert.equal(await page.locator('.brief-outline.mobile-active').count(), 1);
  await assertViewport(page);
  await page.screenshot({ path: path.join(output, 'brief-outline-mobile.png'), fullPage: true });
  await tabs.getByRole('button', { name: '工作流' }).click();
  assert.equal(await page.locator('.workflow-draft-panel.mobile-active').count(), 1);
  await page.getByText(/0 个独立工作单元/).waitFor();
  assert.equal(await page.getByRole('button', { name: '添加工作流节点' }).count(), 1);
  await assertViewport(page);
  await page.screenshot({ path: path.join(output, 'brief-workflow-mobile.png'), fullPage: true });
  await tabs.getByRole('button', { name: '简报' }).click();
  assert.equal(await page.locator('.brief-document.mobile-active').count(), 1);
}

export async function captureOperationDiagnostics(page, { output, viewports, assertViewport, assertInsideViewport }) {
  let mode = 'running';
  const setupPattern = '**/api/setup/status',
    activePattern = '**/api/codex/docker/builds/active',
    eventsPattern = '**/api/codex/docker/builds/*/events';
  await page.route(setupPattern, async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.complete = false;
    body.can_complete = false;
    body.steps.codex = {
      ...body.steps.codex,
      ready: false,
      status: 'runtime_required',
      detail: '等待 Codex 隔离镜像',
      checks: { ...(body.steps.codex.checks || {}), docker_ready: false, probe_ok: false }
    };
    if (!body.reasons.includes('Codex 尚未通过隔离运行探针')) body.reasons.push('Codex 尚未通过隔离运行探针');
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(activePattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ operation: visualBuild(mode) })
    })
  );
  await page.route(eventsPattern, (route) => route.abort('connectionrefused'));
  await page.goto(`http://127.0.0.1:${new URL(page.url()).port || 4592}/setup`);
  await page.locator('.codex-build-progress.running').waitFor();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await assertViewport(page);
    await page.screenshot({ path: path.join(output, `setup-codex-build-${viewport.name}.png`), fullPage: true });
  }
  mode = 'failed';
  await page.reload();
  await page.locator('.codex-build-progress.failed').waitFor();
  await page.getByRole('button', { name: '操作与诊断' }).click();
  await page.locator('.operation-panel.open').waitFor();
  await page.locator('.operation-summary').first().click();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await assertViewport(page);
    await assertInsideViewport(page, '.operation-panel.open');
    await page.screenshot({ path: path.join(output, `operation-diagnostics-${viewport.name}.png`), fullPage: true });
  }
  await page.evaluate(() => sessionStorage.removeItem('aiws-operation-diagnostics-v1'));
  await page.goto('about:blank');
  await page.unroute(setupPattern);
  await page.unroute(activePattern);
  await page.unroute(eventsPattern);
}

function visualBuild(mode) {
  const failed = mode === 'failed',
    now = new Date(0).toISOString();
  return {
    operation_id: 'cdxbuild_visual',
    image: 'aiws-codex-runner:1.7.0',
    status: failed ? 'failed' : 'running',
    phase: { key: failed ? 'building' : 'building', label: '构建镜像', index: 3, total: 5 },
    started_at: now,
    updated_at: now,
    completed_at: failed ? now : null,
    elapsed_ms: 42_000,
    error_code: failed ? 'docker_build_network_failed' : null,
    message: failed ? 'Docker Build 网络请求失败' : '正在安装 Codex Runner 依赖',
    action: failed ? '检查网络、DNS 和 Docker 代理配置后重试。' : null,
    retryable: failed,
    latest_log: failed ? 'ERROR failed to fetch package index' : '#12 installing runtime dependencies',
    logs: [
      { at: now, stream: 'stdout', text: '#11 loading build context' },
      {
        at: now,
        stream: failed ? 'stderr' : 'stdout',
        text: failed ? 'ERROR failed to fetch package index' : '#12 installing runtime dependencies'
      }
    ],
    last_event_id: 12
  };
}
