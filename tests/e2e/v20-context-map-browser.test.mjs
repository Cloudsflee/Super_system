import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

import {
  assertA11y,
  assertInsideViewport,
  assertNoHorizontalScroll,
  assertNoOverlap,
  assertViewport,
  browserExecutable
} from './playwright-helpers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v20-context-browser-'));
const home = path.join(root, 'home');
const port = Number(process.env.AIWS_V20_CONTEXT_PORT || 4602);
const output = process.env.AIWS_TEST_REPORT_DIR
  ? path.resolve(process.env.AIWS_TEST_REPORT_DIR, 'e2e-v20-context')
  : path.resolve('.ai-workspace', 'e2e-v20-context');
const viewports = [
  { name: 'ultrawide', width: 2560, height: 1440 },
  { name: 'wide', width: 1920, height: 1080 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
].filter((item) => !process.env.AIWS_TEST_VIEWPORT || item.name === process.env.AIWS_TEST_VIEWPORT);
const scopes = [
  'context:read',
  'context:admin',
  'system:read',
  'project:create',
  'project:read',
  'workflow:read',
  'assets:read',
  'files:read',
  'runs:read',
  'assist:read',
  'setup:read',
  'governance:read',
  'approval:read',
  'github:read',
  'terminal:read',
  'exchange:read'
].join(' ');

let browser;
let server;
let serverLog = '';
let ownerId = '';

fs.mkdirSync(output, { recursive: true });
buildWeb();

try {
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
      NODE_ENV: 'test'
    }
  });
  server.stdout.on('data', (chunk) => {
    serverLog += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });
  await waitForServer();
  ownerId = (await request('/health')).local_owner.id;
  const created = await request('/projects', 'POST', {
    title: '上下文地图浏览器项目',
    goal: '验证六种视口下的系统上下文投影'
  });
  const projectId = created.project.id;
  const map = await request(`/context/v1/map?project_id=${encodeURIComponent(projectId)}`);
  const projectNode = map.nodes.find((node) => node.source_collection === 'projects' && node.source_id === projectId);
  assert.ok(
    projectNode,
    `project context node is materialized: ${JSON.stringify(
      map.nodes.map((node) => ({ id: node.id, source_collection: node.source_collection, source_id: node.source_id }))
    )}`
  );
  const projectDocument = await request(`/context/v1/nodes/${encodeURIComponent(projectNode.id)}`);
  const selection = await request('/context/v1/selections', 'POST', {
    project_id: projectId,
    anchor_node_id: projectNode.id,
    candidate_node_ids: map.nodes.map((node) => node.id),
    token_budget: projectDocument.version.token_estimate
  });
  assert.ok(selection.included.length > 0, 'selection audit has included nodes');
  assert.ok(selection.excluded.length > 0, 'selection audit has excluded nodes');

  browser = await chromium.launch({ headless: true, ...browserExecutable() });
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      extraHTTPHeaders: authenticatedHeaders()
    });
    const page = await context.newPage();
    const errors = [];
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

    await verifyGlobalMap(page, viewport);
    await verifyProjectMap(page, projectId, viewport);
    assert.deepEqual(
      errors.filter((item) => !item.includes('favicon')),
      [],
      `${viewport.name} context browser errors:\n${errors.join('\n')}`
    );
    await context.close();
  }

  console.log(`V2.0 Context Map six-viewport browser tests passed; screenshots: ${output}`);
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

async function verifyGlobalMap(page, viewport) {
  await page.goto(`http://127.0.0.1:${port}/context`);
  await page.getByRole('heading', { name: '上下文地图' }).waitFor();
  await page.getByText(/全局 · \d+ 个节点/).waitFor();
  await assertContextLayout(page, viewport);
}

async function verifyProjectMap(page, projectId, viewport) {
  await page.goto(`http://127.0.0.1:${port}/projects/${projectId}/context`);
  await page.getByRole('heading', { name: '上下文地图' }).waitFor();
  await page.getByText(/当前项目 · \d+ 个节点/).waitFor();
  const mobile = viewport.width <= 768;
  if (mobile) {
    assert.equal(await page.locator('.context-mobile-tabs').isVisible(), true, 'mobile pane tabs are visible');
    assert.equal(await page.locator('.context-directory').isVisible(), true, 'mobile starts in directory pane');
    assert.equal(await page.locator('.context-document').isVisible(), false, 'mobile document pane starts hidden');
    await page.locator('.context-directory-list > button').filter({ hasText: '上下文地图浏览器项目' }).first().click();
  }
  await page.locator('.context-document-heading').waitFor();
  await page.getByRole('heading', { name: '上下文地图浏览器项目' }).waitFor();

  await page.locator('.context-document-tabs').getByRole('button', { name: '原文' }).click();
  await page.locator('.context-markdown-source').getByText('## 完整事实').waitFor();
  await page.locator('.context-document-tabs').getByRole('button', { name: '结构' }).click();
  await page
    .locator('.context-document-body')
    .getByText(/"title": "上下文地图浏览器项目"/)
    .waitFor();
  await page.locator('.context-document-tabs').getByRole('button', { name: '关系' }).click();
  await page.locator('.context-relation-list').waitFor();
  await page.locator('.context-document-tabs').getByRole('button', { name: '历史' }).click();
  await page.locator('.context-history > button').first().waitFor();

  if (mobile) {
    await page.locator('.context-mobile-tabs').getByRole('button', { name: '关系' }).click();
    assert.equal(await page.locator('.context-details').isVisible(), true, 'mobile details pane is visible');
    assert.equal(
      await page.locator('.context-document').isVisible(),
      false,
      'mobile document pane is hidden in details'
    );
  }
  await page.locator('.context-selection-audit').getByText('本轮取用', { exact: true }).waitFor();
  await page
    .locator('.context-selection-audit')
    .getByText(/纳入 \d+/)
    .waitFor();
  await page
    .locator('.context-selection-audit')
    .getByText(/排除 \d+/)
    .waitFor();

  if (mobile) await page.locator('.context-mobile-tabs').getByRole('button', { name: '目录' }).click();
  const search = page.getByRole('search');
  await search.getByRole('textbox', { name: '检索上下文' }).fill('浏览器项目');
  await search.getByRole('textbox', { name: '检索上下文' }).press('Enter');
  await page.locator('.context-directory > header').getByText('检索结果', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清除检索' }).click();

  await assertContextLayout(page, viewport);
  await assertA11y(page, `Context Map ${viewport.name}`);
  await page.screenshot({ path: path.join(output, `context-map-${viewport.name}.png`), fullPage: true });
}

async function assertContextLayout(page, viewport) {
  await assertInsideViewport(page, '.context-map-page');
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
    assert.equal(await page.locator('.context-mobile-tabs').isVisible(), false, 'desktop pane tabs remain hidden');
    await assertNoOverlap(page, '.context-directory', '.context-document');
    await assertNoOverlap(page, '.context-document', '.context-details');
  }
}

async function request(route, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...authenticatedHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}

function authenticatedHeaders() {
  return ownerId ? { 'x-aiws-user-id': ownerId, 'x-aiws-scopes': scopes } : {};
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`API exited before ready (${server.exitCode}):\n${serverLog}`);
    try {
      if ((await request('/health')).status === 'ok') return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`API did not start:\n${serverLog}`);
}

function buildWeb() {
  const result = spawnSync(process.execPath, ['scripts/build-web.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, `web build failed:\n${result.stdout}\n${result.stderr}`);
}
