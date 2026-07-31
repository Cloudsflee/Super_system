#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { limitedLog, readJson, runCommand, utcRunId, writeFileEnsured } from './v175-lib.mjs';

const mode = process.argv[2];
if (!['pr', 'full', 'release'].includes(mode)) {
  console.error('usage: node scripts/v22-runner.mjs <pr|full|release>');
  process.exit(2);
}
const catalog = readJson('tests/v22/catalog.json'),
  suites = readJson('tests/v22/suites.json'),
  byId = new Map(catalog.tests.map((item) => [item.id, item])),
  selected = suites[mode].map((id) => byId.get(id)),
  budgetMs = Number(catalog.budgets_ms[mode]),
  runId = utcRunId(`${mode}-`),
  reportDir = path.join(process.cwd(), '.ai-workspace', 'test-reports', 'v2.2', runId),
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
  const caseRoot = path.join(reportDir, 'fixtures', item.id.toLowerCase());
  fs.mkdirSync(caseRoot, { recursive: true });
  const env = {
    ...process.env,
    AIWS_TEST_RUN_ID: runId,
    AIWS_TEST_CASE_ID: item.id,
    AIWS_TEST_REPORT_DIR: caseRoot,
    AIWS_GATE_CACHE_DISABLED:
      mode === 'release' || item.external_effects === 'docker' || item.external_effects === 'live'
        ? '1'
        : process.env.AIWS_GATE_CACHE_DISABLED
  };
  const timeout = Math.min(Number(item.timeout_ms), remaining),
    result = await runCommand(item.command, { timeout, env }),
    output = limitedLog(`${result.stdout || ''}\n${result.stderr || ''}`, 80_000),
    status = result.status === 0 && !result.timedOut ? 'PASS' : result.timedOut ? 'TIMEOUT' : 'FAIL';
  writeFileEnsured(path.join(reportDir, `${item.id}.log`), `${output}\n`);
  results.push(caseResult(item, status, result.durationMs, output.slice(-4000)));
  console.log(`[v22:${mode}] ${item.id} ${status} (${result.durationMs}ms)`);
  if (status !== 'PASS') break;
}

const report = {
    schema_version: 'aiws.test_report.v22',
    product_version: '2.2.0',
    state_schema: 22,
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
    '# AIWS V2.2 Test Report',
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
console.log(`V2.2 ${mode} suite passed in ${report.duration_ms}ms; report: ${reportDir}`);

function caseResult(item, status, durationMs, detail) {
  return { id: item.id, layer: item.layer, domain: item.domain, status, duration_ms: durationMs, detail };
}
