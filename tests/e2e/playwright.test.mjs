import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConfirmedProject, repositorySnapshot } from '../integration/v13-test-helpers.mjs';

const port = 4592;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-browser-home-'));
const repo = path.join(home, 'repo');
const output = path.resolve('.ai-workspace', 'e2e-v16');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 }
];
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'node --check src/index.ts', lint: 'node --check src/index.ts', build: 'node --check src/index.ts' } }));
fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const ready = true;\n');
spawnSync('git', ['init'], { cwd: repo });
spawnSync('git', ['config', 'user.email', 'browser@example.test'], { cwd: repo });
spawnSync('git', ['config', 'user.name', 'Browser Fixture'], { cwd: repo });
spawnSync('git', ['add', '.'], { cwd: repo });
spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });
const sourceBefore = repositorySnapshot(repo);
const server = spawn(process.execPath, ['apps/api/server.mjs'], { env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, ...browserExecutable() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`http://127.0.0.1:${port}/projects`);
  await page.waitForURL('**/setup');
  await page.getByRole('heading', { name: '连接工作环境' }).waitFor();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: path.join(output, `setup-${viewport.name}.png`), fullPage: true });
    await assertViewport(page);
  }
  await configureGithubAndDocker();
  await page.route('**/api/codex/discovery', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(browserDiscovery()) }));
  await page.goto(`http://127.0.0.1:${port}/setup`);
  await page.getByRole('button', { name: 'cc-switch' }).click();
  await page.getByRole('radio', { name: /Browser Relay/ }).waitFor();
  await page.getByText('凭据已配置（内容隐藏）').waitFor();
  assert.equal(await page.getByText('stored', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '本地 Codex' }).click();
  await page.getByRole('radio', { name: /Local Gateway/ }).click();
  await page.getByLabel('Discovery API Key').waitFor();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: path.join(output, `setup-codex-discovery-${viewport.name}.png`), fullPage: true });
    await assertViewport(page);
  }
  await page.getByRole('button', { name: '手动 API' }).click();
  await page.getByRole('combobox', { name: 'Provider' }).selectOption('custom');
  await page.getByRole('textbox', { name: 'API Base URL' }).waitFor();
  await page.getByRole('button', { name: 'cc-switch' }).waitFor();
  await page.getByText(/Chat 需独立 cc-switch local proxy/).waitFor();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: path.join(output, `setup-codex-third-party-${viewport.name}.png`), fullPage: true });
    await assertViewport(page);
  }
  const fixture = await configureWorkspace();
  for (const viewport of viewports) await verifyWorkspaceViewport(page, fixture, viewport);
  assert.deepEqual(repositorySnapshot(repo), sourceBefore);
  assert.deepEqual(errors.filter((item) => !item.includes('favicon')), [], `browser errors:\n${errors.join('\n')}`);
  console.log(`Playwright V1.6 visual tests passed; screenshots: ${output}`);
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(home, { recursive: true, force: true });
}

async function configureWorkspace() {
  await api('/codex/auth/api-key', 'POST', { provider: 'openai', api_key: 'browser-api-key' });
  const profile = await api('/codex/profiles', 'POST', { name: 'Browser Profile', provider: 'openai', model: 'gpt-test', reasoning: 'high', mounts: [] });
  await api('/codex/probe', 'POST', { adapter: 'test', profile_id: profile.id });
  await api('/setup/complete', 'POST', {});
  const draft = await api('/projects', 'POST', { title: '待引导工作空间', goal: '通过项目引导确认范围' });
  const project = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`,
    title: '发布工作空间', goal: '实现并验证可发布的桌面工作空间', source: repo,
    workflowNodes: [
      { type: 'goal_definition', title: '目标', dependency_indexes: [] },
      { type: 'research', title: '调研', dependency_indexes: [0] },
      { type: 'analysis', title: '分析', dependency_indexes: [1] },
      { type: 'execution', title: '执行', dependency_indexes: [2] },
      { type: 'retrospective', title: '复盘', dependency_indexes: [3] }
    ]
  });
  const assistSessionId = project.draft.assist_session.id;
  const preview = await uploadAttachment(assistSessionId, 'preview-v16.md', '# Preview heading\n\nSafe **Markdown** content.\n');
  const visualTurn = await api(`/assist/v3/sessions/${assistSessionId}/turns`, 'POST', {
    adapter: 'test', collaboration_mode: 'plan', content: 'Short V1.6 prompt', attachment_ids: [preview.id],
    test_response: { message: 'V1.6 visual reply', events: [{ type: 'usage', data: { input_tokens: 1000, output_tokens: 234, total_tokens: 1234 } }] }
  });
  await waitForTurn(visualTurn.id, 'completed');
  const stateFile = path.join(home, 'data', 'state.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const rootSession = state.assist_sessions.find((item) => item.id === assistSessionId);
  rootSession.native_goal_snapshot = { objective: 'Ship V1.6', status: 'active', tokenBudget: 99999, tokensUsed: 42000, timeUsedSeconds: 3600 };
  state.assist_sessions.push({ ...rootSession, id: 'asst_e2e_deleted_branch', title: 'Deleted visual branch', parent_session_id: assistSessionId, forked_from_session_id: assistSessionId, forked_from_turn_id: visualTurn.id, codex_thread_id: null, pinned: false, lifecycle: 'deleted', delete_batch_id: 'adel_e2e_visual', deleted_at: new Date(0).toISOString(), purge_after: new Date(Date.now() + 86400000).toISOString() });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const bundle = await api(`/projects/${project.project.id}`);
  return { onboardingProjectId: draft.project.id, projectId: project.project.id, executionNodeId: bundle.nodes.find((item) => item.type === 'execution').id, previewTitle: preview.title };
}
async function configureGithubAndDocker() {
  await api('/setup/mode', 'PUT', { mode: 'byo' });
  await api('/github/app-config/validate', 'POST', { adapter: 'test', app_id: '101', client_id: 'Iv1.browser', client_secret: 'browser-client', private_key: 'browser-private', webhook_secret: 'browser-hook' });
  const device = await api('/github/device/start', 'POST', { adapter: 'test' });
  await api('/github/device/poll', 'POST', { adapter: 'test', request_id: device.request_id });
  await api('/github/installations/start', 'POST', { adapter: 'test' });
  await api('/github/installations/9001/repositories', 'PUT', { repository_ids: ['7001'] });
  await api('/codex/docker/build', 'POST', { adapter: 'test' });
}
function browserDiscovery() {
  return { updated_at: new Date(0).toISOString(), sources: [
    { source_id: 'browser-cc', type: 'cc_switch', display_name: 'cc-switch local providers', status: 'available', path_hint: '~/.cc-switch/cc-switch.db', revision: 'browser-revision-cc', providers: [{ discovery_id: 'browser-cc-provider', source_revision: 'browser-revision-cc', name: 'Browser Relay', provider: 'browser-relay', base_url: 'https://relay.browser.test/v1', model: 'browser/codex', wire_api: 'responses', has_credential: true, credential_hint: 'stored', importable: true }] },
    { source_id: 'browser-home', type: 'codex_home', display_name: 'Local ~/.codex', status: 'available', path_hint: '~/.codex/config.toml', revision: 'browser-revision-home', providers: [{ discovery_id: 'browser-home-provider', source_revision: 'browser-revision-home', name: 'Local Gateway', provider: 'local-gateway', base_url: 'http://127.0.0.1:8080/v1', model: 'local/codex', wire_api: 'responses', has_credential: false, credential_hint: 'required', importable: true }] }
  ] };
}
async function verifyWorkspaceViewport(page, fixture, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`http://127.0.0.1:${port}/projects/${fixture.onboardingProjectId}/workflow`);
  await page.waitForURL(`**/projects/${fixture.onboardingProjectId}/onboarding`);
  await page.locator('.onboarding-page').waitFor();
  await assertInsideViewport(page, '.onboarding-page');
  await page.screenshot({ path: path.join(output, `workflow-empty-onboarding-${viewport.name}.png`), fullPage: true });

  await page.goto(`http://127.0.0.1:${port}/projects/${fixture.projectId}/workflow`);
  await page.locator('.workspace-node').first().waitFor();
  assert.equal(await page.locator('.workspace-node').count(), 5);
  await assertCanvasBounds(page);
  await page.screenshot({ path: path.join(output, `workflow-${viewport.name}.png`) });
  await page.locator('.workspace-node').first().click();
  await page.locator('.node-inspector').waitFor();
  await assertInsideViewport(page, '.node-inspector');
  await page.screenshot({ path: path.join(output, `workflow-inspector-${viewport.name}.png`) });
  await page.getByRole('button', { name: '移除' }).click();
  await page.locator('.approval-prompt').waitFor();
  await assertInsideViewport(page, '.approval-prompt');
  assert.equal(await page.locator('.node-inspector').count(), 1, '即时审批与 Inspector 可并存');
  await page.screenshot({ path: path.join(output, `workflow-approval-${viewport.name}.png`) });
  await page.keyboard.press('Escape');
  await page.locator('.approval-prompt').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '打开 Codex Assist' }).click();
  await page.locator('.assist-workbench').waitFor();
  await page.locator('.assist-composer-v3').waitFor();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.node-inspector').count(), 1, 'V1.3 Assist 与 Inspector 可并存');
  await assertInsideViewport(page, '.assist-workbench');
  if (viewport.width <= 700) {
    await page.waitForFunction(() => (document.querySelector('.assist-main')?.getBoundingClientRect().width || 0) >= window.innerWidth - 1);
    const main = await page.locator('.assist-main').boundingBox();
    assert.ok(main && main.width >= viewport.width - 1, `mobile Assist main is not full width: ${JSON.stringify(main)}`);
    await page.locator('.toast').waitFor();
    await assertNoOverlap(page, '.toast', '.assist-composer-v3');
  }
  await page.screenshot({ path: path.join(output, `workflow-assist-${viewport.name}.png`) });
  while (await page.getByRole('button', { name: '关闭通知' }).count()) await page.getByRole('button', { name: '关闭通知' }).first().click();
  await verifyV16Assist(page, fixture, viewport);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.assist-workbench').count(), 1, 'docked Assist 不因 Escape 丢失线程');

  await page.goto(`http://127.0.0.1:${port}/projects/${fixture.projectId}/nodes/${fixture.executionNodeId}`);
  await page.locator('.execution-workspace').waitFor();
  await page.locator('.file-list button').filter({ hasText: 'src' }).click();
  await page.locator('.file-list button').filter({ hasText: 'index.ts' }).click();
  await page.locator('.monaco-editor').waitFor({ timeout: 20000 });
  await assertInsideViewport(page, '.execution-workspace');
  await page.screenshot({ path: path.join(output, `execution-monaco-${viewport.name}.png`) });
  await assertViewport(page);
}
async function verifyV16Assist(page, fixture, viewport) {
  await page.getByText('Ship V1.6', { exact: true }).waitFor();
  await page.getByText('V1.6 visual reply', { exact: true }).waitFor();
  assert.equal(await page.getByText('42,000', { exact: true }).count(), 0, 'Goal usage stays out of the compact card');
  assert.equal(await page.locator('.turn-prompt .sr-only').textContent(), '用户消息');
  assert.equal(await page.locator('.turn-output .sr-only').textContent(), '助手回复');
  const [prompt, timeline] = await Promise.all([page.locator('.turn-prompt').boundingBox(), page.locator('.turn-timeline').boundingBox()]);
  assert.ok(prompt && timeline && prompt.width < timeline.width * 0.9, `short prompt did not shrink: ${JSON.stringify({ prompt, timeline })}`);

  const composerHandle = page.getByRole('separator', { name: '调整输入区高度' });
  await composerHandle.hover(); await page.waitForTimeout(150);
  assert.equal(await composerHandle.evaluate((element) => getComputedStyle(element, '::after').opacity), '1');
  await page.screenshot({ path: path.join(output, `assist-tooltip-composer-${viewport.name}.png`) });
  await composerHandle.focus();
  const before = Number(await composerHandle.getAttribute('aria-valuenow')); await page.keyboard.press('ArrowDown');
  const after = Number(await composerHandle.getAttribute('aria-valuenow')); assert.ok(after < before && after >= 84, `composer keyboard resize failed: ${before} -> ${after}`);
  assert.ok(await page.evaluate(() => Number(localStorage.getItem('aiws-composer-height-v16')) >= 84));
  await composerHandle.dispatchEvent('dblclick'); assert.equal(await page.evaluate(() => localStorage.getItem('aiws-composer-height-v16')), null);

  const input = page.getByRole('textbox', { name: 'Assist 消息' }); await input.focus(); await page.keyboard.press('Shift+F10');
  const keyboardMenu = page.getByRole('menu', { name: '上下文菜单' }); await keyboardMenu.waitFor();
  assert.equal(await keyboardMenu.getByRole('menuitem', { name: '粘贴' }).count(), 1); await page.keyboard.press('ArrowDown');
  await page.screenshot({ path: path.join(output, `assist-context-keyboard-${viewport.name}.png`) }); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => { const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true }); document.body.dispatchEvent(event); return event.defaultPrevented; }), false, 'Shift+right-click must escape to the native menu');

  const reply = page.locator('.turn-output p').filter({ hasText: 'V1.6 visual reply' });
  await reply.evaluate((element) => { const range = document.createRange(), selection = window.getSelection(); range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range); });
  await reply.click({ button: 'right' }); const selectionMenu = page.getByRole('menu', { name: '上下文菜单' });
  await selectionMenu.getByRole('menuitem', { name: 'Ask' }).waitFor();
  await page.screenshot({ path: path.join(output, `assist-context-selection-${viewport.name}.png`) });
  await selectionMenu.getByRole('menuitem', { name: 'Ask' }).click();
  const btw = page.locator('.btw-popover[aria-label="问点什么"]'); await btw.waitFor(); await assertInsideViewport(page, '.btw-popover');
  assert.match(await btw.locator('blockquote').textContent(), /V1\.6 visual reply/);
  await page.screenshot({ path: path.join(output, `assist-btw-${viewport.name}.png`) }); await btw.getByRole('button', { name: '关闭临时问答' }).click();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const gauge = page.getByRole('button', { name: '查看本次回复用量' }); await gauge.click();
  const usage = page.getByRole('dialog', { name: '本次回复用量' }); await usage.waitFor(); assert.match(await usage.textContent(), /总计1,234/);
  await page.screenshot({ path: path.join(output, `assist-usage-${viewport.name}.png`) }); await usage.getByRole('button', { name: '关闭用量' }).click();

  if (!await page.getByText('已删除分支', { exact: true }).count()) await page.getByRole('button', { name: '显示线程列表' }).click();
  await page.getByText('已删除分支', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `assist-deleted-branch-${viewport.name}.png`) });
  if (viewport.width <= 700) await page.getByRole('button', { name: '隐藏线程列表' }).click();

  await page.getByRole('button', { name: fixture.previewTitle, exact: true }).click();
  const preview = page.getByRole('dialog', { name: `${fixture.previewTitle} 预览` }); await preview.waitFor();
  await preview.getByRole('heading', { name: 'Preview heading' }).waitFor(); await assertInsideViewport(page, '.attachment-preview-modal');
  await page.screenshot({ path: path.join(output, `assist-preview-${viewport.name}.png`) }); await preview.getByRole('button', { name: '关闭预览' }).click();
  await assertViewport(page);
}
async function api(route, method = 'GET', body) { const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); assert.ok(response.ok, `${route}: ${JSON.stringify(data)}`); return data; }
async function uploadAttachment(sessionId, filename, content) { const form = new FormData(); form.set('file', new Blob([content], { type: 'text/markdown' }), filename); const response = await fetch(`http://127.0.0.1:${port}/assist/v3/sessions/${sessionId}/attachments/upload`, { method: 'POST', body: form }); const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data)); return data; }
async function waitForTurn(id, status) { for (let index = 0; index < 200; index++) { const turn = await api(`/assist/v3/turns/${id}`); if (turn.status === status) return turn; if (['completed', 'failed', 'stopped', 'interrupted'].includes(turn.status)) throw new Error(`${id} reached ${turn.status}:${turn.error_code || ''}`); await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error(`${id} did not reach ${status}`); }
async function waitForServer() { for (let index = 0; index < 100; index++) { try { await api('/health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } } throw new Error('server did not start'); }
async function assertViewport(page) { const sizes = await page.evaluate(() => { const rows = [...document.querySelectorAll('body *')].filter((element) => getComputedStyle(element).display !== 'none' && !element.closest('.monaco-editor,.react-flow__viewport') && !element.matches('.monaco-aria-container,.monaco-alert,.monaco-status,.react-flow__viewport')).map((element) => ({ element: `${element.tagName.toLowerCase()}.${element.getAttribute('class') || ''}`, rect: element.getBoundingClientRect().toJSON() })); return { scrollHeight: document.documentElement.scrollHeight, height: window.innerHeight, offenders: rows.filter((item) => item.rect.right > window.innerWidth + 1 || item.rect.left < -1).slice(0, 12) }; }); assert.deepEqual(sizes.offenders, [], `elements outside viewport: ${JSON.stringify(sizes.offenders)}`); assert.ok(sizes.scrollHeight >= sizes.height, 'document is rendered'); }
async function assertCanvasBounds(page) { await assertViewport(page); const [bar, toolbar] = await Promise.all([page.locator('.app-bar').boundingBox(), page.locator('.canvas-toolbar').boundingBox()]); assert.ok(bar && toolbar && toolbar.y >= bar.y + bar.height, `canvas toolbar overlaps app bar: ${JSON.stringify({ bar, toolbar })}`); await assertInsideViewport(page, '.canvas-toolbar'); }
async function assertInsideViewport(page, selector) { const box = await page.locator(selector).boundingBox(); const size = page.viewportSize(); assert.ok(box && size && box.x >= -1 && box.y >= -1 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `${selector} outside viewport: ${JSON.stringify({ box, size })}`); }
async function assertNoOverlap(page, firstSelector, secondSelector) { const [first, second] = await Promise.all([page.locator(firstSelector).first().boundingBox(), page.locator(secondSelector).first().boundingBox()]); assert.ok(first && second && (first.x + first.width <= second.x || second.x + second.width <= first.x || first.y + first.height <= second.y || second.y + second.height <= first.y), `${firstSelector} overlaps ${secondSelector}: ${JSON.stringify({ first, second })}`); }
function browserExecutable() {
  if (fs.existsSync(chromium.executablePath())) return {};
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const executablePath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  return executablePath ? { executablePath } : {};
}
