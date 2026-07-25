import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ASSIST_CAPABILITY_MANIFEST } from '../packages/shared/src/assist-capabilities.mjs';
import { collections } from '../apps/api/src/config.mjs';
import { versionAtLeast } from './legacy-baseline-policy.mjs';
import { ROOT, matchesAny, matchesGlob, normalizePath, readJson, runCommandSync, walk } from './v175-lib.mjs';

const errors = [],
  requiredFields = [
    'id',
    'layer',
    'domain',
    'priority',
    'command',
    'timeout',
    'dependencies',
    'cleanup',
    'external_effects',
    'quadrants',
    'covers',
    'suites'
  ];
const layers = new Set(Array.from({ length: 9 }, (_, index) => `L${index}`));
const priorities = new Set(['P0', 'P1', 'P2']),
  effects = new Set(['none', 'docker', 'codex', 'github', 'cc-switch']);
const suites = new Set(['pr', 'full', 'live', 'soak', 'release']),
  quadrants = ['normal', 'boundary', 'failure', 'recovery'];

let catalog, impact, groups;
try {
  catalog = readJson('tests/v175/catalog.json');
} catch (error) {
  errors.push(`catalog JSON invalid: ${error.message}`);
}
try {
  impact = readJson('tests/v175/impact-map.json');
} catch (error) {
  errors.push(`impact map JSON invalid: ${error.message}`);
}
try {
  groups = readJson('tests/v175/suite-files.json');
} catch (error) {
  errors.push(`suite files JSON invalid: ${error.message}`);
}

validateDocument();
validateDevelopmentPlan();
validateInfrastructureSyntax();
if (catalog) validateCatalog();
if (groups) validateGroups();
if (catalog && impact) validateImpactMap();
if (catalog) validateCoverage();

if (errors.length) {
  console.error(`V1.75 plan validation failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `V1.75 plan validation passed (${catalog.tests.length} cases, ${collections.length} collections, ${ASSIST_CAPABILITY_MANIFEST.filter((item) => item.mutation).length} write capabilities)`
);

function validateDocument() {
  const file = path.join(ROOT, '测试计划v1.75.md');
  if (!fs.existsSync(file)) return errors.push('测试计划v1.75.md is missing');
  const text = fs.readFileSync(file, 'utf8');
  for (const anchor of [
    'AIWS 测试计划 V1.75',
    '产品版本：`1.7.0`',
    'state schema：`16`',
    'tests/v175/catalog.json',
    'tests/v175/impact-map.json',
    'PASS / FAIL / BLOCKED / SKIPPED / FLAKY',
    '修复状态：未修复（按 V1.75 计划）',
    'pnpm test:v175:plan',
    'pnpm test:v175:impact',
    'pnpm test:v175:pr',
    'pnpm test:v175:full',
    'pnpm test:v175:user-journey',
    'pnpm test:v175:live',
    'pnpm test:v175:soak'
  ])
    if (!text.includes(anchor)) errors.push(`plan document missing anchor: ${anchor}`);
  for (const layer of layers) if (!text.includes(`${layer} `)) errors.push(`plan document missing layer ${layer}`);
  for (const quadrant of ['正常', '边界', '失败', '恢复'])
    if (!text.includes(quadrant)) errors.push(`plan document missing quadrant ${quadrant}`);
}

function validateDevelopmentPlan() {
  const file = path.join(ROOT, '开发计划v1.75.md');
  if (!fs.existsSync(file)) return errors.push('开发计划v1.75.md is missing after the first formal run');
  const text = fs.readFileSync(file, 'utf8');
  for (const anchor of [
    'AIWS 开发计划 V1.75',
    '产品版本：`1.7.0`',
    'state schema：`16`',
    'DEV175-01',
    'DEV175-02',
    'DEV175-03',
    'DEV175-04',
    'DEV175-05',
    '测试计划v1.75.md'
  ])
    if (!text.includes(anchor)) errors.push(`development plan missing anchor: ${anchor}`);
}

function validateInfrastructureSyntax() {
  const files = [
    ...walk('scripts').filter((file) => /^scripts\/v175-.*\.mjs$/.test(file)),
    ...walk('tests/v175').filter((file) => file.endsWith('.mjs'))
  ];
  for (const file of files) {
    const result = runCommandSync(['node', '--check', file]);
    if (result.status !== 0)
      errors.push(`syntax check failed for ${file}: ${(result.stderr || result.stdout).trim().split(/\r?\n/).at(-1)}`);
  }
}

function validateCatalog() {
  if (catalog.version !== '1.75') errors.push('catalog version must be 1.75');
  if (catalog.product_version !== '1.7.0') errors.push('catalog product_version must stay 1.7.0');
  if (catalog.state_schema !== 16) errors.push('catalog state_schema must stay 16');
  const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (!versionAtLeast(packageVersion, catalog.product_version))
    errors.push(`package version ${packageVersion} predates the V1.75 baseline ${catalog.product_version}`);
  const migration = fs.readFileSync(path.join(ROOT, 'apps/api/src/state-migration-v16.mjs'), 'utf8');
  if (!/STATE_SCHEMA_VERSION\s*=\s*16\b/.test(migration)) errors.push('state schema source is not 16');
  if (!Array.isArray(catalog.tests) || !catalog.tests.length) return errors.push('catalog tests must be non-empty');
  const ids = new Set(),
    domains = new Set();
  for (const item of catalog.tests) {
    for (const field of requiredFields)
      if (!Object.hasOwn(item, field)) errors.push(`${item.id || '<unknown>'} missing ${field}`);
    if (!/^V175-L[0-8]-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}$/.test(item.id || '')) errors.push(`invalid case id: ${item.id}`);
    if (ids.has(item.id)) errors.push(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    domains.add(item.domain);
    if (!layers.has(item.layer)) errors.push(`${item.id} invalid layer`);
    if (!priorities.has(item.priority)) errors.push(`${item.id} invalid priority`);
    if (!Array.isArray(item.command) || !item.command.length || !['node', 'pnpm', 'docker'].includes(item.command[0]))
      errors.push(`${item.id} command must be an argv array with an allowed executable`);
    if (!Number.isInteger(item.timeout) || item.timeout < 1000)
      errors.push(`${item.id} timeout must be positive milliseconds`);
    if (
      !Array.isArray(item.dependencies) ||
      !Array.isArray(item.cleanup) ||
      !Array.isArray(item.covers) ||
      !item.covers.length ||
      !Array.isArray(item.suites) ||
      !item.suites.length
    )
      errors.push(`${item.id} has invalid array fields`);
    if (!effects.has(item.external_effects)) errors.push(`${item.id} invalid external_effects`);
    for (const suite of item.suites || []) if (!suites.has(suite)) errors.push(`${item.id} invalid suite ${suite}`);
    for (const cleanup of item.cleanup || [])
      if (!Array.isArray(cleanup) || !cleanup.length) errors.push(`${item.id} cleanup entries must be argv arrays`);
    if (['P0', 'P1'].includes(item.priority) && !quadrants.every((value) => item.quadrants?.includes(value)))
      errors.push(`${item.id} must cover all four quadrants`);
    if (item.command?.[1] === 'scripts/v175-suite.mjs' && !groups?.[item.command[2]])
      errors.push(`${item.id} references unknown suite group ${item.command[2]}`);
  }
  for (const item of catalog.tests)
    for (const dependency of item.dependencies || []) {
      const target = catalog.tests.find((candidate) => candidate.id === dependency);
      if (!target) errors.push(`${item.id} has unknown dependency ${dependency}`);
      else if (Number(target.layer.slice(1)) > Number(item.layer.slice(1)))
        errors.push(`${item.id} depends on later layer ${dependency}`);
    }
  for (const layer of layers)
    if (!catalog.tests.some((item) => item.layer === layer)) errors.push(`catalog missing ${layer}`);
  for (const domain of [
    'governance',
    'static',
    'state',
    'runtime',
    'setup',
    'onboard',
    'assist',
    'action',
    'workflow',
    'change',
    'files',
    'git',
    'diagnostics',
    'web',
    'e2e',
    'release',
    'live-codex',
    'live-github',
    'live-cc-switch',
    'soak'
  ])
    if (!domains.has(domain)) errors.push(`catalog missing domain ${domain}`);
}

function validateGroups() {
  const seen = new Map();
  for (const [group, files] of Object.entries(groups)) {
    if (!Array.isArray(files) || !files.length) errors.push(`suite group ${group} must be non-empty`);
    for (const file of files || []) {
      if (!fs.existsSync(path.join(ROOT, file))) errors.push(`suite group ${group} missing file ${file}`);
      if (seen.has(file)) errors.push(`suite file ${file} duplicated in ${seen.get(file)} and ${group}`);
      else seen.set(file, group);
    }
  }
  const expected = [
    ...walk('tests/unit').filter((file) => file.endsWith('.test.mjs')),
    ...walk('tests/integration').filter((file) => file.endsWith('.test.mjs') && !file.endsWith('-live.test.mjs'))
  ];
  for (const file of expected)
    if (!seen.has(file)) errors.push(`deterministic test is absent from suite-files.json: ${file}`);
  for (const file of [...expected, ...walk('tests/e2e').filter((item) => item.endsWith('.mjs'))]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (source.includes('.ai-workspace') && !source.includes('AIWS_TEST_REPORT_DIR'))
      errors.push(`deterministic test writes the active workspace without report redirection: ${file}`);
  }
}

function validateImpactMap() {
  if (impact.version !== '1.75' || impact.match_mode !== 'first' || !Array.isArray(impact.mappings))
    errors.push('impact map header is invalid');
  const domains = new Set(catalog.tests.map((item) => item.domain));
  for (const [index, mapping] of (impact.mappings || []).entries()) {
    if (
      !Array.isArray(mapping.patterns) ||
      !mapping.patterns.length ||
      !Array.isArray(mapping.domains) ||
      !mapping.domains.length ||
      !priorities.has(mapping.priority)
    )
      errors.push(`impact mapping ${index} is invalid`);
    for (const domain of mapping.domains || [])
      if (!domains.has(domain)) errors.push(`impact mapping ${index} references missing domain ${domain}`);
  }
  const business = [
    ...(impact.business_roots || []).flatMap(walk),
    ...(impact.business_files || []).filter((file) => fs.existsSync(path.join(ROOT, file)))
  ].filter((file) => !matchesAny(file, impact.exclude || []));
  for (const file of business)
    if (!(impact.mappings || []).some((mapping) => matchesAny(file, mapping.patterns)))
      errors.push(`unclassified business file: ${file}`);
}

function validateCoverage() {
  const covered = (token) => catalog.tests.some((item) => item.covers.some((pattern) => matchesGlob(token, pattern)));
  const routes = walk('apps/api/src/routes').filter((file) => file.endsWith('.mjs'));
  for (const file of routes) if (!covered(file)) errors.push(`unmapped API route module: ${file}`);
  const runtime = walk('apps/api/src').filter(
    (file) =>
      /(?:codex|container-runtime|terminal|host-bridge|assist[^/]*runtime|handlers\/runners)\b/.test(file) &&
      file.endsWith('.mjs')
  );
  for (const file of runtime) if (!covered(file)) errors.push(`unmapped runtime module: ${file}`);
  for (const capability of ASSIST_CAPABILITY_MANIFEST.filter((item) => item.mutation))
    if (!covered(`capability:${capability.id}`)) errors.push(`unmapped write capability: ${capability.id}`);
  for (const collection of collections)
    if (!covered(`collection:${collection}`)) errors.push(`unmapped state collection: ${collection}`);
  let writeRoutes = 0;
  for (const file of routes) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    writeRoutes += [...source.matchAll(/makeRoute\(\s*['"](?:POST|PUT|PATCH|DELETE)['"]\s*,\s*['"][^'"]+['"]/g)].length;
  }
  if (!writeRoutes) errors.push('no API write routes were discovered');
  else if (!routes.every(covered)) errors.push('API write route mapping is incomplete');
}
