#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { CONTEXT_INTERNAL_COLLECTIONS, CONTEXT_STATE_ADAPTERS } from '../packages/system-context/src/index.mjs';
import { collections } from '../apps/api/src/config.mjs';
import { isMain, readJson } from './v175-lib.mjs';

export function validateV20Catalog() {
  const errors = [];
  const catalog = readJson('tests/v20/catalog.json');
  const suites = readJson('tests/v20/suites.json');
  const coverage = readJson('tests/v20/coverage-map.json');
  if (
    catalog.version !== '2.0' ||
    catalog.product_version !== '2.0.0' ||
    catalog.state_schema !== 20 ||
    catalog.protocol !== 'aiws.system-context.v1'
  )
    errors.push('catalog header must pin V2.0.0/schema 20/system-context v1');
  for (const mode of ['pr', 'full', 'release'])
    if (!Number.isFinite(Number(catalog.budgets_ms?.[mode])) || Number(catalog.budgets_ms[mode]) < 1000)
      errors.push(`catalog budget missing: ${mode}`);

  const byId = new Map();
  for (const item of catalog.tests || []) {
    if (!/^V20-L[0-6]-[A-Z0-9]+-\d{3}$/.test(String(item.id || ''))) errors.push(`invalid test id: ${item.id}`);
    if (byId.has(item.id)) errors.push(`duplicate test id: ${item.id}`);
    byId.set(item.id, item);
    for (const field of ['layer', 'domain', 'priority', 'command', 'suites', 'covers'])
      if (!item[field] || !item[field].length) errors.push(`${item.id}: missing ${field}`);
    if (!Number.isFinite(Number(item.timeout_ms)) || Number(item.timeout_ms) < 1000)
      errors.push(`${item.id}: invalid timeout_ms`);
    if (!['none', 'browser', 'docker'].includes(item.external_effects))
      errors.push(`${item.id}: invalid external_effects`);
    if (!Array.isArray(item.requires_env)) errors.push(`${item.id}: requires_env must be an array`);
    const commandFile = item.command?.[0] === 'node' ? item.command[1] : null;
    if (commandFile && !fs.existsSync(path.resolve(commandFile))) errors.push(`${item.id}: missing ${commandFile}`);
  }
  for (let layer = 0; layer <= 6; layer += 1)
    if (!(catalog.tests || []).some((item) => item.layer === `L${layer}`)) errors.push(`catalog missing L${layer}`);

  for (const mode of ['pr', 'full', 'release']) {
    if (!Array.isArray(suites[mode]) || !suites[mode].length) errors.push(`suite missing: ${mode}`);
    for (const id of suites[mode] || []) {
      const item = byId.get(id);
      if (!item) errors.push(`${mode}: unknown test ${id}`);
      else if (!item.suites.includes(mode)) errors.push(`${mode}: ${id} catalog suite mismatch`);
    }
  }

  const sourceCollections = collections.filter((name) => !CONTEXT_INTERNAL_COLLECTIONS.includes(name));
  if (!sameSet(sourceCollections, coverage.state_collections))
    errors.push('coverage state_collections differ from schema 20');
  if (!sameSet(CONTEXT_INTERNAL_COLLECTIONS, coverage.context_collections))
    errors.push('coverage context_collections differ from protocol collections');
  if (!sameSet(sourceCollections, Object.keys(CONTEXT_STATE_ADAPTERS)))
    errors.push('state adapter catalog is incomplete');
  return { errors, catalog, suites, coverage };
}

if (isMain(import.meta.url)) {
  const result = validateV20Catalog();
  if (result.errors.length) {
    console.error(
      `V2.0 catalog validation failed (${result.errors.length}):\n${result.errors.map((item) => `- ${item}`).join('\n')}`
    );
    process.exit(1);
  }
  console.log(`V2.0 catalog validation passed (${result.catalog.tests.length} cases, 84 source adapters)`);
}

function sameSet(left, right) {
  return left.length === right?.length && left.every((item) => right.includes(item));
}
