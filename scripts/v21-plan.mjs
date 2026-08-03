#!/usr/bin/env node
import fs from 'node:fs';

import { validateV21Catalog } from './v21-catalog.mjs';
import { readJson } from './v175-lib.mjs';

const errors = [...validateV21Catalog().errors],
  manifest = readJson('package.json'),
  coverage = readJson('tests/v21/coverage-map.json');

if (!['2.1.0', '2.2.0', '2.3.0'].includes(manifest.version))
  errors.push('package.json version must be V2.1 or a declared V2.2/V2.3 compatibility successor');
for (const [name, expected] of Object.entries({
  'test:v21:plan': 'scripts/v21-plan.mjs',
  'test:v21:catalog': 'scripts/v21-catalog.mjs',
  'test:v21:coverage': 'scripts/v21-coverage.mjs',
  'test:v21:impact': 'scripts/v21-impact.mjs',
  'test:v21:unit': 'scripts/v21-suite.mjs unit',
  'test:v21:integration': 'scripts/v21-suite.mjs integration',
  'test:v21:web': 'scripts/v21-suite.mjs web',
  'test:v21:security': 'scripts/v21-suite.mjs security',
  'test:v21:performance': 'scripts/v21-suite.mjs performance',
  'test:v21:soak': 'scripts/v21-suite.mjs soak',
  'test:v21:pr': 'scripts/v21-runner.mjs pr',
  'test:v21:full': 'scripts/v21-runner.mjs full',
  'test:v21:release': 'scripts/v21-runner.mjs release'
}))
  if (!String(manifest.scripts?.[name] || '').includes(expected))
    errors.push(`package script ${name} must use ${expected}`);

for (const file of [
  '开发计划v2.1.md',
  '测试计划v2.1.md',
  'packages/execution-protocol/src/index.mjs',
  'apps/api/src/state-migration-v21.mjs',
  'apps/api/src/outcome-service.mjs',
  'apps/api/src/execution-stage-service.mjs',
  'apps/api/src/execution-replay-service.mjs',
  'apps/api/src/context-projector-coordinator.mjs',
  'apps/api/src/context-projection-worker.mjs',
  'apps/api/src/workflow-finalization-service.mjs',
  'docker/release-volume-v21.mjs',
  'docker/v21-upgrade.mjs',
  'scripts/gate-receipt-v21.mjs',
  'scripts/v21-release.mjs'
])
  if (!fs.existsSync(file)) errors.push(`missing V2.1 implementation file: ${file}`);

for (const [file, anchors] of [
  [
    '开发计划v2.1.md',
    ['# AIWS 开发计划 V2.1', '产品版本：`2.1.0`', 'state schema：`21`', 'aiws.context_pack.v5', 'DEV210-14']
  ],
  [
    '测试计划v2.1.md',
    ['# AIWS 测试计划 V2.1', '产品版本：`2.1.0`', 'state schema：`21`', 'test:v21:plan', '5/6 + 12/15 + Outbox pending']
  ],
  [
    'apps/api/src/state-migration-v21.mjs',
    ['STATE_SCHEMA_VERSION = 21', "V21_RUNNER_IMAGE = 'aiws-codex-runner:2.1.0-codex-0.144.0'"]
  ],
  [
    'packages/system-context/src/protocol.mjs',
    [
      "CONTEXT_PROTOCOL_VERSION = 'aiws.system-context.v1'",
      "CONTEXT_SELECTION_SCHEMA = 'aiws.context_selection.v2'",
      "CONTEXT_PACK_SCHEMA = 'aiws.context_pack.v5'"
    ]
  ],
  ['docker/v21-upgrade.mjs', ["V21_PROJECT = 'aiws-v21'", "V21_APP_IMAGE = 'aiws-app:2.1.0'"]],
  ['docker/release-volume-v21.mjs', ["V21_TARGET_VOLUME = 'aiws-data-v21'"]]
]) {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const anchor of anchors) if (!source.includes(anchor)) errors.push(`${file}: missing ${anchor}`);
}

if (coverage.version !== '2.1' || coverage.product_version !== '2.1.0' || coverage.state_schema !== 21)
  errors.push('coverage header invalid');
for (let number = 1; number <= 14; number += 1)
  if (!coverage.work_packages?.[`DEV210-${String(number).padStart(2, '0')}`])
    errors.push(`coverage missing DEV210-${String(number).padStart(2, '0')}`);

if (errors.length) {
  console.error(`V2.1 plan validation failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('V2.1 plan validation passed (historical product 2.1.0, schema 21, Context Pack v5)');
