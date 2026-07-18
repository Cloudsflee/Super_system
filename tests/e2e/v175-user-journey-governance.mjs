import assert from 'node:assert/strict';

export async function governWorkflowAndContract(runtime, fixture) {
  const page = runtime.page;
  await page.goto(`${runtime.baseUrl}/projects/${fixture.projectId}/workflow`);
  const node = page.locator('.workspace-node').first();
  await node.waitFor(); await node.click();
  const inspector = page.locator('.node-inspector');
  await inspector.waitFor();
  const originalTitle = await inspector.getByRole('heading', { level: 2 }).textContent();
  await inspector.getByRole('button', { name: '更多节点操作' }).click();
  await page.getByRole('menuitem', { name: '编辑节点' }).click();
  await inspector.getByLabel('标题').fill(`${originalTitle} · 已审查`);
  await inspector.getByRole('textbox', { name: '目标', exact: true }).fill('经用户提案审批后形成可追溯目标');
  await inspector.getByRole('button', { name: '提交提案' }).click();
  await approvePrompt(page);
  await page.getByText(`${originalTitle} · 已审查`, { exact: true }).first().waitFor();

  const execution = fixture.bundle.nodes.find((item) => item.type === 'execution');
  assert.ok(execution, 'execution node missing');
  await page.goto(`${runtime.baseUrl}/projects/${fixture.projectId}/nodes/${execution.id}`);
  await page.locator('.execution-workspace').waitFor();
  await page.getByRole('button', { name: 'Contract' }).click();
  const before = await runtime.api(`/nodes/${execution.id}/workspace`);
  await page.getByLabel('节点目标').fill('在受管副本中完成实现、测试和可回滚交付');
  await page.getByLabel('验收标准').fill('受管文件可保存\n测试任务成功\n所有 Git 写入经过审批');
  const firstTool = page.locator('.tool-checks input[type="checkbox"]').first();
  if (await firstTool.count() && !await firstTool.isChecked()) await firstTool.check();
  await page.getByRole('button', { name: '提交变更提案' }).click();
  await approvePrompt(page);
  const after = await waitForWorkspace(runtime, execution.id, (value) => value.contract.version > before.contract.version);
  assert.equal(after.contract.node_goal, '在受管副本中完成实现、测试和可回滚交付');
  assert.deepEqual(after.contract.acceptance_criteria, ['受管文件可保存', '测试任务成功', '所有 Git 写入经过审批']);
}

export async function approvePrompt(page) {
  const prompt = page.locator('.approval-prompt');
  await prompt.waitFor({ timeout: 20_000 });
  await prompt.getByRole('button', { name: '批准并应用' }).click();
  await prompt.waitFor({ state: 'detached', timeout: 20_000 });
}

export async function waitForWorkspace(runtime, nodeId, predicate, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await runtime.api(`/nodes/${nodeId}/workspace`);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`node workspace did not reach expected state: ${nodeId}`);
}
