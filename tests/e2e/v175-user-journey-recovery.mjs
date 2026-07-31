import assert from 'node:assert/strict';

export async function verifyBrowserAndServiceRecovery(runtime, fixture, nodes, assist, delivery) {
  await runtime.reopenBrowserContext();
  let page = runtime.page;
  await page.goto(`${runtime.baseUrl}/projects/${fixture.projectId}/workflow`);
  await page.locator('.workspace-node').first().waitFor();
  assert.equal(await page.locator('.workspace-node').count(), 5);
  await assertWorkspaceUi(runtime, fixture.projectId, nodes);
  await page.goto(`${runtime.baseUrl}/projects/${fixture.projectId}/workflow`);
  await page.getByRole('button', { name: '打开 Codex Assist' }).click();
  await page.getByText('已写入真实用户旅程结果文件', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByText('完成 V1.75 全业务用户旅程', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'journey-requirements.md', exact: true }).waitFor();

  await page.goto('about:blank');
  await runtime.restartServer();
  page = runtime.page;
  await page.goto(`${runtime.baseUrl}/projects/${fixture.projectId}/workflow`);
  await page.locator('.workspace-node').first().waitFor();
  assert.equal(await page.locator('.workspace-node').count(), 5);

  const health = await runtime.api('/health');
  assert.equal(health.version, '2.2.0');
  assert.equal(health.schema_version, 22);
  const setup = await runtime.api('/setup/status');
  assert.equal(setup.complete, true);
  const onboarding = await runtime.api(`/projects/${fixture.projectId}/onboarding`);
  assert.equal(onboarding.project.status, 'active');
  assert.equal(onboarding.intake.context_sources.length, 2);
  const bundle = await runtime.api(`/projects/${fixture.projectId}`);
  assert.equal(bundle.nodes.length, 5);
  assert.ok(bundle.nodes.some((item) => item.title.endsWith('· 已审查')));

  const execution = await runtime.api(`/nodes/${nodes.execution.id}/workspace`);
  assert.equal(execution.contract.node_goal, '在受管副本中完成实现、测试和可回滚交付');
  const retrospective = await runtime.api(`/nodes/${nodes.retrospective.id}/workspace`);
  assert.ok(retrospective.runs.some((item) => item.id === delivery.runId && item.status === 'succeeded'));
  assert.ok(
    retrospective.code_changes.some(
      (item) => item.run_id === delivery.runId && ['draft', 'pr_created'].includes(item.status)
    )
  );
  assert.equal(retrospective.assets.find((item) => item.id === delivery.assetId).status, 'confirmed');

  const session = await runtime.api(`/assist/v3/sessions/${assist.sessionId}`);
  assert.ok(session.turns.some((item) => item.status === 'completed'));
  assert.ok(session.attachments.some((item) => item.title === 'journey-requirements.md'));
  const goal = await runtime.api(`/assist/v3/sessions/${assist.sessionId}/goal`);
  assert.equal(goal.goal.objective, '完成 V1.75 全业务用户旅程');
}

async function assertWorkspaceUi(runtime, projectId, nodes) {
  const page = runtime.page;
  await page.goto(`${runtime.baseUrl}/projects/${projectId}/nodes/${nodes.goal_definition.id}`);
  await waitForValue(page.getByLabel('目标范围'), '验证 V1.75 全业务闭环和重启恢复');
  await page.goto(`${runtime.baseUrl}/projects/${projectId}/nodes/${nodes.research.id}`);
  await waitForValue(page.getByLabel('来源 1 标题'), 'V1.75 测试计划');
  await page.goto(`${runtime.baseUrl}/projects/${projectId}/nodes/${nodes.analysis.id}`);
  await waitForValue(page.getByLabel('决策'), '选择可重复、可审计且不修改外部源的隔离方案');
  await page.goto(`${runtime.baseUrl}/projects/${projectId}/nodes/${nodes.retrospective.id}`);
  await waitForValue(page.getByLabel('复盘摘要'), '真实用户旅程已完成引导、治理、执行和持久化验证。');
}

async function waitForValue(locator, expected) {
  await locator.waitFor({ timeout: 20_000 });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await locator.inputValue()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await locator.inputValue(), expected);
}
