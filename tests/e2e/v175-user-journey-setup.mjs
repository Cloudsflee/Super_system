import assert from 'node:assert/strict';

export async function completeSetup(runtime) {
  const page = runtime.page;
  await page.goto(`${runtime.baseUrl}/projects`);
  await page.waitForURL('**/setup');
  await page.getByRole('heading', { name: '连接工作环境' }).waitFor();
  await page.getByRole('button', { name: '自有 GitHub App' }).click();
  await page.getByLabel('应用 ID').fill('17501');
  await page.getByLabel('客户端 ID').fill('Iv1.v175-journey');
  await page.getByLabel('客户端密钥').fill('journey-client-secret');
  await page.getByLabel('Webhook 密钥').fill('journey-webhook-secret');
  await page.getByLabel('私钥').fill('journey-private-key');
  await page.getByRole('button', { name: '验证并保存' }).click();
  await page.getByRole('button', { name: '连接 GitHub' }).waitFor();

  await page.getByRole('button', { name: '连接 GitHub' }).click();
  await page.getByRole('button', { name: '检查授权' }).waitFor();
  await page.getByRole('button', { name: '检查授权' }).click();
  await page.getByText('GitHub 所有者授权已完成。').waitFor();
  await page.getByRole('button', { name: '打开安装页' }).waitFor();
  await page.getByRole('button', { name: '打开安装页' }).click();
  const repository = page.locator('.repository-picker input[type="checkbox"]').first();
  await repository.waitFor();
  await repository.check();
  await page.getByRole('button', { name: '确认选择' }).click();
  await waitForSetup(runtime, (value) => value.steps.github.ready === true, 'GitHub setup did not become ready');

  await page.getByRole('button', { name: '检测并构建' }).waitFor();
  await page.getByRole('button', { name: '检测并构建' }).click();
  await waitForSetup(
    runtime,
    (value) => value.steps.codex.checks?.docker_ready === true,
    'Codex Docker build did not finish'
  );
  await page.getByRole('button', { name: '手动 API' }).click();
  await page.getByLabel('API 密钥').fill('journey-api-key');
  await page.getByRole('button', { name: '保存凭据与接口地址' }).click();
  const profile = page.getByRole('button', { name: '保存并校验配置' });
  await profile.waitFor();
  await profile.click();
  await page.getByRole('button', { name: '运行探针' }).waitFor();
  await page.getByRole('button', { name: '运行探针' }).click();
  const finish = page.getByRole('button', { name: '完成配置' });
  await finish.waitFor();
  await finish.click();
  await page.waitForURL('**/projects');

  const setup = await runtime.api('/setup/status');
  assert.equal(setup.complete, true);
  assert.equal(setup.steps.github.ready, true);
  assert.equal(setup.steps.codex.ready, true);
  assert.doesNotMatch(JSON.stringify(setup), /journey-(?:client-secret|private-key|webhook-secret|api-key)/);
  for (const popup of runtime.context.pages().filter((candidate) => candidate !== page)) await popup.close();
}

async function waitForSetup(runtime, predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await runtime.api('/setup/status');
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
