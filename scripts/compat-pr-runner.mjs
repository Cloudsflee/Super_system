#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { V18_CONTRACT_TESTS } from './v18-contract.mjs';
import { collectImpact } from './v175-impact.mjs';
import {
  ROOT,
  isMain,
  limitedLog,
  normalizePath,
  parseArgs,
  readJson,
  runCommand,
  utcRunId,
  writeFileEnsured
} from './v175-lib.mjs';

const BUDGET_MS = 15 * 60_000;

export function buildCompatibilityPlan({ domains, v175Catalog, suiteFiles, versionCatalogs }) {
  const selectedV175 = selectV175Cases(v175Catalog.tests, 'pr', domains),
    coverage = v175Coverage(selectedV175, suiteFiles),
    candidates = compatibilityCandidates(versionCatalogs),
    tasks = new Map(),
    aliases = [];

  for (const candidate of candidates) {
    const coveredBy = v175CoverageForCommand(candidate.command, coverage);
    if (coveredBy.length) {
      aliases.push({ ...candidate, status: 'DEDUPED', dedupe_kind: 'v175', covered_by: coveredBy });
      continue;
    }
    const key = commandKey(candidate.command),
      existing = tasks.get(key);
    if (existing) {
      const coveredByOwners = existing.owners.map(ownerLabel);
      existing.owners.push(candidate.owner);
      existing.timeout_ms = Math.max(existing.timeout_ms, candidate.timeout_ms);
      aliases.push({
        ...candidate,
        status: 'DEDUPED',
        dedupe_kind: 'supplemental',
        task_key: key,
        covered_by: coveredByOwners
      });
      continue;
    }
    tasks.set(key, {
      key,
      command: candidate.command,
      timeout_ms: candidate.timeout_ms,
      owners: [candidate.owner]
    });
  }

  return {
    selected_v175_ids: selectedV175.map((item) => item.id),
    selected_v175_groups: [...coverage.groups].sort(),
    v175_covered_files: [...coverage.files.keys()].sort(),
    declared_compatibility_cases: candidates.length,
    supplemental_tasks: [...tasks.values()],
    aliases
  };
}

export function selectV175Cases(items, mode, domains) {
  const eligible = items.filter((item) => item.suites.includes(mode)),
    wanted = new Set(
      eligible
        .filter((item) => mode !== 'pr' || item.layer === 'L0' || item.layer === 'L1' || domains.includes(item.domain))
        .map((item) => item.id)
    );
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items.filter((value) => wanted.has(value.id)))
      for (const dependency of item.dependencies || [])
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

export function commandKey(command) {
  const file = commandTestFile(command);
  if (file) {
    const index = command.indexOf(file),
      trailing = command.slice(index + 1);
    return `test-file:${normalizePath(file)}:${JSON.stringify(trailing)}`;
  }
  return `command:${JSON.stringify(command)}`;
}

async function main() {
  const args = parseArgs(),
    base = process.env.AIWS_TEST_BASE_SHA || 'HEAD',
    head = process.env.AIWS_TEST_HEAD_SHA || null,
    impact = collectImpact(base, head);
  if (impact.unclassified.length) throw new Error(`unclassified business files:\n${impact.unclassified.join('\n')}`);
  const plan = buildCompatibilityPlan({
    domains: impact.domains,
    v175Catalog: readJson('tests/v175/catalog.json'),
    suiteFiles: readJson('tests/v175/suite-files.json'),
    versionCatalogs: loadVersionCatalogs()
  });
  if (args.plan) {
    console.log(JSON.stringify({ base: impact.base, head: impact.head, domains: impact.domains, ...plan }, null, 2));
    return;
  }

  const runId = utcRunId('compat-pr-'),
    reportDir = path.join(ROOT, '.ai-workspace', 'test-reports', 'compat-pr', runId),
    started = Date.now(),
    results = [];
  fs.mkdirSync(reportDir, { recursive: true });
  console.log(
    `[compat-pr] V1.75 cases=${plan.selected_v175_ids.length}; compatibility cases=${plan.declared_compatibility_cases}; ` +
      `supplemental commands=${plan.supplemental_tasks.length}; deduplicated=${plan.aliases.length}`
  );

  const v175 = await runCommand(['node', 'scripts/v175-runner.mjs', 'pr'], {
    timeout: BUDGET_MS,
    inherit: true
  });
  results.push({
    key: 'v175:pr',
    command: ['node', 'scripts/v175-runner.mjs', 'pr'],
    owners: plan.selected_v175_ids.map((id) => ({ version: '1.75', id })),
    status: commandStatus(v175),
    duration_ms: v175.durationMs,
    detail: commandDetail(v175)
  });

  if (v175.status === 0 && !v175.timedOut) {
    for (const [index, task] of plan.supplemental_tasks.entries()) {
      const remaining = BUDGET_MS - (Date.now() - started);
      if (remaining <= 1000) {
        results.push({ ...task, status: 'TIMEOUT', duration_ms: 0, detail: 'compatibility budget exhausted' });
        break;
      }
      console.log(`\n[compat-pr] ${task.owners.map(ownerLabel).join(', ')} :: ${task.command.join(' ')}`);
      const fixture = path.join(reportDir, 'fixtures', String(index + 1).padStart(3, '0')),
        port = await freePort();
      fs.mkdirSync(fixture, { recursive: true });
      const executed = await runCommand(task.command, {
        timeout: Math.min(task.timeout_ms, remaining),
        inherit: true,
        env: {
          AIWS_HOME: path.join(fixture, 'home'),
          AIWS_TEST_CASE_ID: task.owners.map(ownerLabel).join(','),
          AIWS_TEST_PORT: String(port),
          AIWS_TEST_REPORT_DIR: fixture,
          AIWS_TEST_RUN_ID: runId,
          NODE_ENV: 'test'
        }
      });
      let cleanup = true;
      try {
        fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        cleanup = false;
      }
      const status = cleanup ? commandStatus(executed) : 'FAIL',
        result = {
          ...task,
          status,
          duration_ms: executed.durationMs,
          detail: cleanup ? commandDetail(executed) : 'fixture cleanup failed'
        };
      results.push(result);
      writeFileEnsured(path.join(reportDir, 'logs', `${String(index + 1).padStart(3, '0')}.log`), commandLog(executed));
      if (status !== 'PASS') break;
    }
  }

  const passed =
      results.length === plan.supplemental_tasks.length + 1 && results.every((item) => item.status === 'PASS'),
    report = buildCompatibilityReport({ runId, impact, plan, results, started, passed });
  writeFileEnsured(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileEnsured(path.join(reportDir, 'report.md'), renderReport(report));
  console.log(
    `\n[compat-pr] ${passed ? 'PASS' : 'FAIL'} in ${report.duration_ms}ms; ` +
      `${plan.aliases.length} duplicate ownership records reused; report: ${reportDir}`
  );
  if (!passed) process.exit(1);
}

function loadVersionCatalogs() {
  return Object.fromEntries(
    ['v18', 'v20', 'v21', 'v22'].map((version) => [
      version,
      {
        catalog: readJson(`tests/${version}/catalog.json`),
        suites: readJson(`tests/${version}/suites.json`)
      }
    ])
  );
}

function compatibilityCandidates(versionCatalogs) {
  const candidates = [
      candidate('1.8', 'V18-L0-PLAN-001', ['node', 'scripts/v18-plan.mjs'], 60_000),
      candidate('1.8', 'V18-L0-IMPACT-001', ['node', 'scripts/v18-impact.mjs', '--audit'], 60_000)
    ],
    v18Tests = versionCatalogs.v18.catalog.tests;
  for (const file of V18_CONTRACT_TESTS) {
    const item = v18Tests.find((test) => commandTestFile(test.command) === file);
    candidates.push(candidate('1.8', item?.id || `V18-CONTRACT-${path.basename(file)}`, ['node', file], 240_000));
  }
  const journey = v18Tests.find((test) => test.id === 'V18-L5-JOURNEY-002');
  candidates.push(candidate('1.8', journey.id, journey.command, 240_000));

  for (const version of ['v20', 'v21', 'v22']) {
    const { catalog, suites } = versionCatalogs[version],
      byId = new Map(catalog.tests.map((item) => [item.id, item]));
    for (const id of suites.pr) {
      const item = byId.get(id);
      if (!item) throw new Error(`compatibility_catalog_case_missing:${version}:${id}`);
      candidates.push(candidate(catalog.version, id, item.command, Number(item.timeout_ms || 240_000)));
    }
  }
  return candidates;
}

function candidate(version, id, command, timeoutMs) {
  return { owner: { version, id }, command: [...command], timeout_ms: timeoutMs };
}

function v175Coverage(selected, suiteFiles) {
  const files = new Map(),
    groups = new Set(),
    commandOwners = new Map(),
    webOwners = [];
  for (const item of selected) {
    const group = v175SuiteGroup(item.command);
    if (group) {
      groups.add(group);
      for (const file of suiteFiles[group] || []) {
        const normalized = normalizePath(file),
          owners = files.get(normalized) || [];
        owners.push(item.id);
        files.set(normalized, owners);
      }
      continue;
    }
    if (isWholeWebTest(item.command)) webOwners.push(item.id);
    const key = commandKey(item.command),
      owners = commandOwners.get(key) || [];
    owners.push(item.id);
    commandOwners.set(key, owners);
  }
  return { files, groups, commandOwners, webOwners };
}

function v175CoverageForCommand(command, coverage) {
  const file = commandTestFile(command);
  if (file && coverage.files.has(file)) return coverage.files.get(file).map((id) => `1.75:${id}`);
  if (isWebVitest(command) && coverage.webOwners.length) return coverage.webOwners.map((id) => `1.75:${id}`);
  return (coverage.commandOwners.get(commandKey(command)) || []).map((id) => `1.75:${id}`);
}

function v175SuiteGroup(command) {
  const index = command.findIndex((value) => normalizePath(value) === 'scripts/v175-suite.mjs');
  return index >= 0 ? command[index + 1] || null : null;
}

function commandTestFile(command) {
  const file = command.find((value) => /^tests\/.+\.mjs$/i.test(normalizePath(value)));
  return file ? normalizePath(file) : null;
}

function isWholeWebTest(command) {
  return command[0] === 'pnpm' && command.includes('@aiws/web') && command.at(-1) === 'test';
}

function isWebVitest(command) {
  return command[0] === 'pnpm' && command.includes('@aiws/web') && command.includes('vitest');
}

function ownerLabel(owner) {
  return `${owner.version}:${owner.id}`;
}

function commandStatus(result) {
  return result.timedOut ? 'TIMEOUT' : result.status === 0 ? 'PASS' : 'FAIL';
}

function commandDetail(result) {
  if (result.timedOut) return 'timed out';
  if (result.error) return result.error.message;
  return `exit ${result.status ?? 'unknown'}`;
}

function commandLog(result) {
  return `${limitedLog(`${result.stdout || ''}\n${result.stderr || ''}`)}\n`;
}

export function buildCompatibilityReport({ runId, impact, plan, results, started, passed }) {
  const resultByKey = new Map(results.map((item) => [item.key, item])),
    v175Status = resultByKey.get('v175:pr')?.status,
    supplementalAliasOwners = new Set(
      plan.aliases.filter((item) => item.dedupe_kind === 'supplemental').map((item) => ownerLabel(item.owner))
    ),
    ownership = [
      ...plan.aliases.map((item) => {
        const sourceStatus = item.dedupe_kind === 'v175' ? v175Status : resultByKey.get(item.task_key)?.status;
        return {
          owner: item.owner,
          status: sourceStatus === 'PASS' ? 'DEDUPED' : sourceStatus || 'NOT_RUN',
          covered_by: item.covered_by
        };
      }),
      ...plan.supplemental_tasks.flatMap((task) =>
        task.owners
          .filter((owner) => !supplementalAliasOwners.has(ownerLabel(owner)))
          .map((owner) => ({
            owner,
            status: resultByKey.get(task.key)?.status || 'NOT_RUN',
            covered_by: [task.key]
          }))
      )
    ],
    versions = {};
  for (const item of ownership) {
    const summary = versions[item.owner.version] || { declared: 0, passed: 0, deduplicated: 0, failed: 0 };
    summary.declared += 1;
    if (item.status === 'PASS') summary.passed += 1;
    else if (item.status === 'DEDUPED') summary.deduplicated += 1;
    else summary.failed += 1;
    versions[item.owner.version] = summary;
  }
  versions['1.75'] = {
    declared: plan.selected_v175_ids.length,
    passed: results[0]?.status === 'PASS' ? plan.selected_v175_ids.length : 0,
    deduplicated: 0,
    failed: results[0]?.status === 'PASS' ? 0 : plan.selected_v175_ids.length
  };
  return {
    schema_version: 'aiws.compat_pr_report.v1',
    run_id: runId,
    status: passed ? 'PASS' : 'FAIL',
    base_sha: process.env.AIWS_TEST_BASE_SHA || impact.base,
    head_sha: process.env.AIWS_TEST_HEAD_SHA || impact.head,
    domains: impact.domains,
    duration_ms: Date.now() - started,
    budget_ms: BUDGET_MS,
    concurrency: Number(process.env.AIWS_TEST_CONCURRENCY || 2),
    selected_v175_cases: plan.selected_v175_ids,
    selected_v175_groups: plan.selected_v175_groups,
    compatibility_cases: plan.declared_compatibility_cases,
    supplemental_commands: plan.supplemental_tasks.length,
    deduplicated_ownership_records: plan.aliases.length,
    versions,
    results,
    aliases: plan.aliases.map(
      ({ owner, command, dedupe_kind: dedupeKind, task_key: taskKey, covered_by: coveredBy }) => ({
        owner,
        command,
        dedupe_kind: dedupeKind,
        task_key: taskKey || null,
        covered_by: coveredBy
      })
    )
  };
}

function renderReport(report) {
  return [
    '# AIWS Consolidated PR Gate',
    '',
    `- Status: \`${report.status}\``,
    `- Base / Head: \`${report.base_sha}\` / \`${report.head_sha}\``,
    `- Duration: \`${report.duration_ms}ms\` / \`${report.budget_ms}ms\``,
    `- V1.75 concurrency: \`${report.concurrency}\``,
    `- Supplemental commands: \`${report.supplemental_commands}\``,
    `- Reused ownership records: \`${report.deduplicated_ownership_records}\``,
    '',
    '| Version | Declared | Executed PASS | Reused | Failed |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.versions).map(
      ([version, item]) => `| ${version} | ${item.declared} | ${item.passed} | ${item.deduplicated} | ${item.failed} |`
    ),
    '',
    '| Command | Owners | Status | Duration |',
    '| --- | --- | --- | ---: |',
    ...report.results.map(
      (item) =>
        `| \`${item.command.join(' ')}\` | ${(item.owners || []).map(ownerLabel).join(', ')} | ${item.status} | ${item.duration_ms}ms |`
    ),
    ''
  ].join('\n');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

if (isMain(import.meta.url))
  main().catch((error) => {
    console.error(`[compat-pr] ${error.stack || error.message}`);
    process.exit(1);
  });
