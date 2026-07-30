#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { isMain, readJson } from './v175-lib.mjs';

export function validateV21Catalog() {
  const errors = [],
    catalog = readJson('tests/v21/catalog.json'),
    suites = readJson('tests/v21/suites.json');
  if (
    catalog.version !== '2.1' ||
    catalog.product_version !== '2.1.0' ||
    catalog.state_schema !== 21 ||
    catalog.protocol !== 'aiws.system-context.v1'
  )
    errors.push('catalog header must pin V2.1.0/schema 21/system-context v1');
  for (const [mode, minimum] of Object.entries({ cache_hit: 1000, pr: 60_000, full: 60_000, release: 60_000 }))
    if (!Number.isFinite(Number(catalog.budgets_ms?.[mode])) || Number(catalog.budgets_ms[mode]) < minimum)
      errors.push(`catalog budget invalid: ${mode}`);

  const byId = new Map();
  for (const item of catalog.tests || []) {
    if (!/^V21-L[0-7]-[A-Z0-9]+-\d{3}$/.test(String(item.id || ''))) errors.push(`invalid test id: ${item.id}`);
    if (byId.has(item.id)) errors.push(`duplicate test id: ${item.id}`);
    byId.set(item.id, item);
    for (const field of ['layer', 'domain', 'priority', 'command', 'suites', 'covers'])
      if (!item[field] || !item[field].length) errors.push(`${item.id}: missing ${field}`);
    if (!Number.isFinite(Number(item.timeout_ms)) || Number(item.timeout_ms) < 1000)
      errors.push(`${item.id}: invalid timeout_ms`);
    if (!['none', 'browser', 'docker', 'live'].includes(item.external_effects))
      errors.push(`${item.id}: invalid external_effects`);
    if (!Array.isArray(item.requires_env)) errors.push(`${item.id}: requires_env must be an array`);
    const commandFile = item.command?.[0] === 'node' ? item.command[1] : null;
    if (commandFile && !fs.existsSync(path.resolve(commandFile))) errors.push(`${item.id}: missing ${commandFile}`);
  }
  for (let layer = 0; layer <= 7; layer += 1)
    if (!(catalog.tests || []).some((item) => item.layer === `L${layer}`)) errors.push(`catalog missing L${layer}`);

  for (const mode of ['pr', 'full', 'release']) {
    const ids = suites[mode];
    if (!Array.isArray(ids) || !ids.length) {
      errors.push(`suite missing: ${mode}`);
      continue;
    }
    if (new Set(ids).size !== ids.length) errors.push(`${mode}: duplicate test ids`);
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) errors.push(`${mode}: unknown test ${id}`);
      else if (!item.suites.includes(mode)) errors.push(`${mode}: ${id} catalog suite mismatch`);
    }
    for (const item of catalog.tests || [])
      if (item.suites.includes(mode) && !ids.includes(item.id))
        errors.push(`${mode}: catalog test omitted from suite ${item.id}`);
  }
  return { errors, catalog, suites, byId };
}

if (isMain(import.meta.url)) {
  const result = validateV21Catalog();
  if (result.errors.length) {
    console.error(
      `V2.1 catalog validation failed (${result.errors.length}):\n${result.errors.map((item) => `- ${item}`).join('\n')}`
    );
    process.exit(1);
  }
  console.log(`V2.1 catalog validation passed (${result.catalog.tests.length} cases across L0-L7)`);
}
