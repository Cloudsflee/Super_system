import assert from 'node:assert/strict';

const briefFields = [
  ['核心目标', '交付一套可恢复、可审计的本地 AI 工作空间'],
  ['目标用户', '本地项目负责人\n研发团队'],
  ['范围内功能', '项目引导\nAssist 协作\n工作流治理\nGit 交付'],
  ['范围外事项', '正式生产环境发布'],
  ['约束', '本地优先\n所有写操作可追溯'],
  ['里程碑', '完成引导\n完成工作流\n完成交付审查'],
  ['验收标准', '刷新后数据完整\n源仓库保持不变\n所有审批可审计'],
  ['风险', '服务重启\n外部依赖不可用'],
  ['开放问题', '后续如何扩展专用 GitHub 测试仓库']
];

export async function createAndActivateProject(runtime) {
  const page = runtime.page;
  await page.getByLabel('项目名称').fill('V1.75 真实用户旅程');
  await page.getByLabel('初始目标（可选）').fill('验证从 Setup 到 Git 交付的完整业务闭环');
  await page.getByRole('button', { name: '创建并开始引导' }).click();
  await page.waitForURL('**/projects/*/onboarding');
  const projectId = new URL(page.url()).pathname.split('/')[2];
  await page.getByRole('button', { name: /基于已有项目/ }).click();
  await page.getByRole('heading', { name: '描述项目并选择代码源' }).waitFor();

  for (const [label, value] of briefFields) await page.getByLabel(label).fill(value);
  await page.getByLabel('来源类型').selectOption('local_git');
  await page.getByLabel('本机绝对路径').fill(runtime.sourceRepo);
  await page.getByRole('button', { name: '添加上下文材料' }).click();
  await page.getByLabel('材料名称').fill('产品约束');
  await page.getByLabel('材料位置').fill('https://example.test/v175-requirements');
  await page.getByRole('button', { name: '添加上下文材料' }).click();
  await page.getByLabel('材料类型').nth(1).selectOption('text');
  await page.getByLabel('材料名称').nth(1).fill('用户访谈');
  await page.getByLabel('材料内容').fill('用户要求刷新、重启后仍能恢复工作，并保留完整审批证据。');
  await page.getByRole('button', { name: '保存并生成简报' }).click();
  await page.getByRole('heading', { name: '审查项目简报与初始工作流' }).waitFor();

  await ensureFiveNodeKinds(runtime, projectId);
  const saved = await runtime.api(`/projects/${projectId}/onboarding`);
  assertBrief(saved);
  assert.deepEqual(
    new Set(saved.workflow_draft.nodes.map((node) => node.type)),
    new Set(['goal_definition', 'research', 'analysis', 'execution', 'retrospective'])
  );
  await page.getByRole('button', { name: '开始导入' }).click();
  await page.getByText('受管代码副本已就绪').waitFor({ timeout: 30_000 });
  const confirm = page.getByRole('button', { name: '确认简报并激活项目' });
  await waitEnabled(confirm);
  await confirm.click();
  await page.waitForURL(`**/projects/${projectId}/workflow`);
  await page.locator('.workspace-node').first().waitFor();

  const bundle = await runtime.api(`/projects/${projectId}`);
  assert.equal(bundle.project.status, 'active');
  assert.equal(bundle.project.onboarding_state, 'confirmed');
  assert.equal(bundle.project.managed_workspace_state, 'ready');
  assert.equal(bundle.nodes.length, 5);
  return { projectId, bundle };
}

async function ensureFiveNodeKinds(runtime, projectId) {
  const page = runtime.page,
    expected = ['goal_definition', 'research', 'analysis', 'execution', 'retrospective'];
  let onboarding = await runtime.api(`/projects/${projectId}/onboarding`);
  for (const kind of expected.filter((value) => !onboarding.workflow_draft.nodes.some((node) => node.type === value))) {
    const count = await page.locator('.workflow-draft-node').count();
    await page.getByRole('button', { name: '添加工作流节点' }).click();
    await page.waitForFunction(
      (value) => document.querySelectorAll('.workflow-draft-node').length === value,
      count + 1
    );
    let node = page.locator('.workflow-draft-node').last();
    await patchWorkflow(page, () => node.locator('select').selectOption(kind));
    node = page.locator('.workflow-draft-node').last();
    const title = node.locator('header input');
    await title.fill(nodeTitle(kind));
    await patchWorkflow(page, () => title.press('Tab'));
    node = page.locator('.workflow-draft-node').last();
    const goal = node.locator('textarea').first();
    await goal.fill(`完成${nodeTitle(kind)}并形成可审查证据`);
    await patchWorkflow(page, () => goal.press('Tab'));
    onboarding = await runtime.api(`/projects/${projectId}/onboarding`);
  }
}

async function patchWorkflow(page, action) {
  const response = page.waitForResponse(
    (item) => item.url().includes('/workflow-draft') && item.request().method() === 'PATCH' && item.ok()
  );
  await action();
  await response;
}
async function waitEnabled(locator) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('control did not become enabled');
}
function nodeTitle(kind) {
  return {
    goal_definition: '目标定义',
    research: '用户调研',
    analysis: '方案分析',
    execution: '执行交付',
    retrospective: '复盘交付'
  }[kind];
}
function assertBrief(value) {
  const serialized = JSON.stringify(value);
  for (const expected of briefFields.map((item) => item[1].split('\n')).flat())
    assert.match(serialized, new RegExp(expected));
  assert.deepEqual(value.intake.context_sources, [
    { type: 'url', label: '产品约束', url: 'https://example.test/v175-requirements' },
    { type: 'text', label: '用户访谈', text: '用户要求刷新、重启后仍能恢复工作，并保留完整审批证据。' }
  ]);
}
