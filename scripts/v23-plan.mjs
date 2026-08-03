#!/usr/bin/env node
import fs from 'node:fs';

import { readJson } from './v175-lib.mjs';
import { validateV23Catalog } from './v23-catalog.mjs';

const errors = [...validateV23Catalog().errors],
  manifest = readJson('package.json'),
  coverage = readJson('tests/v23/coverage-map.json');

if (manifest.version !== '2.3.0') errors.push('package.json version must be 2.3.0');
if (!String(manifest.description || '').includes('V2.3')) errors.push('package description must identify V2.3');
for (const [name, expected] of Object.entries({
  'test:v23:plan': 'scripts/v23-plan.mjs',
  'test:v23:catalog': 'scripts/v23-catalog.mjs',
  'test:v23:coverage': 'scripts/v23-coverage.mjs',
  'test:v23:impact': 'scripts/v23-impact.mjs',
  'test:v23:unit': 'scripts/v23-suite.mjs unit',
  'test:v23:integration': 'scripts/v23-suite.mjs integration',
  'test:v23:security': 'scripts/v23-suite.mjs security',
  'test:v23:performance': 'scripts/v23-suite.mjs performance',
  'test:v23:pr': 'scripts/v23-runner.mjs pr',
  'test:v23:full': 'scripts/v23-runner.mjs full',
  'test:v23:release': 'scripts/v23-runner.mjs release',
  'test:compat:pr': 'scripts/compat-pr-runner.mjs'
}))
  if (!String(manifest.scripts?.[name] || '').includes(expected))
    errors.push(`package script ${name} must use ${expected}`);

for (const file of [
  '开发计划v2.3.md',
  '测试计划v2.3.md',
  'apps/api/src/state-store.mjs',
  'apps/api/src/state-store-worker.mjs',
  'apps/api/src/state-migration-v23.mjs',
  'apps/api/src/context-index-runtime.mjs',
  'apps/api/src/runtime-health.mjs',
  'apps/api/src/shutdown-coordinator.mjs',
  'docker/release-volume-v23.mjs',
  'docker/release-volume-v23-cli.mjs',
  'docker/v23-upgrade.mjs',
  'scripts/compat-pr-runner.mjs',
  'scripts/gate-scheduler.mjs',
  'scripts/gate-receipt-v23.mjs',
  'scripts/impact-range.mjs',
  'scripts/v23-release.mjs'
])
  if (!fs.existsSync(file)) errors.push(`missing V2.3 implementation file: ${file}`);

for (const [file, anchors] of [
  ['开发计划v2.3.md', ['# AIWS 开发计划 V2.3', '产品版本：`2.3.0`', 'state schema：`23`', 'OPT23-01']],
  ['测试计划v2.3.md', ['# AIWS 测试计划 V2.3', '产品版本：`2.3.0`', 'state schema：`23`', 'test:v23:plan']],
  [
    'packages/shared/src/version.mjs',
    ["AIWS_VERSION = '2.3.0'", 'AIWS_STATE_SCHEMA_VERSION = 23', "AIWS_COMPOSE_PROJECT = 'aiws-v23'"]
  ],
  [
    'packages/system-context/src/protocol.mjs',
    ["CONTEXT_PROTOCOL_VERSION = 'aiws.system-context.v1'", "CONTEXT_PACK_SCHEMA = 'aiws.context_pack.v5'"]
  ],
  ['compose.yml', ['name: aiws-v23', 'aiws-app:2.3.0', 'aiws-codex-runner:2.3.0-codex-0.144.0', 'aiws-data-v23']]
]) {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const anchor of anchors) if (!source.includes(anchor)) errors.push(`${file}: missing ${anchor}`);
}

if (coverage.version !== '2.3' || coverage.product_version !== '2.3.0' || coverage.state_schema !== 23)
  errors.push('coverage header invalid');
for (const id of ['OPT21-01', 'OPT21-02', 'OPT21-03', 'OPT21-04', 'OPT21-05', 'OPT22-01', 'OPT23-01'])
  if (!coverage.work_packages?.[id]) errors.push(`coverage missing ${id}`);

if (errors.length) {
  console.error(`V2.3 plan validation failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('V2.3 plan validation passed (product 2.3.0, schema 23, SQLite authority)');
