import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

import {
  assertInsideViewport,
  assertNoHorizontalScroll,
  assertNoOverlap,
  assertViewport,
  browserExecutable
} from './playwright-helpers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v21-browser-')),
  home = path.join(root, 'home'),
  port = Number(process.env.AIWS_V21_BROWSER_PORT || 4611),
  output = process.env.AIWS_TEST_REPORT_DIR
    ? path.resolve(process.env.AIWS_TEST_REPORT_DIR, 'e2e-v21-outcomes')
    : path.resolve('.ai-workspace', 'e2e-v21-outcomes'),
  viewports = [
    { name: 'ultrawide', width: 2560, height: 1440 },
    { name: 'wide', width: 1920, height: 1080 },
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'laptop', width: 1024, height: 768 },
    { name: 'tablet', width: 768, height: 900 },
    { name: 'mobile', width: 390, height: 844 }
  ].filter((item) => !process.env.AIWS_TEST_VIEWPORT || item.name === process.env.AIWS_TEST_VIEWPORT);

process.env.AIWS_HOME = home;
process.env.NODE_ENV = 'test';
process.env.AIWS_TEST_ADAPTERS = '1';
fs.mkdirSync(output, { recursive: true });

let browser,
  server,
  serverLog = '';

try {
  buildWeb();
  await seedFixture();
  server = spawn(process.execPath, ['apps/api/server.mjs'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AIWS_HOME: home,
      AIWS_PORT: String(port),
      AIWS_BYPASS_SETUP: '1',
      AIWS_CONTEXT_REPOSITORY_FILE_LIMIT: '0',
      NODE_ENV: 'test',
      AIWS_TEST_ADAPTERS: '1'
    }
  });
  server.stdout.on('data', (chunk) => {
    serverLog += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });
  await waitForServer();

  browser = await chromium.launch({ headless: true, ...browserExecutable() });
  for (const viewport of viewports) await verifyViewport(viewport);
  console.log(
    `V2.1 Outcome/stage/Context worker ${viewports.length}-viewport browser tests passed; screenshots: ${output}`
  );
} finally {
  await browser?.close();
  if (server && server.exitCode == null) server.kill();
  if (server)
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ]);
  if (server && server.exitCode == null) server.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

async function verifyViewport(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 }),
    page = await context.newPage(),
    errors = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });

  await verifyWorkflow(page, viewport);
  await verifyContextWorker(page, viewport);
  assert.deepEqual(
    errors.filter((item) => !item.includes('favicon')),
    [],
    `${viewport.name} browser errors:\n${errors.join('\n')}\n${serverLog}`
  );
  await context.close();
}

async function verifyWorkflow(page, viewport) {
  await page.goto(`http://127.0.0.1:${port}/projects/project-v21/workflow`);
  await page.locator('.workflow-execution-band').waitFor();
  await page.getByText('完成但有缺口', { exact: true }).waitFor();
  const badge = page.locator('.workflow-completion-badge');
  assert.equal(await badge.getAttribute('data-tooltip'), 'Release blocked');

  await page.getByRole('button', { name: 'Outcome', exact: true }).click();
  const outcomes = page.locator('.workflow-outcome-panel');
  await outcomes.getByText('Mandatory gap', { exact: true }).waitFor();
  await outcomes.getByText('DesignSignal source coverage', { exact: true }).waitFor();
  assert.equal(await outcomes.locator('input[type="checkbox"]').count(), 1);
  assert.equal(await outcomes.getByText('Waiver 理由', { exact: true }).count(), 1);

  const stages = page.locator('.workflow-task-stages');
  if (!(await stages.isVisible().catch(() => false))) {
    const disclosure = page.getByRole('button', { name: /展开任务详情：验证真实完成/ });
    if (await disclosure.count()) await disclosure.click();
  }
  await stages.waitFor();
  for (const label of ['Preflight', 'Execute', 'Collect', 'Verify', 'Attest', 'Promote', 'Finalize'])
    await stages.getByText(label, { exact: true }).waitFor();
  const replay = page.getByRole('button', { name: '仅重放 Verify 阶段' });
  await replay.waitFor();
  assert.equal(await replay.isEnabled(), true);
  await replay.scrollIntoViewIfNeeded();
  await assertNoHorizontalScroll(page, '.workflow-task-stages');
  await assertInsideViewport(page, '.task-stage-timeline li.failed .icon-button');

  await assertNoHorizontalScroll(page, '.workflow-view-shell');
  await assertViewport(page, {
    allowOverflowWithin: [
      '.workflow-process-master',
      '.workflow-task-inspector',
      '.workflow-outcome-requirements',
      '.task-stage-timeline'
    ]
  });
  await assertNoOverlap(page, '.workflow-execution-band', '.workflow-view-layout');
  await page.screenshot({ path: path.join(output, `workflow-outcome-stages-${viewport.name}.png`), fullPage: true });
}

async function verifyContextWorker(page, viewport) {
  await page.goto(`http://127.0.0.1:${port}/context`);
  await page.getByRole('heading', { name: '上下文地图' }).waitFor();
  const trigger = page.getByRole('button', { name: 'Context worker 状态' });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Context worker 状态' });
  await menu.waitFor();
  for (const label of [
    'Worker',
    'Heartbeat',
    'Oldest job',
    'Lease / Failed',
    'Index rebuild',
    'Lease recovery',
    'Event loop lag'
  ])
    await menu.getByText(label, { exact: true }).waitFor();
  await assertInsideViewport(page, '.context-worker-menu');
  await assertNoHorizontalScroll(page, '.context-map-page');
  await assertViewport(page, {
    allowOverflowWithin: [
      '.context-directory-list',
      '.context-document-tabs',
      '.context-document-body',
      '.context-details'
    ]
  });
  if (viewport.width > 768) {
    await assertNoOverlap(page, '.context-directory', '.context-document');
    await assertNoOverlap(page, '.context-document', '.context-details');
  }
  await page.screenshot({ path: path.join(output, `context-worker-${viewport.name}.png`), fullPage: true });
}

async function seedFixture() {
  const { protocolHash } = await import('../../packages/execution-protocol/src/index.mjs'),
    stateService = await import('../../apps/api/src/state.mjs'),
    { materializeOutcomeRequirementsInState, evaluateWorkflowOutcomesInState } =
      await import('../../apps/api/src/outcome-service.mjs'),
    { beginExecutionStageInState, completeExecutionStageInState, failExecutionStageInState } =
      await import('../../apps/api/src/execution-stage-service.mjs');
  await stateService.ensureRuntime();
  const ownerId = (await stateService.readState()).instance_owner_user_id,
    timestamp = '2026-07-30T00:00:00.000Z',
    outcomeContract = {
      schema_version: 'aiws.outcome_contract.v1',
      version: 1,
      source: 'declared',
      requirements: [
        requirement('source_coverage', 'DesignSignal source coverage', true, 'metric', 'trusted_metric', true, 0),
        requirement('delivery_receipt', 'Outbox delivery receipt', true, 'delivery', 'delivery_receipt', true, 1)
      ]
    },
    qualityRubric = {
      schema_version: 'aiws.quality_rubric.v1',
      version: 1,
      criteria: [
        {
          id: 'not_applicable',
          title: 'Non-content fixture',
          evaluator: 'evidence_refs',
          mandatory: false,
          applicable: false,
          expected: null,
          authority_mapping: {}
        }
      ]
    };
  await stateService.mutate((state) =>
    seedOutcomeFixtureState(state, {
      ownerId,
      timestamp,
      outcomeContract,
      qualityRubric,
      protocolHash,
      materializeOutcomeRequirementsInState,
      evaluateWorkflowOutcomesInState,
      beginExecutionStageInState,
      completeExecutionStageInState,
      failExecutionStageInState
    })
  );
}

function seedOutcomeFixtureState(
  state,
  {
    ownerId,
    timestamp,
    outcomeContract,
    qualityRubric,
    protocolHash,
    materializeOutcomeRequirementsInState,
    evaluateWorkflowOutcomesInState,
    beginExecutionStageInState,
    completeExecutionStageInState,
    failExecutionStageInState
  }
) {
  state.projects.push({
    id: 'project-v21',
    title: 'AIWS V2.1 Outcome fixture',
    goal: 'Verify completion, replay and worker status',
    status: 'active',
    onboarding_state: 'confirmed',
    managed_workspace_state: 'ready',
    current_workspace_id: 'workspace-v21-root',
    owner_user_id: ownerId,
    created_by_user_id: ownerId,
    lifecycle_operation: null,
    deleted_at: null,
    settings: {}
  });
  state.project_memberships.push({
    id: 'membership-v21-owner',
    project_id: 'project-v21',
    user_id: ownerId,
    role: 'owner',
    status: 'active'
  });
  state.workspaces.push(
    { id: 'workspace-v21-root', project_id: 'project-v21', title: 'Project' },
    {
      id: 'workspace-v21-stream',
      project_id: 'project-v21',
      workflow_node_id: 'workstream-v21',
      title: 'Outcome verification'
    },
    {
      id: 'workspace-v21-task',
      project_id: 'project-v21',
      workflow_node_id: 'task-v21',
      title: 'Verify real completion'
    }
  );
  const workflow = {
    id: 'workflow-v21',
    project_id: 'project-v21',
    workspace_id: 'workspace-v21-root',
    title: 'V2.1 real completion',
    goal: 'Expose Outcome and stage state',
    status: 'active',
    planning_quality: 'verified',
    project_classification: 'software',
    hierarchy_mode: 'canonical',
    workflow_revision: 1,
    version: 1,
    brief_coverage: {},
    outcome_contract: outcomeContract,
    quality_rubric: qualityRubric,
    outcome_contract_hash: protocolHash(outcomeContract),
    quality_rubric_hash: protocolHash(qualityRubric),
    created_at: timestamp,
    updated_at: timestamp
  };
  state.workflows.push(workflow);
  state.workflow_nodes.push(
    {
      id: 'workstream-v21',
      workflow_id: workflow.id,
      workspace_id: 'workspace-v21-stream',
      role: 'workstream',
      title: 'Outcome verification',
      goal: 'Confirm release eligibility',
      outcome: 'Audited completion state',
      category: 'deliverable',
      status: 'blocked',
      dependencies: [],
      order_index: 0
    },
    {
      id: 'task-v21',
      workflow_id: workflow.id,
      parent_node_id: 'workstream-v21',
      workspace_id: 'workspace-v21-task',
      role: 'task',
      title: '验证真实完成',
      goal: 'Replay only the failed verifier',
      outcome: 'Verified evidence',
      status: 'blocked',
      task_kind: 'test',
      execution_mode: 'codex',
      execution_revision: 1,
      current_contract_id: 'contract-v21',
      dependencies: [],
      order_index: 1
    }
  );
  state.node_contracts.push({
    id: 'contract-v21',
    node_id: 'task-v21',
    version: 1,
    expected_inputs: [],
    expected_outputs: [
      {
        key: 'verification',
        kind: 'asset',
        required: true,
        asset_type: 'TestReportAsset',
        confirmation_policy: 'system_evidence',
        acceptance_criteria: ['Verifier passes']
      }
    ],
    acceptance_criteria: ['Verifier passes'],
    allowed_tools: []
  });
  const workflowExecution = {
    id: 'workflow-execution-v21',
    project_id: 'project-v21',
    workflow_id: workflow.id,
    workflow_revision: 1,
    status: 'completed',
    completion_status: 'pending',
    release_eligible: false,
    finalization_state: 'completed',
    outcome_summary: summary(2),
    outcome_facts: {
      source_coverage: {
        status: 'unsatisfied',
        actual: { covered: 5, total: 6 },
        evidence_refs: ['fixture:designsignal-5-of-6']
      },
      delivery_receipt: {
        status: 'satisfied',
        actual: { status: 'sent' },
        evidence_refs: ['fixture:delivery-sent']
      }
    },
    outcome_contract_hash: protocolHash(outcomeContract),
    quality_rubric_hash: protocolHash(qualityRubric),
    frontier: [],
    waiting_reasons: [],
    executor_config: { runner_image_digest: 'sha256:v21-browser-fixture' },
    started_at: timestamp,
    completed_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp
  };
  state.workflow_executions.push(workflowExecution);
  const taskExecution = {
    id: 'task-execution-v21',
    workflow_execution_id: workflowExecution.id,
    project_id: 'project-v21',
    workflow_id: workflow.id,
    workflow_revision: 1,
    task_id: 'task-v21',
    task_revision: 1,
    contract_id: 'contract-v21',
    contract_version: 1,
    executor: 'assist',
    attempt: 1,
    status: 'failed',
    input_snapshot_hash: '3'.repeat(64),
    context_snapshot: { inputs: [], system_context: { document_versions: [] }, asset_mounts: [] },
    output_bindings: [],
    readiness: { ready: false, reasons: [{ code: 'verifier_failed' }] },
    stage_checkpoint_ids: [],
    replay_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: timestamp
  };
  state.task_executions.push(taskExecution);
  materializeOutcomeRequirementsInState(state, workflowExecution, workflow, timestamp);
  evaluateWorkflowOutcomesInState(state, workflowExecution.id, { timestamp });
  seedStageFixture(state, workflowExecution, taskExecution, timestamp, {
    beginExecutionStageInState,
    completeExecutionStageInState,
    failExecutionStageInState
  });
}

function seedStageFixture(state, workflowExecution, taskExecution, timestamp, stageService) {
  for (const stage of ['preflight', 'execute', 'collect']) {
    const token = stageService.beginExecutionStageInState(state, {
      workflowExecutionId: workflowExecution.id,
      taskExecutionId: taskExecution.id,
      stage,
      input: { stage }
    });
    stageService.completeExecutionStageInState(state, token, { output: { passed: true }, timestamp });
  }
  const verify = stageService.beginExecutionStageInState(state, {
    workflowExecutionId: workflowExecution.id,
    taskExecutionId: taskExecution.id,
    stage: 'verify',
    input: { evidence: 'fixture' },
    timestamp
  });
  stageService.failExecutionStageInState(
    state,
    verify,
    Object.assign(new Error('Injected browser verifier failure'), { code: 'verifier_injected_failure' }),
    { category: 'verifier', retryable: true, timestamp }
  );
}

function requirement(id, title, mandatory, scope, evaluator, waivable, order) {
  return { id, title, mandatory, scope, order, evaluator, expected: { passed: true }, waivable, evaluator_config: {} };
}

function summary(total) {
  return { total, pending: total, satisfied: 0, unsatisfied: 0, waived: 0, error: 0, mandatory_gaps: total };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (server?.exitCode != null) throw new Error(`API exited before ready: ${server.exitCode}\n${serverLog}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`API did not start\n${serverLog}`);
}

function buildWeb() {
  const result = spawnSync(process.execPath, ['scripts/build-web.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, `web build failed:\n${result.stdout}\n${result.stderr}`);
}
