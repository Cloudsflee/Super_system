import assert from 'node:assert/strict';
import path from 'node:path';

export async function assertWorkflowContextViews(page, scope, fixture, output, viewport) {
  const context = scope.locator('.workflow-task-context');
  const summaryButton = context.getByRole('button', { name: '摘要' });
  const sourceButton = context.getByRole('button', { name: '原文' });
  const summaryRegion = context.getByRole('region', { name: 'Collect release evidence 上下文摘要' });
  await summaryRegion.waitFor();
  assert.equal(await summaryButton.getAttribute('aria-pressed'), 'true', 'Task context must default to its summary');
  assert.equal(await sourceButton.getAttribute('aria-pressed'), 'false');
  assert.equal(await summaryRegion.locator('dl > div').count(), 5, 'summary must expose five structured fields');
  await summaryRegion.getByText('关键要点', { exact: true }).waitFor();
  await summaryRegion.getByLabel('命令行：node src/cli.mjs collect --date 2026-07-23').waitFor();
  await summaryRegion.getByText('23:50', { exact: true }).waitFor();
  await summaryRegion.getByText('Asia/Shanghai', { exact: true }).waitFor();
  const summarySize = await summaryRegion.locator('dl').evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  assert.ok(
    summarySize.clientHeight <= Math.min(320, viewport.height * 0.42) + 2,
    `summary exceeded its height budget: ${JSON.stringify(summarySize)}`
  );
  assert.ok(
    summarySize.scrollWidth <= summarySize.clientWidth + 1,
    `summary has horizontal overflow: ${JSON.stringify(summarySize)}`
  );
  await context.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `workflow-context-summary-${viewport.name}.png`) });

  await sourceButton.click();
  const sourceRegion = context.getByRole('region', { name: 'Collect release evidence 上下文原文' });
  await sourceRegion.waitFor();
  assert.equal(await sourceButton.getAttribute('aria-pressed'), 'true');
  const source = sourceRegion.locator('pre');
  assert.equal(await source.textContent(), fixture.taskGoal, 'source view must preserve the complete context verbatim');
  const sourceSize = await source.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth
  }));
  assert.ok(
    sourceSize.clientHeight <= Math.min(280, viewport.height * 0.38) + 2,
    `source exceeded its height budget: ${JSON.stringify(sourceSize)}`
  );
  assert.ok(sourceSize.scrollHeight > sourceSize.clientHeight, 'long source must scroll inside its own region');
  assert.ok(
    sourceSize.scrollWidth <= sourceSize.clientWidth + 1,
    `source has horizontal overflow: ${JSON.stringify(sourceSize)}`
  );
  const [contextBox, dependencyBox] = await Promise.all([
    context.boundingBox(),
    scope.locator('.workflow-task-dependencies').boundingBox()
  ]);
  assert.ok(
    contextBox && dependencyBox && contextBox.y + contextBox.height <= dependencyBox.y + 1,
    `context overlaps the following section: ${JSON.stringify({ contextBox, dependencyBox })}`
  );
  await page.screenshot({ path: path.join(output, `workflow-context-source-${viewport.name}.png`) });

  await summaryButton.click();
  await summaryRegion.waitFor();
  assert.equal(await summaryButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await sourceRegion.count(), 0, 'source content must leave the document after returning to summary');
}
