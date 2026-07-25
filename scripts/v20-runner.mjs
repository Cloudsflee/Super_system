#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { limitedLog, readJson, runCommand, runCommandSync, utcRunId, writeFileEnsured } from './v175-lib.mjs';

const mode = process.argv[2];
if (!['pr', 'full', 'release'].includes(mode)) {
  console.error('usage: node scripts/v20-runner.mjs <pr|full|release>');
  process.exit(2);
}
const catalog = readJson('tests/v20/catalog.json');
const suites = readJson('tests/v20/suites.json');
const byId = new Map(catalog.tests.map((item) => [item.id, item]));
const selected = suites[mode].map((id) => byId.get(id));
const budgetMs = Number(catalog.budgets_ms[mode]);
const runId = utcRunId(`${mode}-`);
const reportDir = path.join(process.cwd(), '.ai-workspace', 'test-reports', 'v2.0', runId);
const startedAt = new Date();
const started = Date.now();
const results = [];
fs.mkdirSync(reportDir, { recursive: true });

for (const item of selected) {
  const remaining = budgetMs - (Date.now() - started);
  if (remaining <= 1000) {
    results.push(result(item, 'SKIPPED', 0, 'suite budget exhausted', null));
    continue;
  }
  const blocked = precondition(item);
  if (blocked) {
    results.push(result(item, 'BLOCKED', 0, blocked, null));
    continue;
  }
  const caseRoot = path.join(reportDir, 'fixtures', item.id.toLowerCase());
  const home = path.join(caseRoot, 'home');
  fs.mkdirSync(home, { recursive: true });
  console.log(`\n[v20] ${item.id} ${item.layer}/${item.domain}`);
  const executed = await runCommand(item.command, {
    timeout: Math.max(1000, Math.min(Number(item.timeout_ms), remaining)),
    inherit: true,
    env: {
      AIWS_HOME: home,
      AIWS_TEST_REPORT_DIR: reportDir,
      AIWS_TEST_RUN_ID: runId,
      AIWS_TEST_CASE_ID: item.id,
      NODE_ENV: 'test'
    }
  });
  const evidence = limitedLog(`[stdout]\n${executed.stdout}\n[stderr]\n${executed.stderr}`);
  const log = path.posix.join('logs', `${item.id.toLowerCase()}.log`);
  writeFileEnsured(path.join(reportDir, log), evidence);
  let cleanup = true;
  try {
    fs.rmSync(caseRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    cleanup = false;
  }
  const status = executed.status === 0 && !executed.timedOut && cleanup ? 'PASS' : 'FAIL';
  results.push(
    result(
      item,
      status,
      executed.durationMs,
      executed.timedOut ? 'timed out' : cleanup ? `exit ${executed.status}` : 'fixture cleanup failed',
      log
    )
  );
}

const elapsedMs = Date.now() - started;
if (elapsedMs > budgetMs)
  results.push({ id: 'V20-BUDGET', status: 'FAIL', duration_ms: 0, summary: `exceeded ${budgetMs}ms`, log: null });
const status = results.some((item) => ['FAIL', 'SKIPPED'].includes(item.status))
  ? 'FAIL'
  : results.some((item) => item.status === 'BLOCKED')
    ? 'BLOCKED'
    : 'PASS';
const finishedAt = new Date();
writeFileEnsured(
  path.join(reportDir, 'results.json'),
  `${JSON.stringify(
    {
      run_id: runId,
      suite: mode,
      product_version: '2.0.0',
      state_schema: 20,
      status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      elapsed_ms: elapsedMs,
      budget_ms: budgetMs,
      results
    },
    null,
    2
  )}\n`
);
writeFileEnsured(path.join(reportDir, '测试结果v2.0.md'), reportMarkdown(status, elapsedMs, startedAt, finishedAt));
console.log(`V2.0 ${mode} report: ${path.relative(process.cwd(), reportDir)}`);
if (status === 'BLOCKED') process.exit(2);
if (status !== 'PASS') process.exit(1);

function precondition(item) {
  const missing = (item.requires_env || []).filter((name) => !String(process.env[name] || '').trim());
  if (missing.length) return `missing environment: ${missing.join(', ')}`;
  if (item.external_effects === 'docker') {
    const docker = runCommandSync(['docker', 'info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
    if (docker.status !== 0) return 'Docker daemon unavailable';
  }
  return null;
}

function result(item, status, durationMs, summary, log) {
  return {
    id: item.id,
    layer: item.layer,
    domain: item.domain,
    priority: item.priority,
    command: item.command.join(' '),
    status,
    duration_ms: durationMs,
    summary,
    log
  };
}

function reportMarkdown(status, elapsedMs, startedAt, finishedAt) {
  return [
    '# AIWS 测试结果 V2.0',
    '',
    `- Run ID：\`${runId}\``,
    `- Suite：\`${mode}\``,
    '- 产品版本：`2.0.0`',
    '- state schema：`20`',
    `- 结果：\`${status}\``,
    `- 耗时：${elapsedMs} ms / 预算 ${budgetMs} ms`,
    `- 开始：${startedAt.toISOString()}`,
    `- 结束：${finishedAt.toISOString()}`,
    '',
    '| 用例 | 状态 | 耗时 | 摘要 |',
    '|---|---|---:|---|',
    ...results.map((item) => `| \`${item.id}\` | ${item.status} | ${item.duration_ms} ms | ${item.summary} |`),
    ''
  ].join('\n');
}
