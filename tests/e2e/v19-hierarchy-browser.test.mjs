import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { assertA11y, assertNoOverlap, assertViewport, browserExecutable } from './playwright-helpers.mjs';
import {
  assertAssistScope,
  assertReplanResponsiveLayout,
  assertWorkflowProcessSemantics,
  assertWorkflowTaskSelectionJourney
} from './v19-hierarchy-browser-helpers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v19-browser-'));
const home = path.join(root, 'home');
const port = Number(process.env.AIWS_V19_BROWSER_PORT || 4598);
const output = process.env.AIWS_TEST_REPORT_DIR
  ? path.resolve(process.env.AIWS_TEST_REPORT_DIR, 'e2e-v19')
  : path.resolve('.ai-workspace', 'e2e-v19');
const viewports = [
  { name: 'wide', width: 1920, height: 1080 },
  { name: 'ultrawide', width: 2560, height: 1440 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
].filter((item) => !process.env.AIWS_TEST_VIEWPORT || item.name === process.env.AIWS_TEST_VIEWPORT);
let browser,
  server,
  serverLog = '';

process.env.AIWS_HOME = home;
process.env.NODE_ENV = 'test';
fs.mkdirSync(output, { recursive: true });

try {
  const fixture = await seedHierarchyProject();
  server = spawn(process.execPath, ['apps/api/server.mjs'], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AIWS_HOME: home, AIWS_PORT: String(port), AIWS_BYPASS_SETUP: '1', NODE_ENV: 'test' }
  });
  server.stdout.on('data', (chunk) => {
    serverLog += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });
  await waitForServer();
  browser = await chromium.launch({ headless: true, ...browserExecutable() });

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage(),
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

    await verifyHierarchyJourney(page, fixture, viewport);
    assert.deepEqual(
      errors.filter((item) => !item.includes('favicon')),
      [],
      `${viewport.name} browser errors:\n${errors.join('\n')}`
    );
    await context.close();
  }

  console.log(`V1.9 hierarchy and scoped Assist browser tests passed; screenshots: ${output}`);
} finally {
  await browser?.close();
  if (server?.exitCode == null) server.kill();
  if (server)
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  if (server?.exitCode == null) server.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

async function verifyHierarchyJourney(page, fixture, viewport) {
  const workflowUrl = await openAndVerifyWorkflowProcess(page, fixture, viewport);
  const replan = page.getByRole('button', { name: '重新规划' });
  assert.equal((await replan.textContent())?.trim(), '', 'replan must be an icon-only secondary action');
  assert.equal(
    await page.locator('.workflow-view-shell .button.primary:visible').count(),
    1,
    'Start DAG must be the only bright primary command before execution'
  );
  await replan.click();
  await assertReplanResponsiveLayout(page, viewport, true);
  await page.getByText('Collect release evidence with provenance', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `workflow-process-${viewport.name}.png`), fullPage: true });
  await assertA11y(page, `V1.9 complete workflow ${viewport.name}`);
  await page.getByRole('button', { name: '关闭重新规划' }).click();
  await assertReplanResponsiveLayout(page, viewport, false);
  await page.getByRole('tab', { name: '成果视图' }).click();
  assert.equal(
    await page.locator('.workflow-density-menu').count(),
    0,
    'density controls only belong to the complete process view'
  );
  await page.locator('.workflow-page .workspace-node').first().waitFor();
  assert.equal(
    await page.locator('.workflow-page .workspace-node').count(),
    2,
    'the top canvas renders only Workstreams'
  );
  assert.equal(
    await page.getByText('Collect release evidence', { exact: true }).count(),
    0,
    'Task titles do not leak onto the parent canvas'
  );
  await assertAssistScope(page, fixture, output, {
    label: '工作流',
    icon: 'lucide-git-branch',
    breadcrumb: `${fixture.projectTitle} / ${fixture.workflowTitle}`,
    thread: 'Workflow-only thread',
    forbidden: ['Project-only thread', 'Workstream-only thread', 'Task-only thread']
  });

  await page.goto(`http://127.0.0.1:${port}/projects`);
  await page.getByRole('heading', { name: '项目' }).waitFor();
  await assertAssistScope(page, fixture, output, {
    label: '项目',
    icon: 'lucide-folder-kanban',
    breadcrumb: fixture.projectTitle,
    thread: 'Project-only thread',
    forbidden: ['Workflow-only thread', 'Workstream-only thread', 'Task-only thread']
  });

  await page.goto(workflowUrl);
  await page.getByRole('tab', { name: '成果视图' }).click();
  const workstreamCard = page.locator('.workspace-node').filter({ hasText: fixture.workstreamTitle });
  await workstreamCard.waitFor();
  await page.getByRole('button', { name: '放大' }).click();
  await page.getByRole('button', { name: '放大' }).click();
  await page.waitForTimeout(100);
  await workstreamCard.click();
  await page.locator('.node-inspector').waitFor();
  await page.locator('.node-inspector').getByRole('button', { name: '进入成果节点' }).click();
  await page.waitForURL(`**/projects/${fixture.projectId}/workflow/${fixture.workstreamId}`);
  await page.reload();
  const storedView = await page.evaluate(
    (workflowId) => JSON.parse(sessionStorage.getItem(`aiws:v19:workflow-view:${workflowId}`) || 'null'),
    fixture.workflowId
  );
  assert.equal(storedView.selectedId, fixture.workstreamId);
  assert.equal(storedView.inspectorOpen, true);

  await page.locator('.workstream-page').waitFor();
  assert.equal(
    await page.locator('.workflow-page').count(),
    0,
    'mobile and desktop both navigate to a separate child page'
  );
  const breadcrumb = await page.locator('.workflow-breadcrumb').textContent();
  for (const label of [fixture.projectTitle, fixture.workflowTitle, fixture.workstreamTitle])
    assert.match(breadcrumb || '', new RegExp(escapeRegExp(label)));
  assert.equal(await page.locator('.task-list [role="listitem"]').count(), 3);
  const openTask = page.getByRole('button', { name: '进入任务工作台：Collect release evidence' });
  await openTask.focus();
  const openStyle = await openTask.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: Number.parseFloat(style.height),
      color: style.color,
      background: style.backgroundColor,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineStyle: style.outlineStyle
    };
  });
  assert.ok(openStyle.height >= 36, `Task open action is too short: ${JSON.stringify(openStyle)}`);
  assert.ok(
    contrastRatio(openStyle.color, openStyle.background) >= 4.5,
    `Task open action contrast is too low: ${JSON.stringify(openStyle)}`
  );
  assert.ok(
    openStyle.outlineWidth >= 3 && openStyle.outlineStyle !== 'none',
    `Task open focus indicator is insufficient: ${JSON.stringify(openStyle)}`
  );
  await page.screenshot({ path: path.join(output, `workstream-list-${viewport.name}.png`), fullPage: true });

  await page.getByRole('tab', { name: '看板' }).click();
  await page.locator('.task-board').waitFor();
  assert.equal(await page.locator('.task-board > section').count(), 5);
  assert.equal(await page.locator('.task-board').getByText('Collect release evidence', { exact: true }).count(), 1);
  await page.screenshot({ path: path.join(output, `workstream-board-${viewport.name}.png`), fullPage: true });

  await page.getByRole('tab', { name: '结构' }).click();
  await page.locator('.task-structure .react-flow__node').first().waitFor();
  assert.equal(await page.locator('.task-structure .react-flow__node').count(), 3);
  assert.equal(
    await page.locator('.task-structure .react-flow__edge').count(),
    2,
    'branching task dependencies render only in the local graph'
  );
  assert.equal(
    await page.locator('.workspace-node .react-flow,.node-inspector .react-flow').count(),
    0,
    'the local graph is never embedded in a parent card or Inspector'
  );
  await page.screenshot({ path: path.join(output, `workstream-structure-${viewport.name}.png`), fullPage: true });
  await assertViewport(page);

  await page.getByRole('tab', { name: '列表' }).click();
  await assertAssistScope(page, fixture, output, {
    label: '成果节点',
    icon: 'lucide-boxes',
    breadcrumb: `${fixture.projectTitle} / ${fixture.workflowTitle} / ${fixture.workstreamTitle}`,
    thread: 'Workstream-only thread',
    forbidden: ['Project-only thread', 'Workflow-only thread', 'Task-only thread']
  });

  await page.locator('.task-list [role="listitem"]').filter({ hasText: 'Collect release evidence' }).click();
  await assertAssistScope(page, fixture, output, {
    label: '任务',
    icon: 'lucide-list-todo',
    breadcrumb: `${fixture.projectTitle} / ${fixture.workflowTitle} / ${fixture.workstreamTitle} / Collect release evidence`,
    thread: 'Task-only thread',
    forbidden: ['Project-only thread', 'Workflow-only thread', 'Workstream-only thread', 'Sibling-task-only thread']
  });

  await page.getByRole('button', { name: '返回顶层工作流' }).click();
  await page.waitForURL(`**/projects/${fixture.projectId}/workflow`);
  await page.getByRole('tab', { name: '成果视图' }).click();
  await page.locator('.node-inspector').waitFor();
  assert.equal(
    await page.locator('.node-inspector').getByText(fixture.workstreamTitle, { exact: true }).count(),
    1,
    'the selected Workstream and Inspector are restored'
  );
  await page.waitForFunction(
    ({ expected }) => {
      const viewportNode = document.querySelector('.workflow-page .react-flow__viewport');
      if (!viewportNode) return false;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(viewportNode).transform);
      return (
        Math.abs(matrix.m41 - expected.x) < 2 &&
        Math.abs(matrix.m42 - expected.y) < 2 &&
        Math.abs(matrix.a - expected.zoom) < 0.02
      );
    },
    { expected: storedView.viewport }
  );
  if (viewport.width > 700) {
    const addButton = page.getByRole('button', { name: '添加成果节点' });
    await addButton.hover();
    const tooltip = await addButton.evaluate((element) => {
      const style = getComputedStyle(element, '::after');
      return {
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        whiteSpace: style.whiteSpace
      };
    });
    assert.ok(
      tooltip.width >= 60 && tooltip.height <= 30,
      `canvas tooltip must stay horizontal: ${JSON.stringify(tooltip)}`
    );
  }
  await page.screenshot({ path: path.join(output, `workflow-restored-${viewport.name}.png`) });
  await assertViewport(page);
}

async function openAndVerifyWorkflowProcess(page, fixture, viewport) {
  const workflowUrl = `http://127.0.0.1:${port}/projects/${fixture.projectId}/workflow`;
  await page.goto(workflowUrl);
  await page.locator('.workflow-full-process').waitFor();
  assert.equal(
    await page.getByRole('tab', { name: '完整流程' }).getAttribute('aria-selected'),
    'true',
    'verified workflows open on the visible Task DAG'
  );
  assert.equal(
    await page.locator('.workflow-phase-coverage [role="listitem"]').count(),
    6,
    'the complete view exposes six-stage coverage'
  );
  assert.equal(
    await page.locator('.workflow-process-task').count(),
    4,
    'the complete view exposes every Task in its Workstream DAG'
  );
  assert.equal(await page.locator('.workflow-task-details').count(), 0, 'row metadata stays collapsed until requested');
  const summaryHeights = await page
    .locator('.workflow-task-summary')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  assert.ok(
    summaryHeights.every((height) => height <= (viewport.width <= 600 ? 80 : 72)),
    `comfortable Task summaries exceed their target: ${JSON.stringify(summaryHeights)}`
  );
  await assertWorkflowProcessSemantics(page, output, viewport);
  await assertViewport(page);
  await assertNoOverlap(page, '.workflow-full-process', '.command-dock');
  await page.screenshot({ path: path.join(output, `workflow-compact-${viewport.name}.png`), fullPage: true });
  await assertWorkflowTaskSelectionJourney(page, viewport);
  await assertViewport(page);
  await assertNoOverlap(page, '.workflow-full-process', '.command-dock');
  await page.screenshot({ path: path.join(output, `workflow-expanded-${viewport.name}.png`), fullPage: true });
  return workflowUrl;
}

async function seedHierarchyProject() {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const { activateDraftInState, createDraftProjectRecords } = await import('../../apps/api/src/project-lifecycle.mjs');
  const { makeSession, resolveScope } = await import('../../apps/api/src/assist-v3-domain.mjs');
  await stateApi.ensureRuntime();
  const actor = stateApi.owner(await stateApi.readState());
  let fixture;
  await stateApi.mutate((state) => {
    const created = createDraftProjectRecords(
      {
        title: 'Outcome delivery studio',
        goal: 'Deliver independently accepted release outcomes',
        mode: 'brainstorm',
        answers: { goal: 'Deliver independently accepted release outcomes' }
      },
      actor
    );
    created.project.managed_workspace_state = 'ready';
    state.projects.push(created.project);
    state.workspaces.push(created.workspace);
    state.project_intakes.push(created.intake);
    state.project_briefs.push(created.brief);
    state.workflow_drafts.push(created.workflowDraft);
    state.assist_sessions.push(created.session);
    const activated = activateDraftInState(state, created.project, created.brief, hierarchy(), actor.id);
    activated.workflow.planning_quality = 'verified';
    const workstream = activated.nodes.find((item) => item.id === 'ws-release-evidence');
    const task = activated.nodes.find((item) => item.id === 'task-collect-evidence');
    const siblingTask = activated.nodes.find((item) => item.id === 'task-verify-build');
    const currentNodes = activated.nodes.map((item) => ({
      ...item,
      dependency_ids: (item.dependencies || []).map((entry) => entry.node_id)
    }));
    const candidateNodes = currentNodes.map((item) =>
      item.id === task.id ? { ...item, title: 'Collect release evidence with provenance' } : item
    );
    state.workflow_generations.push({
      id: 'wfg-browser-replan',
      project_id: created.project.id,
      workflow_id: activated.workflow.id,
      mode: 'replan',
      status: 'completed',
      phase: 'completed',
      result_mode: 'replan_diff',
      candidate: { nodes: candidateNodes, confidence: 0.88 },
      diff: {
        workflow_id: activated.workflow.id,
        from_revision: activated.workflow.workflow_revision,
        current_nodes: currentNodes,
        candidate_nodes: candidateNodes
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    created.session.title = 'Project-only thread';
    const scopeSessions = [
      ['workflow', activated.workflow.id, 'Workflow-only thread'],
      ['workstream', workstream.id, 'Workstream-only thread'],
      ['task', task.id, 'Task-only thread'],
      ['task', siblingTask.id, 'Sibling-task-only thread']
    ];
    for (const [scopeType, scopeId, title] of scopeSessions) {
      const scope = resolveScope(state, created.project, scopeType, scopeId);
      state.assist_sessions.push(
        makeSession({
          actor,
          project: created.project,
          scope,
          title,
          viewContext: { route: `/projects/${created.project.id}/workflow` }
        })
      );
    }
    fixture = {
      projectId: created.project.id,
      projectTitle: created.project.title,
      workflowId: activated.workflow.id,
      workflowTitle: activated.workflow.title,
      workstreamId: workstream.id,
      workstreamTitle: workstream.title,
      taskId: task.id
    };
  });
  return fixture;
}

function hierarchy() {
  return [
    {
      id: 'ws-release-evidence',
      role: 'workstream',
      title: 'Verified release evidence',
      outcome: 'A complete and independently reviewable release evidence package.',
      category: 'deliverable',
      boundary: { repository: 'acme/release' },
      acceptance_criteria: ['Evidence links and build checks are accepted.'],
      dependency_ids: [],
      position: { x: 120, y: 160 },
      tasks: [
        {
          id: 'task-collect-evidence',
          role: 'task',
          title: 'Collect release evidence',
          goal:
            '收集可追溯发布证据。 Collect traceable release evidence with complete provenance. CLI: `node src/cli.mjs collect --date 2026-07-23`. Run at 23:50 Asia/Shanghai. ' +
            'Preserve source provenance and immutable hashes. '.repeat(80),
          task_kind: 'research',
          execution_mode: 'assist',
          dependency_ids: [],
          position: { x: 100, y: 120 }
        },
        {
          id: 'task-verify-build',
          role: 'task',
          title: 'Verify release build',
          goal: 'Run and record build verification',
          task_kind: 'test',
          execution_mode: 'codex',
          dependency_ids: ['task-collect-evidence'],
          position: { x: 420, y: 40 }
        },
        {
          id: 'task-review-notes',
          role: 'task',
          title: 'Review release notes',
          goal: 'Review release notes against evidence',
          task_kind: 'review',
          execution_mode: 'assist',
          dependency_ids: ['task-collect-evidence'],
          position: { x: 420, y: 220 }
        }
      ]
    },
    {
      id: 'ws-launch-decision',
      role: 'workstream',
      title: 'Approved launch decision',
      outcome: 'A recorded launch decision with accepted constraints.',
      category: 'decision',
      boundary: { owner: 'release-owner' },
      acceptance_criteria: ['The launch owner records an explicit decision.'],
      dependency_ids: ['ws-release-evidence'],
      position: { x: 520, y: 160 },
      tasks: [
        {
          id: 'task-record-decision',
          role: 'task',
          title: 'Record launch decision',
          goal: 'Record the accepted launch decision',
          task_kind: 'manual',
          execution_mode: 'manual',
          dependency_ids: []
        }
      ]
    }
  ];
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`API exited ${server.exitCode}:\n${serverLog}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`API startup timed out:\n${serverLog}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function contrastRatio(left, right) {
  const luminance = (value) => {
    const channels = value
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map((item) => Number(item) / 255)
      .map((item) => (item <= 0.04045 ? item / 12.92 : ((item + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const a = luminance(left),
    b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
