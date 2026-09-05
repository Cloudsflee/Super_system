import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateP10EvidenceManifest } from '../../scripts/catalog-loader.mjs';

const evidence = 'docs/evidence/v3-clean-p10-final-governance-20260829';

test('P10 release is temporary, dynamic-origin, and restores the P9 v8 boundary', () => {
  const source = fs.readFileSync('scripts/v3-clean-p10-release-probe.mjs', 'utf8');
  for (const marker of ["fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p10-release-'))", 'dynamicOrigin', 'production_cutover: false', 'targetVersion: 8', 'targetVersion: 9', 'restored_user_version', 'byte_exact', 'production_image_boundary', 'command -v docker', '/var/run/docker.sock']) assert.ok(source.includes(marker), marker);
  assert.doesNotMatch(source, /docker\s+(?:system|image|volume|builder)\s+prune/);
});

test('P10 final Evidence binds parity, 21 parser formats, three viewports, four artifacts, and actual rollback', () => {
  const verification = JSON.parse(fs.readFileSync(`${evidence}/verification.json`, 'utf8'));
  assert.equal(verification.status, 'verified');
  assert.equal(verification.provisional, false);
  assert.equal(verification.catalog_promotion, '27/0/27');
  assert.deepEqual(verification.parity.counts, { cases: 14, routes: 360, collections: 98, web_routes: 11, optimization_packages: 7 });
  assert.equal(verification.parity.business_groups, 19);
  assert.equal(verification.parity.gaps, 0);
  assert.equal(verification.rollback.restored_user_version, 8);
  assert.deepEqual(verification.rollback.ledger, [1,2,3,4,5,6,7,8]);
  assert.deepEqual(verification.rollback.p10_tables_present, []);
  assert.deepEqual(verification.rollback.p10_columns_present, []);
  assert.deepEqual(verification.rollback.byte_exact_mismatches, []);
  assert.deepEqual(validateP10EvidenceManifest(evidence, verification), []);
});
