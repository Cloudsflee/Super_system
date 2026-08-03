import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { assertNoHorizontalScroll, assertNoOverlap, assertViewport, browserExecutable } from './playwright-helpers.mjs';
import {
  contentPayload,
  contractFixture,
  EXECUTION_ID,
  executionFixture,
  membershipFixture,
  PROJECT_ID,
  projectFixture,
  taskFixture,
  WORKFLOW_ID,
  workflowFixture,
  workspaceFixtures,
  workstreamFixture
} from './v23-quality-review-browser-fixtures.mjs';

const SERVER_MODE = 'AIWS_V23_BROWSER_SERVER',
  dimensions = ['目标与要求覆盖', '事实准确性与证据支撑', '分析深度、反证与边界', '内部一致性', '表达清晰度与可操作性'];
let fixtureAdviceMode = 'completed';

if (process.env[SERVER_MODE] === '1') await startFixtureServer();
else await runBrowserJourney();

async function startFixtureServer() {
  const { setQualityReviewModelRunner } = await import('../../apps/api/src/quality-review-service.mjs');
  setQualityReviewModelRunner(async ({ rubric, parsed }) => {
    await delay(Number(process.env.AIWS_V23_REVIEWER_DELAY_MS || 1_200));
    if (fixtureAdviceMode === 'unavailable') {
      const error = new Error('quality_review_model_failed');
      error.code = 'quality_review_model_failed';
      throw error;
    }
    const anchors = parsed.flatMap((item) => item.anchors || []);
    return {
      schema_version: 'aiws.quality_review_advice.v1',
      reviewer: { profile_id: null, provider: null, model: null, attempt: 1 },
      status: 'completed',
      dimensions: rubric.dimensions
        .filter((item) => item.enabled)
        .map((dimension, index) => ({
          criterion_id: dimension.id,
          recommendation: 92,
          rationale: `独立模型已核验 ${dimension.title}，建议人工结合证据锚点复核。`,
          evidence_anchors: anchors.length ? [anchors[index % anchors.length]] : [],
          limitations: []
        })),
      limitations: ['模型建议仅用于 V2.3 浏览器旅程，不会预填人工评分。'],
      generated_at: new Date().toISOString()
    };
  });
  attachFixtureCommands();
  await import('../../apps/api/server.mjs');
}

function attachFixtureCommands() {
  process.on('message', (message) => {
    const operation =
      message?.type === 'advance-main-asset'
        ? advanceMainAsset()
        : message?.type === 'set-advice-mode'
          ? Promise.resolve(setAdviceMode(message.mode))
          : null;
    if (!operation) return;
    void operation
      .then((result) => process.send?.({ request_id: message.request_id, ok: true, result }))
      .catch((error) =>
        process.send?.({
          request_id: message.request_id,
          ok: false,
          error: error?.stack || error?.message || String(error)
        })
      );
  });
}

function setAdviceMode(mode) {
  assert.ok(['completed', 'unavailable'].includes(mode), `invalid fixture advice mode: ${mode}`);
  fixtureAdviceMode = mode;
  return { mode };
}

async function advanceMainAsset() {
  const { mutate } = await import('../../apps/api/src/state.mjs'),
    { createImmutableAssetVersion } = await import('../../apps/api/src/asset-cas.mjs'),
    { evaluateWorkflowOutcomesInState } = await import('../../apps/api/src/outcome-service.mjs');
  return mutate(async (state) => {
    const asset = state.assets.find((item) => item.project_id === PROJECT_ID && item.output_key === 'main'),
      taskExecution = state.task_executions.find((item) => item.workflow_execution_id === EXECUTION_ID),
      execution = state.workflow_executions.find((item) => item.id === EXECUTION_ID);
    assert.ok(asset && taskExecution && execution, 'quality review stale fixture is incomplete');
    const version = await createImmutableAssetVersion(state, {
      asset,
      payload: contentPayload(`\n\n资产修订 ${Date.now()}：补充了新的执行边界。`),
      evidenceRefs: ['source:quality-review-browser'],
      actorId: state.instance_owner_user_id,
      outputKey: 'main'
    });
    const binding = taskExecution.output_bindings.find((item) => item.key === 'main');
    binding.version_id = version.id;
    evaluateWorkflowOutcomesInState(state, execution.id);
    return {
      asset_version_id: version.id,
      completion_status: execution.completion_status,
      release_eligible: execution.release_eligible
    };
  });
}

async function runBrowserJourney() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v23-quality-browser-')),
    home = path.join(root, 'home'),
    port = Number(process.env.AIWS_V23_BROWSER_PORT || 4623),
    output = process.env.AIWS_TEST_REPORT_DIR
      ? path.resolve(process.env.AIWS_TEST_REPORT_DIR, 'e2e-v23-quality-review')
      : path.resolve('.ai-workspace', 'e2e-v23-quality-review'),
    viewports = [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 }
    ].filter((item) => !process.env.AIWS_TEST_VIEWPORT || item.name === process.env.AIWS_TEST_VIEWPORT);
  Object.assign(process.env, {
    AIWS_HOME: home,
    NODE_ENV: 'test',
    AIWS_TEST_ADAPTERS: '1',
    AIWS_TEST_DISABLE_CONTEXT_PROJECTOR: '1'
  });
  fs.mkdirSync(output, { recursive: true });
  let browser,
    server,
    serverLog = '';
  try {
    buildWeb();
    await seedFixture();
    server = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        [SERVER_MODE]: '1',
        AIWS_HOME: home,
        AIWS_PORT: String(port),
        AIWS_BYPASS_SETUP: '1',
        AIWS_CONTEXT_REPOSITORY_FILE_LIMIT: '0',
        AIWS_TEST_DISABLE_CONTEXT_PROJECTOR: '1',
        AIWS_V23_REVIEWER_DELAY_MS: '1200',
        NODE_ENV: 'production'
      }
    });
    server.stdout.on('data', (chunk) => {
      serverLog += chunk;
    });
    server.stderr.on('data', (chunk) => {
      serverLog += chunk;
    });
    await waitForServer(server, () => serverLog, port);
    browser = await chromium.launch({ headless: true, ...browserExecutable() });
    for (const viewport of viewports)
      await verifyViewport({ browser, server, serverLog: () => serverLog, port, output, viewport });
    console.log(`V2.3 Quality Review ${viewports.length}-viewport browser journey passed; screenshots: ${output}`);
  } finally {
    await browser?.close();
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

async function verifyViewport({ browser, server, serverLog, port, output, viewport }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 }),
    page = await context.newPage(),
    errors = [];
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockSetupStatus(page);
    const readiness = await mockReviewerReadiness(page);
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });

    await sendFixtureCommand(server, { type: 'set-advice-mode', mode: 'completed' });
    readiness.setMode('ready');
    await completeQualityReview(page, port, output, viewport);
    const stale = await sendFixtureCommand(server, { type: 'advance-main-asset' });
    assert.equal(stale.completion_status, 'completed_with_gaps');
    assert.equal(stale.release_eligible, false);
    readiness.setMode('unavailable');
    await sendFixtureCommand(server, { type: 'set-advice-mode', mode: 'unavailable' });
    const staleRunId = await verifyStaleReview(page, port, output, viewport);
    await verifyDegradedRereview(page, port, output, viewport, staleRunId);
    assert.deepEqual(
      errors.filter((item) => !item.includes('favicon')),
      [],
      `${viewport.name} browser errors:\n${errors.join('\n')}\n${serverLog()}`
    );
  } catch (error) {
    const logTail = serverLog().slice(-20_000);
    throw new Error(
      `${viewport.name} browser journey failed (server exit=${server?.exitCode ?? 'running'}, signal=${server?.signalCode ?? 'none'})\n${error?.stack || error}\nAPI log tail:\n${logTail}`,
      { cause: error }
    );
  } finally {
    await context.close();
  }
}

async function completeQualityReview(page, port, output, viewport) {
  await page.goto(`http://127.0.0.1:${port}/projects/${PROJECT_ID}/workflow`);
  await page.locator('.workflow-execution-band').waitFor();
  await verifyPolicyOptIn(page, viewport);
  await page.getByText('完成但有缺口', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Outcome', exact: true }).click();
  const outcomes = page.locator('.workflow-outcome-panel'),
    quality = outcomes.getByRole('region', { name: 'Quality Review 内容质量评审' });
  await quality.getByText('Quality Review', { exact: true }).waitFor();
  await quality.getByText(/Mandatory · 阈值 80/).waitFor();
  await quality.getByText(/Reviewer ready/).waitFor();
  await quality.getByText('openai / browser-reviewer', { exact: true }).waitFor();
  await openAndConfigureDrawer(quality, page, output, viewport);
  await startReview(quality, page);
  await quality.locator('.quality-review-progress').waitFor();
  await quality.getByRole('button', { name: '取消', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `quality-review-running-${viewport.name}.png`), fullPage: true });

  await quality.getByText('人工最终评分', { exact: true }).waitFor({ timeout: 30_000 });
  await verifyReportAndScore(quality, page, output, viewport);
  await submitDecision(quality, page);
  await quality.locator('.quality-review-decision-summary').getByText('通过', { exact: true }).waitFor();
  await page.getByText('真实完成', { exact: true }).waitFor();
  assert.equal(await page.locator('.workflow-completion-badge').getAttribute('data-tooltip'), 'Release eligible');
  await verifyCompletedApi(page, quality, port);
  await verifyQualityLayout(page);
  await page.screenshot({ path: path.join(output, `quality-review-completed-${viewport.name}.png`), fullPage: true });
}

async function verifyPolicyOptIn(page, viewport) {
  const policy = page.getByRole('region', { name: 'Quality Review 策略' }),
    toggle = policy.locator('.quality-review-policy-toggle input'),
    save = policy.getByRole('button', { name: '保存策略' });
  await policy.waitFor();
  assert.equal(await toggle.isChecked(), true);

  await toggle.uncheck();
  await policy.getByText('未启用', { exact: true }).waitFor();
  const disabled = await savePolicy(page, save, false);
  await policy.getByText(`Revision ${disabled.revision}`, { exact: true }).waitFor();

  await toggle.check();
  await policy.getByText('Rubric 编辑器', { exact: true }).waitFor();
  await policy.getByLabel('目标与要求覆盖 说明').fill(`Policy ${viewport.name}：未来执行必须核验用户要求和验收边界。`);
  const enabled = await savePolicy(page, save, true);
  await policy.getByText(`Revision ${enabled.revision}`, { exact: true }).waitFor();
  assert.equal(enabled.quality_review_policy.enabled, true);
  assert.equal(enabled.quality_review_policy.mandatory, true);
  assert.equal(enabled.quality_review_policy.rubric.threshold, 80);
}

async function savePolicy(page, save, enabled) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'PUT' &&
        candidate.url().endsWith(`/api/workflows/${WORKFLOW_ID}/quality-review-policy`)
    ),
    save.click()
  ]);
  assert.equal(response.status(), 200);
  const request = response.request().postDataJSON();
  assert.equal(request.enabled, enabled);
  assert.ok(Number.isInteger(request.expected_revision));
  if (enabled) {
    assert.equal(request.rubric.mandatory, true);
    assert.equal(request.rubric.threshold, 80);
    assert.equal(
      request.rubric.dimensions.filter((item) => item.enabled).reduce((sum, item) => sum + item.weight, 0),
      100
    );
  }
  return response.json();
}

async function openAndConfigureDrawer(quality, page, output, viewport) {
  await quality.getByRole('button', { name: /^(启动 Quality Review|重新评审)$/ }).click();
  const drawer = quality.getByRole('dialog', { name: '启动 Quality Review' }),
    main = drawer.locator('.quality-review-asset').filter({ hasText: '最终质量报告' }),
    appendix = drawer.locator('.quality-review-asset').filter({ hasText: '补充分析附件' }),
    recording = drawer.locator('.quality-review-asset.out-of-scope').filter({ hasText: '访谈录音' }),
    confirm = drawer.getByRole('button', { name: '确认启动' });
  await drawer.waitFor();
  assert.equal(await main.locator('input[type="checkbox"]').isChecked(), true);
  assert.equal(await main.locator('input[type="checkbox"]').isDisabled(), true);
  assert.equal(await appendix.locator('input[type="checkbox"]').isChecked(), true);
  await recording.getByText('范围外', { exact: true }).waitFor();
  await appendix.locator('input[type="checkbox"]').uncheck();
  assert.equal(await confirm.isDisabled(), true);
  await appendix.getByPlaceholder('填写排除理由（必填）').fill('补充附件仅供背景参考，不纳入最终交付评分。');

  const coverageWeight = drawer.getByLabel('目标与要求覆盖 权重'),
    coverageInstructions = drawer.getByLabel('目标与要求覆盖 说明');
  await coverageInstructions.fill(`E2E ${viewport.name}：核验用户要求和验收边界。`);
  await coverageWeight.fill('24');
  await drawer.getByText('启用维度权重必须合计 100。', { exact: true }).waitFor();
  assert.equal(await confirm.isDisabled(), true);
  await coverageWeight.fill('25');
  await drawer.getByText('启用权重 100/100', { exact: true }).waitFor();
  assert.equal(await confirm.isEnabled(), true);
  await drawer.getByText(/阈值 80 只读/).waitFor();
  await assertNoHorizontalScroll(page, '.quality-review-drawer');
  await assertNoOverlap(
    page,
    '.quality-review-drawer-section:first-child',
    '.quality-review-drawer-section:last-child'
  );
  await page.screenshot({ path: path.join(output, `quality-review-drawer-${viewport.name}.png`), fullPage: true });
}

async function startReview(quality, page) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        candidate.url().endsWith(`/api/workflow-executions/${EXECUTION_ID}/quality-reviews`)
    ),
    quality.getByRole('button', { name: '确认启动' }).click()
  ]);
  assert.equal(response.status(), 202);
  const body = response.request().postDataJSON();
  assert.equal(body.excluded_assets.length, 1);
  assert.equal(body.excluded_assets[0].reason, '补充附件仅供背景参考，不纳入最终交付评分。');
  assert.equal(body.included_asset_version_ids.length, 1);
  assert.match(body.rubric.dimensions[0].instructions, /^E2E (desktop|mobile)/);
}

async function verifyReportAndScore(quality, page, output, viewport) {
  const report = quality.locator('.quality-review-report');
  await report.getByText('自动检查与模型建议', { exact: true }).waitFor();
  for (const check of ['required_outputs', 'rubric_identity', 'rubric_weights', 'outcome_threshold', 'asset_integrity'])
    await report.getByText(check, { exact: true }).waitFor();
  assert.equal(await report.getByText('建议 92/100', { exact: true }).count(), 5);
  assert.equal(await report.getByText(/证据锚点：/).count(), 5);
  await report.getByText('限制说明', { exact: true }).waitFor();
  await report.getByText(/访谈录音/).waitFor();

  for (const dimension of dimensions) {
    const score = quality.getByLabel(`${dimension} 分数`),
      reason = quality.getByLabel(`${dimension} 评分理由`);
    assert.equal(await score.inputValue(), '', `${dimension} must not be prefilled from model advice`);
    await score.fill('92');
    await reason.fill(`${dimension} 已由人工根据冻结资产和证据锚点独立复核。`);
  }
  await quality.locator('.quality-review-score-total').getByText('92.00', { exact: true }).waitFor();
  await quality.getByText('达到阈值 80 · 预计通过', { exact: true }).waitFor();
  await quality
    .getByText('最终裁决理由', { exact: true })
    .locator('..')
    .locator('textarea')
    .fill('人工逐维度复核完成，当前交付满足冻结 Rubric 和发布阈值。');
  await verifyQualityLayout(page);
  await page.screenshot({ path: path.join(output, `quality-review-awaiting-${viewport.name}.png`), fullPage: true });
}

async function submitDecision(quality, page) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' && /\/api\/quality-reviews\/[^/]+\/decision$/.test(candidate.url())
    ),
    quality.getByRole('button', { name: '提交人工裁决' }).click()
  ]);
  assert.equal(response.status(), 200);
  const body = response.request().postDataJSON();
  assert.equal(body.dimension_scores.length, 5);
  assert.ok(body.dimension_scores.every((item) => item.score === 92));
}

async function verifyCompletedApi(page, quality, port) {
  await quality.getByText('人工裁决：').waitFor();
  await quality.getByText(/总分 92/).waitFor();
  const outcomesResponse = await page.request.get(
      `http://127.0.0.1:${port}/api/workflow-executions/${EXECUTION_ID}/outcomes`
    ),
    outcomes = await outcomesResponse.json();
  assert.equal(outcomesResponse.status(), 200);
  assert.equal(outcomes.workflow_execution.completion_status, 'completed');
  assert.equal(outcomes.workflow_execution.release_eligible, true);
  assert.equal(outcomes.workflow_execution.outcome_summary.mandatory_gaps, 0);
  const semantic = outcomes.requirements.find((item) => item.contract_requirement_id === 'rubric:semantic_human_score'),
    evaluation = outcomes.evaluations.find((item) => item.requirement_id === semantic?.id);
  assert.equal(evaluation?.status, 'satisfied');
  assert.equal(evaluation?.actual?.score, 92);

  const historyResponse = await page.request.get(
      `http://127.0.0.1:${port}/api/workflow-executions/${EXECUTION_ID}/quality-reviews`
    ),
    history = await historyResponse.json();
  assert.equal(historyResponse.status(), 200);
  assert.equal(history.current.status, 'completed');
  assert.equal(history.current.score, 92);
  assert.equal(history.current.excluded_assets.length, 1);
  assert.match(history.current.rubric.dimensions[0].instructions, /^E2E (desktop|mobile)/);
  assert.equal(history.current.report.advice.status, 'completed');
  assert.ok(history.current.report.advice.dimensions.every((item) => item.evidence_anchors.length === 1));
}

async function verifyStaleReview(page, port, output, viewport) {
  await page.reload();
  await page.locator('.workflow-execution-band').waitFor();
  await page.getByText('完成但有缺口', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Outcome', exact: true }).click();
  const quality = page.getByRole('region', { name: 'Quality Review 内容质量评审' });
  await quality.getByText(/Reviewer unavailable/).waitFor();
  await quality.getByRole('status').getByText('Advice unavailable', { exact: true }).waitFor();
  await quality.getByText(/image: reviewer_runner_image_unavailable/).waitFor();
  await quality.getByText(/credential: reviewer_credential_reference_missing/).waitFor();
  await quality.getByText('已过期', { exact: true }).waitFor();
  await quality.getByText(/资产版本或 Rubric 已变化/).waitFor();
  await quality.getByRole('button', { name: '重新评审' }).waitFor();
  const response = await page.request.get(`http://127.0.0.1:${port}/api/workflow-executions/${EXECUTION_ID}/outcomes`),
    outcomes = await response.json();
  assert.equal(outcomes.workflow_execution.release_eligible, false);
  assert.equal(outcomes.workflow_execution.outcome_summary.mandatory_gaps, 1);
  const historyResponse = await page.request.get(
      `http://127.0.0.1:${port}/api/workflow-executions/${EXECUTION_ID}/quality-reviews`
    ),
    history = await historyResponse.json(),
    staleRun = history.items.find((item) => item.status === 'completed' && item.stale === true);
  assert.equal(historyResponse.status(), 200);
  assert.ok(staleRun?.id, 'completed stale Quality Review must remain selectable');
  await verifyQualityLayout(page);
  await page.screenshot({ path: path.join(output, `quality-review-stale-${viewport.name}.png`), fullPage: true });
  return staleRun.id;
}

async function verifyDegradedRereview(page, port, output, viewport, staleRunId) {
  const quality = page.getByRole('region', { name: 'Quality Review 内容质量评审' });
  await quality.getByRole('button', { name: '重新评审', exact: true }).click();
  const drawer = quality.getByRole('dialog', { name: '启动 Quality Review' });
  await drawer.waitFor();
  const [startResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        candidate.url().endsWith(`/api/workflow-executions/${EXECUTION_ID}/quality-reviews`)
    ),
    drawer.getByRole('button', { name: '确认启动' }).click()
  ]);
  assert.equal(startResponse.status(), 202);

  await quality.getByText('人工最终评分', { exact: true }).waitFor({ timeout: 30_000 });
  const report = quality.locator('.quality-review-report');
  await report.getByText('Advice unavailable', { exact: true }).waitFor();
  await report.getByText('Advice unavailable: quality_review_model_unavailable.', { exact: true }).waitFor();
  assert.equal(await report.getByText(/^建议 /).count(), 0);
  for (const dimension of dimensions) assert.equal(await quality.getByLabel(`${dimension} 分数`).inputValue(), '');

  const historyResponse = await page.request.get(
      `http://127.0.0.1:${port}/api/workflow-executions/${EXECUTION_ID}/quality-reviews`
    ),
    history = await historyResponse.json(),
    activeRunId = history.active?.id;
  assert.equal(historyResponse.status(), 200);
  assert.ok(activeRunId, 'degraded Quality Review must await a human decision');
  assert.notEqual(activeRunId, staleRunId);
  const select = quality.getByLabel('选择 Quality Review 历史记录');
  await select.selectOption(staleRunId);
  await quality.locator('.quality-review-status').getByText('已过期', { exact: true }).waitFor();
  assert.equal(await quality.getByText('人工最终评分', { exact: true }).count(), 0);
  await select.selectOption(activeRunId);
  await quality.getByText('人工最终评分', { exact: true }).waitFor();
  await verifyQualityLayout(page);
  await page.screenshot({ path: path.join(output, `quality-review-degraded-${viewport.name}.png`), fullPage: true });

  const [cancelResponse] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        candidate.url().endsWith(`/api/quality-reviews/${activeRunId}/cancel`)
    ),
    quality.getByRole('button', { name: '取消', exact: true }).click()
  ]);
  assert.equal(cancelResponse.status(), 202);
  await quality.locator('.quality-review-status').getByText('已取消', { exact: true }).waitFor();
  assert.equal(await quality.getByText('人工最终评分', { exact: true }).count(), 0);

  const cancelledResponse = await page.request.get(
      `http://127.0.0.1:${port}/api/workflow-executions/${EXECUTION_ID}/quality-reviews`
    ),
    cancelled = await cancelledResponse.json();
  assert.equal(cancelled.active, null);
  assert.equal(cancelled.latest.id, activeRunId);
  assert.equal(cancelled.latest.status, 'cancelled');
  await select.selectOption(staleRunId);
  await quality.locator('.quality-review-status').getByText('已过期', { exact: true }).waitFor();
  await select.selectOption(activeRunId);
  await quality.locator('.quality-review-status').getByText('已取消', { exact: true }).waitFor();
  const labels = await select.locator('option').allTextContents();
  assert.ok(labels.some((item) => item.includes('stale')));
  assert.ok(labels.some((item) => item.includes('unavailable')));
  await verifyQualityLayout(page);
  await page.screenshot({ path: path.join(output, `quality-review-history-${viewport.name}.png`), fullPage: true });
}

async function verifyQualityLayout(page) {
  await assertNoHorizontalScroll(page, '.workflow-view-shell');
  await assertNoHorizontalScroll(page, '.workflow-outcome-panel');
  await assertNoHorizontalScroll(page, '.quality-review-section');
  if (await page.locator('.quality-review-decision, .quality-review-decision-summary').count())
    await assertNoOverlap(page, '.quality-review-report', '.quality-review-decision, .quality-review-decision-summary');
  await assertViewport(page, {
    allowOverflowWithin: [
      '.workflow-process-master',
      '.workflow-task-inspector',
      '.workflow-outcome-requirements',
      '.quality-review-assets'
    ]
  });
}

async function seedFixture() {
  const stateService = await import('../../apps/api/src/state.mjs'),
    { createAssetRecord, createImmutableAssetVersion } = await import('../../apps/api/src/asset-cas.mjs'),
    { pendingTaskExecution } = await import('../../apps/api/src/workflow-execution-support.mjs'),
    { applyWorkflowOutcomeProtocols } = await import('../../apps/api/src/workflow-outcome-definition.mjs'),
    { materializeOutcomeRequirementsInState, evaluateWorkflowOutcomesInState } =
      await import('../../apps/api/src/outcome-service.mjs'),
    { defaultQualityReviewRubric, qualityReviewRubricHash } =
      await import('../../apps/api/src/quality-review-rubric.mjs');
  await stateService.ensureRuntime();
  const state = await stateService.readState(),
    ownerId = state.instance_owner_user_id,
    timestamp = '2026-08-01T00:00:00.000Z',
    rubric = defaultQualityReviewRubric(),
    workstream = workstreamFixture(),
    task = taskFixture(),
    contract = contractFixture(),
    workflow = workflowFixture(timestamp, rubric, qualityReviewRubricHash(rubric));
  applyWorkflowOutcomeProtocols(workflow, [workstream, task]);
  state.projects.push(projectFixture(ownerId));
  state.project_memberships.push(membershipFixture(ownerId));
  state.workspaces.push(...workspaceFixtures());
  state.workflows.push(workflow);
  state.workflow_nodes.push(workstream, task);
  state.node_contracts.push(contract);
  const execution = executionFixture(timestamp),
    taskExecution = pendingTaskExecution(execution, task, contract, ownerId, timestamp);
  Object.assign(taskExecution, {
    status: 'completed',
    readiness: { ready: true, reasons: [] },
    context_snapshot: { inputs: [], system_context: { document_versions: [] }, asset_mounts: [] },
    input_snapshot_hash: 'a'.repeat(64),
    evidence: { evidence_refs: ['source:quality-review-browser'] },
    completed_at: timestamp,
    updated_at: timestamp
  });
  state.workflow_executions.push(execution);
  state.task_executions.push(taskExecution);
  await addAssetVersions(state, taskExecution, ownerId, createAssetRecord, createImmutableAssetVersion);
  materializeOutcomeRequirementsInState(state, execution, workflow, timestamp);
  evaluateWorkflowOutcomesInState(state, execution.id, { timestamp });
  assert.equal(execution.completion_status, 'completed_with_gaps');
  assert.equal(execution.outcome_summary.mandatory_gaps, 1);
  await stateService.writeState(state);
  await stateService.checkpointAndCloseState();
}

async function addAssetVersions(state, taskExecution, ownerId, createAssetRecord, createImmutableAssetVersion) {
  const specs = [
    {
      key: 'main',
      title: '最终质量报告',
      assetType: 'DocumentAsset',
      payload: contentPayload('')
    },
    {
      key: 'appendix',
      title: '补充分析附件',
      assetType: 'DocumentAsset',
      payload: {
        payload_kind: 'text',
        media_type: 'text/markdown',
        content: '# 补充分析\n\n这是可选背景材料，不属于最终交付。',
        files: []
      }
    },
    {
      key: 'recording',
      title: '访谈录音',
      assetType: 'AudioAsset',
      payload: {
        payload_kind: 'binary',
        media_type: 'audio/mpeg',
        content: Buffer.from('ID3 quality review browser fixture')
      }
    }
  ];
  for (const spec of specs) {
    const asset = createAssetRecord({
      projectId: PROJECT_ID,
      workspaceId: 'workspace-v23-quality-task',
      taskId: 'task-v23-quality',
      taskExecutionId: taskExecution.id,
      assetType: spec.assetType,
      title: spec.title,
      outputKey: spec.key,
      actorId: ownerId
    });
    state.assets.push(asset);
    const version = await createImmutableAssetVersion(state, {
      asset,
      payload: spec.payload,
      evidenceRefs: ['source:quality-review-browser'],
      actorId: ownerId,
      outputKey: spec.key
    });
    taskExecution.output_bindings.push({ key: spec.key, version_id: version.id });
  }
}

async function mockReviewerReadiness(page) {
  const state = { mode: 'ready' };
  await page.route('**/api/workflow-executions/*/quality-reviews/prepare', async (route) => {
    const response = await route.fetch({ maxRetries: 1 }),
      body = await response.json();
    await route.fulfill({ response, json: { ...body, reviewer_readiness: reviewerReadinessFixture(state.mode) } });
  });
  return { setMode: (mode) => (state.mode = mode) };
}

function reviewerReadinessFixture(mode) {
  const checkedAt = new Date().toISOString(),
    ready = mode === 'ready',
    check = (name) => ({
      status: ready || name === 'profile' ? 'passed' : name === 'probe' || name === 'vision' ? 'not_checked' : 'failed',
      ready: ready || name === 'profile',
      code: ready || name === 'profile' ? null : readinessFailureCode(name),
      checked_at: checkedAt,
      details: name === 'image' ? { image: 'aiws-codex-runner:2.3.0-codex-0.144.0' } : {}
    });
  return {
    status: ready ? 'ready' : 'unavailable',
    ready,
    advice_available: ready,
    checked_at: checkedAt,
    profile: {
      id: 'reviewer_profile_browser',
      provider: 'openai',
      model: 'browser-reviewer',
      kind: 'codex',
      image: 'aiws-codex-runner:2.3.0-codex-0.144.0',
      status: 'validated'
    },
    checks: Object.fromEntries(['profile', 'image', 'credential', 'probe', 'vision'].map((name) => [name, check(name)]))
  };
}

function readinessFailureCode(name) {
  return (
    {
      image: 'reviewer_runner_image_unavailable',
      credential: 'reviewer_credential_reference_missing',
      probe: 'reviewer_check_not_run',
      vision: 'reviewer_check_not_run'
    }[name] || 'reviewer_check_failed'
  );
}

async function mockSetupStatus(page) {
  await page.route('**/api/setup/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        complete: true,
        can_complete: true,
        mode: 'byo',
        steps: { github: { ready: true }, codex: { ready: true } },
        reasons: []
      })
    })
  );
}

function sendFixtureCommand(server, command) {
  assert.ok(server?.connected, 'fixture server IPC is unavailable');
  const requestId = `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error(`fixture command timed out: ${command.type}`)), 10_000),
      onMessage = (message) => {
        if (message?.request_id !== requestId) return;
        finish(message.ok ? resolve : reject, message.ok ? message.result : new Error(message.error));
      },
      finish = (callback, value) => {
        clearTimeout(timer);
        server.off('message', onMessage);
        callback(value);
      };
    server.on('message', onMessage);
    server.send({ ...command, request_id: requestId });
  });
}

async function waitForServer(server, serverLog, port) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (server?.exitCode != null) throw new Error(`API exited before ready: ${server.exitCode}\n${serverLog()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`API did not start\n${serverLog()}`);
}

async function stopServer(server) {
  if (!server) return;
  if (server.exitCode == null) server.kill();
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (server.exitCode == null) server.kill('SIGKILL');
}

function buildWeb() {
  const result = spawnSync(process.execPath, ['scripts/build-web.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, `web build failed:\n${result.stdout}\n${result.stderr}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
