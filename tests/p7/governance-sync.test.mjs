import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadCleanConfig } from '../../apps/api/src/clean/config.mjs';
import { CLEAN_P6_MIGRATION_REGISTRY, CLEAN_P7_MIGRATION_REGISTRY } from '../../apps/api/src/clean/migration-service.mjs';
import {
  CLEAN_P6_TABLE_OWNERS, CLEAN_P7_TABLE_OWNERS, CLEAN_PLATFORM_OWNERSHIP
} from '../../apps/api/src/clean/ownership.mjs';
import { P7_PARSER_IMAGE_DIGEST } from '../../apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs';
import { createCleanCommandRegistry, registryParity } from '../../apps/api/src/clean/registry.mjs';
import { CLEAN_SQL_BOUNDARIES, ownerOf } from '../../apps/api/src/modules/registry.mjs';
import {
  EVIDENCE_POLICIES, P7_CLEAN_CATALOG_IDS, P7_VERIFIED_CATALOG_IDS,
  loadCatalogIndex, loadCatalogLayers, resolveCatalogEvidenceReference, validateCatalogLayers
} from '../../scripts/catalog-loader.mjs';
import { P1_PACKAGE_SCRIPT_DEFINITIONS, classifyWorkspacePath } from '../../scripts/lib/v3-clean-p1-scope.mjs';
import { createFormalVerificationPlan } from '../../scripts/verify.mjs';

const root = process.cwd();
const evidenceReference = 'docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json';
const p7Tables = [
  'asset_attestations', 'asset_blobs', 'asset_relations', 'asset_versions', 'assets',
  'code_changes', 'digests', 'human_reviews', 'outcome_evaluations', 'outcome_waivers',
  'parser_formats', 'parser_runs', 'quality_review_events', 'quality_review_reports',
  'quality_review_runs', 'test_results', 'traces'
];
const p7Commands = [
  'parser.format.list', 'parser.run.start', 'parser.run.get', 'parser.run.retry', 'parser.run.cancel',
  'asset.list', 'asset.capture', 'asset.get', 'asset.version.list', 'asset.content',
  'asset.relation.list', 'asset.relation.create', 'asset.attestation.list', 'asset.attest',
  'asset.tombstone', 'evidence.execution.get', 'evidence.trace.list', 'evidence.digest.list',
  'evidence.test-result.list', 'evidence.code-change.list', 'quality.list', 'quality.start',
  'quality.get', 'quality.events', 'quality.report.get', 'quality.decision', 'quality.cancel',
  'quality.retry', 'outcome.get', 'outcome.evaluate', 'outcome.waiver.create',
  'outcome.waiver.revoke'
];

test('P7 migration, ownership, registry, package gates and paths are synchronized', () => {
  assert.deepEqual(CLEAN_P7_MIGRATION_REGISTRY.map((migration) => migration.id), [
    '001-clean-baseline', '002-identity-acl', '003-project-workflow',
    '004-context-projection-mcp', '005-assist-files-terminal-bridge',
    '006-runner-execution-checkpoint-replay', '007-evidence-quality-parser-outcome'
  ]);
  assert.deepEqual(CLEAN_P6_MIGRATION_REGISTRY.map((migration) => migration.id), CLEAN_P7_MIGRATION_REGISTRY.slice(0, 6).map((migration) => migration.id));
  assert.deepEqual(Object.keys(CLEAN_P7_TABLE_OWNERS).filter((table) => !Object.hasOwn(CLEAN_P6_TABLE_OWNERS, table)).sort(), p7Tables);
  assert.equal(CLEAN_PLATFORM_OWNERSHIP.schema_version, 'aiws.v3-clean.owner-manifest.v8');
  for (const table of p7Tables) assert.equal(ownerOf('table', table, { clean: true }), CLEAN_P7_TABLE_OWNERS[table].toLowerCase(), table);
  for (const service of [
    'apps/api/src/clean/evidence-service.mjs', 'apps/api/src/clean/parser-service.mjs',
    'apps/api/src/clean/quality-service.mjs', 'apps/api/src/clean/outcome-evaluation-service.mjs'
  ]) assert.ok(CLEAN_SQL_BOUNDARIES.includes(service), service);

  const registry = createCleanCommandRegistry({ targetVersion: 7 });
  assert.equal(registryParity(registry).valid, true);
  assert.deepEqual(registry.entries.filter((entry) => entry.phase === 'p7').map((entry) => entry.command_id), p7Commands);
  assert.equal(registry.entries.filter((entry) => entry.phase === 'p7').length, 32);
  for (const id of ['asset.content', 'asset.tombstone', 'quality.decision', 'outcome.waiver.create', 'outcome.waiver.revoke']) {
    assert.deepEqual(registry.get(id).transport_allowlist, ['rest', 'web'], id);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.keys(packageJson.scripts).length, 60);
  assert.deepEqual(packageJson.scripts, Object.fromEntries(Object.entries(P1_PACKAGE_SCRIPT_DEFINITIONS).map(([name, value]) => [name, value.command])));
  assert.equal(packageJson.scripts['test:p7'], 'node --test tests/p7/*.test.mjs');
  assert.equal(packageJson.scripts['evidence:p7'], 'node scripts/v3-clean-p7-evidence.mjs');
  const verificationIds = createFormalVerificationPlan().map((entry) => entry.id);
  assert.ok(verificationIds.indexOf('test-p7') > verificationIds.indexOf('test-p6'));
  assert.ok(verificationIds.indexOf('evidence-p7') > verificationIds.indexOf('test-p7'));
  assert.ok(verificationIds.indexOf('evidence-p7') < verificationIds.indexOf('e2e'));

  for (const file of [
    'apps/api/src/clean/migrations/007-evidence-quality-parser-outcome.mjs',
    'apps/api/src/clean/evidence-service.mjs', 'apps/api/src/clean/parser-service.mjs',
    'apps/api/src/clean/quality-service.mjs', 'apps/api/src/clean/outcome-evaluation-service.mjs',
    'apps/api/src/modules/registry.mjs', 'apps/parser-worker/worker.mjs',
    'apps/web/src/features/evidence/EvidencePage.tsx', 'scripts/v3-clean-p7-evidence.mjs',
    'tests/p7/governance-sync.test.mjs'
  ]) assert.equal(classifyWorkspacePath(file)?.phase, 'P7', file);
});

test('P7 Catalog promotion is disjoint, complete and bound to a staging or final receipt', () => {
  const p9 = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/v3-clean-p9-web-release-20260826/verification.json'), 'utf8'));
  const finalStatus = p9.status === 'verified' && p9.provisional === false ? 'released' : 'verified';
  const runId = `governance-${process.pid}-${Date.now()}`;
  const attemptRoot = path.join(root, 'docs', 'evidence', 'v3-clean-p7-evidence-quality-outcome-20260824', 'attempts', runId);
  const previous = process.env.AIWS_P7_EVIDENCE_STAGING_ROOT;
  fs.mkdirSync(attemptRoot, { recursive: true });
  fs.writeFileSync(path.join(attemptRoot, 'catalog-staging.json'), `${JSON.stringify({
    schema_version: 'aiws.v3-clean.p7-catalog-staging.v1', phase: 'P7', status: 'staging',
    provisional: true, run_id: runId, final_reference: evidenceReference
  }, null, 2)}\n`);
  process.env.AIWS_P7_EVIDENCE_STAGING_ROOT = attemptRoot;
  try {
    const resolved = resolveCatalogEvidenceReference(root, evidenceReference);
    assert.equal(resolved.staging, true);
    assert.equal(resolved.path, path.join(attemptRoot, 'catalog-staging.json'));
    const index = loadCatalogIndex(root); const layers = loadCatalogLayers(root, index);
    const validation = validateCatalogLayers({ root, index, layers });
    assert.equal(validation.valid, true, JSON.stringify(validation.failures));
    assert.equal(validation.counts.total, 27);
    assert.ok(validation.counts.clean >= 23);
    assert.ok(validation.counts.historical <= 4);
    const clean = new Map(layers.clean.features.map((feature) => [feature.id, feature]));
    const historical = new Set(layers.historical.features.map((feature) => feature.id));
    for (const id of P7_CLEAN_CATALOG_IDS) assert.equal(historical.has(id), false, id);
    for (const id of P7_VERIFIED_CATALOG_IDS) {
      assert.equal(clean.get(id)?.status, finalStatus, id);
      assert.deepEqual(clean.get(id)?.evidence, [evidenceReference], id);
      assert.equal(clean.get(id)?.runtime_surface, 'v3-clean', id);
    }
    assert.equal(clean.get('REC-D10-FRONTEND-024')?.status, finalStatus === 'released' ? 'released' : 'scaffolded');
    const aggregate = JSON.parse(fs.readFileSync(path.join(root, 'feature-catalog.json'), 'utf8'));
    assert.deepEqual(aggregate.exclusions, []);
    assert.deepEqual(new Set(aggregate.features.map((feature) => feature.id)), new Set([...clean.keys(), ...historical]));
    for (const id of P7_VERIFIED_CATALOG_IDS) assert.equal(aggregate.features.find((feature) => feature.id === id)?.status, finalStatus, id);
  } finally {
    if (previous == null) delete process.env.AIWS_P7_EVIDENCE_STAGING_ROOT;
    else process.env.AIWS_P7_EVIDENCE_STAGING_ROOT = previous;
    fs.rmSync(attemptRoot, { recursive: true, force: true });
  }
});

test('P7 parser digest, dependencies, Evidence roles and architecture documents are synchronized', () => {
  assert.match(P7_PARSER_IMAGE_DIGEST, /^sha256:[a-f0-9]{64}$/);
  assert.equal(loadCleanConfig({}).parserImageDigest, P7_PARSER_IMAGE_DIGEST);
  for (const file of ['apps/runner-broker/clean-server.mjs', 'tests/p7/helpers.mjs']) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), new RegExp(P7_PARSER_IMAGE_DIGEST.replace(':', '\\:')), file);
  }
  const parserPackage = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'parser-worker', 'package.json'), 'utf8'));
  assert.deepEqual(parserPackage.dependencies, {
    '@napi-rs/canvas': '1.0.8', 'csv-parse': '7.0.2', 'ffmpeg-static': '5.3.0',
    'ffprobe-static': '3.1.0', 'libarchive.js': '2.0.2', officeparser: '7.8.0',
    'pdfjs-dist': '6.1.200', saxes: '6.0.0'
  });

  const evidenceSource = fs.readFileSync(path.join(root, 'scripts', 'v3-clean-p7-evidence.mjs'), 'utf8');
  assert.match(evidenceSource, /rollback-v6\.sqlite/);
  assert.match(evidenceSource, /p7_tables_absent/);
  assert.match(evidenceSource, /signatures_json/);
  assert.doesNotMatch(evidenceSource, /rollback-v5|magic_hex_json/);
  for (const role of ['sqlite', 'cas', 'vault', 'workspace', 'broker', 'bridge', 'parser']) assert.match(evidenceSource, new RegExp(`restored_components|${role}`));
  for (const policy of ['p4', 'p5', 'p6', 'p7']) assert.ok(EVIDENCE_POLICIES.some((entry) => entry.key === policy), policy);

  const documents = {
    'AGENTS.md': ['D-036', 'pnpm test:p7', 'pnpm evidence:p7', '23 Clean and 4 Historical'],
    'docs/testing.md': ['## P7 Evidence, Quality, Parser, and Outcome', '100-asset lineage', 'Rollback restores the v6'],
    'docs/architecture/decision-log.md': ['D-036', '007-evidence-quality-parser-outcome', '23/4/27'],
    'docs/architecture/clean-schema.md': ['PRAGMA user_version = 7', 'parser.receipt.v1', 'outcome_evaluations'],
    'docs/architecture/api-v2-contract.md': ['### 4.5 P7 Evidence/Quality/Parser/Outcome boundary', '/internal/v2/parser-jobs', 'human_score'],
    'docs/architecture/v3-clean-development-plan.md': ['P7 固定基线', '007-evidence-quality-parser-outcome', 'byte_exact_mismatches=[]'],
    'docs/architecture/v23-capability-matrix.md': ['## 20. P7 Evidence, Quality, Parser, and Outcome receipt', 'REC-D9-EVIDENCE-019', '23/4/27']
  };
  for (const [file, markers] of Object.entries(documents)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const marker of markers) assert.ok(source.includes(marker), `${file}:${marker}`);
  }
});
