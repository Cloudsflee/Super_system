#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { limitedLog, readJson, runCommand, utcRunId, writeFileEnsured } from './v175-lib.mjs';

const mode = process.argv[2];
if (!['pr', 'full', 'release'].includes(mode)) {
  console.error('usage: node scripts/v23-runner.mjs <pr|full|release>');
  process.exit(2);
}
const catalog = readJson('tests/v23/catalog.json'),
  suites = readJson('tests/v23/suites.json'),
  byId = new Map(catalog.tests.map((item) => [item.id, item])),
  selected = suites[mode].map((id) => byId.get(id)),
  budgetMs = Number(catalog.budgets_ms[mode]),
  runId = utcRunId(`${mode}-`),
  reportDir = path.join(process.cwd(), '.ai-workspace', 'test-reports', 'v2.3', runId),
  startedAt = new Date(),
  started = Date.now(),
  results = [];
fs.mkdirSync(reportDir, { recursive: true });

for (const item of selected) {
  const remaining = budgetMs - (Date.now() - started);
  if (remaining <= 1000) {
    results.push(caseResult(item, 'SKIPPED', 0, 'suite budget exhausted'));
    continue;
  }
  const missing = (item.requires_env || []).filter((name) => !process.env[name]);
  if (missing.length) {
    results.push(caseResult(item, 'BLOCKED', 0, `missing env: ${missing.join(', ')}`));
    continue;
  }
  const caseRoot = path.join(reportDir, 'fixtures', item.id.toLowerCase()),
    caseHome = path.join(caseRoot, 'home');
  fs.mkdirSync(caseHome, { recursive: true });
  const env = {
    ...process.env,
    AIWS_HOME: caseHome,
    AIWS_TEST_RUN_ID: runId,
    AIWS_TEST_CASE_ID: item.id,
    AIWS_TEST_REPORT_DIR: caseRoot,
    NODE_ENV: 'test',
    AIWS_GATE_CACHE_DISABLED:
      mode === 'release' || item.external_effects === 'docker' || item.external_effects === 'live'
        ? '1'
        : process.env.AIWS_GATE_CACHE_DISABLED
  };
  const timeout = Math.min(Number(item.timeout_ms), remaining),
    result = await runCommand(item.command, { timeout, env }),
    cleanup = cleanupCaseHome(caseHome),
    output = limitedLog(`${result.stdout || ''}\n${result.stderr || ''}\n${runnerDiagnostic(result, cleanup)}`, env),
    status = cleanup.ok
      ? result.status === 0 && !result.timedOut
        ? 'PASS'
        : result.timedOut
          ? 'TIMEOUT'
          : 'FAIL'
      : 'FAIL';
  writeFileEnsured(path.join(reportDir, `${item.id}.log`), `${output}\n`);
  results.push(caseResult(item, status, result.durationMs, output.slice(-4000), cleanup.status));
  console.log(`[v23:${mode}] ${item.id} ${status} (${result.durationMs}ms)`);
  if (status !== 'PASS') break;
}

const report = {
    schema_version: 'aiws.test_report.v23',
    product_version: '2.3.0',
    state_schema: 23,
    run_id: runId,
    mode,
    base_sha: process.env.AIWS_TEST_BASE_SHA || null,
    head_sha: process.env.AIWS_TEST_HEAD_SHA || null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    budget_ms: budgetMs,
    cache_used: false,
    results
  },
  passed = results.length === selected.length && results.every((item) => item.status === 'PASS');
writeFileEnsured(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileEnsured(
  path.join(reportDir, 'report.md'),
  [
    '# AIWS V2.3 Test Report',
    '',
    `- Mode: \`${mode}\``,
    `- Result: \`${passed ? 'PASS' : 'FAIL'}\``,
    `- Base: \`${report.base_sha || 'working-tree'}\``,
    `- Head: \`${report.head_sha || 'working-tree'}\``,
    `- Duration: \`${report.duration_ms}ms\` / \`${budgetMs}ms\``,
    '- Cache used: `false`',
    '',
    '| ID | Status | Duration |',
    '| --- | --- | ---: |',
    ...results.map((item) => `| ${item.id} | ${item.status} | ${item.duration_ms}ms |`),
    ''
  ].join('\n')
);
if (!passed) process.exit(1);
console.log(`V2.3 ${mode} suite passed in ${report.duration_ms}ms; report: ${reportDir}`);

function caseResult(item, status, durationMs, detail, cleanup = 'not-started') {
  return { id: item.id, layer: item.layer, domain: item.domain, status, duration_ms: durationMs, detail, cleanup };
}

function cleanupCaseHome(caseHome) {
  try {
    fs.rmSync(caseHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { ok: true, status: 'isolated-home-removed' };
  } catch (error) {
    return { ok: false, status: `isolated-home-cleanup-failed:${error.code || 'unknown'}` };
  }
}

function runnerDiagnostic(result, cleanup) {
  return (
    `[runner] status=${result.status ?? 'none'} signal=${result.signal || 'none'} ` +
    `timed_out=${result.timedOut === true} error=${result.error?.code || 'none'} cleanup=${cleanup.status}`
  );
}
