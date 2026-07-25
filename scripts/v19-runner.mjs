#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { limitedLog, readJson, runCommand, utcRunId, writeFileEnsured } from './v175-lib.mjs';

const mode = process.argv[2];
const supportedModes = ['pr', 'full', 'live', 'release', 'soak'];
if (!supportedModes.includes(mode)) {
  console.error('usage: node scripts/v19-runner.mjs <pr|full|live|release|soak>');
  process.exit(2);
}

const root = process.cwd();
const catalog = readJson('tests/v19/catalog.json');
const suites = readJson('tests/v19/suites.json');
const byId = new Map(catalog.tests.map((item) => [item.id, item]));
const selected = suites[mode].map((id) => byId.get(id));
const budgetMs = Number(catalog.budgets_ms[mode]);
const runId = utcRunId(`${mode}-`);
const reportDir = path.join(root, '.ai-workspace', 'test-reports', 'v1.9', runId);
const startedAt = new Date();
const started = Date.now();
const results = [];
fs.mkdirSync(reportDir, { recursive: true });

const gitResult = await runCommand(['git', 'rev-parse', 'HEAD'], { timeout: 15_000 });
const gitSha = gitResult.status === 0 ? gitResult.stdout.trim() : 'unavailable';
const source = await sourceState();

for (const item of selected) await executeCase(item, 1);

if (mode === 'soak' && !results.some((item) => item.status !== 'PASS')) {
  const requestedMinutes = Number(process.env.AIWS_V19_SOAK_MINUTES || 120);
  const durationMs = Math.min(Math.max(Number.isFinite(requestedMinutes) ? requestedMinutes : 120, 1), 120) * 60_000;
  const repeatable = selected.filter((item) => item.id !== 'V19-L0-PLAN-001');
  let cycle = 2;
  soak: while (Date.now() - started < durationMs) {
    for (const item of repeatable) {
      if (budgetMs - (Date.now() - started) <= 1_000) break soak;
      await executeCase(item, cycle);
      if (results.at(-1).status !== 'PASS') break soak;
    }
    cycle += 1;
  }
}

const elapsedMs = Date.now() - started;
if (elapsedMs > budgetMs)
  results.push({
    id: 'V19-BUDGET',
    case_id: 'V19-BUDGET',
    command: '',
    priority: 'P0',
    status: 'FAIL',
    duration_ms: 0,
    cleanup: 'not-applicable',
    summary: `Suite exceeded ${budgetMs} ms budget.`,
    log: null,
    cycle: 1
  });
const status = aggregateStatus(results);
const finishedAt = new Date();
const markdown = reportMarkdown({ status, elapsedMs, gitSha, source, startedAt, finishedAt });
writeFileEnsured(path.join(reportDir, '测试结果v1.9.md'), markdown);
writeFileEnsured(
  path.join(reportDir, 'results.json'),
  `${JSON.stringify(
    {
      run_id: runId,
      suite: mode,
      product_version: catalog.product_version,
      state_schema: catalog.state_schema,
      git_sha: gitSha,
      git_dirty: source.dirty,
      source_fingerprint: source.fingerprint,
      status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      elapsed_ms: elapsedMs,
      budget_ms: budgetMs,
      report: '测试结果v1.9.md',
      results: results.map(({ evidence, ...item }) => item)
    },
    null,
    2
  )}\n`
);

console.log(`V1.9 ${mode} report: ${path.relative(root, reportDir)}`);
if (status === 'BLOCKED') process.exit(2);
if (status !== 'PASS') process.exit(1);

async function executeCase(item, cycle) {
  const caseId = cycle === 1 ? item.id : `${item.id}#${cycle}`;
  const remaining = budgetMs - (Date.now() - started);
  if (remaining <= 1_000) {
    results.push(result(item, caseId, cycle, 'SKIPPED', 0, 'not-started', 'Global suite budget exhausted.', null, ''));
    return;
  }
  const blocked = precondition(item);
  if (blocked) {
    results.push(result(item, caseId, cycle, 'BLOCKED', 0, 'not-started', blocked, null, ''));
    return;
  }

  const caseRoot = path.join(reportDir, 'fixtures', safeName(caseId));
  const home = path.join(caseRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    AIWS_HOME: home,
    AIWS_TEST_REPORT_DIR: reportDir,
    AIWS_TEST_RUN_ID: runId,
    AIWS_V19_RUN_ID: runId,
    AIWS_TEST_CASE_ID: caseId,
    NODE_ENV: 'test'
  };
  const timeout = Math.max(1_000, Math.min(Number(item.timeout_ms), remaining));
  console.log(`\n[v19] ${caseId} ${item.layer}/${item.domain}`);
  const executed = await runCommand(item.command, { timeout, inherit: true, env });
  const evidence = limitedLog(`[stdout]\n${executed.stdout}\n[stderr]\n${executed.stderr}`, { ...process.env, ...env });
  const logRelative = path.posix.join('logs', `${safeName(caseId)}.log`);
  writeFileEnsured(path.join(reportDir, logRelative), evidence);
  const cleanup = removeCaseRoot(caseRoot) ? 'isolated-home-removed' : 'isolated-home-cleanup-failed';
  const caseStatus = executed.status === 0 && !executed.timedOut ? 'PASS' : executed.status === 2 ? 'BLOCKED' : 'FAIL';
  const summary = executed.timedOut
    ? `Timed out after ${timeout} ms.`
    : executed.error
      ? `Failed to start: ${executed.error.message}`
      : executed.status === 0
        ? 'Command passed.'
        : `Command exited with status ${executed.status ?? 'unknown'}.`;
  results.push(
    result(
      item,
      caseId,
      cycle,
      cleanup === 'isolated-home-removed' ? caseStatus : 'FAIL',
      executed.durationMs,
      cleanup,
      summary,
      logRelative,
      evidence
    )
  );
}

function precondition(item) {
  const missing = item.requires_env.filter((key) => !String(process.env[key] || '').trim());
  if (missing.length) return `Missing required environment variable(s): ${missing.join(', ')}.`;
  if (item.id === 'V19-L6-LIVE-001' && process.env.AIWS_MCP_LIVE_SMOKE_CONFIRM !== 'create-private-github-repository')
    return 'AIWS_MCP_LIVE_SMOKE_CONFIRM must equal create-private-github-repository.';
  return null;
}

function result(item, caseId, cycle, status, durationMs, cleanup, summary, log, evidence) {
  return {
    id: item.id,
    case_id: caseId,
    cycle,
    layer: item.layer,
    domain: item.domain,
    priority: item.priority,
    command: item.command.join(' '),
    status,
    duration_ms: durationMs,
    cleanup,
    summary,
    log,
    evidence
  };
}

function aggregateStatus(items) {
  if (items.some((item) => item.status === 'FAIL' || item.status === 'SKIPPED')) return 'FAIL';
  if (items.some((item) => item.status === 'BLOCKED')) return 'BLOCKED';
  if (items.some((item) => item.status === 'FLAKY')) return 'FLAKY';
  return 'PASS';
}

function reportMarkdown({ status, elapsedMs, gitSha, source, startedAt, finishedAt }) {
  const totals = Object.fromEntries(
    ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY'].map((value) => [
      value,
      results.filter((item) => item.status === value).length
    ])
  );
  const lines = [
    '# AIWS 测试结果 V1.9',
    '',
    `- Run ID：\`${runId}\``,
    `- Suite：\`${mode}\``,
    `- 产品版本：\`${catalog.product_version}\``,
    `- state schema：\`${catalog.state_schema}\``,
    `- Git SHA：\`${gitSha}\``,
    `- Git 工作树：\`${source.dirty ? 'dirty' : 'clean'}\``,
    `- Source fingerprint：\`${source.fingerprint}\``,
    `- 结果：\`${status}\``,
    `- 耗时：${elapsedMs} ms`,
    `- 预算：${budgetMs} ms`,
    `- 开始：${startedAt.toISOString()}`,
    `- 结束：${finishedAt.toISOString()}`,
    `- 统计：PASS ${totals.PASS} / FAIL ${totals.FAIL} / BLOCKED ${totals.BLOCKED} / SKIPPED ${totals.SKIPPED} / FLAKY ${totals.FLAKY}`,
    '- 隔离：每个命令使用独立 AIWS_HOME；命令结束后删除隔离目录。',
    '- 脱敏：日志通过 limitedLog() 截断并移除环境变量凭据、Token、API Key 和带查询参数 URL。',
    '',
    '| 用例 | 命令 | 状态 | 耗时 | 清理 |',
    '|---|---|---|---:|---|',
    ...results.map(
      (item) =>
        `| \`${table(item.case_id)}\` | \`${table(item.command)}\` | ${item.status} | ${item.duration_ms} ms | ${table(item.cleanup)} |`
    ),
    ''
  ];
  for (const item of results.filter((entry) => entry.status !== 'PASS')) {
    lines.push(`## ${item.status}: ${item.case_id}`, '', item.summary, '');
    if (item.log) lines.push(`日志：\`${item.log}\``, '');
    if (item.evidence) lines.push('```text', item.evidence, '```', '');
  }
  lines.push(`生成时间：${finishedAt.toISOString()}`, '');
  return lines.join('\n');
}

function removeCaseRoot(caseRoot) {
  const relative = path.relative(reportDir, path.resolve(caseRoot));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    fs.rmSync(caseRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

async function sourceState() {
  const [status, diff, untracked] = await Promise.all([
    runCommand(['git', 'status', '--porcelain=v1', '--untracked-files=all'], {
      timeout: 15_000,
      maxCapture: 8 * 1024 * 1024
    }),
    runCommand(['git', 'diff', '--no-ext-diff', '--binary', 'HEAD'], { timeout: 30_000, maxCapture: 32 * 1024 * 1024 }),
    runCommand(['git', 'ls-files', '--others', '--exclude-standard', '-z'], {
      timeout: 15_000,
      maxCapture: 8 * 1024 * 1024
    })
  ]);
  const hash = crypto.createHash('sha256');
  hash.update(diff.stdout || '');
  for (const relative of untracked.stdout.split('\0').filter(Boolean).sort()) {
    const file = path.resolve(root, relative);
    const withinRoot = !path.relative(root, file).startsWith('..') && !path.isAbsolute(path.relative(root, file));
    hash.update(`\0${relative}\0`);
    if (withinRoot && fs.existsSync(file) && fs.statSync(file).isFile()) hash.update(fs.readFileSync(file));
  }
  return { dirty: Boolean(status.stdout.trim()), fingerprint: hash.digest('hex') };
}

function safeName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
}
function table(value) {
  return String(value || '')
    .replaceAll('|', '\\|')
    .replaceAll('`', "'");
}
