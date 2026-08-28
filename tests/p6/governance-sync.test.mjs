import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { CLEAN_P5_MIGRATION_REGISTRY, CLEAN_P6_MIGRATION_REGISTRY } from '../../apps/api/src/clean/migration-service.mjs';
import { CLEAN_P5_TABLE_OWNERS, CLEAN_P6_TABLE_OWNERS, CLEAN_PLATFORM_OWNERSHIP } from '../../apps/api/src/clean/ownership.mjs';
import { createCleanCommandRegistry, registryParity } from '../../apps/api/src/clean/registry.mjs';
import { CLEAN_SQL_BOUNDARIES, ownerOf } from '../../apps/api/src/modules/registry.mjs';
import {
  EVIDENCE_POLICIES, P6_CLEAN_CATALOG_IDS, loadCatalogIndex, loadCatalogLayers,
  resolveCatalogEvidenceReference, validateCatalogLayers, validateP6EvidenceManifest
} from '../../scripts/catalog-loader.mjs';
import { P1_PACKAGE_SCRIPT_DEFINITIONS, classifyWorkspacePath } from '../../scripts/lib/v3-clean-p1-scope.mjs';

const root = process.cwd();
const evidenceReference = 'docs/evidence/v3-clean-p6-runner-execution-20260824/verification.json';
const p6Tables = [
  'execution_events', 'execution_inputs', 'execution_stage_checkpoints', 'executions',
  'job_specs', 'runner_profiles', 'runner_receipts', 'task_attempts'
];
const p6Commands = [
  'runner.profile.list', 'runner.profile.create', 'runner.profile.get', 'runner.profile.update',
  'runner.profile.probe', 'runner.profile.disable', 'execution.list', 'execution.create',
  'execution.get', 'execution.events', 'execution.attempts', 'execution.checkpoints',
  'execution.start', 'execution.pause', 'execution.resume', 'execution.cancel',
  'execution.replan', 'execution.stage.replay'
];

test('P6 migration, ownership, registry, paths and package gates are synchronized', () => {
  assert.deepEqual(CLEAN_P6_MIGRATION_REGISTRY.map((migration) => migration.id), [
    '001-clean-baseline', '002-identity-acl', '003-project-workflow',
    '004-context-projection-mcp', '005-assist-files-terminal-bridge',
    '006-runner-execution-checkpoint-replay'
  ]);
  assert.deepEqual(CLEAN_P5_MIGRATION_REGISTRY.map((migration) => migration.id), CLEAN_P6_MIGRATION_REGISTRY.slice(0, 5).map((migration) => migration.id));
  assert.deepEqual(Object.keys(CLEAN_P6_TABLE_OWNERS).filter((table) => !Object.hasOwn(CLEAN_P5_TABLE_OWNERS, table)).sort(), p6Tables);
  assert.equal(CLEAN_PLATFORM_OWNERSHIP.schema_version, 'aiws.v3-clean.owner-manifest.v8');
  for (const table of p6Tables) assert.equal(ownerOf('table', table, { clean: true }), CLEAN_P6_TABLE_OWNERS[table].toLowerCase(), table);
  for (const service of ['apps/api/src/clean/runner-service.mjs', 'apps/api/src/clean/execution-service.mjs']) assert.ok(CLEAN_SQL_BOUNDARIES.includes(service), service);

  const registry = createCleanCommandRegistry({ targetVersion: 6 });
  assert.equal(registryParity(registry).valid, true);
  assert.deepEqual(registry.entries.filter((entry) => entry.phase === 'p6').map((entry) => entry.command_id), p6Commands);

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.keys(packageJson.scripts).length, 53);
  assert.deepEqual(packageJson.scripts, Object.fromEntries(Object.entries(P1_PACKAGE_SCRIPT_DEFINITIONS).map(([name, value]) => [name, value.command])));
  assert.equal(packageJson.scripts['dev:broker'], 'node apps/runner-broker/clean-server.mjs');
  assert.equal(packageJson.scripts['test:p6'], 'node --test tests/p6/*.test.mjs');
  assert.equal(packageJson.scripts['evidence:p6'], 'node scripts/v3-clean-p6-evidence.mjs');
  const verifySource = fs.readFileSync(path.join(root, 'scripts', 'verify.mjs'), 'utf8');
  const p5EvidenceCheck = verifySource.indexOf("['evidence:p5', '--', '--verify']");
  const p6EvidenceCheck = verifySource.indexOf("['evidence:p6', '--', '--verify']");
  assert.ok(p5EvidenceCheck >= 0);
  assert.ok(p6EvidenceCheck > p5EvidenceCheck);

  const paths = [
    'apps/api/src/clean/migrations/006-runner-execution-checkpoint-replay.mjs',
    'apps/api/src/clean/execution-service.mjs', 'apps/api/src/clean/runner-protocol.mjs',
    'apps/api/src/clean/runner-adapters.mjs', 'apps/api/src/clean/runner-service.mjs',
    'apps/runner-broker/clean-server.mjs', 'apps/web/src/features/execution/ExecutionPage.tsx',
    'scripts/v3-clean-p6-evidence.mjs', 'tests/p6/governance-sync.test.mjs'
  ];
  for (const file of paths) {
    const expectedPhase = ['apps/runner-broker/clean-server.mjs', 'apps/web/src/features/execution/ExecutionPage.tsx'].includes(file) ? 'P7' : 'P6';
    assert.equal(classifyWorkspacePath(file)?.phase, expectedPhase, file);
  }
});

test('P6 Catalog promotion is disjoint, complete and Evidence-gated', () => {
  const index = loadCatalogIndex(root); const layers = loadCatalogLayers(root, index);
  const validation = validateCatalogLayers({ root, index, layers });
  assert.equal(validation.valid, true, JSON.stringify(validation.failures));
  assert.equal(validation.counts.total, 27);
  assert.ok(validation.counts.clean >= 21);
  assert.ok(validation.counts.historical <= 6);
  const clean = new Map(layers.clean.features.map((feature) => [feature.id, feature]));
  const historical = new Set(layers.historical.features.map((feature) => feature.id));
  for (const id of P6_CLEAN_CATALOG_IDS) {
    assert.equal(historical.has(id), false, id);
    assert.equal(clean.get(id)?.status, 'verified', id);
    assert.deepEqual(clean.get(id)?.evidence, [evidenceReference], id);
    assert.equal(clean.get(id)?.runtime_surface, 'v3-clean', id);
  }
  assert.equal(clean.get('REC-D10-FRONTEND-024')?.status, 'scaffolded');
  assert.equal(clean.get('REC-D6-OUTCOME-009')?.status, 'verified');
});

test('P4, P5 and P6 Evidence policies are declarative and final P6 artifacts reopen', () => {
  assert.deepEqual(EVIDENCE_POLICIES.map((policy) => policy.key), ['p9', 'p4', 'p5', 'p6', 'p7', 'p8']);
  const resolved = resolveCatalogEvidenceReference(root, evidenceReference);
  if (process.env.AIWS_P6_EVIDENCE_STAGING_ROOT) {
    assert.equal(resolved.staging, true);
    assert.equal(path.basename(resolved.path), 'catalog-staging.json');
  } else {
    assert.equal(resolved.staging, false);
    assert.deepEqual(validateP6EvidenceManifest(path.dirname(resolved.path)), []);
  }
  const source = fs.readFileSync(path.join(root, 'scripts', 'v3-clean-p6-evidence.mjs'), 'utf8');
  assert.match(source, /rollback-v5\.sqlite/);
  assert.match(source, /p6_tables_absent/);
  assert.match(source, /value\.startsWith\('tests\/p1\/'\)/);
  assert.match(source, /value\.startsWith\('tests\/p4\/'\)/);
  for (const role of ['sqlite', 'cas', 'vault', 'workspace', 'broker', 'bridge']) assert.match(source, new RegExp(`restored_components|${role}`));
});
