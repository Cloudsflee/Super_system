import assert from 'node:assert/strict';
import { approvePrompt, waitForWorkspace } from './v175-user-journey-governance.mjs';

export async function runDeliveryAndInspect(runtime, fixture, nodes) {
  const page = runtime.page,
    node = nodes.retrospective;
  await page.goto(`${runtime.baseUrl}/projects/${fixture.projectId}/nodes/${node.id}`);
  await page.locator('.review-workspace').waitFor();
  await page.getByRole('button', { name: '运行节点' }).click();
  await approvePrompt(page);
  let workspace = await waitForWorkspace(runtime, node.id, (value) =>
    value.runs.some((run) => run.status === 'succeeded')
  );
  const run = workspace.runs.find((item) => item.status === 'succeeded');
  assert.ok(run, 'successful retrospective NodeRun missing');
  await page.reload();
  await page.locator('.review-workspace').waitFor();

  await clickAndWait(page, page.getByRole('button', { name: '生成 Digest' }), '/digests');
  await clickAndWait(page, page.getByRole('button', { name: '提交顶层' }), '/submissions');
  await clickAndWait(page, page.getByRole('button', { name: '分支', exact: true }), `/runs/${run.id}/git/branch`);
  await clickAndWait(page, page.getByRole('button', { name: 'Diff', exact: true }), `/runs/${run.id}/git/diff`);
  const commit = page.getByRole('button', { name: 'Commit', exact: true });
  await waitEnabled(commit);
  await commit.click();
  await approvePrompt(page);
  workspace = await waitForWorkspace(runtime, node.id, (value) =>
    value.code_changes.some((item) => item.run_id === run.id && item.status === 'committed')
  );
  assert.equal(workspace.code_changes.find((item) => item.run_id === run.id).status, 'committed');

  const draftPr = page.getByRole('button', { name: 'Draft PR', exact: true });
  await waitEnabled(draftPr);
  await draftPr.click();
  await approvePrompt(page);
  workspace = await waitForWorkspace(runtime, node.id, (value) =>
    value.code_changes.some((item) => item.run_id === run.id && ['draft', 'pr_created'].includes(item.status))
  );
  assert.ok(['draft', 'pr_created'].includes(workspace.code_changes.find((item) => item.run_id === run.id).status));

  const candidate = workspace.assets.find((item) => item.status === 'candidate');
  assert.ok(candidate, 'NodeRun asset candidate missing');
  await navigate(page, '资产');
  await page.getByRole('heading', { name: '资产' }).waitFor();
  await page.getByRole('button', { name: `确认 ${candidate.title}` }).click();
  await page.getByText('confirmed', { exact: true }).waitFor();
  const assets = await runtime.api(`/assets?project_id=${fixture.projectId}`);
  assert.equal(assets.find((item) => item.id === candidate.id).status, 'confirmed');

  await navigate(page, '审计');
  await page.getByRole('heading', { name: '审计' }).waitFor();
  assert.ok((await page.locator('.audit-traces article').count()) > 0, 'audit trace list is empty');
  assert.ok((await page.locator('.audit-page aside button').count()) > 0, 'audit proposal list is empty');
  await navigate(page, '设置');
  await page.getByRole('heading', { name: '设置' }).waitFor();
  await page.getByText('配置完成', { exact: true }).waitFor();
  const settingsText = await page.locator('.settings-page, .data-page').first().textContent();
  assert.doesNotMatch(settingsText || '', /journey-(?:client-secret|private-key|webhook-secret|api-key)/);
  return { runId: run.id, assetId: candidate.id };
}

async function clickAndWait(page, button, path) {
  await waitEnabled(button);
  const response = page.waitForResponse(
    (item) => item.url().includes(path) && item.request().method() === 'POST' && item.ok()
  );
  await button.click();
  await response;
}
async function navigate(page, name) {
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('link', { name, exact: true }).click();
}
async function waitEnabled(locator) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('control did not become enabled');
}
