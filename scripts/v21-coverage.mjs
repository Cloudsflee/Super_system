#!/usr/bin/env node
import fs from 'node:fs';

import { apiRoutes } from '../apps/api/src/api-routes.mjs';
import { createApiRouteRegistry } from '../apps/api/src/api-route-registry.mjs';
import { collections } from '../apps/api/src/config.mjs';
import { CONTEXT_INTERNAL_COLLECTIONS } from '../packages/system-context/src/index.mjs';
import { readJson } from './v175-lib.mjs';
import { validateV21Catalog } from './v21-catalog.mjs';

const errors = [],
  coverage = readJson('tests/v21/coverage-map.json'),
  catalog = validateV21Catalog(),
  knownTests = new Set(catalog.catalog.tests.map((item) => item.id)),
  knownImplementations = new Set(Object.keys(coverage.work_packages || {})),
  successorCollections = new Set(['quality_review_runs', 'quality_review_reports', 'quality_review_events']),
  sources = collections.filter(
    (name) => !CONTEXT_INTERNAL_COLLECTIONS.includes(name) && !successorCollections.has(name)
  );

if (!sameSet(sources, coverage.state_collections)) errors.push('state collection coverage is not exact');
if (!sameSet(CONTEXT_INTERNAL_COLLECTIONS, coverage.context_collections))
  errors.push('context collection coverage is not exact');

const routeKeys = new Set(apiRoutes.map((route) => `${route.method} ${route.pattern}`));
for (const route of coverage.rest || [])
  if (!routeKeys.has(route)) errors.push(`REST coverage route missing: ${route}`);
const registry = createApiRouteRegistry(apiRoutes),
  operationIds = new Set(registry.map((item) => item.operation_id));
for (const operationId of coverage.mcp_actions || [])
  if (!operationIds.has(operationId)) errors.push(`MCP operation missing: ${operationId}`);

for (const [id, mapping] of Object.entries(coverage.work_packages || {})) {
  if (!/^DEV210-(?:0[1-9]|1[0-4])$/.test(id)) errors.push(`invalid work package: ${id}`);
  if (!mapping.implementation?.length) errors.push(`${id}: implementation mapping empty`);
  if (!mapping.tests?.length) errors.push(`${id}: test mapping empty`);
  for (const file of mapping.implementation || [])
    if (!fs.existsSync(file)) errors.push(`${id}: implementation missing ${file}`);
  for (const testId of mapping.tests || []) if (!knownTests.has(testId)) errors.push(`${id}: unknown test ${testId}`);
}
for (const item of catalog.catalog.tests)
  if (
    item.covers.some((value) => /^DEV210-/.test(value)) &&
    !item.covers.some((value) => knownImplementations.has(value))
  )
    errors.push(`${item.id}: unknown DEV coverage`);

const expectedIssues = [
  ...Array.from({ length: 8 }, (_, index) => `SYS-0${index + 1}`),
  'CTX-01',
  'CTX-02',
  'GOV-01',
  'GOV-02',
  'GOV-03',
  'OPS-01',
  'OPS-02',
  'OPS-03'
];
if (!sameSet(expectedIssues, Object.keys(coverage.retrospective_issues || {})))
  errors.push('retrospective issue coverage is not exact');
for (const [issue, mapping] of Object.entries(coverage.retrospective_issues || {})) {
  if (!mapping.implementation_ids?.length || !mapping.test_ids?.length) errors.push(`${issue}: coverage incomplete`);
  for (const implementationId of mapping.implementation_ids || [])
    if (!knownImplementations.has(implementationId))
      errors.push(`${issue}: unknown implementation ${implementationId}`);
  for (const testId of mapping.test_ids || [])
    if (!knownTests.has(testId)) errors.push(`${issue}: unknown test ${testId}`);
}
for (const viewport of [2560, 1920, 1440, 1024, 768, 390])
  if (!coverage.viewports?.includes(viewport)) errors.push(`viewport missing: ${viewport}`);

if (errors.length) {
  console.error(`V2.1 coverage gate failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `V2.1 coverage gate passed (${sources.length} source collections, 14 work packages, 16 retrospective issues)`
);

function sameSet(left, right) {
  return left.length === right?.length && left.every((item) => right.includes(item));
}
