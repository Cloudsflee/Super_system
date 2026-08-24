import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const root = process.cwd();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-e2e-'));
const apiPort = await freePort();
const webPort = await freePort();
const vaultKey = 'p6-clean-e2e-vault-key';
const reportDir = path.join(root, '.ai-workspace', 'e2e-clean-p6');
fs.rmSync(reportDir, { recursive: true, force: true });
fs.mkdirSync(reportDir, { recursive: true });
const children = [];
const requests = [];
const browserErrors = [];
const httpErrors = [];

const api = start(process.execPath, ['apps/api/server.mjs'], {
  AIWS_CLEAN_PORT: String(apiPort), AIWS_CLEAN_HOME: home,
  AIWS_CLEAN_VAULT_KEY: vaultKey, AIWS_CLEAN_RUNTIME_BUILD: 'v3-clean-p6-e2e',
  AIWS_CLEAN_MCP_PEPPER: 'p6-clean-e2e-mcp-pepper', AIWS_GATEWAY_SECRET: 'p6-clean-e2e-gateway-secret',
  AIWS_CLEAN_PROVIDER_MODE: 'deterministic', AIWS_RUNNER_POLL_INTERVAL_MS: '10'
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
page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()}:${response.url()}`); });
page.on('pageerror', (error) => browserErrors.push(`pageerror:${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console:${message.text()}`); });

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
  await page.getByLabel('Display name').fill('P6 E2E owner');
  await page.getByLabel('Team name').fill('P6 E2E team');
  await page.getByRole('button', { name: 'Complete setup', exact: true }).click();
  await page.getByText('Workspace is ready', { exact: true }).waitFor();

  await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
  await page.getByLabel('Name').fill('P6 Clean project');
  await page.getByLabel('Description').fill('Clean E2E fixture');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('heading', { name: 'P6 Clean project', exact: true }).waitFor();

  const setup = await pageApi('/api/v2/setup');
  assert(setup.status === 200 && setup.body.data?.needs_setup === false, 'setup cookie/session');
  const projects = await pageApi('/api/v2/projects');
  const project = projects.body.data?.projects?.[0];
  assert(project?.id, 'project create');

  const intake = await pageApi(`/api/v2/projects/${project.id}/intake`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-intake-01', 'X-Expected-Revision': String(project.revision) },
    body: { mode: 'brainstorm', content: {}, expected_revision: project.revision }
  });
  assert([201, 202].includes(intake.status), `intake:${intake.status}`);
  await waitOperation(pageApi, intake.body.data?.operation_id || intake.body.data?.operation?.operation_id);
  const brief = await pageApi(`/api/v2/projects/${project.id}/briefs`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-brief-01', 'X-Expected-Revision': String(project.revision) },
    body: { objective: 'Verify clean workflow', acceptance: ['replay'], constraints: [], expected_revision: project.revision }
  });
  assert([200, 201].includes(brief.status), `brief:${brief.status}`);

  const beforeConfirm = await pageApi(`/api/v2/projects/${project.id}`);
  const briefRevision = brief.body.data?.brief?.current_revision || brief.body.data?.revision_record?.revision || 1;
  const confirmed = await pageApi(`/api/v2/projects/${project.id}/briefs/${briefRevision}/confirm`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-confirm-01', 'X-Expected-Revision': String(beforeConfirm.body.data.project.revision) },
    body: { brief_revision: briefRevision, expected_revision: beforeConfirm.body.data.project.revision }
  });
  assert(confirmed.status === 200, `brief-confirm:${confirmed.status}`);

  const workflow = await pageApi(`/api/v2/projects/${project.id}/workflow-draft`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-workflow-01', 'X-Expected-Revision': '1' },
    body: { graph: { nodes: [{ id: 'inspect', kind: 'workstream', title: 'Inspect' }] }, nodes: [], layout: {}, expected_revision: 1 }
  });
  assert([200, 201].includes(workflow.status), `workflow:${workflow.status}`);

  const replay = await pageApi('/api/v2/projects', { method: 'GET' });
  assert(replay.status === 200 && replay.body.data?.projects?.some((item) => item.id === project.id), 'reload/replay');
  const denied = await pageApi(`/api/v2/projects/${project.id}/permissions`);
  assert([200, 403].includes(denied.status), `ACL probe:${denied.status}`);

  const target = await pageApi('/api/v2/projects', {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-target-project-01', 'X-Expected-Revision': '0' },
    body: { name: 'P6 Exchange target', description: 'Clean E2E target', metadata: {}, expected_revision: 0 }
  });
  assert(target.status === 201 && target.body.data?.project?.id, `target-project:${target.status}`);

  const source = await pageApi(`/api/v2/projects/${project.id}/context/sources`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-context-source-01', 'X-Expected-Revision': '0' },
    body: { kind: 'note', title: 'P6 verification note', uri: 'notes/p6-verification', content: 'runner execution checkpoint replay evidence', source_revision: 'r1', expected_revision: 0 }
  });
  assert(source.status === 201, `context-source:${source.status}`);
  const rebuilt = await pageApi(`/api/v2/projects/${project.id}/context/rebuild`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-context-rebuild-01', 'X-Expected-Revision': '0' },
    body: { mode: 'full', expected_revision: 0 }
  });
  assert(rebuilt.status === 202, `context-rebuild:${rebuilt.status}`);
  await waitOperation(pageApi, rebuilt.body.data?.operation_id);
  const selection = await pageApi(`/api/v2/projects/${project.id}/context/selections`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-context-selection-01', 'X-Expected-Revision': '0' },
    body: { query: 'checkpoint replay', token_budget: 1024, expected_revision: 0 }
  });
  assert(selection.status === 201 && selection.body.data?.selection?.id, `context-selection:${selection.status}`);
  const pack = await pageApi(`/api/v2/projects/${project.id}/context/packs`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-context-pack-01', 'X-Expected-Revision': '0' },
    body: { selection_id: selection.body.data.selection.id, require_authoritative: false, expected_revision: 0 }
  });
  assert(pack.status === 201 && pack.body.data?.pack?.pack_hash, `context-pack:${pack.status}`);

  const connection = await pageApi(`/api/v2/projects/${project.id}/repository-connections`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-repository-01', 'X-Expected-Revision': '0' },
    body: { provider: 'fixture', source_kind: 'git', source_locator: 'fixture/p6-e2e', source_revision: 'r1', source_hash: 'a'.repeat(64), expected_revision: 0 }
  });
  assert(connection.status === 201 && connection.body.data?.connection?.id, `repository-connection:${connection.status}`);
  const lines = await pageApi(`/api/v2/projects/${project.id}/repository-lines`);
  const line = lines.body.data?.lines?.[0];
  assert(lines.status === 200 && line?.id, `repository-lines:${lines.status}`);
  const reconciled = await pageApi(`/api/v2/repository-lines/${line.id}/reconcile`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-reconcile-01', 'X-Expected-Revision': String(line.revision) },
    body: { source_revision: 'r1', source_hash: 'a'.repeat(64), expected_revision: line.revision }
  });
  assert(reconciled.status === 200 && reconciled.body.data?.line?.status === 'ready', `repository-reconcile:${reconciled.status}`);
  const workspace = await pageApi(`/api/v2/projects/${project.id}/repository-workspaces`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-workspace-01', 'X-Expected-Revision': '0' },
    body: { line_id: line.id, relative_path: `projects/${project.id}/p6-e2e`, expected_revision: 0 }
  });
  assert(workspace.status === 201 && workspace.body.data?.workspace?.id, `repository-workspace:${workspace.status}`);

  const createdProfile = await pageApi('/api/v2/runners/profiles', {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-runner-profile-01', 'X-Expected-Revision': '0' },
    body: { label: 'P6 E2E Host', runner_type: 'host', expected_revision: 0 }
  });
  assert(createdProfile.status === 201 && createdProfile.body.data?.profile?.id, `runner-profile:${createdProfile.status}`);
  const profileId = createdProfile.body.data.profile.id;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/#/connections`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Runner Profiles', exact: true }).click();
  await page.getByText('P6 E2E Host', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Probe Runner profile', exact: true }).click();
  const readyProfile = await waitForApi(pageApi, `/api/v2/runners/profiles/${profileId}`, (result) => result.body.data?.profile?.status === 'ready');
  assert(readyProfile.body.data.profile.identity_public_key, 'runner profile identity');

  const currentProject = await pageApi(`/api/v2/projects/${project.id}`);
  const execution = await pageApi(`/api/v2/projects/${project.id}/executions`, {
    method: 'POST', headers: { 'Idempotency-Key': 'p6-e2e-execution-01', 'X-Expected-Revision': String(currentProject.body.data.project.revision) },
    body: {
      repository_workspace_id: workspace.body.data.workspace.id,
      context_pack_id: pack.body.data.pack.id,
      runner_profile_id: profileId,
      tasks: [{ id: 'inspect', mode: 'read', depends_on: [], input_paths: [], output_paths: [], check_ids: [] }],
      requires_approval: true,
      expected_revision: currentProject.body.data.project.revision
    }
  });
  assert(execution.status === 201 && execution.body.data?.execution?.id, `execution-create:${execution.status}`);
  const executionId = execution.body.data.execution.id;

  await page.goto(`${base}/#/execution`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Execution', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start Execution', exact: true }).click();
  await waitForApi(pageApi, `/api/v2/executions/${executionId}`, (result) => result.body.data?.execution?.status === 'awaiting_approval', 20_000);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('awaiting approval', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Approval', exact: true }).click();
  await page.getByRole('heading', { name: 'Approval Center', exact: true }).waitFor();
  const executionApproval = page.locator('article').filter({ hasText: 'execution.review' }).first();
  await executionApproval.getByRole('button', { name: 'Approve', exact: true }).click();
  await executionApproval.getByText('approved', { exact: true }).waitFor();

  await page.goto(`${base}/#/execution`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Resume Execution', exact: true }).click();
  await waitForApi(pageApi, `/api/v2/executions/${executionId}`, (result) => result.body.data?.execution?.status === 'completed', 20_000);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('completed', { exact: true }).first().waitFor();
  const replayResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/v2/executions/${executionId}/stages/deliver/replay`));
  await page.getByRole('button', { name: 'Replay deliver', exact: true }).click();
  const replayResponse = await replayResponsePromise;
  const replayPayload = await replayResponse.json().catch(() => ({}));
  assert(replayResponse.status() === 202, `execution-replay:${replayResponse.status()}:${JSON.stringify(replayPayload)}`);
  const replayedExecution = await waitForApi(pageApi, `/api/v2/executions/${executionId}`, (result) => result.body.data?.execution?.status === 'completed' && result.body.data.execution.generation === 2, 20_000);
  assert(replayedExecution.body.data.execution.handoff_manifest?.delivery_ready === true, 'execution delivery handoff');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('generation 2', { exact: false }).first().waitFor();
  for (const control of ['Start Execution', 'Pause Execution', 'Resume Execution', 'Cancel Execution', 'Replan Execution']) {
    assert(await page.getByRole('button', { name: control, exact: true }).count() === 1, `execution control:${control}`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/#/context`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Context', exact: true }).waitFor();
  await page.getByText('P6 verification note', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pin node' }).click();
  await page.getByText('Context pin policy updated', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Rebuild', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('completed', { exact: true }).first().waitFor();

  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'MCP & Exchange', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create client', exact: true }).click();
  await page.getByText('One-time token', { exact: true }).waitFor();
  await page.getByLabel('Target project ID').fill(target.body.data.project.id);
  await page.getByRole('button', { name: 'Request exchange', exact: true }).click();
  await page.getByText('requested', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByText('partially_approved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Target', exact: true }).click();
  await page.getByText('active', { exact: true }).last().waitFor();

  const layoutReceipts = [];
  for (const [name, width, height] of [['mobile', 390, 844], ['laptop', 1024, 768], ['desktop', 1440, 900]]) {
    await page.setViewportSize({ width, height });
    for (const route of ['context', 'settings', 'execution', 'connections']) {
      await page.goto(`${base}/#/${route}`, { waitUntil: 'networkidle' });
      const heading = { context: 'Context', settings: 'MCP & Exchange', execution: 'Execution', connections: 'Connections' }[route];
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      if (route === 'context') await page.getByText('P6 verification note', { exact: true }).waitFor();
      else if (route === 'settings') await page.getByText('context_map', { exact: true }).waitFor();
      else if (route === 'execution') await page.getByText('generation 2', { exact: false }).first().waitFor();
      else {
        await page.getByRole('button', { name: 'Runner Profiles', exact: true }).click();
        await page.getByText('P6 E2E Host', { exact: true }).first().waitFor();
      }
      await page.screenshot({ path: path.join(reportDir, `${name}-${route}.png`), fullPage: true });
      const layout = await inspectLayout(page);
      assert(!layout.horizontal_overflow, `${name}/${route} horizontal overflow`);
      assert(layout.overlaps.length === 0, `${name}/${route} overlaps:${JSON.stringify(layout.overlaps)}`);
      layoutReceipts.push({ viewport: name, route, ...layout });
    }
  }

  const legacyRequests = requests.filter((url) => /\/api\/v1(?:\/|$)/.test(url));
  if (legacyRequests.length) throw new Error(`active Clean Web emitted /api/v1: ${legacyRequests.join(', ')}`);
  assert(browserErrors.length === 0, `browser errors:${JSON.stringify(browserErrors)} http:${JSON.stringify(httpErrors)}`);
  const checkpoints = await pageApi(`/api/v2/executions/${executionId}/checkpoints`);
  const attempts = await pageApi(`/api/v2/executions/${executionId}/attempts`);
  fs.writeFileSync(path.join(reportDir, 'receipt.json'), `${JSON.stringify({
    schema_version: 'aiws.v3-clean.p6-e2e-receipt.v1', status: 'passed', provisional: false,
    api_port: apiPort, web_port: webPort, viewports: ['mobile', 'laptop', 'desktop'],
    routes: ['context', 'settings', 'execution', 'connections'], request_count: requests.length,
    legacy_api_v1_requests: legacyRequests, browser_errors: browserErrors, http_errors: httpErrors,
    layouts: layoutReceipts, context_pack_hash: pack.body.data.pack.pack_hash,
    runner_profile: { id: profileId, type: readyProfile.body.data.profile.runner_type, status: readyProfile.body.data.profile.status },
    execution: { id: executionId, status: replayedExecution.body.data.execution.status, generation: replayedExecution.body.data.execution.generation, checkpoint_count: checkpoints.body.data?.checkpoints?.length || 0, attempt_count: attempts.body.data?.attempts?.length || 0, delivery_ready: true, approval_wait_resumed: true, replayed_stage: 'deliver' }
  }, null, 2)}\n`);
  process.stdout.write(`P6 Clean E2E passed: Runner/Execution/Approval/Replay and P4 surfaces across 3 viewports; overlaps=0; /api/v1 requests=0\n`);
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

async function waitOperation(api, operationId, timeout = 10_000) {
  assert(operationId, 'operation receipt missing');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await api(`/api/v2/operations/${operationId}`);
    const status = result.body.data?.status;
    if (status === 'succeeded') return result.body.data;
    if (['failed', 'cancelled', 'expired'].includes(status)) throw new Error(`operation_${status}:${operationId}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`operation_timeout:${operationId}`);
}

async function waitForApi(api, pathname, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await api(pathname);
    if (latest.status === 200 && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`api_state_timeout:${pathname}:${JSON.stringify(latest?.body || {})}`);
}

async function inspectLayout(targetPage) {
  return targetPage.evaluate(() => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll('button,input,select,textarea')]
      .filter((element) => {
        if (element.closest('.sidebar:not(.is-open)')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
          && rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0
          && rect.left < innerWidth && rect.top < innerHeight
          && Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element)));
      })
      .map((element) => ({ element, rect: element.getBoundingClientRect(), name: element.getAttribute('aria-label') || element.getAttribute('placeholder') || `${element.tagName}:${element.getAttribute('type') || ''}` }));
    const overlaps = [];
    for (let left = 0; left < controls.length; left += 1) {
      for (let right = left + 1; right < controls.length; right += 1) {
        const a = controls[left], b = controls[right];
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (width > 1 && height > 1) overlaps.push([a.name, b.name]);
      }
    }
    return { horizontal_overflow: root.scrollWidth > root.clientWidth + 1, scroll_width: root.scrollWidth, client_width: root.clientWidth, overlaps: overlaps.slice(0, 20) };
  });
}

function removeTree(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch { /* SQLite handles may release just after a child exits on Windows. */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
