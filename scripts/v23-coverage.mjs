#!/usr/bin/env node
import fs from 'node:fs';

import { readJson } from './v175-lib.mjs';
import { validateV23Catalog } from './v23-catalog.mjs';

const errors = [],
  coverage = readJson('tests/v23/coverage-map.json'),
  catalog = validateV23Catalog(),
  knownTests = new Set(catalog.catalog.tests.map((item) => item.id)),
  expectedPackages = ['OPT21-01', 'OPT21-02', 'OPT21-03', 'OPT21-04', 'OPT21-05', 'OPT22-01', 'OPT23-01'],
  knownPackages = new Set(Object.keys(coverage.work_packages || {}));

errors.push(...catalog.errors);
if (coverage.version !== '2.3' || coverage.product_version !== '2.3.0' || coverage.state_schema !== 23)
  errors.push('coverage header must pin V2.3.0/schema 23');
if (!sameSet(expectedPackages, [...knownPackages])) errors.push('optimization package coverage is not exact');

for (const [id, mapping] of Object.entries(coverage.work_packages || {})) {
  if (!expectedPackages.includes(id)) errors.push(`invalid optimization package: ${id}`);
  if (!mapping.implementation?.length) errors.push(`${id}: implementation mapping empty`);
  if (!mapping.tests?.length) errors.push(`${id}: test mapping empty`);
  for (const file of mapping.implementation || [])
    if (!fs.existsSync(file)) errors.push(`${id}: implementation missing ${file}`);
  for (const testId of mapping.tests || []) if (!knownTests.has(testId)) errors.push(`${id}: unknown test ${testId}`);
}

for (const item of catalog.catalog.tests) {
  const packageCoverage = item.covers.filter((value) => /^OPT\d{2}-\d{2}$/.test(value));
  if (!packageCoverage.length) errors.push(`${item.id}: optimization coverage missing`);
  for (const id of packageCoverage) {
    if (!knownPackages.has(id)) errors.push(`${item.id}: unknown optimization package ${id}`);
    else if (!coverage.work_packages[id].tests.includes(item.id))
      errors.push(`${item.id}: ${id} coverage is not bidirectional`);
  }
}
for (const [id, mapping] of Object.entries(coverage.work_packages || {}))
  for (const testId of mapping.tests || [])
    if (!catalog.byId.get(testId)?.covers.includes(id)) errors.push(`${id}: ${testId} coverage is not bidirectional`);

if (errors.length) {
  console.error(`V2.3 coverage gate failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(`V2.3 coverage gate passed (${expectedPackages.length} optimization packages, ${knownTests.size} tests)`);

function sameSet(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}
