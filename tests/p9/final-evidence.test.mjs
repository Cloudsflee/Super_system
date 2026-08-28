import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadCatalogIndex, loadCatalogLayers, validateCatalogLayers, validateP9EvidenceManifest } from '../../scripts/catalog-loader.mjs';

const root = process.cwd();
const evidence = path.join(root, 'docs/evidence/v3-clean-p9-web-release-20260826');
const reference = 'docs/evidence/v3-clean-p9-web-release-20260826/verification.json';

test('P9 final Evidence, rollback and 27 release rows are bidirectional', () => {
  const verification = JSON.parse(fs.readFileSync(path.join(evidence, 'verification.json'), 'utf8'));
  assert.equal(verification.run_id, 'run-1787933538303');
  assert.equal(verification.status, 'verified'); assert.equal(verification.provisional, false);
  assert.equal(verification.runtime_phase, 9); assert.equal(verification.target_user_version, 8); assert.equal(verification.migration_added, false);
  assert.deepEqual(verification.migration_ledger, [1,2,3,4,5,6,7,8]);
  assert.deepEqual(verification.catalog, { clean: 27, historical: 0, total: 27 });
  assert.equal(verification.release.status, 'passed'); assert.equal(verification.release.provisional, false); assert.match(verification.release.image_digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(verification.rollback.byte_exact_mismatches, []); assert.deepEqual(verification.rollback.ledger, [1,2,3,4,5,6,7,8]);
  assert.deepEqual(validateP9EvidenceManifest(evidence, verification), []);

  const index = loadCatalogIndex(root); const layers = loadCatalogLayers(root, index); const validation = validateCatalogLayers({ root, index, layers });
  assert.equal(validation.valid, true, validation.failures.join('\n')); assert.deepEqual(validation.counts, { clean: 27, historical: 0, total: 27 });
  assert.equal(layers.historical.features.length, 0); assert.equal(layers.clean.features.length, 27);
  for (const row of layers.clean.features) { assert.equal(row.status, 'released', row.id); assert.ok(row.release_receipts.includes(reference), row.id); }
  for (const id of ['REC-D1-CONTRACTS-023','REC-D10-FRONTEND-024']) assert.ok(layers.clean.features.find((row) => row.id === id).evidence.includes(reference), id);
  assert.deepEqual(new Set(verification.release_rows), new Set(layers.clean.features.map((row) => row.id)));
});

test('P9 final governance documents name the published boundary', () => {
  for (const file of ['AGENTS.md','docs/testing.md','docs/architecture/decision-log.md','docs/architecture/v3-clean-development-plan.md','docs/architecture/v23-capability-matrix.md']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const marker of ['run-1787933538303','27/0/27']) assert.ok(source.includes(marker), `${file}:${marker}`);
  }
});
