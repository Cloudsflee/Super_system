import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const root = process.cwd();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p31-e2e-'));
const apiPort = await freePort();
const webPort = await freePort();
const vaultKey = 'p31-clean-e2e-vault-key';
const reportDir = path.join(root, '.ai-workspace', 'e2e-clean-p31');
fs.mkdirSync(reportDir, { recursive: true });
const children = [];
const requests = [];

const api = start(process.execPath, ['apps/api/server.mjs'], {
  AIWS_CLEAN_PORT: String(apiPort), AIWS_CLEAN_HOME: home,
  AIWS_CLEAN_VAULT_KEY: vaultKey, AIWS_CLEAN_RUNTIME_BUILD: 'v3-clean-p31-e2e'
});
children.push(api);
await waitFor(`http://127.0.0.1:${apiPort}/readyz`);

const viteEntry = path.join(root, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
const web = start(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  AIWS_WEB_API_TARGET: `http://127.0.0.1:${apiPort}`
}, path.join(root, 'apps', 'web'));
children.push(web);
const base = `http://127.0.0.1:${webPort}`;
await waitFor(`${base}/`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('request', (request) => requests.push(request.url()));
page.on('pageerror', (error) => { throw error; });

async function pageApi(pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(pathname, {
      ...options,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
      body: options.body == null ? undefined : JSON.stringify(options.body)
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  }, { pathname, options });
}

try {
  await page.goto(`${base}/#/setup`, { waitUntil: 'networkidle' });
  try { await page.getByRole('heading', { name: 'Setup', exact: true }).waitFor({ timeout: 8_000 }); }
  catch (error) { process.stderr.write(`Clean Web bootstrap body:\n${await page.locator('body').innerText()}\nURL=${page.url()}\nRequests=${JSON.stringify(requests)}\n`); throw error; }
  await page.getByLabel('Display name').fill('P31 E2E owner');
  await page.getByLabel('Team name').fill('P31 E2E team');
  await page.getByRole('button', { name: 'Complete setup', exact: true }).click();
  await page.getByText('Workspace is ready', { exact: true }).waitFor();

  await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
  await page.getByLabel('Name').fill('P31 Clean project');
  await page.getByLabel('Description').fill('Clean E2E fixture');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('heading', { name: 'P31 Clean project', exact: true }).waitFor();

  const setup = await pageApi('/api/v2/setup');
  assert(setup.status === 200 && setup.body.data?.needs_setup === false, 'setup cookie/session');
  const projects = await pageApi('/api/v2/projects');
  const project = projects.body.data?.projects?.[0];
  assert(project?.id, 'project create');

  const intake = await pageApi(`/api/v2/projects/${project.id}/intake`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p31-e2e-intake-01', 'X-Expected-Revision': String(project.revision) },
    body: { mode: 'brainstorm', content: {}, expected_revision: project.revision }
  });
  assert([201, 202].includes(intake.status), `intake:${intake.status}`);
  const brief = await pageApi(`/api/v2/projects/${project.id}/briefs`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p31-e2e-brief-01', 'X-Expected-Revision': String(project.revision) },
    body: { objective: 'Verify clean workflow', acceptance: ['replay'], constraints: [], expected_revision: project.revision }
  });
  assert([200, 201].includes(brief.status), `brief:${brief.status}`);

  const workflow = await pageApi(`/api/v2/projects/${project.id}/workflow-draft`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p31-e2e-workflow-01', 'X-Expected-Revision': '1' },
    body: { graph: { nodes: [{ id: 'inspect', kind: 'workstream', title: 'Inspect' }] }, nodes: [], layout: {}, expected_revision: 1 }
  });
  assert([200, 201].includes(workflow.status), `workflow:${workflow.status}`);

  const replay = await pageApi('/api/v2/projects', { method: 'GET' });
  assert(replay.status === 200 && replay.body.data?.projects?.some((item) => item.id === project.id), 'reload/replay');
  const denied = await pageApi(`/api/v2/projects/${project.id}/permissions`);
  assert([200, 403].includes(denied.status), `ACL probe:${denied.status}`);

  for (const [name, width, height] of [['mobile', 390, 844], ['laptop', 1024, 768], ['desktop', 1440, 900]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/#/workflow`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(reportDir, `${name}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert(!overflow, `${name} horizontal overflow`);
  }

  const legacyRequests = requests.filter((url) => /\/api\/v1(?:\/|$)/.test(url));
  if (legacyRequests.length) throw new Error(`active Clean Web emitted /api/v1: ${legacyRequests.join(', ')}`);
  fs.writeFileSync(path.join(reportDir, 'receipt.json'), `${JSON.stringify({ schema_version: 'aiws.v3-clean.p31-e2e-receipt.v1', status: 'passed', api_port: apiPort, web_port: webPort, viewports: ['mobile', 'laptop', 'desktop'], request_count: requests.length, legacy_api_v1_requests: legacyRequests }, null, 2)}\n`);
  process.stdout.write(`P3.1 Clean E2E passed: project ${project.id}, setup cookie, intake, brief, workflow, ACL probe, and 3 viewports; /api/v1 requests=0\n`);
} finally {
  await browser.close();
  for (const child of children.reverse()) await stop(child);
  removeTree(home);
}

function start(command, args, env = {}, cwd = root) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && command !== process.execPath });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${path.basename(command)}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${path.basename(command)}] ${chunk}`));
  return child;
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await new Promise((resolve) => { const timer = setTimeout(resolve, 1500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  if (child.exitCode == null && process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve) => killer.once('exit', resolve));
  }
}

async function waitFor(url, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok || response.status === 404) return; } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`startup_timeout:${url}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function assert(condition, message) { if (!condition) throw new Error(`e2e_assertion_failed:${message}`); }

function removeTree(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch { /* SQLite handles may release just after a child exits on Windows. */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
