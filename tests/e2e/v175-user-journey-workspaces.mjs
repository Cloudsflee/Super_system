import assert from 'node:assert/strict';

export async function saveAllNodeWorkspaces(runtime, fixture) {
  const nodes = Object.fromEntries(fixture.bundle.nodes.map((item) => [item.type, item]));
  await saveGoal(runtime, fixture.projectId, nodes.goal_definition);
  await saveResearch(runtime, fixture.projectId, nodes.research);
  await saveAnalysis(runtime, fixture.projectId, nodes.analysis);
  await saveExecution(runtime, fixture.projectId, nodes.execution);
  await saveRetrospective(runtime, fixture.projectId, nodes.retrospective);
  for (const [kind, node] of Object.entries(nodes)) {
    if (kind === 'execution') continue;
    const workspace = await runtime.api(`/nodes/${node.id}/workspace`);
    assert.ok(Object.keys(workspace.data).length > 0, `${kind} workspace was not persisted`);
  }
  return nodes;
}

async function saveGoal(runtime, projectId, node) {
  assert.ok(node, 'goal node missing');
  const page = runtime.page;
  await openNode(runtime, projectId, node.id, '.structured-workspace');
  await page.getByLabel('目标范围').fill('验证 V1.75 全业务闭环和重启恢复');
  await page.getByLabel('成功标准').fill('全部用户步骤通过\n证据完整\n外部源不变');
  await page.getByLabel('待确认问题').fill('Live 凭据是否可用\n是否进入专用发布环境');
  await saveWorkspace(page, node.id);
}

async function saveResearch(runtime, projectId, node) {
  assert.ok(node, 'research node missing');
  const page = runtime.page;
  await openNode(runtime, projectId, node.id, '.research-workspace');
  await page.getByRole('button', { name: '来源', exact: true }).click();
  const row = page.locator('.source-row').first();
  await row.getByPlaceholder('标题').fill('V1.75 测试计划');
  await row.getByPlaceholder('URL / repo path').fill('测试计划v1.75.md');
  await row.locator('textarea').nth(0).fill('计划要求从 Setup 到恢复形成完整证据。');
  await row.locator('textarea').nth(1).fill('测试计划v1.75.md#核心业务链');
  await saveWorkspace(page, node.id);
}

async function saveAnalysis(runtime, projectId, node) {
  assert.ok(node, 'analysis node missing');
  const page = runtime.page;
  await openNode(runtime, projectId, node.id, '.analysis-workspace');
  await page.getByRole('button', { name: '添加方案' }).click();
  await page.locator('.option-line textarea').first().fill('采用隔离 AIWS_HOME 与受管 Git 副本');
  await page.getByLabel('决策').fill('选择可重复、可审计且不修改外部源的隔离方案');
  await page.getByLabel('风险').fill('浏览器中断\n服务重启\n审批过期');
  await saveWorkspace(page, node.id);
}

async function saveExecution(runtime, projectId, node) {
  assert.ok(node, 'execution node missing');
  const page = runtime.page;
  await openNode(runtime, projectId, node.id, '.execution-workspace');
  await page.locator('.file-list button').filter({ hasText: 'src' }).click();
  await page.locator('.file-list button').filter({ hasText: 'index.js' }).click();
  const editor = page.locator('.monaco-editor');
  await editor.waitFor({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText("export const journey = 'edited-through-monaco';\n");
  const save = page.getByRole('button', { name: '保存', exact: true });
  await waitEnabled(save);
  const saved = page.waitForResponse(
    (item) => item.url().includes('/files/content') && item.request().method() === 'PUT' && item.ok()
  );
  await save.click();
  await saved;
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await page
    .locator('.task-console pre')
    .getByText(/edited-through-monaco/)
    .waitFor();
  await page.getByRole('button', { name: '运行任务' }).click();
  await page
    .locator('.task-console pre')
    .getByText(/\[succeeded\]/)
    .waitFor({ timeout: 30_000 });
  const file = await runtime.api(`/projects/${projectId}/files/content?path=src%2Findex.js`);
  assert.match(file.content, /edited-through-monaco/);
}

async function saveRetrospective(runtime, projectId, node) {
  assert.ok(node, 'retrospective node missing');
  const page = runtime.page;
  await openNode(runtime, projectId, node.id, '.review-workspace');
  await page.getByLabel('复盘摘要').fill('真实用户旅程已完成引导、治理、执行和持久化验证。');
  await page.getByLabel('下一步').fill('完成 Git 交付\n确认资产\n检查审计与恢复');
  await saveWorkspace(page, node.id);
}

async function openNode(runtime, projectId, nodeId, selector) {
  await runtime.page.goto(`${runtime.baseUrl}/projects/${projectId}/nodes/${nodeId}`);
  await runtime.page.locator(selector).waitFor({ timeout: 20_000 });
}
async function saveWorkspace(page, nodeId) {
  const response = page.waitForResponse(
    (item) => item.url().includes(`/nodes/${nodeId}/workspace-data`) && item.request().method() === 'PUT' && item.ok()
  );
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await response;
}
async function waitEnabled(locator) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('control did not become enabled');
}
