import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('recovery catalog has unique feature and test mappings', () => {
  const raw = fs.readFileSync(path.join(root, 'feature-catalog.json'));
  const catalog = JSON.parse(raw);
  assert.equal(catalog.schema_version, 'aiws.v3.feature_catalog.v1');
  assert.equal(catalog.product_version, '3.0.0');
  assert.ok(catalog.features.length >= 20);
  assert.equal(new Set(catalog.features.map((feature) => feature.id)).size, catalog.features.length);
  for (const feature of catalog.features) {
    assert.match(feature.id, /^REC-D\d+-[A-Z]+-\d{3}$/);
    assert.ok(feature.tests.some((entry) => /^T[0-8]$/.test(entry)), feature.id);
  }
  assert.match(createHash('sha256').update(raw).digest('hex'), /^[a-f0-9]{64}$/);
});

test('recovery plan, catalog, and coverage gates emit passed receipts', () => {
  for (const command of ['plan', 'catalog', 'coverage']) {
    const run = spawnSync(process.execPath, ['scripts/recovery-governance.mjs', command], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.ai-workspace', 'recovery', `${command}.json`), 'utf8'));
    assert.equal(receipt.command, command);
    assert.equal(receipt.status, 'passed');
    assert.match(receipt.catalog_sha256, /^[a-f0-9]{64}$/);
  }
});
