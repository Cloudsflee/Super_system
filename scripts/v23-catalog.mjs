#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { isMain, readJson } from './v175-lib.mjs';

const INDEPENDENT_DOMAIN_ENTRYPOINTS = Object.freeze({
  parser: 'tests/unit/v23-quality-review-parser.test.mjs',
  runtime: 'tests/integration/v23-quality-review-flow.test.mjs',
  security: 'tests/security/v23-quality-review-security.test.mjs',
  performance: 'tests/performance/v23-quality-review-performance.test.mjs',
  release: 'tests/release/v23-release-contract.test.mjs'
});

export function validateV23Catalog() {
  const errors = [],
    catalog = readJson('tests/v23/catalog.json'),
    suites = readJson('tests/v23/suites.json'),
    byId = indexCatalogTests(catalog, errors);
  errors.push(
    ...validateCatalogHeader(catalog),
    ...validateCatalogLayers(catalog),
    ...validateIndependentCoverage(catalog),
    ...validateCatalogSuites(catalog, suites, byId)
  );
  return { errors, catalog, suites, byId };
}

function validateCatalogHeader(catalog) {
  const errors = [];
  if (
    catalog.version !== '2.3' ||
    catalog.product_version !== '2.3.0' ||
    catalog.state_schema !== 23 ||
    catalog.protocol !== 'aiws.system-context.v1'
  )
    errors.push('catalog header must pin V2.3.0/schema 23/system-context v1');
  for (const [mode, minimum] of Object.entries({ cache_hit: 1000, pr: 60_000, full: 60_000, release: 60_000 }))
    if (!Number.isFinite(Number(catalog.budgets_ms?.[mode])) || Number(catalog.budgets_ms[mode]) < minimum)
      errors.push(`catalog budget invalid: ${mode}`);
  return errors;
}

function indexCatalogTests(catalog, errors) {
  const byId = new Map();
  for (const item of catalog.tests || []) {
    validateCatalogTest(item, errors, byId);
    byId.set(item.id, item);
  }
  return byId;
}

function validateCatalogTest(item, errors, byId) {
  if (!/^V23-L[0-7]-[A-Z0-9]+-\d{3}$/.test(String(item.id || ''))) errors.push(`invalid test id: ${item.id}`);
  if (byId.has(item.id)) errors.push(`duplicate test id: ${item.id}`);
  for (const field of ['layer', 'domain', 'priority', 'command', 'suites', 'covers'])
    if (!item[field] || !item[field].length) errors.push(`${item.id}: missing ${field}`);
  if (!Number.isFinite(Number(item.timeout_ms)) || Number(item.timeout_ms) < 1000)
    errors.push(`${item.id}: invalid timeout_ms`);
  if (!['none', 'browser', 'docker', 'live'].includes(item.external_effects))
    errors.push(`${item.id}: invalid external_effects`);
  if (!Array.isArray(item.requires_env)) errors.push(`${item.id}: requires_env must be an array`);
  validateCatalogCommand(item, errors);
}

function validateCatalogCommand(item, errors) {
  const commandFile = catalogCommandFile(item);
  if (commandFile && !fs.existsSync(path.resolve(commandFile))) errors.push(`${item.id}: missing ${commandFile}`);
}

function validateIndependentCoverage(catalog) {
  const errors = [],
    commandOwners = new Map();
  for (const item of catalog.tests || []) {
    const commandKey = JSON.stringify((item.command || []).map(String)),
      owner = commandOwners.get(commandKey);
    if (owner) errors.push(`${item.id}: duplicate command also used by ${owner}`);
    else commandOwners.set(commandKey, item.id);
  }
  for (const [domain, expectedEntrypoint] of Object.entries(INDEPENDENT_DOMAIN_ENTRYPOINTS)) {
    const items = (catalog.tests || []).filter((item) => item.domain === domain);
    if (!items.length) {
      errors.push(`catalog missing independent ${domain} test`);
      continue;
    }
    if (!items.some((item) => normalizePath(catalogCommandFile(item)) === expectedEntrypoint))
      errors.push(`${domain}: independent entrypoint must be ${expectedEntrypoint}`);
  }
  return errors;
}

function catalogCommandFile(item) {
  return item.command?.[0] === 'node'
    ? item.command.find((value, index) => index > 0 && !String(value).startsWith('-'))
    : null;
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/');
}

function validateCatalogLayers(catalog) {
  const errors = [];
  for (let layer = 0; layer <= 7; layer += 1)
    if (!(catalog.tests || []).some((item) => item.layer === `L${layer}`)) errors.push(`catalog missing L${layer}`);
  return errors;
}

function validateCatalogSuites(catalog, suites, byId) {
  const errors = [];
  for (const mode of ['pr', 'full', 'release']) errors.push(...validateCatalogSuite(mode, catalog, suites, byId));
  return errors;
}

function validateCatalogSuite(mode, catalog, suites, byId) {
  const errors = [],
    ids = suites[mode];
  if (!Array.isArray(ids) || !ids.length) return [`suite missing: ${mode}`];
  if (new Set(ids).size !== ids.length) errors.push(`${mode}: duplicate test ids`);
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) errors.push(`${mode}: unknown test ${id}`);
    else if (!item.suites.includes(mode)) errors.push(`${mode}: ${id} catalog suite mismatch`);
  }
  for (const item of catalog.tests || [])
    if (item.suites.includes(mode) && !ids.includes(item.id))
      errors.push(`${mode}: catalog test omitted from suite ${item.id}`);
  return errors;
}

if (isMain(import.meta.url)) {
  const result = validateV23Catalog();
  if (result.errors.length) {
    console.error(
      `V2.3 catalog validation failed (${result.errors.length}):\n${result.errors.map((item) => `- ${item}`).join('\n')}`
    );
    process.exit(1);
  }
  console.log(`V2.3 catalog validation passed (${result.catalog.tests.length} cases across L0-L7)`);
}
