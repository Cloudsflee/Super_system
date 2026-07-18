import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function exerciseAssistLifecycle(runtime, fixture) {
  const page = runtime.page;
  await installTestResponses(page);
  await page.goto(`${runtime.baseUrl}/projects/${fixture.projectId}/workflow`);
  await page.getByRole('button', { name: '打开 Codex Assist' }).click();
  await page.locator('.assist-workbench').waitFor();
  const bootstrap = page.getByRole('button', { name: '创建线程后添加附件' });
  if (await bootstrap.count()) await bootstrap.click();
  await page.locator('.assist-composer-v3').waitFor();

  const attachment = path.join(runtime.root, 'journey-requirements.md');
  fs.writeFileSync(attachment, '# Journey requirements\n\nPersist every user action.\n');
  await page.getByLabel('选择附件').setInputFiles(attachment);
  await page.getByRole('button', { name: 'journey-requirements.md', exact: true }).waitFor();
  await send(page, '请审查附件并写入真实用户旅程结果文件', '已写入真实用户旅程结果文件');

  await page.getByRole('button', { name: '设置线程 Goal' }).click();
  await page.getByLabel('Objective').fill('完成 V1.75 全业务用户旅程');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('完成 V1.75 全业务用户旅程', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Review batch' }).click();
  const review = page.locator('.diff-review-panel');
  await review.waitFor({ timeout: 20_000 });
  await review.getByRole('button', { name: 'Mark viewed' }).click();
  await review.getByRole('button', { name: 'Viewed' }).waitFor();
  const apply = review.getByRole('button', { name: '安全应用' });
  await waitEnabled(apply); await apply.click();
  await page.locator('.assist-composer-v3').waitFor();
  const applied = await runtime.api(`/projects/${fixture.projectId}/files/content?path=journey-assist.txt`);
  assert.match(applied.content, /applied through Assist review/);

  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await send(page, 'Plan：列出重启恢复和资源清理步骤', '计划回合已完成');
  await sendAndStop(page);
  await retryStoppedTurn(page);
  await steerRunningTurn(page);
  await closeOpenBatch(page);

  const sessions = await runtime.api(`/assist/v3/sessions?project_id=${fixture.projectId}`);
  const session = sessions.find((item) => !item.deleted_at);
  assert.ok(session, 'Assist session missing');
  const detail = await waitForSessionIdle(runtime, session.id);
  assert.ok(detail.turns.some((turn) => turn.collaboration_mode === 'plan' && turn.status === 'completed'));
  assert.ok(detail.turns.some((turn) => turn.status === 'stopped'));
  assert.ok(detail.turns.some((turn) => turn.status === 'interrupted'));
  assert.ok(detail.attachments.some((item) => item.title === 'journey-requirements.md'));
  return { sessionId: session.id };
}

async function installTestResponses(page) {
  await page.route('**/api/assist/v3/sessions/*/turns', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}'), content = String(body.content || '');
    let testResponse = { message: '真实用户旅程回合已完成', delay_ms: 30 };
    if (content.includes('写入')) testResponse = { message: '已写入真实用户旅程结果文件', delay_ms: 30, files: [{ path: 'journey-assist.txt', content: 'applied through Assist review\n' }] };
    else if (content.includes('Plan')) testResponse = { message: '计划回合已完成', delay_ms: 30, events: [{ type: 'plan', data: { text: '1. 重启服务\n2. 验证状态\n3. 清理资源', status: 'completed' } }] };
    else if (content.includes('停止')) testResponse = { message: '该回合应被用户停止', delay_ms: 1_500 };
    else if (content.includes('steer')) testResponse = { message: '原始慢速回合', delay_ms: 1_500 };
    await route.continue({ postData: JSON.stringify({ ...body, test_response: testResponse }) });
  });
  await page.route('**/api/assist/v3/sessions/*/follow-ups', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.continue({ postData: JSON.stringify({ ...body, test_response: { message: 'Steer 已完成', delay_ms: 30 } }) });
  });
  await page.route('**/api/assist/v3/turns/*/retry', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.continue({ postData: JSON.stringify({ ...body, test_response: { message: '停止回合重试已完成', delay_ms: 30 } }) });
  });
}

async function send(page, prompt, expected) {
  const composer = page.locator('.assist-composer-v3');
  await composer.getByRole('textbox', { name: 'Assist 消息' }).fill(prompt);
  await composer.getByRole('button', { name: '发送' }).click();
  await page.getByText(expected, { exact: true }).waitFor({ timeout: 20_000 });
}
async function sendAndStop(page) {
  const composer = page.locator('.assist-composer-v3');
  await composer.getByRole('textbox', { name: 'Assist 消息' }).fill('启动一个需要用户停止的慢速回合');
  await composer.getByRole('button', { name: '发送' }).click();
  const stop = composer.getByRole('button', { name: 'Stop' });
  await stop.waitFor(); await stop.click();
  await page.getByRole('button', { name: 'Retry' }).last().waitFor({ timeout: 20_000 });
}
async function retryStoppedTurn(page) { await page.getByRole('button', { name: 'Retry' }).last().click(); await page.getByText('停止回合重试已完成', { exact: true }).waitFor({ timeout: 20_000 }); }
async function steerRunningTurn(page) {
  const composer = page.locator('.assist-composer-v3');
  await composer.getByRole('textbox', { name: 'Assist 消息' }).fill('启动可 steer 的慢速回合');
  await composer.getByRole('button', { name: '发送' }).click();
  const behavior = composer.getByLabel('Follow-up 行为');
  await behavior.waitFor(); await behavior.selectOption('steer');
  await composer.getByRole('textbox', { name: 'Assist 消息' }).fill('立即调整方向并完成');
  await composer.getByRole('button', { name: 'Steer', exact: true }).click();
  await page.getByText('Steer 已完成', { exact: true }).waitFor({ timeout: 20_000 });
}
async function closeOpenBatch(page) {
  const reviewButton = page.getByRole('button', { name: 'Review batch' }).last();
  await reviewButton.waitFor({ timeout: 20_000 }); await reviewButton.click();
  const review = page.locator('.diff-review-panel'); await review.waitFor();
  await review.getByRole('button', { name: '放弃 Turn' }).click();
  await page.locator('.assist-composer-v3').waitFor();
}
async function waitForSessionIdle(runtime, sessionId) { for (let attempt = 0; attempt < 200; attempt++) { const value = await runtime.api(`/assist/v3/sessions/${sessionId}`); if (!value.turns.some((turn) => ['queued', 'preparing', 'running', 'stopping'].includes(turn.status))) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('Assist session did not become idle'); }
async function waitEnabled(locator) { for (let attempt = 0; attempt < 100; attempt++) { if (await locator.isEnabled()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error('control did not become enabled'); }
