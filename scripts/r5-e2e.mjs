import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { start as startApi } from '../apps/api/server-legacy.mjs';
import { start as startBroker } from '../apps/runner-broker/server.mjs';

const root = process.cwd();
const reportDir = path.join(root, '.ai-workspace', 'e2e-r5');
const receiptPath = path.join(reportDir, 'receipt.json');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 }
];

if (process.env.R5_E2E_SKIP_BUILD !== '1') {
  const build = spawnSync('corepack', ['pnpm', '--filter', '@aiws/web', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  if (build.status !== 0) process.exit(build.status || 1);
}

fs.rmSync(reportDir, { recursive: true, force: true });
fs.mkdirSync(reportDir, { recursive: true });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r5-e2e-'));
const secret = 'r5-e2e-secret';
const digest = `sha256:${'e'.repeat(64)}`;
const broker = await startBroker({
  config: {
    host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3',
    runnerDigest: digest, executor: 'mock', runnerImage: `runner@${digest}`
  }
});
const brokerUrl = `http://127.0.0.1:${broker.server.address().port}`;
const app = await startApi({
  config: {
    version: '3.0.0', apiPrefix: '/api/v1', host: '127.0.0.1', port: 0,
    home, databaseFile: path.join(home, 'data', 'state.sqlite'), casRoot: path.join(home, 'cas'),
    dataVolume: 'aiws-data-v3', brokerUrl, brokerMode: 'http', brokerSecret: secret,
    runnerDigest: digest, codexAvailable: false, githubAvailable: false, testOnlyBypassSetupGate: true
  }
});
const base = `http://127.0.0.1:${app.server.address().port}`;

const readySetup = Object.freeze({
  id: 'setup_owner', status: 'ready', complete: true, can_complete: true,
  completed_at: '2026-08-16T00:00:00.000Z', revision: 1, checks: {}, blockers: [],
  owner: null, credentials: [], codex_profiles: [], github_apps: []
});
app.domain.setupService.setupState = async () => readySetup;
app.domain.setupService.assertReady = async () => readySetup;

let mutationSequence = 0;
async function request(route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function mutate(route, body, label, method = 'POST') {
  mutationSequence += 1;
  const result = await request(route, {
    method,
    headers: { 'Idempotency-Key': `r5-e2e-${label}-${mutationSequence}` },
    body
  });
  if (!result.response.ok) {
    throw new Error(`${label}:${result.response.status}:${result.body?.error?.code || 'request_failed'}`);
  }
  return result.body;
}

async function waitOperation(operationId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = (await request(`/api/v1/operations/${operationId}`)).body;
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      if (current.status !== 'completed') throw new Error(`operation_${current.status}:${current.error_code || operationId}`);
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`operation_timeout:${operationId}`);
}

async function prepareProject() {
  const project = await mutate('/api/v1/projects', {
    name: 'R5 Context workspace',
    description: 'Deterministic Context and MCP browser fixture'
  }, 'project');
  const intake = await mutate(`/api/v1/projects/${project.id}/intakes`, {
    mode: 'brainstorm', expected_revision: project.revision
  }, 'intake');
  await waitOperation(intake.operation_id);
  const brief = await mutate(`/api/v1/projects/${project.id}/briefs`, {
    content: {
      objective: 'Verify Context projection and scoped MCP access',
      constraints: ['Deterministic projection', 'Explicit project and tool scope'],
      acceptance: ['Context Pack v5 is replayable', 'MCP grants can be revoked']
    }
  }, 'brief');
  const current = (await request(`/api/v1/projects/${project.id}`)).body;
  await mutate(`/api/v1/projects/${project.id}/briefs/${brief.revision}/confirm`, {
    expected_revision: current.revision,
    intake_revision: current.intake.revision
  }, 'brief-confirm');
  await mutate(`/api/v1/projects/${project.id}/workflows`, {
    name: 'R5 Context workflow',
    tasks: [
      {
        id: 'inspect_context', title: 'Inspect projected Context', level: 1, mode: 'read',
        outputs: ['context-report.json'], acceptance: ['Projection is current']
      },
      {
        id: 'verify_scope', title: 'Verify MCP scope', level: 2, mode: 'read', deps: ['inspect_context'],
        inputs: ['context-report.json'], outputs: ['scope-receipt.json'], acceptance: ['Grant is project scoped']
      }
    ]
  }, 'workflow');
  const source = await mutate(`/api/v1/projects/${project.id}/context/sources`, {
    kind: 'note', title: 'R5 projection contract',
    content: 'Context projection uses immutable document versions and deterministic selection ordering.'
  }, 'context-source');
  const rebuild = await mutate(`/api/v1/projects/${project.id}/context/rebuild`, {}, 'context-rebuild');
  const sourceNode = rebuild.map.nodes.find((node) => node.source_id === source.id);
  if (!sourceNode) throw new Error('context_source_node_missing');
  const selection = await mutate(`/api/v1/projects/${project.id}/context/selections`, {
    query: 'projection', token_budget: 4096, node_ids: [sourceNode.id],
    retrieval_plan: { strategy: 'minisearch_deterministic', token_budget: 4096 }
  }, 'context-selection');
  const pack = await mutate(`/api/v1/projects/${project.id}/context/packs`, {
    selection_id: selection.id, schema_version: 'aiws.context_pack.v5'
  }, 'context-pack');
  return { projectId: project.id, sourceNodeId: sourceNode.id, packId: pack.id };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function checkLayout(page, surface, viewport) {
  const result = await page.evaluate(({ surface }) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const roots = [...document.querySelectorAll(surface === 'context' ? '.context-grid > *' : '.mcp-settings-grid > .panel')]
      .filter(visible);
    const rectangles = roots.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const overlaps = rectangles.some((left, index) => rectangles.slice(index + 1).some((right) => (
      left.left < right.right - 1 && left.right > right.left + 1
      && left.top < right.bottom - 1 && left.bottom > right.top + 1
    )));
    const clippedControls = [...document.querySelectorAll('button, select, input')]
      .filter(visible)
      .filter((element) => element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40) || element.tagName)
      .slice(0, 5);
    return {
      roots: roots.length,
      overlaps,
      clipped_controls: clippedControls,
      horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  }, { surface });
  if (!result.roots || result.overlaps || result.horizontal_overflow || result.clipped_controls.length) {
    throw new Error(`${surface}_layout_invalid:${viewport.name}:${JSON.stringify(result)}`);
  }
  return result;
}

async function capture(page, surface, viewport, suffix = '') {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  const layout = await checkLayout(page, surface, viewport);
  const label = `${viewport.name}-${surface}-${viewport.width}x${viewport.height}${suffix}`;
  const file = path.join(reportDir, `${label}.png`);
  const bytes = await page.screenshot({ path: file, fullPage: true });
  if (bytes.length < 10_000 || bytes[0] !== 0x89 || bytes.subarray(1, 4).toString('ascii') !== 'PNG' || new Set(bytes).size < 32) {
    throw new Error(`invalid_screenshot:${label}`);
  }
  return { file: `${label}.png`, width: viewport.width, height: viewport.height, sha256: sha256(bytes), bytes: bytes.length, layout };
}

const screenshots = [];
const pageErrors = [];
const consoleErrors = [];
let browser;
let projectFixture;
let completed = false;
let failure = null;
try {
  projectFixture = await prepareProject();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(`${base}/#/context`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Context', exact: true })).toBeVisible();
  await expect(page.getByText('R5 projection contract', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Search Context').fill('projection');
  await page.getByRole('button', { name: 'Run Context search' }).click();
  await expect(page.getByText('R5 projection contract', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByText('R5 projection contract', { exact: true }).click();
  await page.getByRole('button', { name: 'Pin node' }).click();
  await expect(page.getByRole('status')).toHaveText('Context pin policy updated');
  await page.getByRole('button', { name: 'Create Selection' }).click();
  await expect(page.getByRole('status')).toHaveText('Selection sealed');
  await page.getByRole('button', { name: 'Seal Pack v5' }).click();
  await expect(page.getByRole('status')).toHaveText('Context Pack v5 sealed');
  await page.getByRole('button', { name: 'Rebuild', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Projection queued');
  await expect.poll(async () => (await request(`/api/v1/projects/${projectFixture.projectId}/context/status`)).body.status, { timeout: 15_000 }).toBe('completed');
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByText('R5 projection contract', { exact: true })).toBeVisible();

  for (const viewport of viewports) {
    if (viewport.name === 'mobile') {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.getByRole('tab', { name: 'tree' }).click();
      screenshots.push(await capture(page, 'context', viewport, '-tree'));
      await page.getByRole('tab', { name: 'document' }).click();
      await expect(page.locator('.context-inspector')).toBeVisible();
      screenshots.push(await capture(page, 'context', viewport, '-document'));
    } else {
      screenshots.push(await capture(page, 'context', viewport));
    }
  }

  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'MCP' }).click();
  await expect(page.getByRole('heading', { name: 'MCP clients' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('R5 local bridge');
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByText('One-time token')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss MCP token' }).click();
  await expect(page.getByText('R5 local bridge', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Request scope' }).click();
  await expect(page.getByRole('status')).toHaveText('MCP scope requested');
  await page.getByRole('button', { name: 'Grant', exact: true }).click();
  await expect(page.getByText('One-time token')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss MCP token' }).click();
  await page.waitForTimeout(4500);

  for (const viewport of viewports) {
    screenshots.push(await capture(page, 'mcp', viewport));
  }

  await page.getByRole('button', { name: 'Revoke grant' }).click();
  await expect(page.getByRole('status')).toHaveText('MCP grant revoked');
  await page.getByRole('button', { name: 'Revoke R5 local bridge' }).click();
  await expect(page.getByRole('status')).toHaveText('MCP client revoked');
  if (pageErrors.length) throw new Error(`browser_page_errors:${pageErrors.join(';')}`);
  if (consoleErrors.length) throw new Error(`browser_console_errors:${consoleErrors.join(';')}`);
  completed = true;
} catch (error) {
  failure = error;
} finally {
  if (browser) await browser.close();
  await app.close();
  await broker.close();
  fs.rmSync(home, { recursive: true, force: true });
}

const receipt = {
  schema_version: 'aiws.v3.r5_browser_receipt.v1',
  status: completed ? 'passed' : 'failed',
  created_at: new Date().toISOString(),
  fixture: {
    project_id: projectFixture?.projectId || null,
    source_node_id: projectFixture?.sourceNodeId || null,
    context_pack_id: projectFixture?.packId || null,
    transport: 'loopback_only',
    production_volume_touched: false
  },
  checks: {
    context_search_policy_selection_pack_rebuild: completed,
    mcp_create_scope_grant_revoke: completed,
    page_errors: pageErrors.length,
    console_errors: consoleErrors.length,
    horizontal_overflow: false,
    sibling_overlap: false,
    token_recorded: false,
    context_body_recorded: false,
    host_path_recorded: false
  },
  viewports: viewports.map(({ name, width, height }) => ({ name, width, height })),
  screenshots,
  error: failure ? String(failure.message || failure) : null
};
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: receipt.status, screenshots: screenshots.length, receipt: '.ai-workspace/e2e-r5/receipt.json' }, null, 2)}\n`);
if (failure) throw failure;
