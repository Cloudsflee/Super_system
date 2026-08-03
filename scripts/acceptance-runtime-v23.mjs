import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apiRoutes } from '../apps/api/src/api-routes.mjs';
import { defaultTools } from '../packages/shared/index.mjs';

export const V23_IMPLEMENTATION_CHECKS = Object.freeze([
  ['V2.3 plan gate', 'scripts/v23-plan.mjs', 'V2.3 plan validation passed'],
  ['V2.3 catalog gate', 'scripts/v23-catalog.mjs', 'V2.3 catalog validation passed'],
  ['V2.3 coverage gate', 'scripts/v23-coverage.mjs', 'V2.3 coverage gate passed'],
  ['V2.3 impact map', 'tests/v23/impact-map.json', 'quality-review'],
  [
    'V2.3 state protocol tests',
    'tests/unit/v23-quality-review-state.test.mjs',
    'state round-trip, append-only, revision, stale, policy, and Outcome isolation'
  ],
  [
    'V2.3 parser matrix',
    'tests/unit/v23-quality-review-parser.test.mjs',
    'parser format matrix, media identity, limits, and evidence anchor'
  ],
  [
    'V2.3 lifecycle integration',
    'tests/integration/v23-quality-review-flow.test.mjs',
    'lifecycle, retry, cancellation, supersede, cursor, rollback, draining and stale'
  ],
  ['V2.3 browser journey', 'tests/e2e/v23-quality-review-browser.test.mjs', 'Advice unavailable'],
  ['V2.3 security', 'tests/security/v23-quality-review-security.test.mjs', 'assertNoSentinels'],
  ['V2.3 performance', 'tests/performance/v23-quality-review-performance.test.mjs', 'event-loop lag p95'],
  ['V2.3 release contract', 'tests/release/v23-release-contract.test.mjs', 'V23_APP_IMAGE'],
  [
    'V2.3 read-only release flow',
    'tests/release/v23-volume-flow.test.mjs',
    'V2.3 read-only V22 SQLite clone, schema migration, source retention and receipt redaction tests passed'
  ]
]);

export function auditProductionRuntimeV23() {
  const runtimeFiles = [...walk('apps'), ...walk('packages')].filter(
      (file) =>
        /\.(mjs|js|ts|tsx|html|css|json)$/.test(file) &&
        !file.includes(`${path.sep}dist${path.sep}`) &&
        !isMigrationModule(file)
    ),
    runtime = runtimeFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const forbidden of [
    '/demo/full-chain',
    'MockRunner',
    'mock_runner',
    '生成演示链路',
    '<aiws_actions>',
    'transport_fallback'
  ])
    assert.equal(runtime.includes(forbidden), false, `production runtime excludes ${forbidden}`);
  assert.equal(
    defaultTools('acceptance-owner').some((item) => item.name === 'mock_runner'),
    false,
    'actual default tool registry excludes retired runner'
  );
  assert.equal(
    apiRoutes.some((route) => route.pattern === '/demo/full-chain'),
    false,
    'actual API route registry excludes demo runtime'
  );
  assert.equal(runtime.includes('buildAssistResult'), false, 'production runtime excludes fixed-rule Assist');
  assert.equal(
    runtime.includes('codexProfileFromCcSwitch'),
    false,
    'production runtime excludes fake cc-switch Profiles'
  );
  assert.equal(runtime.includes('aiws-codex-runner:local'), false, 'runtime excludes mutable local Runner tag');
  assert.ok(fs.existsSync('apps/web/dist/index.html'), 'production frontend build exists');
}

export function auditReleaseIdentityV23(manifest) {
  assert.equal(manifest.version, '2.3.0', 'root package is V2.3');
  auditV23Commands(manifest);
  auditV23PrePush();
  for (const file of workspaceManifests())
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '2.3.0', `${file} is V2.3`);
  auditV23Compose();
  auditV23Verify();
  assert.ok(
    fs.readFileSync('bridge/main.go', 'utf8').includes('bridgeVersion   = "2.3.0"'),
    'Windows Bridge reports V2.3'
  );
}

function auditV23Commands(manifest) {
  for (const script of [
    'test:v23:plan',
    'test:v23:catalog',
    'test:v23:coverage',
    'test:v23:impact',
    'test:v23:unit',
    'test:v23:integration',
    'test:v23:security',
    'test:v23:performance',
    'test:v23:pr',
    'test:v23:full',
    'test:v23:release'
  ])
    assert.ok(manifest.scripts[script], `V2.3 command ${script}`);
  for (const suite of ['pr', 'full', 'release'])
    assert.match(
      manifest.scripts[`test:v23:${suite}`],
      new RegExp(`v23-runner\\.mjs ${suite}$`),
      `V2.3 ${suite} uses the catalog runner`
    );
  assert.ok(manifest.scripts.test.includes('v23-suite.mjs unit'), 'unit gate includes V2.3 unit suite');
  assert.ok(manifest.scripts.test.includes('v23-suite.mjs security'), 'unit gate includes V2.3 security suite');
  assert.ok(
    manifest.scripts['test:integration'].includes('v23-suite.mjs integration'),
    'integration gate includes V2.3'
  );
  assert.ok(manifest.scripts['test:release'].includes('v23-volume-flow'), 'release gate includes V2.3 volume clone');
  assert.match(manifest.scripts['test:compat:pr'], /compat-pr-runner\.mjs$/, 'pre-push has one compatibility runner');
}

function auditV23PrePush() {
  const receipt = fs.readFileSync('scripts/gate-receipt-v23.mjs', 'utf8'),
    compatibility = fs.readFileSync('scripts/compat-pr-runner.mjs', 'utf8');
  assert.ok(
    receipt.includes("Object.freeze(['test:v23:pr', 'test:compat:pr'])") &&
      compatibility.includes("['v18', 'v20', 'v21', 'v22', 'v23']") &&
      compatibility.includes('dedupe_kind'),
    'pre-push gate covers V2.3 plus deduplicated historical PR suites'
  );
}

function auditV23Compose() {
  const compose = fs.readFileSync('compose.yml', 'utf8');
  for (const value of ['name: aiws-v23', 'aiws-app:2.3.0', 'aiws-codex-runner:2.3.0-codex-0.144.0', 'aiws-data-v23'])
    assert.ok(compose.includes(value), `Compose pins ${value}`);
  assert.match(compose, /aiws-data:\s+[\s\S]*external: true/, 'production data volume stays external');
  assert.equal(
    compose.includes('source: aiws-data-v22'),
    false,
    'V2.3 Compose never mounts the migration source volume'
  );
  assert.ok(compose.includes('/api/readyz'), 'V2.3 Compose healthcheck uses readiness');
  assert.ok(compose.includes('stop_grace_period: 30s'), 'V2.3 Compose grants 30 seconds for shutdown');

  const collaboration = fs.readFileSync('compose.collaboration.yml', 'utf8');
  for (const value of [
    'aiws-mcp-gateway:2.3.0',
    'target: mcp-gateway',
    'AIWS_MCP_REMOTE_MODE: gateway',
    'AIWS_RUNNER_NETWORK',
    'AIWS_PUBLIC_MCP_URL'
  ])
    assert.ok(collaboration.includes(value), `collaboration Compose includes ${value}`);
  const gateway = collaboration.match(/\n  mcp-gateway:\n([\s\S]*?)\nsecrets:/)?.[1] || '';
  assert.equal(gateway.includes('docker.sock'), false, 'MCP Gateway never mounts Docker socket');
  assert.equal(gateway.includes('/var/lib/aiws'), false, 'MCP Gateway never mounts AIWS data volume');
}

function auditV23Verify() {
  const verify = fs.readFileSync('scripts/verify.mjs', 'utf8');
  for (const gate of ['v2.3:plan', 'v2.3:catalog', 'v2.3:coverage', 'v2.3:impact-audit', 'v2.3:full'])
    assert.ok(verify.includes(gate), `verify includes ${gate}`);
}

function workspaceManifests() {
  return ['apps', 'packages'].flatMap((root) =>
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => path.join(root, item.name, 'package.json'))
      .filter(fs.existsSync)
  );
}

function isMigrationModule(file) {
  return /(?:^|[\\/])apps[\\/]api[\\/]src[\\/]state-migration-[^\\/]+\.mjs$/.test(file);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    return entry.isDirectory() ? walk(full) : [full];
  });
}
