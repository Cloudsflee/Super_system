import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_P7_MIGRATION_REGISTRY, CLEAN_P8_MIGRATION_REGISTRY } from '../../apps/api/src/clean/migration-service.mjs';
import { CLEAN_P7_TABLE_OWNERS, CLEAN_P8_TABLE_OWNERS, validateCleanOwnership } from '../../apps/api/src/clean/ownership.mjs';
import { createCleanCommandRegistry, registryParity } from '../../apps/api/src/clean/registry.mjs';
import { loadCatalogIndex, loadCatalogLayers, validateCatalogLayers, validateP8EvidenceManifest } from '../../scripts/catalog-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidence = path.join(root, 'docs', 'evidence', 'v3-clean-p8-delivery-deployment-importer-20260825');
const p8Ids = ['REC-D7-DELIVERY-015', 'REC-D9-DEPLOYMENT-021', 'REC-D11-OPS-022'];

test('P8 migration, ownership and 25-route inventories are bidirectional', () => {
  const added = Object.keys(CLEAN_P8_TABLE_OWNERS).filter((name) => !Object.hasOwn(CLEAN_P7_TABLE_OWNERS, name)).sort();
  assert.equal(added.length, 11);
  assert.deepEqual(CLEAN_P8_MIGRATION_REGISTRY.slice(0, 7).map((item) => item.id), CLEAN_P7_MIGRATION_REGISTRY.map((item) => item.id));
  assert.equal(CLEAN_P8_MIGRATION_REGISTRY.at(-1).id, '008-delivery-deployment-importer-operations');
  const registry = createCleanCommandRegistry({ targetVersion: 8 });
  const routes = registry.entries.filter((entry) => entry.phase === 'p8');
  assert.equal(routes.length, 25);
  assert.equal(new Set(routes.map((entry) => `${entry.method} ${entry.path}`)).size, 25);
  assert.equal(registryParity(registry).valid, true);
  assert.equal(validateCleanOwnership({ tables: Object.keys(CLEAN_P8_TABLE_OWNERS), registry }).valid, true);
  assert.equal(routes.every((entry) => entry.path.startsWith('/api/v2/') && entry.input_schema !== 'p8.query.v2' && entry.input_schema !== 'p8.mutation.v2'), true);
});

test('Importer mutations are CLI-only and runtime registry contains sealed queries', () => {
  const ids = createCleanCommandRegistry({ targetVersion: 8 }).entries.map((entry) => entry.command_id);
  for (const command of ['import.inspect', 'import.dry-run', 'import.run', 'import.resume', 'import.verify', 'import.cutover', 'import.rollback']) assert.equal(ids.includes(command), false, command);
  assert.equal(ids.includes('import.list'), true);
  assert.equal(ids.includes('import.get'), true);
});

test('P8 Evidence is hash-complete and synchronized with the layered Catalog promotion', () => {
  const verification = JSON.parse(fs.readFileSync(path.join(evidence, 'verification.json'), 'utf8'));
  assert.equal(verification.status, 'verified');
  assert.equal(verification.provisional, false);
  assert.equal(verification.catalog_promotion, '26/1/27');
  assert.deepEqual(validateP8EvidenceManifest(evidence, verification), []);
  const index = loadCatalogIndex(root);
  const layers = loadCatalogLayers(root, index);
  const validation = validateCatalogLayers({ root, index, layers });
  assert.equal(validation.valid, true, validation.failures.join('\n'));
  const p9 = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/v3-clean-p9-web-release-20260826/verification.json'), 'utf8'));
  const p9Final = p9.status === 'verified' && p9.provisional === false;
  assert.deepEqual(validation.counts, p9Final ? { clean: 27, historical: 0, total: 27 } : { clean: 26, historical: 1, total: 27 });
  const historical = new Map(layers.historical.features.map((feature) => [feature.id, feature]));
  const clean = new Map(layers.clean.features.map((feature) => [feature.id, feature]));
  for (const id of p8Ids) {
    assert.equal(historical.has(id), false, id);
    assert.equal(clean.get(id)?.status, p9Final ? 'released' : 'verified', id);
    assert.equal(clean.get(id)?.runtime_surface, 'v3-clean', id);
    assert.ok(clean.get(id)?.evidence.includes('docs/evidence/v3-clean-p8-delivery-deployment-importer-20260825/verification.json'), id);
  }
  assert.equal(clean.get('REC-D2-SETUP-002')?.status, p9Final ? 'released' : 'verified');
  assert.deepEqual([...historical.keys()], p9Final ? [] : ['REC-D1-CONTRACTS-023']);
});

test('P8 package, testing policy, plan, matrix and Evidence references stay synchronized', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.keys(manifest.scripts).length, 53);
  assert.equal(manifest.scripts['test:p8'], 'node --test tests/p8/*.test.mjs');
  assert.equal(manifest.scripts['evidence:p8'], 'node scripts/v3-clean-p8-evidence.mjs');
  for (const file of ['AGENTS.md', 'docs/testing.md', 'docs/architecture/v3-clean-development-plan.md', 'docs/architecture/v23-capability-matrix.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const required of ['pnpm test:p8', 'v3-clean-p8-github-delivery-probe.mjs', 'v3-clean-p8-importer-probe.mjs', 'v3-clean-p8-deployment-rollback-probe.mjs', 'v3-clean-p8-backup-restore-gc-probe.mjs']) assert.ok(text.includes(required), `${file}:${required}`);
  }
});
