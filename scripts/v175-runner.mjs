import fs from 'node:fs';
import path from 'node:path';
import { captureBaseline, finishBaseline } from './v175-baseline.mjs';
import { resolveGateConcurrency, runDependencyGraph } from './gate-scheduler.mjs';
import { collectImpact } from './v175-impact.mjs';
import { createLoopbackPortAllocator } from './loopback-port-allocator.mjs';
import { V175Report } from './v175-report.mjs';
import {
  REPORT_ROOT,
  ROOT,
  interpolateArg,
  limitedLog,
  readJson,
  runCommand,
  runCommandSync,
  sha256,
  utcRunId,
  writeFileEnsured
} from './v175-lib.mjs';

const mode = process.argv[2];
if (!['pr', 'full', 'live', 'soak', 'release'].includes(mode)) {
  console.error('usage: node scripts/v175-runner.mjs <pr|full|live|soak|release>');
  process.exit(2);
}

const PLAN_TIMEOUT = 60_000,
  PR_BUDGET = 15 * 60_000,
  FULL_BUDGET = 90 * 60_000,
  SOAK_BUDGET = 120 * 60_000;
const allocateTestPort = createLoopbackPortAllocator();
const budgets = {
  pr: PR_BUDGET,
  full: FULL_BUDGET,
  live: 30 * 60_000,
  release: FULL_BUDGET,
  soak: SOAK_BUDGET + 60_000
};
const plan = await runCommand(['node', 'scripts/v175-plan.mjs'], { timeout: PLAN_TIMEOUT, inherit: true });
if (plan.status !== 0) process.exit(plan.status || 1);

const catalog = readJson('tests/v175/catalog.json'),
  base = process.env.AIWS_TEST_BASE_SHA || 'HEAD';
let impact;
try {
  impact = collectImpact(base);
} catch (error) {
  console.error(`V1.75 impact collection failed: ${error.message}`);
  process.exit(1);
}
if (impact.unclassified.length) {
  console.error(`unclassified business files:\n${impact.unclassified.join('\n')}`);
  process.exit(1);
}

const runId = utcRunId(`${mode}-`),
  reportDir = path.join(REPORT_ROOT, runId);
fs.mkdirSync(reportDir, { recursive: true });
const selected = selectCases(catalog.tests, mode, impact.domains);
const isolation = {
  child_aiws_home: true,
  report_output_redirected: true,
  docker_context_excludes_active_workspace: fs
    .readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .includes('.ai-workspace')
};
const baseline = captureBaseline(reportDir, runId, isolation);
const report = new V175Report({
  directory: reportDir,
  runId,
  mode,
  catalog,
  baseline,
  impact,
  selectedIds: new Set(selected.map((item) => item.id))
});
const started = Date.now(),
  concurrency = resolveGateConcurrency(mode),
  deferredCleanup = new Map(),
  variables = {
    RUN_ID: runId,
    REPORT_DIR: reportDir,
    BASE_SHA: impact.base
  };
console.log(`[v175] dependency scheduler concurrency=${concurrency}`);
await runDependencyGraph(selected, {
  concurrency,
  resourceKey: v175ResourceKey,
  execute: executeSelectedCase,
  onBlocked: blockSelectedCase
});

function v175ResourceKey(item) {
  return item.command.includes('scripts/v175-suite.mjs') || item.id === 'V175-L3-WEB-001' ? 'v175-host-heavy' : null;
}

async function executeSelectedCase(item) {
  const elapsed = Date.now() - started,
    remaining = budgets[mode] - elapsed;
  if (remaining <= 1000) {
    report.setResult(item.id, resultPatch(item, 'SKIPPED', 'budget', '全局时间预算已耗尽'));
    return { ok: false, status: 'SKIPPED' };
  }
  const precondition = checkPreconditions(item);
  if (precondition) {
    report.setResult(item.id, resultPatch(item, 'BLOCKED', 'precondition', precondition));
    return { ok: false, status: 'BLOCKED' };
  }

  console.log(`\n[v175] ${item.id} ${item.layer}/${item.domain}`);
  const first = await attempt(item, 1, Math.min(item.timeout, remaining));
  let status = first.ok ? 'PASS' : 'FAIL',
    rerun = null,
    summary = first.summary;
  if (!first.ok && budgets[mode] - (Date.now() - started) > 1000) {
    console.log(`[v175] isolate rerun ${item.id}`);
    rerun = await attempt(item, 2, Math.min(item.timeout, budgets[mode] - (Date.now() - started)));
    status = rerun.ok ? 'FLAKY' : 'FAIL';
    summary = rerun.ok
      ? `首次失败，隔离重跑通过：${first.summary}`
      : `${first.summary}; 隔离重跑仍失败：${rerun.summary}`;
  }
  const cleanupState =
    first.homeCleanup && (!rerun || rerun.homeCleanup) ? 'isolated-home-removed' : 'isolated-home-cleanup-failed';
  report.setResult(item.id, {
    status,
    phase: 'execution',
    duration_ms: first.durationMs + (rerun?.durationMs || 0),
    request_id: first.requestId,
    cleanup: cleanupState,
    summary,
    log: path.relative(ROOT, rerun?.logFile || first.logFile).replaceAll('\\', '/'),
    first_attempt_status: first.ok ? 'PASS' : 'FAIL',
    rerun_status: rerun ? (rerun.ok ? 'PASS' : 'FAIL') : null
  });
  for (const command of item.cleanup) {
    const argv = command.map((arg) => interpolateArg(arg, variables)),
      key = JSON.stringify(argv);
    const pending = deferredCleanup.get(key) || { argv, ids: [] };
    pending.ids.push(item.id);
    deferredCleanup.set(key, pending);
  }
  return { ok: ['PASS', 'FLAKY'].includes(status), status };
}

async function blockSelectedCase(item, blockedBy) {
  report.setResult(item.id, resultPatch(item, 'BLOCKED', 'dependency', `依赖未通过：${blockedBy.join(', ')}`));
  return { ok: false, status: 'BLOCKED' };
}

for (const cleanup of [...deferredCleanup.values()].reverse()) {
  const result = await runCommand(cleanup.argv, { timeout: 180000 });
  const state =
    result.status === 0
      ? 'completed'
      : `failed:${limitedLog(result.stderr || result.stdout)
          .split(/\r?\n/)
          .at(-1)}`;
  for (const id of cleanup.ids)
    report.setResult(id, { cleanup: `${formatCleanup(report.results.get(id).cleanup)}; docker=${state}` });
}

const finalBaseline = finishBaseline(baseline, reportDir);
report.finalize(finalBaseline);
const selectedResults = selected.map((item) => report.results.get(item.id));
const unsuccessful = selectedResults.filter((item) => item.status !== 'PASS');
const polluted =
  finalBaseline.source_polluted || finalBaseline.active_workspace_polluted || !finalBaseline.resources_clean;
console.log(
  `\nV1.75 ${mode} completed: ${selectedResults.length - unsuccessful.length}/${selectedResults.length} PASS`
);
console.log(`Report: ${path.join(reportDir, '测试结果v1.75.md')}`);
if (unsuccessful.length || polluted) process.exit(1);

function selectCases(items, selectedMode, domains) {
  const eligible = items.filter((item) => item.suites.includes(selectedMode));
  const wanted = new Set(
    eligible
      .filter(
        (item) => selectedMode !== 'pr' || item.layer === 'L0' || item.layer === 'L1' || domains.includes(item.domain)
      )
      .map((item) => item.id)
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items.filter((value) => wanted.has(value.id)))
      for (const dependency of item.dependencies)
        if (!wanted.has(dependency)) {
          wanted.add(dependency);
          changed = true;
        }
  }
  return items
    .filter((item) => wanted.has(item.id))
    .sort(
      (left, right) =>
        Number(left.layer.slice(1)) - Number(right.layer.slice(1)) || items.indexOf(left) - items.indexOf(right)
    );
}

function checkPreconditions(item) {
  const missing = (item.requires_env || []).filter((key) => !process.env[key]);
  if (missing.length) return `缺少专用环境变量：${missing.join(', ')}`;
  if (item.external_effects === 'docker') {
    const docker = runCommandSync(['docker', 'info', '--format', '{{.ServerVersion}}'], { timeout: 15000 });
    if (docker.status !== 0) return 'Docker daemon 不可用';
  }
  if (item.external_effects === 'codex' && !process.env.AIWS_TEST_LIVE_BASE_URL) {
    const codex = runCommandSync(['codex', '--version'], { timeout: 15000 });
    if (codex.status !== 0) return '专用 Codex CLI/Profile 不可用';
  }
  return null;
}

async function attempt(item, number, timeout) {
  const caseDir = path.join(reportDir, 'fixtures', item.id.toLowerCase(), `attempt-${number}`),
    home = path.join(caseDir, 'home');
  fs.rmSync(caseDir, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const port = await allocateTestPort(),
    requestId = `req_v175_${sha256(`${runId}:${item.id}:${number}`).slice(0, 24)}`;
  const env = {
    AIWS_HOME: home,
    AIWS_TEST_RUN_ID: runId,
    AIWS_TEST_CASE_ID: item.id,
    AIWS_TEST_REQUEST_ID: requestId,
    AIWS_TEST_PORT: String(port),
    AIWS_TEST_REPORT_DIR: reportDir,
    AIWS_TEST_DOCKER_LABEL: `aiws.test_run=${runId}`,
    AIWS_APP_IMAGE: `aiws-app:v175-${runId}`,
    AIWS_V175_AXE: '1',
    RUN_CODEX_LIVE_TESTS: item.external_effects === 'codex' ? '1' : process.env.RUN_CODEX_LIVE_TESTS,
    RUN_GITHUB_LIVE_TESTS: item.external_effects === 'github' ? '1' : process.env.RUN_GITHUB_LIVE_TESTS,
    RUN_CC_SWITCH_LIVE_TESTS: item.external_effects === 'cc-switch' ? '1' : process.env.RUN_CC_SWITCH_LIVE_TESTS
  };
  const argv = item.command.map((arg) => interpolateArg(arg, variables));
  const result = await runCommand(argv, { timeout: Math.max(1000, timeout), env });
  const combined = `[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}`;
  const logFile = path.join(reportDir, 'logs', `${item.id.toLowerCase()}-attempt-${number}.log`);
  writeFileEnsured(logFile, limitedLog(combined, { ...process.env, ...env }));
  let homeCleanup = true;
  try {
    fs.rmSync(caseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    homeCleanup = false;
  }
  const summary = result.timedOut
    ? `超时（${timeout}ms）`
    : result.error
      ? `测试基础设施启动失败：${result.error.message}`
      : result.status === 0
        ? '命令通过'
        : `命令退出码 ${result.status ?? 'unknown'}`;
  return {
    ok: result.status === 0 && !result.timedOut,
    durationMs: result.durationMs,
    requestId,
    logFile,
    homeCleanup,
    summary
  };
}

function resultPatch(item, status, phase, summary) {
  return {
    status,
    phase,
    summary,
    request_id: `req_v175_${sha256(`${runId}:${item.id}`).slice(0, 24)}`,
    cleanup: 'not-started',
    first_attempt_status: null,
    rerun_status: null
  };
}
function formatCleanup(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
