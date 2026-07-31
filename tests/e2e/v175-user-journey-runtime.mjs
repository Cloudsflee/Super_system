import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { openFixtureState, repositorySnapshot } from '../integration/v13-test-helpers.mjs';
import { browserExecutable } from './playwright-helpers.mjs';

export async function createJourneyRuntime() {
  const {
    runId,
    root,
    fixtureRoot,
    ephemeralFixture,
    home,
    sourceRepo,
    screenshots,
    reportFile,
    port,
    sourceBefore,
    state
  } = await initializeJourneyRuntime();

  async function startServer() {
    state.logStream = fs.createWriteStream(path.join(root, 'server.log'), { flags: state.serverStarts++ ? 'a' : 'w' });
    state.server = spawn(process.execPath, ['apps/api/server.mjs'], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        AIWS_PORT: String(port),
        AIWS_HOME: home,
        AIWS_TEST_RUN_ID: runId,
        AIWS_TEST_ADAPTERS: '1',
        NODE_ENV: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    state.server.stdout.pipe(state.logStream);
    state.server.stderr.pipe(state.logStream);
    await waitForServer(state.server, port);
  }

  async function stopServer() {
    const child = state.server;
    if (!child) return;
    state.server = null;
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), delay(5_000)]);
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    if (state.logStream) {
      state.logStream.end();
      await Promise.race([once(state.logStream, 'finish'), delay(1_000)]);
    }
    state.logStream = null;
  }

  async function openBrowserContext() {
    state.context = await state.browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      acceptDownloads: true
    });
    await state.context.route('https://github.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>GitHub test fixture</title>' })
    );
    state.page = await state.context.newPage();
    await state.page.emulateMedia({ reducedMotion: 'reduce' });
    state.page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        state.browserErrors.push(`console: ${message.text()}`);
    });
    state.page.on('pageerror', (error) => state.browserErrors.push(`pageerror: ${error.message}`));
    state.page.on('response', (response) => {
      const requestId = response.headers()['x-aiws-request-id'];
      if (requestId)
        state.requests.push({
          step: state.currentStep,
          method: response.request().method(),
          url: safeUrl(response.url()),
          status: response.status(),
          requestId
        });
      if (response.status() >= 400)
        state.browserErrors.push(`response: ${response.status()} ${safeUrl(response.url())}`);
    });
  }

  async function start() {
    await startServer();
    state.stateApi = await openFixtureState({ home });
    state.browser = await chromium.launch({ headless: true, ...browserExecutable() });
    await openBrowserContext();
    writeReport(state, 'RUNNING');
    return runtime;
  }

  async function step(title, action) {
    const id = `UJ-${String(state.steps.length + 1).padStart(2, '0')}`,
      started = Date.now();
    state.currentStep = id;
    try {
      const result = await action();
      await state.page.screenshot({ path: path.join(screenshots, `${id}-${slug(title)}.png`), fullPage: true });
      state.steps.push(stepRecord(state, id, title, 'PASS', started));
      writeReport(state, 'RUNNING');
      return result;
    } catch (error) {
      await state.page
        ?.screenshot({ path: path.join(screenshots, `${id}-${slug(title)}-FAIL.png`), fullPage: true })
        .catch(() => undefined);
      state.steps.push(stepRecord(state, id, title, 'FAIL', started, error));
      writeReport(state, 'FAIL');
      throw error;
    } finally {
      state.currentStep = null;
    }
  }

  async function api(route, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-aiws-request-id': `journey_${runId}_${Date.now()}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    const requestId = response.headers.get('x-aiws-request-id');
    if (requestId)
      state.requests.push({ step: state.currentStep, method, url: route, status: response.status, requestId });
    assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(payload)}`);
    return payload;
  }

  async function restartServer() {
    await stopServer();
    await assertPortFree(port);
    await startServer();
  }
  async function reopenBrowserContext() {
    await state.context?.close();
    await openBrowserContext();
    return state.page;
  }

  async function finish(failure) {
    let finalError = failure;
    await state.context?.close().catch(() => undefined);
    await state.browser?.close().catch(() => undefined);
    await stopServer();
    const persistedState = await closeJourneyState(state);
    const sourceAfter = repositorySnapshot(sourceRepo);
    state.cleanup.sourceUnchanged = JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore);
    state.cleanup.portReleased = await portIsFree(port);
    state.cleanup.activeResources = persistedState ? activeResources(persistedState) : null;
    state.cleanup.browserErrors = [...new Set(state.browserErrors)].filter((item) => !item.includes('favicon'));
    const secretValues = ['journey-client-secret', 'journey-private-key', 'journey-webhook-secret', 'journey-api-key'],
      stateFiles = ['state.json', 'state-v22.sqlite', 'state-v22.sqlite-wal']
        .map((name) => path.join(home, 'data', name))
        .filter(fs.existsSync),
      stateSnapshot = persistedState ? JSON.stringify(persistedState, null, 2) : '';
    state.cleanup.secretsAbsent =
      !containsSecrets(root, secretValues, stateFiles) && !secretValues.some((value) => stateSnapshot.includes(value));
    if (state.cleanup.secretsAbsent && persistedState)
      fs.writeFileSync(path.join(root, 'state-snapshot.json'), stateSnapshot);
    if (ephemeralFixture) {
      try {
        fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        state.cleanup.fixtureCleanup = fs.existsSync(fixtureRoot) ? 'failed' : 'removed';
      } catch {
        state.cleanup.fixtureCleanup = 'failed';
      }
    } else state.cleanup.fixtureCleanup = 'retained-evidence';
    const cleanupOk =
      state.cleanup.sourceUnchanged &&
      state.cleanup.portReleased &&
      state.cleanup.activeResources === 0 &&
      state.cleanup.browserErrors.length === 0 &&
      state.cleanup.secretsAbsent &&
      state.cleanup.fixtureCleanup !== 'failed';
    if (!finalError && !cleanupOk)
      finalError = new Error(`journey cleanup audit failed: ${JSON.stringify(state.cleanup)}`);
    state.finishedAt = new Date().toISOString();
    state.failure = finalError ? String(finalError.stack || finalError.message || finalError) : null;
    writeReport(state, finalError ? 'FAIL' : 'PASS');
    fs.writeFileSync(path.join(root, 'journey-result.json'), JSON.stringify(publicState(state), null, 2));
    console.log(`V1.75 user journey ${finalError ? 'failed' : 'passed'}: ${root}`);
    return finalError;
  }

  const runtime = {
    get page() {
      return state.page;
    },
    get context() {
      return state.context;
    },
    runId,
    root,
    home,
    sourceRepo,
    screenshots,
    reportFile,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    start,
    step,
    api,
    restartServer,
    reopenBrowserContext,
    finish
  };
  return runtime;
}

async function closeJourneyState(state) {
  let persistedState = null;
  try {
    persistedState = await state.stateApi?.readState();
  } catch {}
  await state.stateApi?.checkpointAndCloseState().catch(() => undefined);
  state.stateApi = null;
  return persistedState;
}

async function initializeJourneyRuntime() {
  const runId = process.env.AIWS_USER_JOURNEY_RUN_ID || utcRunId();
  const evidenceRoot =
    process.env.AIWS_USER_JOURNEY_ROOT ||
    (process.env.AIWS_TEST_REPORT_DIR ? path.join(process.env.AIWS_TEST_REPORT_DIR, 'user-journeys') : 'temp');
  const root = path.resolve(evidenceRoot, `v175-user-journey-${runId}`);
  const ephemeralFixture = Boolean(process.env.AIWS_TEST_REPORT_DIR && !process.env.AIWS_USER_JOURNEY_ROOT);
  const fixtureRoot = ephemeralFixture ? path.join(os.tmpdir(), `aiws-v175-journey-${runId}-${process.pid}`) : root;
  const home = path.join(fixtureRoot, 'aiws-home'),
    sourceRepo = path.join(fixtureRoot, 'source-repository');
  const screenshots = path.join(root, 'screenshots'),
    reportFile = path.join(root, '测试结果v1.75-真实用户旅程.md');
  for (const directory of [root, home, sourceRepo, screenshots]) fs.mkdirSync(directory, { recursive: true });
  initializeRepository(sourceRepo);
  const sourceBefore = repositorySnapshot(sourceRepo),
    port = await freePort();
  const state = {
    runId,
    root,
    fixtureRoot,
    ephemeralFixture,
    home,
    sourceRepo,
    screenshots,
    reportFile,
    port,
    steps: [],
    requests: [],
    browserErrors: [],
    cleanup: {},
    startedAt: new Date().toISOString(),
    currentStep: null,
    server: null,
    serverStarts: 0,
    logStream: null,
    stateApi: null,
    browser: null,
    context: null,
    page: null
  };
  return {
    runId,
    root,
    fixtureRoot,
    ephemeralFixture,
    home,
    sourceRepo,
    screenshots,
    reportFile,
    port,
    sourceBefore,
    state
  };
}

function initializeRepository(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'v175-user-journey-fixture',
        private: true,
        scripts: {
          test: 'node --test',
          typecheck: 'node --check src/index.js',
          lint: 'node --check src/index.js',
          build: 'node --check src/index.js'
        }
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(root, 'src', 'index.js'), "export const journey = 'initial';\n");
  fs.writeFileSync(path.join(root, 'README.md'), '# V1.75 user journey source\n');
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'journey@example.test']);
  runGit(root, ['config', 'user.name', 'V1.75 Journey']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'fixture baseline']);
}
function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
function stepRecord(state, id, title, status, started, error) {
  const requests = state.requests.filter((item) => item.step === id);
  return {
    id,
    title,
    status,
    duration_ms: Date.now() - started,
    request_ids: requests.map((item) => item.requestId),
    error: error ? String(error.stack || error.message || error) : null
  };
}
function publicState(state) {
  return {
    run_id: state.runId,
    status: state.failure ? 'FAIL' : 'PASS',
    started_at: state.startedAt,
    finished_at: state.finishedAt,
    root: state.root,
    fixture_root: state.fixtureRoot,
    home: state.home,
    source_repository: state.sourceRepo,
    port: state.port,
    steps: state.steps,
    requests: state.requests,
    cleanup: state.cleanup,
    failure: state.failure
  };
}
function writeReport(state, status) {
  const rows =
    state.steps
      .map(
        (item) =>
          `| ${item.id} | ${item.title} | ${item.status} | ${item.duration_ms} | ${item.request_ids.join('<br>') || '-'} |`
      )
      .join('\n') || '| - | 尚未执行 | RUNNING | - | - |';
  const cleanup = Object.keys(state.cleanup).length
    ? `\n## 资源与污染审计\n\n\`\`\`json\n${JSON.stringify(state.cleanup, null, 2)}\n\`\`\`\n`
    : '';
  const failure = state.failure ? `\n## 失败\n\n\`\`\`text\n${state.failure}\n\`\`\`\n` : '';
  fs.writeFileSync(
    state.reportFile,
    `# V1.75 真实用户全业务旅程\n\n- 状态：${status}\n- Run ID：\`${state.runId}\`\n- 产品版本：\`2.2.0\`\n- State schema：\`22\`\n- 隔离目录：\`${state.root}\`\n- AIWS_HOME：\`${state.home}\`\n- 源仓库：\`${state.sourceRepo}\`\n- 开始时间：${state.startedAt}\n- 完成时间：${state.finishedAt || '-'}\n\n## 步骤结果\n\n| ID | 用户步骤 | 状态 | 耗时 ms | 请求 ID |\n| --- | --- | --- | ---: | --- |\n${rows}\n${cleanup}${failure}`
  );
}
function activeResources(state) {
  const turns = (state.assist_turns || []).filter((item) =>
    ['queued', 'preparing', 'running', 'stopping', 'waiting_user_input', 'waiting_approval'].includes(item.status)
  ).length;
  const runs = (state.node_runs || []).filter((item) => ['queued', 'running'].includes(item.status)).length;
  const terminals = (state.terminal_sessions || []).filter(
    (item) => !['completed', 'failed', 'cancelled', 'stopped', 'rolled_back'].includes(item.status)
  ).length;
  return turns + runs + terminals;
}
function containsSecrets(root, values, extraFiles = []) {
  const files = [
    ...['server.log', '测试结果v1.75-真实用户旅程.md', 'journey-result.json'].map((name) => path.join(root, name)),
    ...extraFiles
  ].filter(fs.existsSync);
  return files.some((file) => {
    const bytes = fs.readFileSync(file);
    return values.some((value) => bytes.includes(Buffer.from(value)));
  });
}
async function waitForServer(child, port) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null) throw new Error(`API exited before ready: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error('API did not start');
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
async function portIsFree(port) {
  try {
    await assertPortFree(port);
    return true;
  } catch {
    return false;
  }
}
async function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return String(value).split(/[?#]/, 1)[0];
  }
}
function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
function utcRunId() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', 'T');
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
