import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { collectImpactRange, trackedFilesNul } from '../../scripts/impact-range.mjs';
import { buildSourceSnapshot, writeSourceSnapshot } from '../../scripts/source-snapshot.mjs';
import { buildCompatibilityPlan, buildCompatibilityReport } from '../../scripts/compat-pr-runner.mjs';
import { buildGateIdentity, environmentFingerprint, gateReceiptCacheAllowed } from '../../scripts/gate-receipt-v22.mjs';
import { resolveGateConcurrency, runDependencyGraph } from '../../scripts/gate-scheduler.mjs';

const repositoryRoot = process.cwd(),
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v22-impact-'));
try {
  git(['init']);
  git(['config', 'user.email', 'v22-impact@aiws.test']);
  git(['config', 'user.name', 'AIWS V2.2 Impact']);
  fs.writeFileSync(path.join(root, '删除前.txt'), 'first\n');
  fs.writeFileSync(path.join(root, 'rename-me.txt'), 'rename\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  fs.rmSync(path.join(root, '删除前.txt'));
  fs.renameSync(path.join(root, 'rename-me.txt'), path.join(root, '重命名后.txt'));
  fs.writeFileSync(path.join(root, '新增.txt'), 'new\n');
  git(['add', '-A']);
  git(['commit', '-m', 'head']);
  const head = git(['rev-parse', 'HEAD']),
    impact = collectImpactRange({ base, head, cwd: root });
  assert.equal(impact.mode, 'committed-range');
  assert.equal(impact.base_sha, base);
  assert.equal(impact.head_sha, head);
  assert.ok(impact.files.includes('删除前.txt'));
  assert.ok(impact.files.includes('rename-me.txt'));
  assert.ok(impact.files.includes('重命名后.txt'));
  assert.ok(impact.files.includes('新增.txt'));
  assert.throws(
    () => collectImpactRange({ base: '0'.repeat(40), head, cwd: root }),
    (error) => error.code === 'impact_base_not_found'
  );

  const snapshotPath = path.join(root, 'impact-snapshot.json');
  const snapshot = buildSourceSnapshot({
      root,
      baseSha: base,
      headSha: head,
      treeSha: git(['rev-parse', 'HEAD^{tree}'])
    }),
    snapshotEnv = {
      AIWS_IMPACT_SNAPSHOT: snapshotPath,
      AIWS_TEST_BASE_SHA: base,
      AIWS_TEST_HEAD_SHA: head
    };
  writeSourceSnapshot(snapshotPath, snapshot);
  const snapshotImpact = collectImpactRange({ cwd: root, env: snapshotEnv });
  assert.equal(snapshotImpact.mode, 'source-snapshot');
  assert.equal(snapshotImpact.tree_sha, snapshot.tree_sha);
  assert.deepEqual(snapshotImpact.files, ['新增.txt', '重命名后.txt']);
  assert.equal(
    snapshotImpact.files.some((file) => file.startsWith('.git')),
    false
  );
  assert.deepEqual(trackedFilesNul(root, snapshotEnv), snapshotImpact.files);
  assert.throws(
    () => collectImpactRange({ base: 'f'.repeat(40), head, cwd: root, env: snapshotEnv }),
    (error) => error.code === 'impact_snapshot_range_mismatch'
  );
  fs.writeFileSync(snapshotPath, JSON.stringify({ ...snapshot, unexpected: true }));
  assert.throws(
    () => collectImpactRange({ cwd: root, env: snapshotEnv }),
    (error) => error.code === 'impact_snapshot_invalid' && error.details.reason === 'source_snapshot_fields_invalid'
  );
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify({
      ...snapshot,
      entries: [{ ...snapshot.entries[0], unexpected: true }, ...snapshot.entries.slice(1)]
    })
  );
  assert.throws(
    () => collectImpactRange({ cwd: root, env: snapshotEnv }),
    (error) => error.code === 'impact_snapshot_invalid' && error.details.reason === 'source_snapshot_entries_invalid'
  );
  fs.writeFileSync(snapshotPath, JSON.stringify({ ...snapshot, source_sha256: '0'.repeat(64) }));
  assert.throws(
    () => collectImpactRange({ cwd: root, env: snapshotEnv }),
    (error) => error.code === 'impact_snapshot_invalid' && error.details.reason === 'source_snapshot_hash_invalid'
  );
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));

  fs.rmSync(snapshotPath);
  fs.rmSync(path.join(root, '新增.txt'));
  fs.rmSync(path.join(root, '重命名后.txt'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'snapshot-impact-fixture.mjs'), 'export const fixture = true;\n');
  git(['add', '-A']);
  git(['commit', '-m', 'historical impact snapshot']);
  const historicalHead = git(['rev-parse', 'HEAD']),
    historicalSnapshot = buildSourceSnapshot({
      root,
      baseSha: head,
      headSha: historicalHead,
      treeSha: git(['rev-parse', 'HEAD^{tree}'])
    }),
    historicalEnv = withoutGitOnPath({
      ...process.env,
      AIWS_IMPACT_SNAPSHOT: snapshotPath,
      AIWS_TEST_BASE_SHA: head,
      AIWS_TEST_HEAD_SHA: historicalHead
    });
  writeSourceSnapshot(snapshotPath, historicalSnapshot);
  for (const version of ['v21', 'v20', 'v18']) {
    const result = spawnSync(process.execPath, [`scripts/${version}-impact.mjs`, '--audit'], {
      cwd: repositoryRoot,
      env: historicalEnv,
      encoding: 'utf8',
      windowsHide: true
    });
    assert.equal(result.status, 0, `${version} snapshot impact failed without Git:\n${result.stderr || result.stdout}`);
    assert.match(result.stdout, version === 'v18' ? /1 changed files/ : /"mode": "source-snapshot"/);
  }

  const fixture = {
      clean_head_tree: true,
      base_sha: base,
      head_sha: head,
      tree_sha: 'a'.repeat(40),
      lockfile_sha256: 'b'.repeat(64),
      node_version: process.version,
      pnpm_version: '10.14.0',
      os_fingerprint: 'test:x64',
      catalog_sha256: 'c'.repeat(64),
      policy_sha256: 'd'.repeat(64),
      environment_fingerprint: 'e'.repeat(64)
    },
    identity = buildGateIdentity(fixture);
  assert.notEqual(identity.fingerprint, buildGateIdentity({ ...fixture, base_sha: 'f'.repeat(40) }).fingerprint);
  assert.equal(gateReceiptCacheAllowed({ env: { CI: '1' } }).allowed, false);
  assert.equal(gateReceiptCacheAllowed({ mode: 'release', env: {} }).allowed, false);
  assert.equal(gateReceiptCacheAllowed({ externalEffects: 'docker', env: {} }).allowed, false);
  assert.equal(gateReceiptCacheAllowed({ externalEffects: 'live', env: {} }).allowed, false);
  assert.equal(
    environmentFingerprint({
      PATH: 'first',
      PATHEXT: '.EXE;.CMD',
      HOME: 'same',
      npm_config_registry: 'https://registry.npmmirror.com/'
    }),
    environmentFingerprint({
      PATH: 'second',
      PATHEXT: '.COM;.BAT',
      HOME: 'same',
      npm_config_registry: 'https://registry.npmjs.org/'
    })
  );
  assert.equal(
    environmentFingerprint({ USERPROFILE: 'C:\\Users\\Example', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }),
    environmentFingerprint({
      HOME: 'C:/Users/Example',
      USERPROFILE: 'C:/Users/Example',
      COMSPEC: 'c:/windows/system32/cmd.exe'
    })
  );

  await verifyDependencyScheduler();
  verifyCompatibilityPlan();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('V2.2 committed/snapshot impact, consolidated gate scheduler, dedupe and cache identity tests passed');

async function verifyDependencyScheduler() {
  const timeline = [],
    blocked = [],
    items = [
      { id: 'slow', dependencies: [], delay: 30, ok: true },
      { id: 'failed', dependencies: [], delay: 5, ok: false },
      { id: 'after-slow', dependencies: ['slow'], delay: 1, ok: true },
      { id: 'after-failed', dependencies: ['failed'], delay: 1, ok: true }
    ];
  let running = 0,
    maximumRunning = 0;
  const outcomes = await runDependencyGraph(items, {
    concurrency: 2,
    async execute(item) {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      timeline.push(`start:${item.id}`);
      await new Promise((resolve) => setTimeout(resolve, item.delay));
      timeline.push(`end:${item.id}`);
      running -= 1;
      return { ok: item.ok, status: item.ok ? 'PASS' : 'FAIL' };
    },
    async onBlocked(item, blockedBy) {
      blocked.push({ id: item.id, blockedBy });
      return { ok: false, status: 'BLOCKED' };
    }
  });
  assert.equal(maximumRunning, 2);
  assert.ok(timeline.indexOf('start:after-slow') > timeline.indexOf('end:slow'));
  assert.equal(timeline.includes('start:after-failed'), false);
  assert.deepEqual(blocked, [{ id: 'after-failed', blockedBy: ['failed'] }]);
  assert.equal(outcomes.get('after-slow').status, 'PASS');
  assert.equal(outcomes.get('after-failed').status, 'BLOCKED');
  assert.equal(resolveGateConcurrency('pr', {}), 2);
  assert.equal(resolveGateConcurrency('full', {}), 1);
  assert.throws(() => resolveGateConcurrency('pr', { AIWS_TEST_CONCURRENCY: '5' }), /gate_concurrency_invalid/);
}

function verifyCompatibilityPlan() {
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    versionCatalogs = Object.fromEntries(
      ['v18', 'v20', 'v21', 'v22'].map((version) => [
        version,
        { catalog: read(`tests/${version}/catalog.json`), suites: read(`tests/${version}/suites.json`) }
      ])
    ),
    input = {
      v175Catalog: read('tests/v175/catalog.json'),
      suiteFiles: read('tests/v175/suite-files.json'),
      versionCatalogs
    },
    supplementalPlan = buildCompatibilityPlan({ ...input, domains: [] }),
    v23Catalogs = {
      ...versionCatalogs,
      v23: { catalog: read('tests/v23/catalog.json'), suites: read('tests/v23/suites.json') }
    },
    v23PrecoveredPlan = buildCompatibilityPlan({
      ...input,
      versionCatalogs: v23Catalogs,
      domains: [],
      precoveredVersions: ['2.3']
    }),
    contextTasks = supplementalPlan.supplemental_tasks.filter((item) =>
      item.command.includes('tests/unit/v21-context.test.mjs')
    ),
    outcomeTasks = supplementalPlan.supplemental_tasks.filter((item) =>
      item.command.includes('tests/unit/v21-outcome.test.mjs')
    );
  assert.equal(contextTasks.length, 1);
  assert.equal(contextTasks[0].owners.length, 2);
  assert.equal(outcomeTasks.length, 1);
  assert.equal(outcomeTasks[0].owners.length, 2);
  assert.equal(
    v23PrecoveredPlan.aliases.filter((item) => item.owner.version === '2.3' && item.dedupe_kind === 'prepush').length,
    v23Catalogs.v23.suites.pr.length
  );
  assert.equal(
    supplementalPlan.supplemental_tasks.length + supplementalPlan.aliases.length,
    supplementalPlan.declared_compatibility_cases
  );
  const passingResults = [
      {
        key: 'v175:pr',
        status: 'PASS',
        owners: supplementalPlan.selected_v175_ids.map((id) => ({ version: '1.75', id }))
      },
      ...supplementalPlan.supplemental_tasks.map((task) => ({ ...task, status: 'PASS' }))
    ],
    report = buildCompatibilityReport({
      runId: 'compat-unit',
      impact: { base: 'base', head: 'head', domains: [] },
      plan: supplementalPlan,
      results: passingResults,
      started: Date.now(),
      passed: true
    }),
    incompleteReport = buildCompatibilityReport({
      runId: 'compat-unit-incomplete',
      impact: { base: 'base', head: 'head', domains: [] },
      plan: supplementalPlan,
      results: passingResults.slice(0, -1),
      started: Date.now(),
      passed: false
    });
  const compatibilityVersions = Object.entries(report.versions).filter(([version]) => version !== '1.75');
  assert.equal(
    compatibilityVersions.reduce((total, [, summary]) => total + summary.declared, 0),
    supplementalPlan.declared_compatibility_cases
  );
  assert.equal(
    compatibilityVersions.reduce((total, [, summary]) => total + summary.deduplicated, 0),
    supplementalPlan.aliases.length
  );
  assert.ok(compatibilityVersions.every(([, summary]) => summary.failed === 0));
  const incompleteVersions = Object.entries(incompleteReport.versions).filter(([version]) => version !== '1.75');
  assert.equal(
    incompleteVersions.reduce((total, [, summary]) => total + summary.declared, 0),
    supplementalPlan.declared_compatibility_cases
  );
  assert.ok(incompleteVersions.some(([, summary]) => summary.failed > 0));

  const v175DedupePlan = buildCompatibilityPlan({ ...input, domains: ['action'] });
  assert.ok(
    v175DedupePlan.aliases.some((item) => item.owner.id === 'V22-L5-SECURITY-001' && item.dedupe_kind === 'v175')
  );
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return String(result.stdout || '')
    .trim()
    .toLowerCase();
}

function withoutGitOnPath(env) {
  const isolated = { ...env };
  for (const key of Object.keys(isolated)) if (key.toLowerCase() === 'path') delete isolated[key];
  isolated.PATH = path.dirname(process.execPath);
  return isolated;
}
