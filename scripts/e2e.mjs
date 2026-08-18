import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { start as startApi } from '../apps/api/server.mjs';
import { BrokerClient } from '../apps/api/src/broker-client.mjs';
import { start as startBroker } from '../apps/runner-broker/server.mjs';

const build = spawnSync('corepack', ['pnpm', '--filter', '@aiws/web', 'build'], { cwd: process.cwd(), stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
if (build.status !== 0) process.exit(build.status || 1);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-e2e-'));
const secret = 'e2e-secret';
const digest = `sha256:${'c'.repeat(64)}`;
const broker = await startBroker({ config: { host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, executor: 'mock', runnerImage: `runner@${digest}` } });
const brokerUrl = `http://127.0.0.1:${broker.server.address().port}`;
const apiBroker = new BrokerClient({ brokerUrl, brokerMode: 'http', brokerSecret: secret, runnerDigest: digest });
apiBroker.codexProfileProbe = async (profile) => ({
  provider: 'codex', model: profile.model, status: 'available', error_code: null,
  checks: ['transport', 'protocol', 'model', 'inference'].map((phase) => ({ phase, status: 'passed', error_code: null }))
});

function githubFixtureFetch(url) {
  const requestPath = new URL(url).pathname;
  if (requestPath === '/app/installations') return Promise.resolve(jsonResponse([{ id: 67890, account: { login: 'fixture-org' }, permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } }]));
  if (requestPath === '/app') return Promise.resolve(jsonResponse({ id: 12345, slug: 'fixture-app' }));
  if (requestPath === '/app/installations/67890/access_tokens') return Promise.resolve(jsonResponse({ token: 'fixture-installation-token', expires_at: new Date(Date.now() + 600_000).toISOString() }));
  if (requestPath === '/installation/repositories') return Promise.resolve(jsonResponse({ total_count: 1, repositories: [{ id: 9001, full_name: 'fixture-org/repository', default_branch: 'main', private: false, permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } }] }));
  return Promise.resolve(jsonResponse({ message: 'not found' }, 404));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const app = await startApi({
  broker: apiBroker,
  githubOptions: { apiRoot: 'http://github.fixture', fetch: githubFixtureFetch },
  config: { version: '3.0.0', apiPrefix: '/api/v1', host: '127.0.0.1', port: 0, home, databaseFile: path.join(home, 'data', 'state.sqlite'), casRoot: path.join(home, 'cas'), dataVolume: 'aiws-data-v3', brokerUrl, brokerMode: 'http', brokerSecret: secret, runnerDigest: digest, codexAvailable: false, githubAvailable: false, assistNativeV6: true }
});
const base = `http://127.0.0.1:${app.server.address().port}`;

async function apiRequest(route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

let mutationSequence = 0;
async function apiMutation(route, body, label) {
  mutationSequence += 1;
  const result = await apiRequest(route, {
    method: 'POST',
    headers: { 'Idempotency-Key': `e2e-${label}-${mutationSequence}` },
    body
  });
  if (!result.response.ok) throw new Error(`${label}:${result.response.status}:${result.body.error?.code || 'request_failed'}`);
  return result.body;
}

async function waitOperation(operationId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = (await apiRequest(`/api/v1/operations/${operationId}`)).body;
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      if (current.status !== 'completed') throw new Error(`setup_operation_${current.status}:${current.error_code || operationId}`);
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`setup_operation_timeout:${operationId}`);
}

async function prepareSetupProviders() {
  const codexCredential = await apiMutation('/api/v1/credentials', {
    kind: 'codex_api_key', label: 'Browser Codex key', secret: 'browser-codex-fixture-secret'
  }, 'codex-credential');
  const profile = await apiMutation('/api/v1/profiles/codex', {
    label: 'Browser profile', provider: 'openai', model: 'gpt-5.5', base_url: '', wire_api: 'responses',
    reasoning: 'medium', timeout_ms: 30_000, credential_ref: codexCredential.id
  }, 'codex-profile');
  const codexProbe = await apiMutation(`/api/v1/profiles/codex/${profile.id}/probe`, {
    expected_revision: profile.revision, force: true
  }, 'codex-probe');
  await waitOperation(codexProbe.operation_id);

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyCredential = await apiMutation('/api/v1/credentials', {
    kind: 'github_app_private_key', label: 'Browser App key', secret: privateKey.export({ type: 'pkcs8', format: 'pem' })
  }, 'github-key');
  const webhookCredential = await apiMutation('/api/v1/credentials', {
    kind: 'github_webhook_secret', label: 'Browser webhook', secret: 'browser-webhook-fixture-secret'
  }, 'github-webhook');
  const githubApp = await apiMutation('/api/v1/github/apps', {
    label: 'Browser App', app_id: '12345', client_id: 'Iv1.browser',
    private_key_ref: privateKeyCredential.id, webhook_secret_ref: webhookCredential.id
  }, 'github-app');
  const discovery = await apiMutation(`/api/v1/github/apps/${githubApp.id}/installations/discover`, {
    expected_revision: githubApp.revision
  }, 'github-discovery');
  await waitOperation(discovery.operation_id);
  const installation = (await apiRequest('/api/v1/github/installations')).body[0];
  const sync = await apiMutation(`/api/v1/github/installations/${installation.id}/repositories/sync`, {
    expected_revision: installation.revision
  }, 'github-sync');
  await waitOperation(sync.operation_id);
}

async function checkNoOverlap(page, viewport) {
  const overlap = await page.evaluate(() => {
    const elements = [...document.querySelectorAll('.topbar, .page-heading, .panel, .health-band, .execution-toolbar')].filter((element) => {
      const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
    });
    return elements.some((left, index) => elements.slice(index + 1).some((right) => {
      const a = left.getBoundingClientRect(); const b = right.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top && left.parentElement === right.parentElement;
    }));
  });
  if (overlap) throw new Error(`layout overlap at ${viewport}`);
}

async function checkWorkflowSurface(page, viewport) {
  const result = await page.evaluate(() => {
    const visibleRect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    const gridChildren = [...document.querySelectorAll('.workflow-main-grid > *')]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const overlaps = gridChildren.some((left, index) => gridChildren.slice(index + 1).some((right) => (
      left.left < right.right - 1 && left.right > right.left + 1 && left.top < right.bottom - 1 && left.bottom > right.top + 1
    )));
    const nodeRects = [...document.querySelectorAll('.react-flow__node')]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const nodeOverlap = nodeRects.some((left, index) => nodeRects.slice(index + 1).some((right) => (
      left.left < right.right - 2 && left.right > right.left + 2 && left.top < right.bottom - 2 && left.bottom > right.top + 2
    )));
    return {
      canvas: visibleRect('.workflow-canvas-shell'),
      renderer: visibleRect('.react-flow__renderer'),
      node_count: nodeRects.length,
      edge_count: document.querySelectorAll('.react-flow__edge').length,
      overlaps,
      node_overlap: nodeOverlap,
      horizontal_overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  });
  if (!result.canvas || result.canvas.width < 300 || result.canvas.height < 350) throw new Error(`workflow canvas missing at ${viewport}`);
  if (!result.renderer || result.node_count < 2 || result.edge_count < 1) throw new Error(`workflow topology blank at ${viewport}`);
  if (result.overlaps || result.node_overlap || result.horizontal_overflow) throw new Error(`workflow layout invalid at ${viewport}:${JSON.stringify(result)}`);
  const raster = await page.locator('.workflow-canvas-shell').screenshot();
  if (raster.length < 2_000 || new Set(raster).size < 24) throw new Error(`workflow raster blank at ${viewport}`);
  return createHash('sha256').update(raster).digest('hex');
}

async function setViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
}

const browser = await chromium.launch({ headless: true });
const reportDir = path.join(process.cwd(), '.ai-workspace', 'e2e-v3');
fs.mkdirSync(reportDir, { recursive: true });
const viewports = [
  ['mobile', 360, 800], ['mobile-wide', 390, 844], ['tablet', 768, 1024],
  ['laptop', 1024, 768], ['desktop', 1440, 900], ['wide', 1920, 1080]
];
const pageErrors = [];
const consoleErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message); });

  await page.goto(`${base}/#/setup`, { waitUntil: 'networkidle' });
  await expect(page.getByText('AIWS 3.0', { exact: true })).toBeVisible();
  await expect(page.locator('.health-band')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace configuration' })).toBeVisible();
  await expect(page.getByText('Codex credential', { exact: true })).toBeVisible();

  const setupViewports = [
    ['mobile-wide', 390, 844], ['laptop', 1024, 768], ['desktop', 1440, 900]
  ];
  for (const [name, width, height] of setupViewports) {
    await setViewport(page, width, height);
    await checkNoOverlap(page, `${name}-setup-empty`);
    await page.screenshot({ path: path.join(reportDir, `${name}-setup-empty.png`), fullPage: true });
  }

  const blockedProject = await apiRequest('/api/v1/projects', {
    method: 'POST', headers: { 'Idempotency-Key': 'e2e-project-blocked' },
    body: { name: 'Blocked before setup' }
  });
  expect(blockedProject.response.status).toBe(409);
  expect(blockedProject.body.error.code).toBe('setup_not_ready');

  await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Workspace configuration' })).toBeVisible();

  await prepareSetupProviders();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Github' }).click();
  await expect(page.getByRole('heading', { name: 'GitHub App' })).toBeVisible();
  let failNextGithubProbe = true;
  await page.route('**/api/v1/integrations/github/probe', async (route) => {
    if (failNextGithubProbe) {
      failNextGithubProbe = false;
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'github_api_unavailable', message: 'Provider fixture interrupted', retryable: true } })
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Probe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Provider fixture interrupted');
  await setViewport(page, 1440, 900);
  await page.screenshot({ path: path.join(reportDir, 'desktop-setup-failed.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => (await apiRequest('/api/v1/setup')).body.checks.current_github_probe, { timeout: 10_000 }).toBe(true);
  await page.unroute('**/api/v1/integrations/github/probe');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByRole('button', { name: 'Complete setup' })).toBeEnabled();
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.getByRole('button', { name: 'Reconfirm setup' })).toBeVisible();
  await expect.poll(async () => (await apiRequest('/api/v1/setup')).body.complete).toBe(true);

  for (const [name, width, height] of setupViewports) {
    await setViewport(page, width, height);
    await checkNoOverlap(page, `${name}-setup-ready`);
    await page.screenshot({ path: path.join(reportDir, `${name}-setup-ready.png`), fullPage: true });
  }

  await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Browser journey');
  await page.getByLabel('Description', { exact: true }).fill('unique main journey');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Project draft created');
  const projects = await apiRequest('/api/v1/projects');
  const project = projects.body.find((entry) => entry.name === 'Browser journey');
  expect(project).toBeTruthy();

  await page.goto(`${base}/#/workflow`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Workflow' })).toBeVisible();
  await expect(page.locator('.project-readiness')).toContainText('Project onboarding pending');
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  for (const [name, width, height] of setupViewports) {
    await setViewport(page, width, height);
    await checkNoOverlap(page, `${name}-project-gated`);
    await page.screenshot({ path: path.join(reportDir, `${name}-project-gated.png`), fullPage: true });
  }

  await app.database.run("UPDATE project_intakes SET status='failed',attempt=1,revision=revision+1,error_code='repository_probe_failed',updated_at=? WHERE id=?", [new Date().toISOString(), project.intake.id]);
  await app.database.run("UPDATE projects SET onboarding_state='failed',revision=revision+1,updated_at=? WHERE id=?", [new Date().toISOString(), project.id]);
  await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Retry intake', exact: true })).toBeVisible();
  await expect(page.getByText('repository_probe_failed', { exact: true })).toBeVisible();
  for (const [name, width, height] of setupViewports) {
    await setViewport(page, width, height);
    await checkNoOverlap(page, `${name}-project-failed`);
    await page.screenshot({ path: path.join(reportDir, `${name}-project-failed.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Retry intake', exact: true }).click();
  await expect(page.locator('.intake-actions .inline-success')).toContainText('Ready', { timeout: 10_000 });
  await page.getByLabel('Objective', { exact: true }).fill('Ship a browser-verified change');
  await page.getByLabel('Acceptance', { exact: true }).fill('Execution completes\nDraft PR is reviewed');
  await page.getByRole('button', { name: 'Save preview', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Brief preview created');
  await page.getByRole('button', { name: 'Confirm revision', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Brief confirmed');
  await expect(page.locator('.project-status-stack .status')).toContainText('active');
  for (const [name, width, height] of setupViewports) {
    await setViewport(page, width, height);
    await checkNoOverlap(page, `${name}-project-confirmed`);
    await page.screenshot({ path: path.join(reportDir, `${name}-project-confirmed.png`), fullPage: true });
  }

  await page.goto(`${base}/#/workflow`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Workflow' })).toBeVisible();
  await expect(page.locator('.project-readiness')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Workflow canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Generation queued');
  await expect(page.locator('.generation-row.selected .status')).toHaveText('completed', { timeout: 10_000 });
  await expect(page.locator('.critic-receipt strong')).toHaveText('passed');
  const initialGenerations = (await apiRequest(`/api/v1/projects/${project.id}/workflow-generations`)).body;
  const initialGeneration = initialGenerations[0];
  expect(initialGeneration.phase).toBe('completed');
  const sseBeforeApply = await page.evaluate(async (generationId) => {
    const response = await fetch(`/api/v1/workflow-generations/${generationId}/events`, { headers: { accept: 'text/event-stream' } });
    const stream = await response.text();
    const cursors = [...stream.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    return { status: response.status, count: cursors.length, cursor: cursors.at(-1) || 0, stream };
  }, initialGeneration.id);
  expect(sseBeforeApply.status).toBe(200);
  expect(sseBeforeApply.count).toBeGreaterThanOrEqual(5);
  expect(sseBeforeApply.stream).toContain('workflow.generation.proposal_created');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Workflow revision applied', { timeout: 10_000 });
  await expect(page.locator('.workflow-heading-actions .pin').nth(1)).toContainText('r1');
  const sseAfterApply = await page.evaluate(async ({ generationId, cursor }) => {
    const response = await fetch(`/api/v1/workflow-generations/${generationId}/events`, {
      headers: { accept: 'text/event-stream', 'Last-Event-ID': String(cursor) }
    });
    const stream = await response.text();
    const cursors = [...stream.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    return { status: response.status, cursors, stream };
  }, { generationId: initialGeneration.id, cursor: sseBeforeApply.cursor });
  expect(sseAfterApply.status).toBe(200);
  expect(sseAfterApply.cursors.every((cursor) => cursor > sseBeforeApply.cursor)).toBe(true);
  expect(sseAfterApply.stream).toContain('workflow.generation.applied');

  await page.getByRole('button', { name: '保存布局' }).click();
  await expect(page.getByRole('status')).toHaveText('Layout revision saved');
  await page.getByRole('button', { name: 'Replan', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Replan queued');
  await expect(page.locator('.generation-row.selected .status')).toHaveText('completed', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Workflow revision applied', { timeout: 10_000 });
  await expect(page.locator('.workflow-heading-actions .pin').nth(1)).toContainText('r2');

  const workflowViewports = [
    ['desktop', 1440, 900], ['laptop', 1024, 768], ['mobile-wide', 390, 844]
  ];
  const workflowScreenshotHashes = {};
  for (const [name, width, height] of workflowViewports) {
    await setViewport(page, width, height);
    await checkNoOverlap(page, `${name}-workflow`);
    workflowScreenshotHashes[name] = await checkWorkflowSurface(page, `${name}-workflow`);
    await page.screenshot({ path: path.join(reportDir, `${name}-workflow.png`), fullPage: true });
  }
  expect(new Set(Object.values(workflowScreenshotHashes)).size).toBe(3);

  if (process.env.R6_ASSIST_SCREENSHOT_DIR) {
    const assistOutput = path.resolve(process.env.R6_ASSIST_SCREENSHOT_DIR);
    fs.mkdirSync(assistOutput, { recursive: true });
    const source = await apiMutation(`/api/v1/projects/${project.id}/context/sources`, { kind: 'note', title: 'Assist evidence', content: 'Hashed evidence context.' }, 'assist-context-source');
    const rebuilt = await apiMutation(`/api/v1/projects/${project.id}/context/rebuild`, {}, 'assist-context-rebuild');
    const node = rebuilt.map.nodes.find((item) => item.source_id === source.id);
    const selection = await apiMutation(`/api/v1/projects/${project.id}/context/selections`, { node_ids: [node.id], retrieval_plan: { strategy: 'explicit', token_budget: 1024 } }, 'assist-context-selection');
    const pack = await apiMutation(`/api/v1/projects/${project.id}/context/packs`, { selection_id: selection.id, schema_version: 'aiws.context_pack.v5' }, 'assist-context-pack');
    const session = await apiMutation('/api/v1/assist/sessions', { project_id: project.id, scope: 'project', scope_id: project.id, context_pack_id: pack.id, mode: 'native', expected_revision: 0 }, 'assist-session');
    const receipt = await apiMutation(`/api/v1/assist/sessions/${session.id}/turns`, { message: 'Produce the deterministic Assist evidence response.', expected_revision: session.revision, goal: { objective: 'verify' }, plan: [{ step: 'run' }] }, 'assist-turn');
    await waitOperation(receipt.operation_id);
    await page.goto(`${base}/#/assist`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Assist Center' })).toBeVisible();
    await expect(page.getByText('deterministic runner completed')).toBeVisible({ timeout: 10_000 });
    for (const [name, width, height] of [['desktop', 1440, 900], ['laptop', 1024, 768], ['mobile-wide', 390, 844]]) {
      await setViewport(page, width, height);
      await checkNoOverlap(page, `${name}-assist`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error(`${name}-assist-horizontal-overflow`);
      await page.screenshot({ path: path.join(assistOutput, `${name}-assist.png`), fullPage: true });
    }
    await page.goto(`${base}/#/workflow`, { waitUntil: 'networkidle' });
  }

  const delayedGeneration = await apiMutation(`/api/v1/projects/${project.id}/workflow-generations`, {
    provider: 'fixture', fixture_delay_ms: 900, async: true
  }, 'workflow-cancel');
  await expect.poll(async () => (await apiRequest(`/api/v1/workflow-generations/${delayedGeneration.generation_id}`)).body.phase).toBe('running');
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.generation-row.selected .status')).toHaveText('running');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.generation-row.selected .status')).toHaveText('cancelled', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.generation-row.selected .status')).toHaveText('completed', { timeout: 10_000 });

  const rejectedGeneration = await apiMutation(`/api/v1/projects/${project.id}/workflow-generations`, {
    provider: 'fixture', async: true,
    candidate: {
      name: 'Critic browser fixture',
      workstreams: [{ id: 'review', tasks: [{ id: 'review_only', goal: 'Review topology', outputs: ['artifacts/review.json'], acceptance: ['topology reviewed'] }] }]
    }
  }, 'workflow-critic-rejected');
  await expect.poll(async () => (await apiRequest(`/api/v1/workflow-generations/${rejectedGeneration.generation_id}`)).body.phase).toBe('rejected');
  await setViewport(page, 1440, 900);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.generation-row.selected .status')).toHaveText('rejected');
  await expect(page.locator('.critic-receipt strong')).toHaveText('rejected');
  await expect(page.locator('.fault-code')).toHaveText('workflow_generation_critic_rejected');
  await page.screenshot({ path: path.join(reportDir, 'desktop-workflow-rejected.png'), fullPage: true });

  await page.goto(`${base}/#/execution`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Execution', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New execution', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Execution created');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Execution started');
  await expect(page.getByText('completed', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('execution.completed', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('heading', { name: 'Git Diff' })).toBeVisible();
  await expect(page.locator('.diff-panel pre')).toContainText('deterministic runner output');

  await page.getByRole('button', { name: 'Open review', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Review opened');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Review approved');
  await page.getByRole('button', { name: 'Create draft PR', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Draft PR delivery created');
  const deliveries = await apiRequest(`/api/v1/deliveries?project_id=${project.id}`);
  expect(deliveries.body).toHaveLength(1);
  expect(deliveries.body[0].status).toBe('draft');
  const executions = await apiRequest(`/api/v1/projects/${project.id}/executions`);
  const runtimeApproval = await apiRequest(`/api/v1/projects/${project.id}/approvals`, {
    method: 'POST', headers: { 'Idempotency-Key': 'browser-runtime-approval' },
    body: { execution_id: executions.body[0].id, action: 'delivery.publish', request: { delivery_id: deliveries.body[0].id } }
  });
  expect(runtimeApproval.response.status).toBe(201);
  await page.goto(`${base}/#/approvals`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Approval Center' })).toBeVisible();
  await expect(page.getByText('delivery.publish', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Approval approved');

  await page.goto(`${base}/#/terminals`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Request terminal access', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Terminal access requested');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Terminal approval approved');
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Terminal opened');
  await expect(page.getByRole('log', { name: 'Terminal output' })).toBeVisible();
  await page.getByPlaceholder('Run a command').fill('echo AIWS_E2E_TERMINAL');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Terminal output' })).toContainText('AIWS_E2E_TERMINAL', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Stop terminal', exact: true }).click();
  await expect(page.getByText(/stopped|exited/, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

  await page.goto(`${base}/#/assets`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: 'browser-evidence.json', mimeType: 'application/json', buffer: Buffer.from('{"browser":true}') });
  await expect(page.getByText('browser-evidence.json', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Asset version stored');
  await expect(page.getByText('browser-evidence.json', { exact: true })).toBeVisible();

  await page.goto(`${base}/#/audit`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
  await expect(page.getByText('project.created', { exact: true })).toBeVisible();
  await expect(page.getByText('delivery.created', { exact: true })).toBeVisible();
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Isolated broker', { exact: true })).toBeVisible();

  for (const [name, width, height] of viewports) {
    await setViewport(page, width, height);
    await page.goto(`${base}/#/execution`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Execution', exact: true })).toBeVisible();
    await expect(page.getByText('completed', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('execution.completed', { exact: true })).toBeVisible();
    await checkNoOverlap(page, name);
    await page.screenshot({ path: path.join(reportDir, `${name}.png`), fullPage: true });
    await page.goto(`${base}/#/approvals`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Approval Center' })).toBeVisible();
    await expect(page.getByText('delivery.publish', { exact: true })).toBeVisible();
    await checkNoOverlap(page, `${name}-approvals`);
    await page.screenshot({ path: path.join(reportDir, `${name}-approvals.png`), fullPage: true });
    await page.goto(`${base}/#/terminals`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByText(/stopped|exited/, { exact: false }).first()).toBeVisible();
    await checkNoOverlap(page, `${name}-terminals`);
    await page.screenshot({ path: path.join(reportDir, `${name}-terminals.png`), fullPage: true });
  }

  await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Archive project', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('archive completed', { timeout: 10_000 });
  await expect(page.locator('.project-status-stack .status')).toContainText('archived');
  for (const [name, width, height] of setupViewports) {
    await setViewport(page, width, height);
    await checkNoOverlap(page, `${name}-project-archived`);
    await page.screenshot({ path: path.join(reportDir, `${name}-project-archived.png`), fullPage: true });
  }
  if (pageErrors.length) throw new Error(`browser page errors: ${pageErrors.map((error) => error.message).join('; ')}`);
  const unexpectedConsoleErrors = [...consoleErrors];
  const expectedProviderFailure = unexpectedConsoleErrors.findIndex((message) => /status of 502 \(Bad Gateway\)/.test(message.text()));
  if (expectedProviderFailure >= 0) unexpectedConsoleErrors.splice(expectedProviderFailure, 1);
  if (unexpectedConsoleErrors.length) throw new Error(`browser console errors: ${unexpectedConsoleErrors.map((message) => message.text()).join('; ')}`);
  process.stdout.write(`E2E passed: ${viewports.length} workspace viewports, 3 R4 Workflow viewports, project ${project.id}, onboarding, generation and execution journey complete\n`);
} finally {
  await browser.close();
  await app.close();
  await broker.close();
  fs.rmSync(home, { recursive: true, force: true });
}
