import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadCatalogIndex, loadCatalogLayers, validateCatalogLayers } from '../../scripts/catalog-loader.mjs';

test('Clean and historical catalogs are disjoint and bidirectionally validated', () => {
  const root = process.cwd();
  const index = loadCatalogIndex(root);
  const layers = loadCatalogLayers(root, index);
  const result = validateCatalogLayers({ root, index, layers });
  assert.equal(result.valid, true, JSON.stringify(result.failures));
  const clean = new Set(layers.clean.features.map((feature) => feature.id));
  const historical = new Set(layers.historical.features.map((feature) => feature.id));
  assert.equal([...clean].some((id) => historical.has(id)), false);
  assert.ok(clean.has('REC-D0-GOVERNANCE-000'));
  assert.ok(clean.has('REC-D10-FRONTEND-024'));
});

test('catalog files exist and matrix references remain available', () => {
  for (const file of ['feature-catalog.clean.json', 'feature-catalog.historical.json', 'feature-catalog.json', 'docs/architecture/v23-capability-matrix.md']) assert.equal(fs.existsSync(path.join(process.cwd(), file)), true, file);
});
