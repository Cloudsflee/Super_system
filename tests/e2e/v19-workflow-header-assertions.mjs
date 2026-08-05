import assert from 'node:assert/strict';

export async function assertWorkflowHeaderAndCoverage(page, viewport) {
  const shell = await page.evaluate(() => {
    const bar = document.querySelector('.app-bar')?.getBoundingClientRect(),
      execution = document.querySelector('.workflow-execution-band')?.getBoundingClientRect(),
      qualityPolicy = document.querySelector('.quality-review-policy')?.getBoundingClientRect();
    return {
      focus: document.querySelector('.app-shell')?.classList.contains('focus-mode'),
      legacyTitles: document.querySelectorAll('.workflow-viewbar,.workflow-view-title').length,
      breadcrumbs: document.querySelectorAll('.workflow-project-breadcrumb').length,
      portalToolbar: document.querySelectorAll('.route-toolbar-host > .workflow-route-toolbar').length,
      barBottom: bar?.bottom || 0,
      executionTop: execution?.top || 0,
      fixedTop: execution?.bottom || bar?.bottom || 0,
      qualityPolicyTop: qualityPolicy?.top || 0,
      qualityPolicyBottom: qualityPolicy?.bottom || 0,
      qualityPolicyHeight: qualityPolicy?.height || 0
    };
  });
  assert.equal(shell.focus, true, 'the Workflow fixture must exercise Focus mode');
  assert.equal(shell.legacyTitles, 0, 'the legacy Workflow title bar must not render');
  assert.equal(shell.breadcrumbs, 1, 'Workflow must expose exactly one project breadcrumb');
  assert.equal(shell.portalToolbar, 1, 'Workflow controls must portal into the App Bar host');
  assert.ok(
    Math.abs(shell.barBottom - shell.executionTop) <= 1,
    `the status band must follow the App Bar without overlap: ${JSON.stringify(shell)}`
  );
  if (shell.qualityPolicyHeight)
    assert.ok(
      shell.qualityPolicyTop >= shell.executionTop && shell.qualityPolicyBottom <= shell.fixedTop + 1,
      `Quality Review policy must remain inside the execution band: ${JSON.stringify(shell)}`
    );
  const fixedLimit = (viewport.width <= 390 ? 160 : 96) + shell.qualityPolicyHeight;
  assert.ok(shell.fixedTop <= fixedLimit, `fixed Workflow top exceeds ${fixedLimit}px: ${JSON.stringify(shell)}`);

  const process = page.locator('.workflow-full-process'),
    master = page.locator('.workflow-process-master'),
    summary = page.locator('.workflow-process-summary');
  assert.equal(
    await summary.evaluate((element) => element.parentElement?.classList.contains('workflow-process-master')),
    true,
    'stage coverage must be the first Master content block'
  );
  const summaryBox = await summary.boundingBox();
  assert.ok(
    summaryBox && summaryBox.height <= (viewport.width <= 600 ? 57 : 47),
    `stage coverage has an unexpected height: ${JSON.stringify(summaryBox)}`
  );
  const detailTask = await page
    .locator('.workflow-task-inspector')
    .getAttribute('data-detail-task-id')
    .catch(() => null);
  const originalStyle = await master.getAttribute('style');
  await master.evaluate((element) => {
    element.style.height = '180px';
  });
  await page.waitForTimeout(30);
  await master.evaluate((element) => {
    element.scrollTop = 80;
  });
  await page.waitForTimeout(30);
  const [scrolledSummary, masterBox] = await Promise.all([summary.boundingBox(), master.boundingBox()]);
  const scrollState = await master.evaluate((element) => ({
    top: element.scrollTop,
    client: element.clientHeight,
    scroll: element.scrollHeight
  }));
  assert.ok(
    scrolledSummary && masterBox && scrolledSummary.y + scrolledSummary.height <= masterBox.y + 1,
    `stage coverage must leave the viewport with Master scrolling: ${JSON.stringify({ scrolledSummary, masterBox, scrollState })}`
  );
  if (detailTask)
    assert.equal(
      await page.locator('.workflow-task-inspector').getAttribute('data-detail-task-id'),
      detailTask,
      'Master scrolling must not change the pinned detail'
    );
  await master.evaluate((element, style) => {
    element.scrollTop = 0;
    if (style == null) element.removeAttribute('style');
    else element.setAttribute('style', style);
  }, originalStyle);
  if ((await process.getAttribute('data-layout')) === 'master-detail') {
    const [bodyBox, detailBox] = await Promise.all([
      page.locator('.workflow-process-body').boundingBox(),
      page.locator('.workflow-task-inspector').boundingBox()
    ]);
    assert.ok(
      bodyBox && detailBox && Math.abs(bodyBox.y - detailBox.y) <= 1,
      'Task detail must start at the content top, independent of stage coverage'
    );
  }

  if (viewport.width <= 700) {
    const trigger = page.getByRole('button', { name: '更多工作流操作' });
    await trigger.click();
    const menu = page.getByRole('menu', { name: '更多工作流操作' });
    for (const label of ['操作与诊断', '审批队列', '退出专注模式'])
      assert.equal(await menu.getByRole('menuitem', { name: label }).count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0, 'Escape must close the mobile Workflow menu');
    assert.equal(
      await trigger.evaluate((element) => document.activeElement === element),
      true,
      'Escape must restore mobile menu focus'
    );
  }
}
