import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { assertNoHorizontalScroll, assertNoOverlap, assertViewport, browserExecutable } from './playwright-helpers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v110-browser-'));
const home = path.join(root, 'home'),
  port = Number(process.env.AIWS_V110_BROWSER_PORT || 4599);
const output = process.env.AIWS_TEST_REPORT_DIR
  ? path.resolve(process.env.AIWS_TEST_REPORT_DIR, 'e2e-v110')
  : path.resolve('.ai-workspace', 'e2e-v110');
process.env.AIWS_HOME = home;
process.env.NODE_ENV = 'test';
process.env.AIWS_TEST_ADAPTERS = '1';
fs.mkdirSync(output, { recursive: true });
let browser,
  server,
  serverLog = '';

try {
  const fixture = await seedWorkflow();
  server = spawn(process.execPath, ['apps/api/server.mjs'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AIWS_HOME: home,
      AIWS_PORT: String(port),
      AIWS_BYPASS_SETUP: '1',
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    errors = [],
    writes = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTestAdapterRoutes(page);
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(new URL(request.url()).pathname);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });

  const workflowUrl = `http://127.0.0.1:${port}/projects/${fixture.projectId}/workflow`;
  await page.goto(workflowUrl);
  await page.locator('.workflow-execution-band').waitFor();
  await page.getByRole('button', { name: '启动工作流' }).click();
  await page.locator('.workflow-line-config').getByRole('button', { name: '启动', exact: true }).click();
  await page.locator('.workflow-execution-state').getByText('任务流程运行中', { exact: true }).waitFor();

  await page
    .locator('.workflow-process-master')
    .getByRole('link', { name: `进入任务工作台：${fixture.researchTitle}` })
    .click();
  const checkpoint = page.locator('.task-execution-panel');
  try {
    await checkpoint.getByText('1 项候选输出', { exact: true }).waitFor({ timeout: 30_000 });
  } catch (error) {
    const snapshot = await fixture.stateService.readState(),
      research = latest(snapshot, 'task-research');
    throw new Error(`${error.message}\nresearch=${JSON.stringify(research)}\n${serverLog}`);
  }
  await checkpoint.getByRole('button', { name: '验收', exact: true }).click();
  await checkpoint.getByText('已完成', { exact: true }).waitFor({ timeout: 30_000 });

  await page.goto(workflowUrl);
  await page
    .locator('.workflow-process-master')
    .getByRole('link', { name: `进入任务工作台：${fixture.integrateTitle}` })
    .click();
  const integration = page.locator('.task-execution-panel');
  await integration.getByRole('button', { name: '批准创建' }).waitFor({ timeout: 60_000 });
  await integration.getByRole('button', { name: '批准创建' }).click();
  await integration.getByRole('button', { name: '批准合并' }).waitFor({ timeout: 30_000 });
  await integration.getByRole('button', { name: '批准合并' }).click();
  await integration.getByText('已完成', { exact: true }).waitFor({ timeout: 30_000 });

  await page.goto(workflowUrl);
  await page
    .locator('.workflow-execution-state')
    .getByText('任务流程已完成', { exact: true })
    .waitFor({ timeout: 30_000 });
  while (await page.getByRole('button', { name: '关闭通知' }).count())
    await page.getByRole('button', { name: '关闭通知' }).first().click();
  await page.locator('.operation-notices').waitFor({ state: 'detached', timeout: 10_000 });
  await page.screenshot({ path: path.join(output, 'workflow-completed-desktop.png'), fullPage: true });
  await assertViewport(page);
  await assertNoOverlap(page, '.workflow-full-process', '.command-dock');
  await page.goto(`http://127.0.0.1:${port}/projects/${fixture.projectId}/nodes/task-integrate`);
  await page.locator('.task-execution-panel').waitFor();
  await page.screenshot({ path: path.join(output, 'task-completed-desktop.png'), fullPage: true });
  await assertViewport(page);
  await assertNoHorizontalScroll(page, '.route-stage');
  await page.goto(`http://127.0.0.1:${port}/assets`);
  await page.locator('.asset-detail-heading').waitFor();
  await page.screenshot({ path: path.join(output, 'asset-inspector-desktop.png'), fullPage: true });
  await assertViewport(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(workflowUrl);
  await page.locator('.workflow-execution-band').waitFor();
  await page.screenshot({ path: path.join(output, 'workflow-completed-mobile.png'), fullPage: true });
  await assertViewport(page);
  await assertNoOverlap(page, '.workflow-full-process', '.command-dock');
  await page.goto(`http://127.0.0.1:${port}/projects/${fixture.projectId}/nodes/task-integrate`);
  await page.locator('.task-execution-panel').waitFor();
  await page.screenshot({ path: path.join(output, 'task-completed-mobile.png'), fullPage: true });
  await assertViewport(page);
  await assertNoHorizontalScroll(page, '.route-stage');
  await page.goto(`http://127.0.0.1:${port}/assets`);
  await page.locator('.asset-detail-heading').waitFor();
  await page.screenshot({ path: path.join(output, 'asset-inspector-mobile.png'), fullPage: true });
  await assertViewport(page);

  const state = await fixture.stateService.readState();
  const workflowExecution = state.workflow_executions.find((item) => item.workflow_id === fixture.workflowId);
  const line = state.repository_lines.find((item) => item.workflow_execution_id === workflowExecution.id);
  const intent = state.pull_request_intents.find((item) => item.repository_line_id === line.id);
  const code = latest(state, fixture.codeId),
    test = latest(state, fixture.testId);
  assert.equal(workflowExecution.status, 'completed');
  assert.equal(line.status, 'merged');
  assert.equal(intent.approvals.length, 2);
  assert.equal(code.status, 'completed');
  assert.equal(test.status, 'completed');
  assert.deepEqual(latest(state, 'task-integrate').readiness.reasons, []);
  assert.equal(
    code.output_bindings[0].repository_sha,
    test.output_bindings[0].repository_sha,
    'verification consumes the exact committed SHA'
  );
  assert.ok(
    state.assets.some(
      (item) =>
        item.node_id === fixture.workstreamId &&
        item.asset_type === 'WorkstreamOutcomeAsset' &&
        item.status === 'confirmed'
    )
  );
  assertWriteJourney(writes, fixture.workflowId);
  assert.deepEqual(
    errors.filter((item) => !item.includes('favicon')),
    [],
    `browser errors:\n${errors.join('\n')}\n${serverLog}`
  );
  await context.close();
  console.log(`V1.10 browser DAG checkpoint and PR journey passed; screenshots: ${output}`);
} finally {
  await browser?.close();
  if (server && server.exitCode == null) server.kill();
  if (server)
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  if (server && server.exitCode == null) server.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

async function installTestAdapterRoutes(page) {
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
  await page.route('**/api/workflows/*/executions', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON();
    return route.continue({
      postData: JSON.stringify({
        ...body,
        adapter: 'test',
        test_summary: 'Browser DAG candidate',
        test_changes: [{ path: 'src/verified-change.txt', content: 'verified browser change\n' }],
        test_use_required_inputs: true,
        test_use_required_context: true
      }),
      headers: { ...request.headers(), 'content-type': 'application/json' }
    });
  });
  await page.route('**/api/pull-request-intents/*/execute', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON();
    return route.continue({
      postData: JSON.stringify({
        ...body,
        adapter: 'test',
        test_checks_status: 'passed',
        test_checks: [],
        ...(body.action === 'merge_pr' ? { test_merge_commit_sha: 'f'.repeat(40) } : {})
      }),
      headers: { ...request.headers(), 'content-type': 'application/json' }
    });
  });
}

async function seedWorkflow() {
  const { managedRepoPath } = await import('../../apps/api/src/managed-workspace.mjs');
  const stateService = await import('../../apps/api/src/state.mjs');
  await stateService.ensureRuntime();
  const repository = managedRepoPath('project-1');
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'package.json'), '{"name":"browser-dag"}\n');
  git(repository, ['init', '-b', 'main']);
  git(repository, ['add', '.']);
  git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
  const baseSha = git(repository, ['rev-parse', 'HEAD']),
    ownerId = (await stateService.readState()).instance_owner_user_id;
  await stateService.mutate((state) => seedState(state, repository, baseSha, ownerId));
  return {
    stateService,
    projectId: 'project-1',
    workflowId: 'workflow-1',
    workstreamId: 'workstream-1',
    researchTitle: 'Collect evidence',
    integrateTitle: 'Integrate verified change',
    codeId: 'task-code',
    testId: 'task-test'
  };
}

function seedState(state, repository, baseSha, ownerId) {
  state.projects.push({
    id: 'project-1',
    title: 'V1.10 browser DAG',
    goal: 'Ship one verified repository change',
    status: 'active',
    onboarding_state: 'confirmed',
    managed_workspace_state: 'ready',
    repo_path: repository,
    workspace_root: path.dirname(repository),
    current_workspace_id: 'workspace-root',
    lifecycle_operation: null,
    deleted_at: null,
    settings: {}
  });
  state.project_memberships.push({
    id: 'membership-1',
    project_id: 'project-1',
    user_id: ownerId,
    role: 'owner',
    status: 'active'
  });
  state.workspaces.push(
    { id: 'workspace-root', project_id: 'project-1', title: 'Project' },
    { id: 'workspace-workstream', project_id: 'project-1', workflow_node_id: 'workstream-1', title: 'Delivery' },
    ...['research', 'code', 'test', 'integrate'].map((name) => ({
      id: `workspace-${name}`,
      project_id: 'project-1',
      workflow_node_id: `task-${name}`,
      title: name
    }))
  );
  state.workflows.push({
    id: 'workflow-1',
    project_id: 'project-1',
    workspace_id: 'workspace-root',
    title: 'Verified delivery',
    goal: 'Run the complete DAG',
    status: 'active',
    planning_quality: 'verified',
    project_classification: 'software',
    workflow_revision: 1,
    version: 1,
    brief_coverage: {}
  });
  state.workflow_nodes.push(
    {
      id: 'workstream-1',
      workflow_id: 'workflow-1',
      workspace_id: 'workspace-workstream',
      role: 'workstream',
      title: 'Browser delivery',
      goal: 'Deliver a merged verified change',
      outcome: 'Merged repository version',
      category: 'deliverable',
      status: 'pending',
      dependencies: [],
      order_index: 0
    },
    task('research', 'Collect evidence', 'research', [], 1),
    task('code', 'Implement change', 'code', ['task-research'], 2),
    task('test', 'Verify committed SHA', 'test', ['task-code'], 3),
    task('integrate', 'Integrate verified change', 'integration', ['task-test'], 4)
  );
  state.node_contracts.push(
    contract('research', [], outputSlot('research_result', 'ResearchEvidenceAsset', 'human')),
    contract(
      'code',
      [inputSlot('research', 'task-research', 'research_result')],
      outputSlot('repository_version', 'RepositoryVersionAsset', 'system_evidence')
    ),
    contract(
      'test',
      [inputSlot('repository', 'task-code', 'repository_version')],
      outputSlot('test_report', 'TestReportAsset', 'system_evidence')
    ),
    contract(
      'integrate',
      [inputSlot('verification', 'task-test', 'test_report')],
      outputSlot('integration_evidence', 'IntegrationEvidenceAsset', 'system_evidence')
    )
  );
  state.repository_connections.push({
    id: 'connection-1',
    project_id: 'project-1',
    provider: 'github',
    repository_id: '1',
    full_name: 'fixture/browser-dag',
    installation_id: '1',
    default_branch: 'main',
    remote_name: 'origin',
    local_path: repository,
    sync_status: 'ready',
    permissions: { read: true, push: true, pull_requests: true }
  });
  state.delivery_policies.push({
    id: 'policy-1',
    project_id: 'project-1',
    workflow_id: 'workflow-1',
    workstream_id: 'workstream-1',
    connection_id: 'connection-1',
    base_ref: 'main',
    path_prefixes: ['.'],
    test_commands: ['node -e "process.exit(0)"'],
    automation_permissions: ['codex_run', 'commit', 'push', 'draft_pr'],
    policy_hash: 'policy',
    status: 'approved',
    approved_by_user_id: ownerId,
    approved_at: new Date().toISOString()
  });
  assert.match(baseSha, /^[a-f0-9]{40}$/);
}

function task(name, title, kind, dependencies, order) {
  return {
    id: `task-${name}`,
    workflow_id: 'workflow-1',
    parent_node_id: 'workstream-1',
    workspace_id: `workspace-${name}`,
    role: 'task',
    title,
    goal: title,
    status: 'pending',
    task_kind: kind,
    execution_mode: 'codex',
    execution_revision: 1,
    current_contract_id: `contract-${name}`,
    dependencies: dependencies.map((node_id) => ({ node_id, type: 'finish_to_start' })),
    order_index: order
  };
}
function contract(name, expectedInputs, expectedOutput) {
  return {
    id: `contract-${name}`,
    node_id: `task-${name}`,
    version: 1,
    expected_inputs: expectedInputs,
    expected_outputs: [expectedOutput],
    acceptance_criteria: expectedOutput.acceptance_criteria
  };
}
function inputSlot(key, refId, selector) {
  return { key, kind: 'asset_version', required: true, source: 'dependency', ref_id: refId, selector };
}
function outputSlot(key, assetType, policy) {
  return {
    key,
    kind: 'asset',
    required: true,
    asset_type: assetType,
    confirmation_policy: policy,
    acceptance_criteria: [`${key} accepted`]
  };
}
function latest(state, taskId) {
  return state.task_executions.filter((item) => item.task_id === taskId).sort((a, b) => b.attempt - a.attempt)[0];
}
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}
function assertWriteJourney(writes, workflowId) {
  const expected = [
    `/api/workflows/${workflowId}/executions`,
    '/human-approve',
    '/approve',
    '/execute',
    '/approve',
    '/execute'
  ];
  assert.equal(writes.length, expected.length, `unexpected browser writes: ${JSON.stringify(writes)}`);
  assert.equal(writes[0], expected[0]);
  for (let index = 1; index < expected.length; index += 1)
    assert.ok(writes[index].endsWith(expected[index]), `${writes[index]} does not end with ${expected[index]}`);
  assert.equal(
    writes.some((item) => /manual-submit|output-bindings|\/run\/start|\/deliveries$/.test(item)),
    false
  );
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
