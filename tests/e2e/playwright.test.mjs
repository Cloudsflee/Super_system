import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConfirmedProject, repositorySnapshot } from '../integration/v13-test-helpers.mjs';
import {
  assertA11y,
  assertAssistHeader,
  assertCanvasBounds,
  assertInsideViewport,
  assertNoOverlap,
  assertViewport,
  browserDiscovery,
  browserExecutable,
  verifyShellOverlayStacking
} from './playwright-helpers.mjs';
import {
  captureBriefWorkspace,
  captureOperationDiagnostics,
  configureGithubAndDocker,
  prepareDraftBrief,
  seedV17AssistVisualState,
  verifyBriefPersistence
} from './v17-visual-helpers.mjs';
const port = Number(process.env.AIWS_TEST_PORT || 4592);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-browser-home-'));
const repo = path.join(home, 'repo');
const output = process.env.AIWS_TEST_REPORT_DIR
  ? path.resolve(process.env.AIWS_TEST_REPORT_DIR, 'e2e-v17')
  : path.resolve('.ai-workspace', 'e2e-v17');
const viewports = [
  { name: 'wide', width: 1728, height: 1117 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 }
];
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(repo, 'package.json'),
  JSON.stringify({
    scripts: {
      test: 'node --test',
      typecheck: 'node --check src/index.ts',
      lint: 'node --check src/index.ts',
      build: 'node --check src/index.ts'
    }
  })
);
fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const ready = true;\n');
spawnSync('git', ['init'], { cwd: repo });
spawnSync('git', ['config', 'user.email', 'browser@example.test'], { cwd: repo });
spawnSync('git', ['config', 'user.name', 'Browser Fixture'], { cwd: repo });
spawnSync('git', ['add', '.'], { cwd: repo });
spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });
const sourceBefore = repositorySnapshot(repo),
  server = spawn(process.execPath, ['apps/api/server.mjs'], {
    env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
let browser,
  actorId = '';
try {
  await waitForServer();
  actorId = (await api('/health')).local_owner.id;
  browser = await chromium.launch({ headless: true, ...browserExecutable() });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      extraHTTPHeaders: authenticatedHeaders()
    }),
    page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/projects`);
  await page.waitForURL('**/setup');
  await page.getByRole('heading', { name: '连接工作环境' }).waitFor();
  await assertA11y(page, 'setup');
  const trailingRoute = await page.request.get(`http://127.0.0.1:${port}/projects/`);
  assert.equal(trailingRoute.status(), 200, 'SPA routes with a trailing slash must refresh successfully');
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: path.join(output, `setup-${viewport.name}.png`), fullPage: true });
    await assertViewport(page);
  }
  await configureGithubAndDocker(api);
  await captureOperationDiagnostics(page, { output, viewports, assertViewport, assertInsideViewport });
  await page.route('**/api/codex/discovery', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(browserDiscovery()) })
  );
  await page.goto(`http://127.0.0.1:${port}/setup`);
  await page.getByRole('button', { name: 'cc-switch' }).click();
  await page.getByRole('radio', { name: /Browser Relay/ }).waitFor();
  await page.getByText('凭据已配置（内容隐藏）').waitFor();
  assert.equal(await page.getByText('stored', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '本地 Codex' }).click();
  await page.getByRole('radio', { name: /Local Gateway/ }).click();
  await page.getByLabel('导入配置所需的 API 密钥').waitFor();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: path.join(output, `setup-codex-discovery-${viewport.name}.png`), fullPage: true });
    await assertViewport(page);
  }
  await page.getByRole('button', { name: '手动 API' }).click();
  await page.getByRole('combobox', { name: '服务商' }).selectOption('custom');
  await page.getByRole('textbox', { name: 'API 根地址' }).waitFor();
  await page.getByRole('button', { name: 'cc-switch' }).waitFor();
  await page.getByText(/聊天接口需要独立的 cc-switch 本地代理/).waitFor();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: path.join(output, `setup-codex-third-party-${viewport.name}.png`), fullPage: true });
    await assertViewport(page);
  }
  const fixture = await configureWorkspace();
  const reopenedContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: authenticatedHeaders()
    }),
    reopened = await reopenedContext.newPage();
  await verifyBriefPersistence(reopened, `http://127.0.0.1:${port}`, fixture.onboardingProjectId);
  await reopenedContext.close();
  for (const viewport of viewports) await verifyWorkspaceViewport(page, fixture, viewport);
  assert.deepEqual(repositorySnapshot(repo), sourceBefore);
  assert.deepEqual(
    errors.filter((item) => !item.includes('favicon')),
    [],
    `browser errors:\n${errors.join('\n')}`
  );
  console.log(`Playwright V1.7 visual tests passed; screenshots: ${output}`);
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
async function configureWorkspace() {
  await api('/codex/auth/api-key', 'POST', { provider: 'openai', api_key: 'browser-api-key' });
  const profile = await api('/codex/profiles', 'POST', {
    name: 'Browser Profile',
    provider: 'openai',
    model: 'gpt-test',
    reasoning: 'high',
    mounts: []
  });
  await api('/codex/probe', 'POST', { adapter: 'test', profile_id: profile.id });
  await api('/setup/complete', 'POST', {});
  const draft = await api('/projects', 'POST', { title: '待引导工作空间', goal: '通过项目引导确认范围' });
  await prepareDraftBrief(api, draft.project.id);
  const project = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`,
    title: '发布工作空间',
    goal: '实现并验证可发布的桌面工作空间',
    source: repo,
    requestHeaders: authenticatedHeaders(),
    workflowNodes: [
      { type: 'goal_definition', title: '目标', dependency_indexes: [] },
      { type: 'research', title: '调研', dependency_indexes: [0] },
      { type: 'analysis', title: '分析', dependency_indexes: [1] },
      { type: 'execution', title: '执行', dependency_indexes: [2] },
      { type: 'retrospective', title: '复盘', dependency_indexes: [3] }
    ]
  });
  const bundle = await api(`/projects/${project.project.id}`);
  const assistNode = bundle.nodes.find((item) => item.role === 'workstream');
  assert.ok(assistNode, 'confirmed project exposes a Workstream Assist scope');
  const assistSession = await api('/assist/v3/sessions', 'POST', {
    project_id: project.project.id,
    scope_type: 'workstream',
    scope_id: assistNode.id,
    title: 'V1.9 Workstream Assist'
  });
  const assistSessionId = assistSession.id;
  const preview = await uploadAttachment(
    assistSessionId,
    'preview-v17.md',
    '# Preview heading\n\nSafe **Markdown** content.\n'
  );
  const visualTurn = await api(`/assist/v3/sessions/${assistSessionId}/turns`, 'POST', {
    adapter: 'test',
    project_id: project.project.id,
    scope_type: 'workstream',
    scope_id: assistNode.id,
    collaboration_mode: 'plan',
    content: 'Short V1.7 prompt',
    attachment_ids: [preview.id],
    test_response: {
      message:
        '## V1.7 visual reply\n\n已完成本轮审查：\n\n- Brief V2 区块可编辑\n- 工作流草稿已持久化\n\n| 检查 | 结果 |\n| --- | --- |\n| 模式分离 | 通过 |\n| 页面写入 | 受控 |\n\n> 下一步：确认简报并激活项目。',
      events: [{ type: 'usage', data: { input_tokens: 1000, output_tokens: 234, total_tokens: 1234 } }]
    }
  });
  await waitForTurn(visualTurn.id, 'completed');
  seedV17AssistVisualState({
    stateFile: path.join(home, 'data', 'state.json'),
    assistSessionId,
    visualTurnId: visualTurn.id
  });
  return {
    onboardingProjectId: draft.project.id,
    projectId: project.project.id,
    assistNodeId: assistNode.id,
    executionNodeId: bundle.nodes.find((item) => item.type === 'execution').id,
    previewTitle: preview.title
  };
}
async function verifyWorkspaceViewport(page, fixture, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`http://127.0.0.1:${port}/projects/${fixture.onboardingProjectId}/workflow`);
  await page.waitForURL(`**/projects/${fixture.onboardingProjectId}/onboarding`);
  await page.locator('.onboarding-page').waitFor();
  await captureBriefWorkspace(page, { output, viewport, assertViewport });
  if (viewport.name === 'desktop') await assertA11y(page, 'onboarding');
  await page.goto(`http://127.0.0.1:${port}/projects/${fixture.projectId}/workflow`);
  await page.locator('.workspace-node').first().waitFor();
  if (viewport.name === 'desktop') await assertA11y(page, 'workflow');
  if (await page.locator('.node-inspector').count()) {
    await page.keyboard.press('Escape');
    await page.locator('.node-inspector').waitFor({ state: 'detached' });
  }
  while (await page.getByRole('button', { name: '关闭通知' }).count())
    await page.getByRole('button', { name: '关闭通知' }).first().click();
  assert.equal(await page.locator('.workspace-node').count(), 5);
  await assertCanvasBounds(page);
  await page.screenshot({ path: path.join(output, `workflow-${viewport.name}.png`) });
  const canvasNode = page.locator(`.workspace-node[data-workflow-node-id="${fixture.assistNodeId}"]`);
  if (viewport.width > 700) {
    await canvasNode.hover();
    await page.screenshot({ path: path.join(output, `workflow-node-hover-${viewport.name}.png`) });
    await canvasNode.click({ button: 'right' });
  } else await canvasNode.getByRole('button', { name: '更多节点操作' }).click();
  const nodeMenu = page.getByRole('menu', { name: '上下文菜单' });
  await nodeMenu.waitFor();
  await assertInsideViewport(page, '.context-menu');
  assert.equal(await nodeMenu.getByRole('menuitem', { name: '让智能助手优化' }).count(), 1);
  await page.screenshot({ path: path.join(output, `workflow-node-menu-${viewport.name}.png`) });
  await page.keyboard.press('Escape');
  await canvasNode.click();
  await page.locator('.node-inspector').waitFor();
  await assertInsideViewport(page, '.node-inspector');
  await page.screenshot({ path: path.join(output, `workflow-inspector-${viewport.name}.png`) });
  await page.locator('.node-inspector').getByRole('button', { name: '更多节点操作' }).click();
  await page.getByRole('menuitem', { name: '移除节点' }).click();
  await page.locator('.approval-prompt').waitFor();
  await assertInsideViewport(page, '.approval-prompt');
  assert.equal(await page.locator('.node-inspector').count(), 1, '即时审批与 Inspector 可并存');
  await page.screenshot({ path: path.join(output, `workflow-approval-${viewport.name}.png`) });
  await page.keyboard.press('Escape');
  await page.locator('.approval-prompt').waitFor({ state: 'detached' });
  if (viewport.width <= 700) {
    await page.locator('.node-inspector').getByRole('button', { name: '更多节点操作' }).click();
    await page.getByRole('menuitem', { name: '让智能助手优化' }).click();
  } else await page.getByRole('button', { name: '打开 Codex 智能助手' }).click();
  await page.locator('.assist-workbench').waitFor();
  await page.locator('.assist-composer-v3').waitFor();
  if (viewport.name === 'desktop') await assertA11y(page, 'assist');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.node-inspector').count(), 0, 'Assist 展开时 Inspector 应收为 Peek');
  assert.equal(
    await page.locator('.inspector-peek').isVisible(),
    viewport.width > 700,
    'Inspector Peek 可见性应匹配单任务断点'
  );
  await assertInsideViewport(page, '.assist-workbench');
  await assertAssistHeader(page);
  if (viewport.width <= 700) {
    await page.waitForFunction(
      () => (document.querySelector('.assist-main')?.getBoundingClientRect().width || 0) >= window.innerWidth - 1
    );
    const main = await page.locator('.assist-main').boundingBox();
    assert.ok(
      main && main.width >= viewport.width - 1,
      `mobile Assist main is not full width: ${JSON.stringify(main)}`
    );
    await page.locator('.operation-notice.succeeded').first().waitFor();
    await assertNoOverlap(page, '.operation-notice.succeeded', '.assist-composer-v3');
  }
  await page.screenshot({ path: path.join(output, `workflow-assist-${viewport.name}.png`) });
  while (await page.getByRole('button', { name: '关闭通知' }).count())
    await page.getByRole('button', { name: '关闭通知' }).first().click();
  await verifyV17Assist(page, fixture, viewport);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.assist-workbench').count(), 0, 'Escape 应将 Assist 收回 Command Dock');
  assert.equal(
    await page.locator('.command-dock').isVisible(),
    viewport.width > 700,
    'Command Dock 可见性应避让移动端 Inspector'
  );
  assert.equal(await page.locator('.node-inspector').count(), 1, 'Inspector 状态应在 Assist 收起后恢复');
  await page.goto(`http://127.0.0.1:${port}/projects/${fixture.projectId}/nodes/${fixture.executionNodeId}`);
  await page.locator('.execution-workspace').waitFor();
  await page.locator('.file-list button').filter({ hasText: 'src' }).click();
  await page.locator('.file-list button').filter({ hasText: 'index.ts' }).click();
  await page.locator('.monaco-editor').waitFor({ timeout: 20000 });
  if (viewport.name === 'desktop') await assertA11y(page, 'execution');
  await assertInsideViewport(page, '.execution-workspace');
  await page.screenshot({ path: path.join(output, `execution-monaco-${viewport.name}.png`) });
  await verifyShellOverlayStacking(page);
  await assertViewport(page);
}
async function verifyV17Assist(page, fixture, viewport) {
  await page.getByText('Ship V1.7', { exact: true }).waitFor();
  await page.getByText('V1.7 visual reply', { exact: true }).waitFor();
  assert.equal(await page.getByText('42,000', { exact: true }).count(), 0, 'Goal usage stays out of the compact card');
  assert.equal(await page.locator('.turn-prompt .sr-only').textContent(), '用户消息');
  assert.equal(await page.locator('.turn-output .sr-only').textContent(), '助手回复');
  const timelineText = await page.locator('.turn-timeline').textContent();
  assert.doesNotMatch(
    timelineText || '',
    /completed|gpt-test|reasoning|Browser Profile/i,
    'history leaked runtime configuration or lifecycle state'
  );
  assert.equal(
    await page.locator('.assist-activity-ledger,.turn-configuration,.turn-usage').count(),
    0,
    'legacy Assist chrome must stay removed'
  );
  assert.equal(await page.getByText('实时事件已连接', { exact: true }).count(), 0, 'healthy stream stays quiet');
  const [goal, prompt, timeline] = await Promise.all([
    page.locator('.assist-goal-card').boundingBox(),
    page.locator('.turn-prompt').boundingBox(),
    page.locator('.turn-timeline').boundingBox()
  ]);
  assert.ok(goal && goal.height >= 35 && goal.height <= 44, `Goal card must stay compact: ${JSON.stringify(goal)}`);
  assert.ok(
    prompt && timeline && prompt.width < timeline.width * 0.9,
    `short prompt did not shrink: ${JSON.stringify({ prompt, timeline })}`
  );
  const question = page.locator('.native-input-card').first();
  await question.waitFor();
  assert.equal(await question.getByText('推荐', { exact: true }).count(), 1);
  assert.equal(await question.getByRole('textbox', { name: '范围确认 备注' }).count(), 1);
  await question.screenshot({ path: path.join(output, `assist-question-${viewport.name}.png`) });
  const receipt = page.locator('.operation-receipt').first();
  await receipt.waitFor();
  assert.doesNotMatch((await receipt.textContent()) || '', /aiws_project|workflow_graph_patch/);
  assert.equal(await receipt.getByRole('button', { name: '撤销' }).count(), 0);
  assert.equal(await receipt.getByRole('button', { name: '直接编辑' }).count(), 0);
  assert.equal(await receipt.getByRole('button', { name: '审查提案' }).count(), 1);
  assert.equal(await receipt.getByRole('link', { name: '定位工作流' }).count(), 1);
  const receiptBox = await receipt.boundingBox();
  assert.ok(receiptBox && receiptBox.width <= 522, `operation receipt too wide: ${JSON.stringify(receiptBox)}`);
  await receipt.screenshot({ path: path.join(output, `assist-operation-receipt-${viewport.name}.png`) });
  await page
    .locator('.turn-output')
    .filter({ hasText: 'V1.7 visual reply' })
    .screenshot({ path: path.join(output, `assist-reply-${viewport.name}.png`) });

  const layoutButton = page.getByRole('button', { name: '智能助手布局' });
  await layoutButton.click();
  const layoutMenu = page.getByRole('menu', { name: '智能助手布局' });
  await layoutMenu.waitFor();
  assert.equal(await layoutMenu.getByRole('menuitemradio').count(), 3);
  await assertInsideViewport(page, '.assist-layout-menu [role="menu"]');
  await page.keyboard.press('Escape');
  assert.equal(await layoutMenu.count(), 0, 'Escape should close only the Assist layout menu');
  assert.equal(await page.locator('.assist-workbench').count(), 1, 'closing a nested menu must keep Assist open');

  const composerHandle = page.getByRole('separator', { name: '调整输入区高度' });
  await composerHandle.hover();
  await page.waitForTimeout(150);
  assert.equal(await composerHandle.evaluate((element) => getComputedStyle(element, '::after').opacity), '1');
  await page.screenshot({ path: path.join(output, `assist-tooltip-composer-${viewport.name}.png`) });
  await composerHandle.focus();
  const before = Number(await composerHandle.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowDown');
  const after = Number(await composerHandle.getAttribute('aria-valuenow'));
  assert.ok(after < before && after >= 84, `composer keyboard resize failed: ${before} -> ${after}`);
  assert.ok(await page.evaluate(() => Number(localStorage.getItem('aiws-composer-height-v16')) >= 84));
  await composerHandle.dispatchEvent('dblclick');
  assert.equal(await page.evaluate(() => localStorage.getItem('aiws-composer-height-v16')), null);

  const input = page.getByRole('textbox', { name: '智能助手消息' });
  await input.focus();
  await page.keyboard.press('Shift+F10');
  const keyboardMenu = page.getByRole('menu', { name: '上下文菜单' });
  await keyboardMenu.waitFor();
  assert.equal(await keyboardMenu.getByRole('menuitem', { name: '粘贴' }).count(), 1);
  await page.keyboard.press('ArrowDown');
  await page.screenshot({ path: path.join(output, `assist-context-keyboard-${viewport.name}.png`) });
  await page.keyboard.press('Escape');
  assert.equal(
    await page.evaluate(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    false,
    'Shift+right-click must escape to the native menu'
  );

  const reply = page.locator('.turn-output h2').filter({ hasText: 'V1.7 visual reply' });
  await reply.evaluate((element) => {
    const range = document.createRange(),
      selection = window.getSelection();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await reply.click({ button: 'right' });
  const selectionMenu = page.getByRole('menu', { name: '上下文菜单' });
  await selectionMenu.getByRole('menuitem', { name: '询问智能助手' }).waitFor();
  await page.screenshot({ path: path.join(output, `assist-context-selection-${viewport.name}.png`) });
  await selectionMenu.getByRole('menuitem', { name: '询问智能助手' }).click();
  const btw = page.locator('.btw-popover[aria-label="问点什么"]');
  await btw.waitFor();
  await assertInsideViewport(page, '.btw-popover');
  assert.match(await btw.locator('blockquote').textContent(), /V1\.7 visual reply/);
  await page.screenshot({ path: path.join(output, `assist-btw-${viewport.name}.png`) });
  await btw.getByRole('button', { name: '关闭临时问答' }).click();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  assert.equal(
    await page.getByRole('button', { name: '查看本次回复用量' }).count(),
    0,
    'usage gauge must stay removed'
  );
  const runtimeDetails = page.locator('.turn-runtime-details').first();
  await runtimeDetails.waitFor();
  assert.equal(await runtimeDetails.getAttribute('open'), null, 'completed Turn details default to collapsed');
  await runtimeDetails.locator('summary').click();
  const usage = runtimeDetails.locator('[aria-label="令牌用量"]');
  await usage.waitFor();
  assert.match(await usage.textContent(), /输入\s*1,000.*输出\s*234.*总计\s*1,234/s);
  await page.screenshot({ path: path.join(output, `assist-runtime-details-${viewport.name}.png`) });
  await runtimeDetails.locator('summary').click();

  if (!(await page.getByText('已删除分支', { exact: true }).count()))
    await page.getByRole('button', { name: '显示线程列表' }).click();
  await page.getByText('已删除分支', { exact: true }).waitFor();
  const scopeSummaries = await page.locator('.thread-main .thread-scope').allTextContents();
  assert.ok(
    scopeSummaries.length > 0 && scopeSummaries.every((value) => /Workstream.*发布工作空间.*目标/.test(value)),
    `thread scope breadcrumb missing: ${JSON.stringify(scopeSummaries)}`
  );
  const threadSummaries = await page.locator('.thread-main > small:not(.thread-scope)').allTextContents();
  assert.ok(
    threadSummaries.length > 0 && threadSummaries.every((value) => /^\d+ 轮$|^尚无对话$/.test(value)),
    `thread summaries leaked state: ${JSON.stringify(threadSummaries)}`
  );
  await page.screenshot({ path: path.join(output, `assist-deleted-branch-${viewport.name}.png`) });
  await page.getByRole('button', { name: '隐藏线程列表' }).click();
  await page.getByRole('button', { name: fixture.previewTitle, exact: true }).click();
  const preview = page.getByRole('dialog', { name: `${fixture.previewTitle} 预览` });
  await preview.waitFor();
  await preview.getByRole('heading', { name: 'Preview heading' }).waitFor();
  await assertInsideViewport(page, '.attachment-preview-modal');
  await page.screenshot({ path: path.join(output, `assist-preview-${viewport.name}.png`) });
  await preview.getByRole('button', { name: '关闭预览' }).click();
  await assertViewport(page);
}
async function api(route, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...authenticatedHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(data)}`);
  return data;
}
async function uploadAttachment(sessionId, filename, content) {
  const form = new FormData();
  form.set('file', new Blob([content], { type: 'text/markdown' }), filename);
  const response = await fetch(`http://127.0.0.1:${port}/assist/v3/sessions/${sessionId}/attachments/upload`, {
    method: 'POST',
    headers: authenticatedHeaders(),
    body: form
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  return data;
}
function authenticatedHeaders() {
  return actorId ? { 'x-aiws-user-id': actorId, 'x-aiws-scopes': 'project:create' } : {};
}
async function waitForTurn(id, status) {
  for (let index = 0; index < 200; index++) {
    const turn = await api(`/assist/v3/turns/${id}`);
    if (turn.status === status) return turn;
    if (['completed', 'failed', 'stopped', 'interrupted'].includes(turn.status))
      throw new Error(`${id} reached ${turn.status}:${turn.error_code || ''}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${id} did not reach ${status}`);
}
async function waitForServer() {
  for (let index = 0; index < 100; index++) {
    try {
      await api('/health');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('server did not start');
}
