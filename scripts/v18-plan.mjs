import fs from 'node:fs';
import path from 'node:path';
import { collections } from '../apps/api/src/config.mjs';
import { missingBaselineItems, versionAtLeast } from './legacy-baseline-policy.mjs';

const ROOT = process.cwd();
const errors = [];
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const readText = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let catalog, coverage, impact, routeBaseline, suites;
const loaded = {};
for (const [name, file] of Object.entries({ catalog: 'tests/v18/catalog.json', coverage: 'tests/v18/coverage-map.json', impact: 'tests/v18/impact-map.json', routeBaseline: 'tests/v18/route-baseline.json', suites: 'tests/v18/suites.json' })) {
  try { loaded[name] = readJson(file); }
  catch (error) { errors.push(`${file}: ${error.message}`); }
}
({ catalog, coverage, impact, routeBaseline, suites } = loaded);

validateDocument('开发计划v1.8.md', ['AIWS 开发计划 V1.8', '产品版本：`1.8.0`', 'state schema：`17`', 'DEV180-01', 'DEV180-05', 'pnpm test:v18:plan']);
validateDocument('测试计划v1.8.md', ['AIWS 测试计划 V1.8', '214 个 HTTP', 'PASS / FAIL / BLOCKED / SKIPPED / FLAKY', 'test:v18:mcp-journey', '120 分钟', 'V1.75 报告目录只读']);
validateCatalog();
validateCoverage();
validateImpact();
validateSuites();
validatePackageCommand();

if (errors.length) {
  console.error(`V1.8 plan validation failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log(`V1.8 plan validation passed (${catalog.tests.length} cases, ${coverage.expected_legacy_http_routes} legacy/${coverage.expected_http_routes} total HTTP routes, ${coverage.state_collections.length} schema 17 collections)`);

function validateDocument(file, anchors) {
  if (!fs.existsSync(path.join(ROOT, file))) return errors.push(`${file}: missing`);
  const source = readText(file);
  for (const anchor of anchors) if (!source.includes(anchor)) errors.push(`${file}: missing anchor ${anchor}`);
}

function validateCatalog() {
  if (!catalog) return;
  if (catalog.version !== '1.8' || catalog.product_version !== '1.8.0' || catalog.state_schema !== 17 || catalog.sdk_version !== '1.29.0') errors.push('catalog header must pin V1.8.0/schema 17/SDK 1.29.0');
  const packageVersion = readJson('package.json').version;
  if (!versionAtLeast(packageVersion, catalog.product_version)) errors.push(`package version ${packageVersion} predates the V1.8 baseline ${catalog.product_version}`);
  if (catalog.budgets_ms?.pr !== 900000 || catalog.budgets_ms?.full !== 5400000 || catalog.budgets_ms?.soak !== 7200000) errors.push('catalog budgets must be 15m/90m/120m');
  const ids = new Set(), layers = new Set();
  for (const item of catalog.tests || []) {
    if (!/^V18-L[0-8]-[A-Z0-9]+-\d{3}$/.test(item.id || '')) errors.push(`invalid test id ${item.id}`);
    if (ids.has(item.id)) errors.push(`duplicate test id ${item.id}`);
    ids.add(item.id); layers.add(item.layer);
    for (const key of ['domain', 'priority', 'command', 'suites', 'covers']) if (!item[key] || (Array.isArray(item[key]) && !item[key].length)) errors.push(`${item.id}: missing ${key}`);
    const commandFile = item.command?.[0] === 'node' ? item.command[1] : null;
    if (commandFile && !fs.existsSync(path.join(ROOT, commandFile))) errors.push(`${item.id}: command file missing ${commandFile}`);
  }
  for (let index = 0; index <= 8; index += 1) if (!layers.has(`L${index}`)) errors.push(`catalog missing L${index}`);
}

function validateCoverage() {
  if (!coverage || !routeBaseline) return;
  const routeDir = path.join(ROOT, 'apps/api/src/routes');
  const modules = fs.readdirSync(routeDir).filter((item) => item.endsWith('.mjs')).sort();
  const discovered = modules.flatMap((file) => [...readText(`apps/api/src/routes/${file}`).matchAll(/makeRoute\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*['"]([^'"]+)['"]/g)].map((match) => `${match[1]} ${match[2]}`));
  const baselineRoutes = routeBaseline.routes || [], v18Routes = routeBaseline.v18_routes || [];
  const expectedV18Routes = coverage.expected_http_routes - coverage.expected_legacy_http_routes;
  if (coverage.route_baseline_file !== 'tests/v18/route-baseline.json' || routeBaseline.version !== '1.8') errors.push('V1.8 route baseline metadata is invalid');
  if (baselineRoutes.length !== coverage.expected_http_routes || new Set(baselineRoutes).size !== baselineRoutes.length) errors.push(`route baseline must freeze ${coverage.expected_http_routes} unique HTTP routes`);
  for (const route of baselineRoutes) if (!/^(?:GET|POST|PUT|PATCH|DELETE) \/\S+$/.test(route)) errors.push(`invalid V1.8 baseline route: ${route}`);
  if (v18Routes.length !== expectedV18Routes || new Set(v18Routes).size !== v18Routes.length || missingBaselineItems(baselineRoutes, v18Routes).length) errors.push(`route baseline must identify ${expectedV18Routes} unique V1.8 routes`);
  const missingRoutes = missingBaselineItems(discovered, baselineRoutes);
  if (missingRoutes.length) errors.push(`V1.8 baseline routes are missing: ${missingRoutes.join(', ')}`);
  for (const value of ['tool', 'resource', 'async_adapter', 'external_callback', 'frontend_only']) if (!coverage.mappings?.includes(value)) errors.push(`coverage-map missing mapping ${value}`);
  for (const tool of ['aiws_system', 'aiws_projects', 'aiws_workflow', 'aiws_assist', 'aiws_runs', 'aiws_files', 'aiws_terminal', 'aiws_git', 'aiws_github', 'aiws_assets', 'aiws_governance', 'aiws_admin', 'aiws_capabilities', 'aiws_operations', 'aiws_execute']) if (!coverage.tools?.includes(tool)) errors.push(`coverage-map missing tool ${tool}`);
  const missingCollections = missingBaselineItems(collections, coverage.state_collections || []);
  if (missingCollections.length) errors.push(`schema 17 baseline collections are missing: ${missingCollections.join(', ')}`);
  if (coverage.websockets?.length !== 2) errors.push('coverage-map must classify both WebSocket endpoints');
}

function validateImpact() {
  if (!impact) return;
  if (impact.version !== '1.8' || impact.match_mode !== 'all' || !impact.mappings?.length) errors.push('impact-map header is invalid');
  for (const [index, item] of (impact.mappings || []).entries()) if (!item.patterns?.length || !item.suites?.length) errors.push(`impact-map mapping ${index} is incomplete`);
}

function validateSuites() {
  if (!suites) return;
  for (const name of ['pr', 'full', 'live', 'release', 'soak']) if (!Array.isArray(suites[name]) || !suites[name].length) errors.push(`suites.json missing ${name}`);
}

function validatePackageCommand() {
  const manifest = readJson('package.json');
  if (manifest.scripts?.['test:v18:plan'] !== 'node scripts/v18-plan.mjs') errors.push('package.json must expose test:v18:plan');
}
