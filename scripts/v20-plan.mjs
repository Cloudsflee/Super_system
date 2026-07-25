#!/usr/bin/env node
import fs from 'node:fs';

import { CONTEXT_EDGE_TYPES } from '../packages/system-context/src/index.mjs';
import { readJson } from './v175-lib.mjs';
import { validateV20Catalog } from './v20-catalog.mjs';

const errors = [...validateV20Catalog().errors];
const manifest = readJson('package.json');
const coverage = readJson('tests/v20/coverage-map.json');
const impact = readJson('tests/v20/impact-map.json');

if (manifest.version !== '2.0.0') errors.push('package.json version must be 2.0.0');
if (!String(manifest.description || '').includes('V2.0')) errors.push('package description must identify V2.0');
for (const [name, expected] of Object.entries({
  'test:v20:plan': 'scripts/v20-plan.mjs',
  'test:v20:catalog': 'scripts/v20-catalog.mjs',
  'test:v20:coverage': 'scripts/v20-coverage.mjs',
  'test:v20:impact': 'scripts/v20-impact.mjs',
  'test:v20:pr': 'scripts/v20-runner.mjs pr',
  'test:v20:full': 'scripts/v20-runner.mjs full',
  'test:v20:release': 'scripts/v20-runner.mjs release'
}))
  if (!String(manifest.scripts?.[name] || '').includes(expected))
    errors.push(`package script ${name} must use ${expected}`);

for (const file of [
  '开发计划v2.0.md',
  '测试计划v2.0.md',
  'docs/v2.0-code-audit.md',
  'packages/system-context/src/index.mjs',
  'packages/system-context/src/protocol.mjs',
  'packages/system-context/src/search-index.mjs',
  'apps/api/src/state-migration-v20.mjs',
  'apps/api/src/context-projection.mjs',
  'apps/api/src/context-resource-adapters.mjs',
  'apps/api/src/context-service.mjs',
  'apps/api/src/routes/context-v20.mjs',
  'apps/web/src/features/context/ContextMapPage.tsx',
  'docker/release-volume-v20.mjs',
  'tests/e2e/v20-context-map-browser.test.mjs',
  'scripts/v20-catalog.mjs',
  'scripts/v20-coverage.mjs',
  'scripts/v20-impact.mjs',
  'scripts/v20-suite.mjs',
  'scripts/v20-runner.mjs'
])
  if (!fs.existsSync(file)) errors.push(`missing V2.0 implementation file: ${file}`);

for (const [file, anchors] of [
  [
    '开发计划v2.0.md',
    [
      '# AIWS 开发计划 V2.0',
      '产品版本：`2.0.0`',
      'state schema：`20`',
      'aiws.system-context.v1',
      'aiws.context_pack.v4',
      'DEV200-11 旧代码与兼容层审计'
    ]
  ],
  [
    '测试计划v2.0.md',
    [
      '# AIWS 测试计划 V2.0',
      '产品版本：`2.0.0`',
      'state schema：`20`',
      'pnpm test:v20:plan',
      'pnpm verify',
      '10,000 节点'
    ]
  ],
  [
    'docs/v2.0-code-audit.md',
    ['# V2.0 旧代码与兼容层审计', 'mcp-live-project-resume.mjs', 'AIWS_VERSION', '@aiws/system-context']
  ]
]) {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const anchor of anchors) if (!source.includes(anchor)) errors.push(`${file}: missing ${anchor}`);
}

for (const [file, anchors] of [
  ['apps/api/src/state-migration-v20.mjs', ['STATE_SCHEMA_VERSION = 20', 'migrateState19To20']],
  ['apps/api/src/routes/context-v20.mjs', ['/context/v1/map', '/context/v1/selections', '/context/v1/rebuild']],
  ['apps/api/src/mcp-server-factory.mjs', ['aiws_context', 'aiws://context/map/{scope}', 'explain_selection']],
  ['apps/web/src/app/router.tsx', ["path: '/context'", "path: '/projects/:projectId/context'"]],
  ['compose.yml', ['name: aiws-v20', 'aiws-app:2.0.0', 'aiws-data-v20']],
  ['packages/shared/src/version.mjs', ["AIWS_VERSION = '2.0.0'", 'AIWS_STATE_SCHEMA_VERSION = 20']]
]) {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const anchor of anchors) if (!source.includes(anchor)) errors.push(`${file}: missing ${anchor}`);
}

if (coverage.version !== '2.0' || coverage.product_version !== '2.0.0' || coverage.state_schema !== 20)
  errors.push('coverage header invalid');
if (!sameSet(coverage.edge_types, CONTEXT_EDGE_TYPES)) errors.push('coverage edge types differ from protocol');
for (const viewport of [2560, 1920, 1440, 1024, 768, 390])
  if (!coverage.viewports.includes(viewport)) errors.push(`coverage viewport missing: ${viewport}`);
if (impact.version !== '2.0' || impact.match_mode !== 'all' || !impact.mappings?.length)
  errors.push('impact map header invalid');

if (errors.length) {
  console.error(`V2.0 plan validation failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('V2.0 plan validation passed (schema 20, context protocol v1, Context Pack v4)');

function sameSet(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}
