import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { start as startApi } from '../apps/api/server.mjs';
import { start as startBroker } from '../apps/runner-broker/server.mjs';

const execFileAsync = promisify(execFile);

const build = spawnSync('corepack', ['pnpm', '--filter', '@aiws/web', 'build'], { cwd: process.cwd(), stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
if (build.status !== 0) process.exit(build.status || 1);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-e2e-'));
const secret = 'e2e-secret';
const digest = `sha256:${'c'.repeat(64)}`;
const broker = await startBroker({ config: { host: '127.0.0.1', port: 0, secret, dataRoot: home, dataVolume: 'aiws-data-v3', runnerDigest: digest, executor: 'mock', runnerImage: `runner@${digest}` } });
const app = await startApi({ config: { version: '3.0.0', apiPrefix: '/api/v1', host: '127.0.0.1', port: 0, home, databaseFile: path.join(home, 'data', 'state.sqlite'), casRoot: path.join(home, 'cas'), dataVolume: 'aiws-data-v3', brokerUrl: `http://127.0.0.1:${broker.server.address().port}`, brokerMode: 'http', brokerSecret: secret, runnerDigest: digest, codexAvailable: false, githubAvailable: false } });
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

async function initializeGitRepository(directory) {
  await execFileAsync('git', ['init', directory], { windowsHide: true });
  await execFileAsync('git', ['-C', directory, 'config', 'user.email', 'aiws-e2e@example.invalid'], { windowsHide: true });
  await execFileAsync('git', ['-C', directory, 'config', 'user.name', 'AIWS E2E'], { windowsHide: true });
  fs.writeFileSync(path.join(directory, 'README.md'), '# browser fixture\n', 'utf8');
  await execFileAsync('git', ['-C', directory, 'add', 'README.md'], { windowsHide: true });
  await execFileAsync('git', ['-C', directory, 'commit', '-m', 'browser baseline', '--no-gpg-sign'], { windowsHide: true });
  fs.appendFileSync(path.join(directory, 'README.md'), 'browser change\n', 'utf8');
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
  await expect(page.getByRole('heading', { name: 'AIWS 3.0 workspace' })).toBeVisible();
  await expect(page.getByText('/api/v1', { exact: true })).toBeVisible();

  await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Browser journey');
  await page.getByLabel('Description', { exact: true }).fill('unique main journey');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Project created');
  const projects = await apiRequest('/api/v1/projects');
  const project = projects.body.find((entry) => entry.name === 'Browser journey');
  expect(project).toBeTruthy();
  const repositoryDirectory = path.join(home, project.id.startsWith('prj_') ? 'projects' : '', project.id);
  await initializeGitRepository(repositoryDirectory);

  await page.goto(`${base}/#/workflow`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Workflow' })).toBeVisible();
  await page.getByLabel('Objective', { exact: true }).fill('Ship a browser-verified change');
  await page.getByLabel('Acceptance', { exact: true }).fill('Execution completes\nDraft PR is reviewed');
  await page.getByRole('button', { name: 'New revision', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Brief revision created');
  await page.getByPlaceholder('Add repository constraint or implementation signal').fill('browser deterministic signal');
  await page.getByPlaceholder('Add repository constraint or implementation signal').press('Enter');
  await expect(page.getByRole('status')).toHaveText('Context source added');
  await page.getByRole('button', { name: 'Seal pack', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Context pack sealed');
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Workflow revision created');

  await page.goto(`${base}/#/execution`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Execution', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New execution', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Execution created');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('completed', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('execution.completed', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('heading', { name: 'Git Diff' })).toBeVisible();
  await expect(page.locator('.diff-panel pre')).toContainText('browser change');

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
    await page.setViewportSize({ width, height });
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
  if (pageErrors.length) throw new Error(`browser page errors: ${pageErrors.map((error) => error.message).join('; ')}`);
  if (consoleErrors.length) throw new Error(`browser console errors: ${consoleErrors.map((message) => message.text()).join('; ')}`);
  process.stdout.write(`E2E passed: ${viewports.length} viewports, project ${project.id}, execution journey complete\n`);
} finally {
  await browser.close();
  await app.close();
  await broker.close();
  fs.rmSync(home, { recursive: true, force: true });
}
