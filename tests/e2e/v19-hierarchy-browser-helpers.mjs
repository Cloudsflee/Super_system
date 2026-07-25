import assert from 'node:assert/strict';
import path from 'node:path';
import { assertWorkflowHeaderAndCoverage } from './v19-workflow-header-assertions.mjs';

export async function assertAssistScope(page, fixture, output, { label, icon, breadcrumb, thread, forbidden }) {
  await page.getByRole('button', { name: '打开 Codex 智能助手' }).click();
  const workbench = page.locator('.assist-workbench');
  await workbench.waitFor();
  const heading = workbench.locator('.assist-scope-heading');
  await heading.getByText(`${label}智能助手`, { exact: true }).waitFor();
  await heading.getByText(thread, { exact: true }).waitFor();
  assert.equal(await heading.locator(`.${icon}`).count(), 1, `${label} Assist must display its scope icon`);
  assert.equal((await workbench.locator('.assist-scope-breadcrumb').textContent())?.trim(), breadcrumb);
  await workbench.getByRole('button', { name: '显示线程列表' }).click();
  const list = workbench.locator('.thread-list');
  await list.getByText(thread, { exact: true }).waitFor();
  assert.equal(await list.locator('.thread-tree-node').count(), 1, `${label} scope must list only exact-scope sessions`);
  for (const title of forbidden) assert.equal(await list.getByText(title, { exact: true }).count(), 0, `${label} scope leaked ${title}`);
  const scopeRow = list.locator('.thread-scope').first();
  assert.ok((await scopeRow.locator('b').textContent())?.trim(), `${label} thread must carry a visible scope label`);
  assert.equal((await scopeRow.locator('span').textContent())?.trim(), breadcrumb, `${label} thread must carry its complete ownership path`);
  await page.screenshot({ path: path.join(output, `assist-${label}-${page.viewportSize().width}.png`) });
  await workbench.getByRole('button', { name: '关闭智能助手' }).click();
  await workbench.waitFor({ state: 'detached' });
  assert.equal(fixture.projectId.length > 0, true);
}

export async function assertWorkflowProcessSemantics(page, output, viewport) {
  const process = page.locator('.workflow-full-process'), layoutMode = await process.getAttribute('data-layout'), masterDetail = layoutMode === 'master-detail';
  await assertWorkflowHeaderAndCoverage(page, viewport);
  assert.equal(masterDetail, viewport.width >= 1440, `${viewport.name} must use the container-driven layout expected at its fixture width`);
  assert.equal(await page.locator('.workflow-full-process').getAttribute('data-density'), 'comfortable', 'verified workflows default to comfortable density');
  assert.equal(await page.locator('.workflow-process-task .workflow-code-bubble').count(), 0, 'comfortable rows defer CLI details');
  assert.equal(await page.locator('.workflow-process-task .workflow-task-overview').count(), 0, 'comfortable rows defer metrics');
  assert.equal(await page.locator('.workflow-schedule-indicator').count(), 1, 'comfortable rows collapse scheduling into one clock');
  assert.equal(await page.getByText('外部证据', { exact: true }).count(), 0, 'uniform external evidence labels must stay hidden');
  await assertProcessOverflow(page);
  const cardStyle = await page.locator('.workflow-process-task').first().evaluate((element) => { const value = getComputedStyle(element); return { radius: parseFloat(value.borderRadius), shadow: value.boxShadow }; });
  assert.ok(cardStyle.radius <= 6 && cardStyle.shadow === 'none', `Task cards must use restrained 6px geometry without shadow: ${JSON.stringify(cardStyle)}`);
  assert.equal(parseFloat(await page.locator('.workflow-task-dag').first().evaluate((element) => getComputedStyle(element).rowGap)), viewport.width <= 600 ? 6 : 8, 'Task card gap must match the density grid');
  const edges = page.locator('.workflow-topology-edge');
  assert.equal(await edges.count(), 2, 'the fixture DAG must render both dependency edges');
  const paths = await edges.evaluateAll((items) => items.map((item) => item.getAttribute('d') || ''));
  const rowHeights = await page.locator('.workflow-task-summary').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  assert.ok(paths.every((value) => /^M \d/.test(value)), `dependency edges need measured SVG paths: ${JSON.stringify(paths)}`);
  await assertTopologyAnchors(page);
  if (viewport.width > 700) {
    await page.locator('[data-task-id="task-collect-evidence"]').hover();
    assert.equal(await page.locator('[data-task-id="task-collect-evidence"].topology-active').count(), 1, 'hovered Task must be active');
    assert.equal(await page.locator('[data-task-id="task-verify-build"].topology-downstream,[data-task-id="task-review-notes"].topology-downstream').count(), 2, 'all downstream Tasks must highlight');
    assert.equal(await page.locator('.workflow-topology-edge.downstream').count(), 2, 'downstream dependency paths must highlight together');
    assert.deepEqual(await edges.evaluateAll((items) => items.map((item) => item.getAttribute('d') || '')), paths, 'hover must not move dependency paths');
    await page.waitForTimeout(280);
    const preview = masterDetail ? page.locator('.workflow-task-inspector') : page.locator('.workflow-task-quick-preview'); await preview.waitFor();
    assert.equal((await preview.locator('.workflow-code-bubble code').textContent())?.trim(), 'node src/cli.mjs collect --date 2026-07-23', 'Task preview must expose the extracted CLI');
    assert.equal(await preview.locator('.workflow-task-overview').count(), 1, 'Task preview must expose all four metrics');
    if (masterDetail) {
      const objective = await preview.locator('.workflow-task-copy').textContent();
      assert.match(objective || '', /收集可追溯发布证据。/, 'the detail panel must retain the Chinese objective');
      assert.doesNotMatch(objective || '', /Preserve source provenance and immutable hashes/, 'a bilingual objective must not repeat its English translation');
    }
    if (masterDetail) assert.equal(await page.locator('.workflow-task-quick-preview,.workflow-task-details').count(), 0, 'master-detail must not duplicate Task details');
    else await assertPreviewBounds(page);
    await preview.screenshot({ path: path.join(output, `workflow-preview-${viewport.name}.png`) });
    await page.screenshot({ path: path.join(output, `workflow-topology-${viewport.name}.png`) });
    await page.locator('.workflow-process-summary').hover(); await page.waitForTimeout(120);
    if (!masterDetail) assert.equal(await preview.count(), 0, 'quick preview must close after pointer leave');
  } else {
    await page.locator('[data-task-id="task-collect-evidence"]').dispatchEvent('pointerover', { pointerType: 'touch', bubbles: true });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.workflow-task-quick-preview').count(), 0, 'touch pointers must not open hover previews');
    assert.equal(await page.locator('.workflow-process-task.topology-active').count(), 0, 'touch pointers must not activate hover topology');
  }
  assert.deepEqual(await page.locator('.workflow-task-summary').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height)), rowHeights, 'Task previews must not resize summary rows');
  const locked = page.locator('.workflow-task-enter.locked:disabled'), open = page.locator('a.workflow-task-enter').first();
  assert.ok(await locked.count() >= 1, 'blocked Tasks must expose disabled lock actions');
  const [lockedStyle, openStyle] = await Promise.all([locked.first().evaluate(style), open.evaluate(style)]);
  assert.notEqual(lockedStyle.backgroundColor, openStyle.backgroundColor, 'locked actions must not retain the active green treatment');
  const widths = await page.locator('.workflow-task-summary').evaluateAll((rows) => rows.map((row) => ({ client: row.clientWidth, scroll: row.scrollWidth, main: row.querySelector('.workflow-task-main')?.getBoundingClientRect().width || 0 })));
  assert.ok(widths.every(({ client, scroll, main }) => scroll <= client + 1 && main <= client + 1), `elastic Task rows must fit their container: ${JSON.stringify(widths)}`);
  if (viewport.width > 900) await assertWideWorkflowWorkbands(page, masterDetail);
  if (masterDetail) await assertMasterDetailLayout(page);

  for (const [density, desktopMax, mobileMax] of [['compact', 52, 58], ['detailed', 112, 124], ['comfortable', 72, 80]]) {
    await setWorkflowDensity(page, viewport, density); await page.waitForTimeout(40);
    const heights = await page.locator('.workflow-task-summary').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
    const maximum = viewport.width <= 600 ? mobileMax : desktopMax;
    assert.ok(heights.every((height) => height <= maximum), `${density} Task summaries exceed ${maximum}px: ${JSON.stringify(heights)}`);
    await assertProcessOverflow(page); await assertTopologyAnchors(page);
    if (density === 'compact') assert.equal(await page.locator('.workflow-task-primary-line,.workflow-process-task .workflow-task-objective').count(), 0, 'compact rows show no persistent objective context');
    if (density === 'comfortable') assert.equal(await page.locator('.workflow-process-task .workflow-code-bubble,.workflow-process-task .workflow-task-overview').count(), 0, 'comfortable rows defer CLI and metrics');
    if (density === 'detailed') {
      assert.ok(await page.locator('.workflow-process-task .workflow-code-bubble').count() >= 1, 'detailed rows expose CLI context');
      assert.equal(await page.locator('.workflow-process-task .workflow-task-overview').count(), await page.locator('.workflow-process-task').count(), 'detailed rows expose all metrics');
    }
  }

  const dock = page.locator('.command-dock');
  assert.equal(await dock.getAttribute('class'), 'command-dock collapsed', 'the AI drawer must default to collapsed');
  assert.equal(await page.locator('.command-dock-body').count(), 0, 'collapsed AI drawer must not retain the composer');
  const collapsed = await dock.boundingBox();
  assert.ok(collapsed && collapsed.height <= 42, `collapsed AI drawer is too tall: ${JSON.stringify(collapsed)}`);
  await page.getByRole('button', { name: '展开智能助手输入' }).click();
  await page.locator('.command-dock-body').waitFor(); await page.waitForTimeout(80);
  const expanded = await dock.boundingBox();
  assert.ok(expanded && expanded.height >= collapsed.height + 55, `expanded AI drawer did not expose its composer: ${JSON.stringify({ collapsed, expanded })}`);
  await assertProcessAboveDock(page);
  await page.screenshot({ path: path.join(output, `workflow-dock-expanded-${viewport.name}.png`) });
  await page.getByRole('button', { name: '收起智能助手输入' }).click();
  await page.locator('.command-dock-body').waitFor({ state: 'detached' }); await page.waitForTimeout(80); await assertProcessAboveDock(page);
  await page.mouse.move(viewport.width - 4, 100); await page.waitForTimeout(30);
  assert.equal(await page.locator('.workflow-process-task.topology-active').count(), 0, 'topology highlight must clear after the pointer leaves the DAG');
}

export async function setWorkflowDensity(page, viewport, density) {
  const labels = { compact: '紧凑', comfortable: '舒适', detailed: '详细' };
  await page.getByRole('button', { name: /显示设置/ }).click();
  await page.getByRole('menuitemradio', { name: labels[density] }).click();
  await page.waitForFunction((value) => document.querySelector('.workflow-full-process')?.getAttribute('data-density') === value, density);
}

export async function assertWorkflowTaskSelectionJourney(page, viewport) {
  const masterDetail = await page.locator('.workflow-full-process').getAttribute('data-layout') === 'master-detail';
  const topologyBefore = await page.locator('.workflow-topology-edge').evaluateAll((items) => items.map((item) => item.getAttribute('d')));
  if (masterDetail) {
    await page.locator('[data-task-id="task-collect-evidence"] .workflow-task-main').click();
    assert.equal(await page.locator('.workflow-task-inspector').getAttribute('data-detail-task-id'), 'task-collect-evidence');
    assert.equal(await page.getByRole('button', { name: '取消固定任务：Collect release evidence' }).count(), 2, 'row and detail must expose the same pin state');
    assert.equal(await page.locator('.workflow-task-details,.workflow-task-quick-preview').count(), 0, 'wide selection must not add row details');
    assert.deepEqual(await page.locator('.workflow-topology-edge').evaluateAll((items) => items.map((item) => item.getAttribute('d'))), topologyBefore, 'pinning must not reflow topology');
    await setWorkflowDensity(page, viewport, 'compact');
    assert.equal(await page.locator('.workflow-task-inspector').getAttribute('data-detail-task-id'), 'task-collect-evidence', 'density changes must retain the pin');
    await setWorkflowDensity(page, viewport, 'comfortable');
    await page.locator('[data-task-id="task-verify-build"]').getByRole('button', { name: '固定任务：Verify release build' }).click();
    assert.equal(await page.locator('.workflow-task-inspector').getAttribute('data-detail-task-id'), 'task-verify-build', 'a new pin must replace the previous pin');
    assert.deepEqual(await page.locator('.workflow-topology-edge').evaluateAll((items) => items.map((item) => item.getAttribute('d'))), topologyBefore, 'wide Task selection must keep topology geometry stable');
  } else {
    await page.getByRole('button', { name: '展开任务详情：Collect release evidence' }).click();
    await page.getByRole('region', { name: '任务详情：Collect release evidence' }).waitFor();
    await assertWorkflowExpandedWorkband(page, viewport);
    await page.waitForTimeout(80);
    assert.notDeepEqual(await page.locator('.workflow-topology-edge').evaluateAll((items) => items.map((item) => item.getAttribute('d'))), topologyBefore, 'expanded rows must reflow dependency geometry');
    assert.equal(await page.locator('.workflow-task-details').count(), 1, 'only one Task may disclose metadata');
    await setWorkflowDensity(page, viewport, 'compact');
    assert.equal(await page.getByRole('region', { name: '任务详情：Collect release evidence' }).count(), 1, 'density changes must retain the open Task');
    await setWorkflowDensity(page, viewport, 'comfortable');
    await page.getByRole('button', { name: '展开任务详情：Verify release build' }).click();
    assert.equal(await page.getByRole('region', { name: '任务详情：Collect release evidence' }).count(), 0, 'opening another Task closes the previous disclosure');
    await page.getByRole('region', { name: '任务详情：Verify release build' }).waitFor();
  }
}

export async function assertReplanResponsiveLayout(page, viewport, open) {
  await page.waitForTimeout(160);
  const state = await page.locator('.workflow-full-process').evaluate((process) => ({ width: process.getBoundingClientRect().width, measured: Number(process.dataset.containerWidth), layout: process.dataset.layout, detailTaskId: process.querySelector('.workflow-task-inspector')?.dataset.detailTaskId || null, pinnedTaskId: process.querySelector('.workflow-process-task.pinned')?.dataset.taskId || null }));
  assert.equal(state.layout, state.measured >= 1360 ? 'master-detail' : 'accordion', `layout must follow the measured process width: ${JSON.stringify(state)}`);
  assert.ok(Math.abs(state.measured - state.width) <= 2 || state.width === 0, `ResizeObserver measurement is stale: ${JSON.stringify(state)}`);
  if (open && viewport.width === 1440) assert.equal(state.layout, 'accordion', 'the 1440px replan panel must narrow the process into accordion mode');
  if (!open && viewport.width >= 1440) assert.equal(state.layout, 'master-detail', 'closing replan must restore the wide detail panel');
  assert.equal(state.detailTaskId || state.pinnedTaskId, 'task-verify-build', 'layout changes must retain the pinned Task');
}

export async function assertWorkflowExpandedWorkband(page, viewport) {
  if (viewport.width <= 900) return;
  const layout = await page.getByRole('region', { name: '任务详情：Collect release evidence' }).evaluate((region) => {
    const band = region.querySelector('.workflow-task-details-band'), task = region.closest('.workflow-process-task'), main = task.querySelector('.workflow-task-main');
    const regionRect = region.getBoundingClientRect(), bandRect = band.getBoundingClientRect(), taskRect = task.getBoundingClientRect(), mainRect = main.getBoundingClientRect(), taskStyle = getComputedStyle(task);
    return { region: regionRect.toJSON(), band: bandRect.toJSON(), task: taskRect.toJSON(), main: mainRect.toJSON(), taskBorder: Number.parseFloat(taskStyle.borderLeftWidth) + Number.parseFloat(taskStyle.borderRightWidth), columns: getComputedStyle(band).gridTemplateColumns.split(' ').filter(Boolean).length };
  });
  assert.ok(Math.abs(layout.region.width - (layout.task.width - layout.taskBorder)) <= 1, `expanded detail background must remain full-width: ${JSON.stringify(layout)}`);
  assert.ok(layout.band.width <= 1081, `expanded detail workband exceeded 1080px: ${JSON.stringify(layout)}`);
  assert.ok(Math.abs(layout.band.left - layout.main.left) <= 1, `expanded details must share the Task content axis: ${JSON.stringify(layout)}`);
  if (viewport.width > 1120) assert.equal(layout.columns, 3, `wide expanded details must retain three columns: ${JSON.stringify(layout)}`);
}

async function assertProcessOverflow(page) {
  const processOverflow = await page.locator('.workflow-full-process').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const offenders = [...element.querySelectorAll('*')].map((item) => {
      const rect = item.getBoundingClientRect();
      return { item: `${item.tagName.toLowerCase()}.${item.getAttribute('class') || ''}`, left: rect.left, right: rect.right, width: rect.width, client: item.clientWidth, scroll: item.scrollWidth };
    }).filter((item) => item.right > bounds.right + 1 || item.scroll > item.client + 1).slice(0, 12);
    return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, bounds: { left: bounds.left, right: bounds.right }, offenders };
  });
  assert.ok(processOverflow.scrollWidth <= processOverflow.clientWidth + 1, `the process surface must not create horizontal scrolling: ${JSON.stringify(processOverflow)}`);
}

async function assertTopologyAnchors(page) {
  const errors = await page.locator('.workflow-topology-edge').evaluateAll((paths) => paths.flatMap((path) => {
    const dag = path.closest('.workflow-task-dag'), dagRect = dag.getBoundingClientRect();
    return ['source', 'target'].map((side) => {
      const taskId = path.dataset[`${side}Id`], anchor = dag.querySelector(`[data-task-id="${taskId}"] [data-topology-anchor]`), rect = anchor.getBoundingClientRect();
      const expected = { x: rect.left - dagRect.left + rect.width / 2, y: rect.top - dagRect.top + rect.height / 2 };
      return Math.max(Math.abs(Number(path.dataset[`${side}X`]) - expected.x), Math.abs(Number(path.dataset[`${side}Y`]) - expected.y));
    });
  }));
  assert.ok(errors.every((error) => error <= 1), `topology endpoints must stay within 1px of DOM anchors: ${JSON.stringify(errors)}`);
}

async function assertPreviewBounds(page) {
  const result = await page.locator('.workflow-task-quick-preview').evaluate((element) => {
    const preview = element.getBoundingClientRect(), dock = document.querySelector('.command-dock')?.getBoundingClientRect();
    const anchor = document.querySelector(`[data-task-id="${CSS.escape(element.dataset.taskPreview)}"] [data-preview-anchor]`)?.getBoundingClientRect();
    return { preview: preview.toJSON(), anchor: anchor?.toJSON(), dock: dock?.toJSON(), width: innerWidth, height: innerHeight, pointerEvents: getComputedStyle(element).pointerEvents };
  });
  assert.ok(result.preview.left >= 8 && result.preview.top >= 8 && result.preview.right <= result.width - 8 && result.preview.bottom <= result.height - 8, `quick preview crossed its 8px viewport boundary: ${JSON.stringify(result)}`);
  assert.equal(result.pointerEvents, 'none', 'quick preview must remain read-only');
  assert.ok(!result.dock || result.preview.bottom <= result.dock.top - 8, `quick preview must not cover the Command Dock: ${JSON.stringify(result)}`);
  assert.ok(result.anchor, `quick preview must retain its Task content anchor: ${JSON.stringify(result)}`);
  const expectedLeft = Math.min(Math.max(result.anchor.left, 8), Math.max(8, result.width - result.preview.width - 8));
  assert.ok(Math.abs(result.preview.left - expectedLeft) <= 1, `quick preview must align with the Task content axis unless viewport-clamped: ${JSON.stringify(result)}`);
}

async function assertWideWorkflowWorkbands(page, masterDetail) {
  const layout = await page.locator('.workflow-full-process').evaluate((process) => {
    const stream = process.querySelector('.workflow-process-stream'), streamHeader = stream.querySelector(':scope > header'), streamBand = streamHeader.querySelector('.workflow-stream-band');
    const streamMain = streamBand.querySelector('.workflow-stream-main'), streamProgress = streamBand.querySelector('.workflow-stream-progress'), streamAction = streamBand.querySelector(':scope > a');
    const dag = stream.querySelector('.workflow-task-dag'), task = dag.querySelector('.workflow-process-task'), summary = task.querySelector('.workflow-task-summary'), taskBand = summary.querySelector('.workflow-task-summary-band');
    const taskMain = taskBand.querySelector('.workflow-task-main'), taskActions = taskBand.querySelector('.workflow-task-actions'), dagStyle = getComputedStyle(dag), taskStyle = getComputedStyle(task);
    const rect = (element) => element.getBoundingClientRect().toJSON();
    return {
      stream: rect(stream), streamHeader: rect(streamHeader), streamBand: rect(streamBand), streamMain: rect(streamMain), streamProgress: rect(streamProgress), streamAction: rect(streamAction),
      dag: rect(dag), task: rect(task), summary: rect(summary), taskBand: rect(taskBand), taskMain: rect(taskMain), taskActions: rect(taskActions),
      dagPadding: Number.parseFloat(dagStyle.paddingLeft) + Number.parseFloat(dagStyle.paddingRight), taskBorder: Number.parseFloat(taskStyle.borderLeftWidth) + Number.parseFloat(taskStyle.borderRightWidth)
    };
  });
  assert.ok(Math.abs(layout.stream.width - layout.streamHeader.width) <= 1, `Workstream background must remain full-width: ${JSON.stringify(layout)}`);
  assert.ok(Math.abs(layout.task.width - (layout.dag.width - layout.dagPadding)) <= 1, `Task card must remain full-width inside the DAG: ${JSON.stringify(layout)}`);
  assert.ok(Math.abs(layout.summary.width - (layout.task.width - layout.taskBorder)) <= 1, `Task summary background must remain full-width: ${JSON.stringify(layout)}`);
  const maximum = masterDetail ? 961 : 841;
  assert.ok(layout.streamBand.width <= maximum && layout.taskBand.width <= maximum, `control workbands exceeded ${maximum - 1}px: ${JSON.stringify(layout)}`);
  assert.ok(Math.abs(layout.taskActions.left - layout.taskMain.right - 12) <= 1, `Task main/action spacing must be 12px: ${JSON.stringify(layout)}`);
  assert.ok(layout.taskActions.right - layout.taskBand.left <= maximum, `Task actions crossed the control workband: ${JSON.stringify(layout)}`);
  assert.ok(Math.abs(layout.streamProgress.left - layout.streamMain.right - 12) <= 1 && Math.abs(layout.streamAction.left - layout.streamProgress.right - 12) <= 1, `Workstream controls must use 12px spacing: ${JSON.stringify(layout)}`);
  if (!masterDetail || layout.task.width > 963) assert.ok(layout.summary.right - layout.taskBand.right > 1 && layout.streamHeader.right - layout.streamBand.right > 1, `wide-screen whitespace must remain after a bounded interaction band: ${JSON.stringify(layout)}`);
}

export async function assertMasterDetailLayout(page) {
  const layout = await page.locator('.workflow-full-process').evaluate((process) => {
    const body = process.querySelector('.workflow-process-body'), master = process.querySelector('.workflow-process-master'), detail = process.querySelector('.workflow-task-inspector'), coverage = process.querySelector('.workflow-process-summary');
    const rect = (element) => element.getBoundingClientRect().toJSON(), masterStyle = getComputedStyle(master), detailStyle = getComputedStyle(detail);
    return { process: rect(process), body: rect(body), master: rect(master), detail: rect(detail), coverage: rect(coverage), masterOverflow: masterStyle.overflowY, detailOverflow: detailStyle.overflowY, columns: getComputedStyle(detail.querySelector('.workflow-task-inspector-sections')).gridTemplateColumns.split(' ').filter(Boolean).length, scrollWidth: process.scrollWidth, clientWidth: process.clientWidth };
  });
  assert.ok(layout.master.width >= 880 && layout.master.width <= 1120, `master width must stay within 880-1120px: ${JSON.stringify(layout)}`);
  assert.ok(Math.abs(layout.master.width + layout.detail.width - layout.body.width) <= 2, `detail must consume the remaining process width: ${JSON.stringify(layout)}`);
  assert.equal(layout.masterOverflow, 'auto'); assert.equal(layout.detailOverflow, 'auto');
  assert.ok(Math.abs(layout.coverage.width - layout.master.width) <= 1 && Math.abs(layout.coverage.left - layout.master.left) <= 1, `coverage must stay inside the scrolling Master column: ${JSON.stringify(layout)}`);
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `master-detail must not scroll horizontally: ${JSON.stringify(layout)}`);
  const expectedColumns = layout.detail.width >= 1180 ? 3 : layout.detail.width >= 720 ? 2 : 1;
  assert.equal(layout.columns, expectedColumns, `detail container columns do not match its own width: ${JSON.stringify(layout)}`);
}

async function assertProcessAboveDock(page) {
  await page.waitForFunction(() => { const process = document.querySelector('.workflow-full-process')?.getBoundingClientRect(), dock = document.querySelector('.command-dock')?.getBoundingClientRect(); return Boolean(process && dock && process.bottom <= dock.top + 1); });
}

function style(element) { const value = getComputedStyle(element); return { backgroundColor: value.backgroundColor, color: value.color }; }
