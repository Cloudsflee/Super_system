#!/usr/bin/env node
import fs from 'node:fs';

import { readJson } from './v175-lib.mjs';
import { validateV22Catalog } from './v22-catalog.mjs';

const errors = [...validateV22Catalog().errors],
  manifest = readJson('package.json'),
  coverage = readJson('tests/v22/coverage-map.json');

if (manifest.version !== '2.2.0') errors.push('package.json version must be 2.2.0');
if (!String(manifest.description || '').includes('V2.2')) errors.push('package description must identify V2.2');
for (const [name, expected] of Object.entries({
  'test:v22:plan': 'scripts/v22-plan.mjs',
  'test:v22:catalog': 'scripts/v22-catalog.mjs',
  'test:v22:coverage': 'scripts/v22-coverage.mjs',
  'test:v22:impact': 'scripts/v22-impact.mjs',
  'test:v22:unit': 'scripts/v22-suite.mjs unit',
  'test:v22:integration': 'scripts/v22-suite.mjs integration',
  'test:v22:security': 'scripts/v22-suite.mjs security',
  'test:v22:performance': 'scripts/v22-suite.mjs performance',
  'test:v22:pr': 'scripts/v22-runner.mjs pr',
  'test:v22:full': 'scripts/v22-runner.mjs full',
  'test:v22:release': 'scripts/v22-runner.mjs release',
  'test:compat:pr': 'scripts/compat-pr-runner.mjs'
}))
  if (!String(manifest.scripts?.[name] || '').includes(expected))
    errors.push(`package script ${name} must use ${expected}`);

for (const file of [
  '开发计划v2.2.md',
  '测试计划v2.2.md',
  'apps/api/src/state-store.mjs',
  'apps/api/src/state-store-worker.mjs',
  'apps/api/src/state-migration-v22.mjs',
  'apps/api/src/context-index-runtime.mjs',
  'apps/api/src/runtime-health.mjs',
  'apps/api/src/shutdown-coordinator.mjs',
  'docker/release-volume-v22.mjs',
  'docker/release-volume-v22-cli.mjs',
  'docker/v22-upgrade.mjs',
  'scripts/compat-pr-runner.mjs',
  'scripts/gate-scheduler.mjs',
  'scripts/gate-receipt-v22.mjs',
  'scripts/impact-range.mjs',
  'scripts/v22-release.mjs'
])
  if (!fs.existsSync(file)) errors.push(`missing V2.2 implementation file: ${file}`);

for (const [file, anchors] of [
  ['开发计划v2.2.md', ['# AIWS 开发计划 V2.2', '产品版本：`2.2.0`', 'state schema：`22`', 'OPT22-01']],
  ['测试计划v2.2.md', ['# AIWS 测试计划 V2.2', '产品版本：`2.2.0`', 'state schema：`22`', 'test:v22:plan']],
  [
    'packages/shared/src/version.mjs',
    ["AIWS_VERSION = '2.2.0'", 'AIWS_STATE_SCHEMA_VERSION = 22', "AIWS_COMPOSE_PROJECT = 'aiws-v22'"]
  ],
  [
    'packages/system-context/src/protocol.mjs',
    ["CONTEXT_PROTOCOL_VERSION = 'aiws.system-context.v1'", "CONTEXT_PACK_SCHEMA = 'aiws.context_pack.v5'"]
  ],
  ['compose.yml', ['name: aiws-v22', 'aiws-app:2.2.0', 'aiws-codex-runner:2.2.0-codex-0.144.0', 'aiws-data-v22']]
]) {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const anchor of anchors) if (!source.includes(anchor)) errors.push(`${file}: missing ${anchor}`);
}

if (coverage.version !== '2.2' || coverage.product_version !== '2.2.0' || coverage.state_schema !== 22)
  errors.push('coverage header invalid');
for (const id of ['OPT21-01', 'OPT21-02', 'OPT21-03', 'OPT21-04', 'OPT21-05', 'OPT22-01'])
  if (!coverage.work_packages?.[id]) errors.push(`coverage missing ${id}`);

if (errors.length) {
  console.error(`V2.2 plan validation failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('V2.2 plan validation passed (product 2.2.0, schema 22, SQLite authority)');
