import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  FROZEN_SURFACES,
  LEGACY_SQL_BOUNDARIES,
  MODULE_REGISTRY,
  PLACEHOLDER_SUCCESS_PATTERNS,
  SQL_BOUNDARY_SUFFIXES,
  ownerOf
} from '../apps/api/src/modules/registry.mjs';

const root = process.cwd();
const command = process.argv[2];
const audit = process.argv.includes('--audit');
const allowedCommands = new Set(['plan', 'catalog', 'coverage', 'impact']);
const STATUS_FLOW = ['planned', 'scaffolded', 'implemented', 'verified', 'released'];
const failures = [];

if (!allowedCommands.has(command)) fail(`unknown recovery governance command: ${command || '<empty>'}`);

const catalogPath = path.join(root, 'feature-catalog.json');
const catalog = readJson(catalogPath);
const features = catalog.features;
const ids = new Set();
const modules = new Map(MODULE_REGISTRY.map((module) => [module.id, module]));

validateCatalogShape();
validateModuleRegistry();

let result;
if (command === 'plan') result = checkPlan();
if (command === 'catalog') result = checkCatalog();
if (command === 'coverage') result = checkCoverage();
if (command === 'impact') result = checkImpact();

if (failures.length) fail(failures.join('\n'));

const receipt = {
  schema_version: 'aiws.v3.recovery_governance_receipt.v2',
  command,
  status: 'passed',
  created_at: new Date().toISOString(),
  catalog_sha256: sha256(fs.readFileSync(catalogPath)),
  result
};
const receiptDirectory = path.join(root, '.ai-workspace', 'recovery');
fs.mkdirSync(receiptDirectory, { recursive: true });
const receiptPath = path.join(receiptDirectory, `${command}.json`);
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...result, receipt: relative(receiptPath) }, null, 2)}\n`);

function validateCatalogShape() {
  if (catalog.schema_version !== 'aiws.v3.feature_catalog.v2') failures.push('catalog schema_version must be aiws.v3.feature_catalog.v2');
  if (catalog.product_version !== '3.0.0') failures.push('catalog product_version must be 3.0.0');
  if (JSON.stringify(catalog.status_flow) !== JSON.stringify(STATUS_FLOW)) failures.push('catalog status_flow must use the five ordered recovery states');
  if (!Array.isArray(features) || features.length === 0) {
    failures.push('catalog contains no features');
    return;
  }
  for (const feature of features) {
    for (const field of ['id', 'domain', 'name', 'status']) {
      if (typeof feature[field] !== 'string' || !feature[field]) failures.push(`${feature.id || '<unknown>'}: missing ${field}`);
    }
    for (const field of [
      'owner_modules', 'source_files', 'target_modules', 'tables', 'apis', 'ui', 'events',
      'behavior_tests', 'ui_tests', 'evidence', 'release_receipts', 'tests'
    ]) {
      if (!Array.isArray(feature[field])) failures.push(`${feature.id || '<unknown>'}: ${field} must be an array`);
    }
    if (ids.has(feature.id)) failures.push(`duplicate feature id: ${feature.id}`);
    ids.add(feature.id);
    if (!STATUS_FLOW.includes(feature.status)) failures.push(`${feature.id}: invalid status ${feature.status}`);
    if (!/^REC-D\d+-[A-Z]+-\d{3}$/.test(feature.id)) failures.push(`${feature.id}: invalid feature id`);
    for (const moduleId of feature.owner_modules || []) {
      if (!modules.has(moduleId)) failures.push(`${feature.id}: unknown owner module ${moduleId}`);
    }
    for (const table of feature.tables || []) {
      const owner = ownerOf('table', table);
      if (!owner) failures.push(`${feature.id}: table has no registered owner: ${table}`);
      else if (!feature.owner_modules.includes(owner)) failures.push(`${feature.id}: table ${table} is owned by ${owner}, which is not a feature owner`);
    }
    for (const event of feature.events || []) {
      const owner = ownerOf('event', event);
      if (!owner) failures.push(`${feature.id}: event has no registered owner: ${event}`);
      else if (!feature.owner_modules.includes(owner)) failures.push(`${feature.id}: event ${event} is owned by ${owner}, which is not a feature owner`);
    }
  }
}

function validateModuleRegistry() {
  const idsSeen = new Set();
  const owned = { tables: new Map(), commands: new Map(), events: new Map() };
  for (const module of MODULE_REGISTRY) {
    if (!/^[a-z][a-z0-9_]*$/.test(module.id) || idsSeen.has(module.id)) failures.push(`invalid or duplicate module id: ${module.id}`);
    idsSeen.add(module.id);
    for (const dependency of module.dependencies) {
      if (!modules.has(dependency)) failures.push(`${module.id}: unknown dependency ${dependency}`);
      if (dependency === module.id) failures.push(`${module.id}: module depends on itself`);
    }
    for (const field of ['tables', 'commands', 'events']) {
      for (const value of module[field]) {
        const previous = owned[field].get(value);
        if (previous) failures.push(`${field.slice(0, -1)} ${value} is owned by both ${previous} and ${module.id}`);
        owned[field].set(value, module.id);
      }
    }
    const modulePath = path.join(root, 'apps', 'api', 'src', 'modules', module.id, 'index.mjs');
    if (!fs.existsSync(modulePath)) failures.push(`${module.id}: module entrypoint is missing`);
  }
  detectDependencyCycles();
  validateModuleImports();
}

function checkPlan() {
  const documents = ['docs/开发计划v3功能恢复.md', 'docs/测试计划v3功能恢复.md'];
  for (const document of documents) {
    const full = path.join(root, document);
    if (!fs.existsSync(full) || fs.statSync(full).size < 1000) failures.push(`missing or incomplete plan: ${document}`);
  }
  const developmentPlan = fs.existsSync(path.join(root, documents[0])) ? fs.readFileSync(path.join(root, documents[0]), 'utf8') : '';
  for (const release of Array.from({ length: 10 }, (_, index) => `R${index}`)) {
    if (!developmentPlan.includes(release)) failures.push(`development plan is missing ${release}`);
  }
  const requiredDomains = [
    'identity', 'setup', 'runner', 'mcp', 'project', 'workflow', 'execution', 'outcome',
    'assist', 'terminal', 'bridge', 'repository', 'delivery', 'context', 'evidence',
    'quality', 'operations'
  ];
  const domains = new Set((features || []).map((feature) => feature.domain));
  for (const domain of requiredDomains) if (!domains.has(domain)) failures.push(`plan domain is not cataloged: ${domain}`);
  const terminal = features?.find((feature) => feature.id === 'REC-D8-TERMINAL-025');
  const bridge = features?.find((feature) => feature.id === 'REC-D8-BRIDGE-026');
  if (!terminal || !bridge || terminal.name.includes('Bridge') || terminal.tables.some((table) => table.startsWith('bridge_'))) {
    failures.push('Terminal and Windows Bridge must be separate catalog features');
  }
  return { documents, domains: [...domains].sort(), feature_count: features?.length || 0, phases: 10 };
}

function checkCatalog() {
  validateStatusEvidence();
  validateRuntimeOwnership();
  validateFrozenSurfaces();
  validateSqlBoundaries();
  validatePlaceholderSuccess();
  validateLegacyRuntime();
  const statuses = Object.fromEntries(STATUS_FLOW.map((status) => [status, features.filter((feature) => feature.status === status).length]));
  return {
    feature_count: features?.length || 0,
    statuses,
    module_count: MODULE_REGISTRY.length,
    owned_tables: MODULE_REGISTRY.reduce((count, module) => count + module.tables.length, 0),
    owned_commands: MODULE_REGISTRY.reduce((count, module) => count + module.commands.length, 0),
    unique_ids: ids.size
  };
}

function checkCoverage() {
  const byGate = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`T${index}`, 0]));
  for (const feature of features || []) {
    if (!feature.tests?.length) failures.push(`${feature.id}: no mapped tests`);
    const gates = feature.tests.filter((entry) => /^T[0-8]$/.test(entry));
    if (!gates.length) failures.push(`${feature.id}: no T0-T8 gate`);
    for (const gate of gates) byGate[gate] += 1;
    for (const testPath of allConcreteTests(feature)) {
      if (!fs.existsSync(path.join(root, testPath))) failures.push(`${feature.id}: mapped test does not exist: ${testPath}`);
    }
    if (rank(feature.status) >= rank('implemented')) {
      if (!feature.behavior_tests.length) failures.push(`${feature.id}: implemented feature has no behavior test`);
      if (feature.ui.length && !feature.ui_tests.length) failures.push(`${feature.id}: implemented UI feature has no UI test`);
    }
  }
  return {
    feature_count: features?.length || 0,
    covered_features: features.filter((feature) => feature.tests?.length).length,
    behavior_covered: features.filter((feature) => feature.behavior_tests?.length).length,
    ui_covered: features.filter((feature) => !feature.ui?.length || feature.ui_tests?.length).length,
    gates: byGate
  };
}

function checkImpact() {
  const changed = changedFiles();
  const mappings = [];
  const unmapped = [];
  const governance = /^(?:feature-catalog\.json|package\.json|docs\/|V3功能恢复与架构治理判断\.md|scripts\/(?:recovery-governance|recovery-evidence)\.mjs|apps\/api\/src\/(?:schema|db-worker|migration-service)\.mjs|apps\/api\/src\/(?:migrations|modules)\/(?:index|registry|define-module)\.mjs)/;
  for (const file of [...changed].sort()) {
    const matched = features.filter((feature) => featurePaths(feature).some((target) => {
      const normalized = normalize(target);
      return file === normalized || file.startsWith(`${normalized}/`) || normalized.startsWith(`${file}/`);
    })).map((feature) => feature.id);
    if (!matched.length && !governance.test(file)) unmapped.push(file);
    mappings.push({ file, features: matched });
  }
  if (audit && unmapped.length) failures.push(`unmapped changed files: ${unmapped.join(', ')}`);
  const selectedTests = [...new Set(mappings
    .flatMap((mapping) => mapping.features)
    .flatMap((featureId) => features.find((feature) => feature.id === featureId)?.tests || []))].sort();
  return { audit, changed_files: mappings, unmapped_files: unmapped, selected_tests: selectedTests };
}

function validateStatusEvidence() {
  for (const feature of features) {
    const featureRank = rank(feature.status);
    if (featureRank >= rank('scaffolded') && !feature.target_modules.some((target) => fs.existsSync(path.join(root, target)))) {
      failures.push(`${feature.id}: scaffolded feature has no existing target module`);
    }
    if (featureRank < rank('implemented')) continue;
    if (!feature.behavior_tests.length) failures.push(`${feature.id}: implemented feature has no behavior tests`);
    if (feature.ui.length && !feature.ui_tests.length) failures.push(`${feature.id}: implemented UI feature has no UI tests`);
    if (!feature.evidence.length) failures.push(`${feature.id}: implemented feature has no evidence`);
    for (const testPath of [...feature.behavior_tests, ...feature.ui_tests]) requirePath(feature.id, testPath, 'test');
    for (const evidencePath of feature.evidence) validateEvidence(feature, evidencePath, featureRank >= rank('verified'));
    if (featureRank >= rank('released')) {
      if (!feature.release_receipts.length) failures.push(`${feature.id}: released feature has no release receipt`);
      for (const receiptPath of feature.release_receipts) validateReleaseReceipt(feature, receiptPath);
    }
  }
}

function validateEvidence(feature, evidencePath, requirePassed) {
  const full = requirePath(feature.id, evidencePath, 'evidence');
  if (!full) return;
  let evidence;
  try { evidence = readJson(full); } catch { return; }
  const tests = evidence.tests || evidence.commands || [];
  const failed = tests.filter((entry) => Number(entry.exit_status ?? entry.exit_code ?? 1) !== 0);
  if (requirePassed && (evidence.status === 'failed' || failed.length || !tests.length)) {
    failures.push(`${feature.id}: verification evidence is not passed: ${evidencePath}`);
  }
  if (evidence.schema_version === 'aiws.v3.recovery_evidence_manifest.v1') {
    if (!evidence.diff || !fs.existsSync(path.join(root, evidence.diff))) failures.push(`${feature.id}: evidence diff is missing: ${evidencePath}`);
    const rollback = evidence.rollback?.script;
    if (!rollback || !fs.existsSync(path.join(root, rollback))) failures.push(`${feature.id}: evidence rollback is missing: ${evidencePath}`);
  }
  if (evidence.schema_version === 'aiws.v3.recovery_verification.v1') {
    for (const role of ['modified_artifact', 'patch', 'rollback']) {
      const rolePath = evidence.artifacts?.[role];
      if (!rolePath || !fs.existsSync(path.join(root, rolePath))) failures.push(`${feature.id}: verification role ${role} is missing`);
    }
  }
}

function validateReleaseReceipt(feature, receiptPath) {
  const full = requirePath(feature.id, receiptPath, 'release receipt');
  if (!full) return;
  const receipt = readJson(full);
  if (!['passed', 'released', 'promoted'].includes(receipt.status)) failures.push(`${feature.id}: release receipt is not passed: ${receiptPath}`);
}

function validateRuntimeOwnership() {
  const schemaSources = [
    fs.readFileSync(path.join(root, 'apps/api/src/schema.mjs'), 'utf8'),
    ...walk(path.join(root, 'apps/api/src/migrations'))
      .filter((file) => file.endsWith('.mjs'))
      .map((file) => fs.readFileSync(file, 'utf8'))
  ];
  const schemaTables = new Set(schemaSources.flatMap((source) =>
    [...source.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/g)].map((match) => match[1])));
  schemaTables.add('schema_migrations');
  const registeredTables = new Set(MODULE_REGISTRY.flatMap((module) => module.tables));
  for (const table of schemaTables) if (!registeredTables.has(table)) failures.push(`schema table has no module owner: ${table}`);
  for (const table of registeredTables) if (!schemaTables.has(table)) failures.push(`registered table is absent from schema or migration infrastructure: ${table}`);

  const commandSources = [
    fs.readFileSync(path.join(root, 'apps/api/src/command-registry.mjs'), 'utf8'),
    fs.readFileSync(path.join(root, 'apps/api/src/modules/r2-runtime.mjs'), 'utf8')
  ];
  const runtimeCommands = new Set(commandSources.flatMap((source) => {
    const commandMap = /const commands = new Map\(\[([\s\S]*?)\]\);/.exec(source)?.[1] || '';
    return [...commandMap.matchAll(/\['([^']+)',\s*\(/g)].map((match) => match[1]);
  }));
  const registeredCommands = new Set(MODULE_REGISTRY.flatMap((module) => module.commands));
  for (const runtimeCommand of runtimeCommands) if (!registeredCommands.has(runtimeCommand)) failures.push(`runtime command has no module owner: ${runtimeCommand}`);
  for (const registeredCommand of registeredCommands) if (!runtimeCommands.has(registeredCommand)) failures.push(`registered command has no runtime handler: ${registeredCommand}`);
}

function validateFrozenSurfaces() {
  for (const surface of FROZEN_SURFACES) {
    const lines = lineCount(path.join(root, surface.path));
    if (lines > surface.max_lines) failures.push(`frozen surface grew: ${surface.path} (${lines} > ${surface.max_lines})`);
  }
}

function validateSqlBoundaries() {
  const frozen = new Map(LEGACY_SQL_BOUNDARIES.map((entry) => [normalize(entry.path), entry.max_statements]));
  for (const file of walk(path.join(root, 'apps', 'api', 'src')).filter((entry) => entry.endsWith('.mjs'))) {
    const relativePath = relative(file);
    const source = fs.readFileSync(file, 'utf8');
    const statements = sqlStatementCount(source);
    if (!statements) continue;
    if (frozen.has(relativePath)) {
      if (statements > frozen.get(relativePath)) failures.push(`legacy SQL boundary grew: ${relativePath} (${statements} > ${frozen.get(relativePath)})`);
      continue;
    }
    if (!SQL_BOUNDARY_SUFFIXES.some((suffix) => suffix.endsWith('/')
      ? `/${relativePath}/`.includes(suffix)
      : `/${relativePath}`.endsWith(suffix))) {
      failures.push(`raw SQL outside repository or migration boundary: ${relativePath}`);
      continue;
    }
    const moduleMatch = relativePath.match(/^apps\/api\/src\/modules\/([^/]+)\//);
    if (!moduleMatch) continue;
    const moduleId = moduleMatch[1];
    for (const table of sqlTableReferences(source)) {
      const owner = ownerOf('table', table);
      if (owner && owner !== moduleId) failures.push(`${relativePath}: cross-domain SQL for ${table}, owned by ${owner}`);
    }
  }
}

function validatePlaceholderSuccess() {
  const files = walk(path.join(root, 'apps')).filter((file) => /\.(?:mjs|js|ts|tsx)$/.test(file) && !file.endsWith(`${path.sep}modules${path.sep}registry.mjs`));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const check of PLACEHOLDER_SUCCESS_PATTERNS) {
      check.pattern.lastIndex = 0;
      if (check.pattern.test(source)) failures.push(`placeholder success ${check.id}: ${relative(file)}`);
    }
  }
}

function validateLegacyRuntime() {
  const forbiddenDirectories = ['apps/worker', 'apps/mcp-gateway', 'prisma'];
  for (const directory of forbiddenDirectories) if (fs.existsSync(path.join(root, directory))) failures.push(`legacy runtime directory exists: ${directory}`);
  const runtimeFiles = ['apps', 'packages'].flatMap((directory) => walk(path.join(root, directory))).filter((file) => /\.(?:mjs|js|ts|tsx)$/.test(file));
  for (const file of runtimeFiles) {
    const relativePath = relative(file);
    const basename = path.basename(file);
    const source = fs.readFileSync(file, 'utf8');
    if (/v(?:12|13|14|15|16|17|175|18|19|20|21|22|23)/i.test(basename)) failures.push(`versioned runtime filename: ${relativePath}`);
    if (/\/api\/v(?:2|12|13|14|15|16|17|18|19|20|21|22|23)(?:\/|\b)/i.test(source)) failures.push(`legacy API route: ${relativePath}`);
    if (/state-migration-v\d+|global state snapshot/i.test(source)) failures.push(`legacy state runtime reference: ${relativePath}`);
  }
}

function detectDependencyCycles() {
  const visiting = new Set();
  const visited = new Set();
  const visit = (moduleId, trail) => {
    if (visiting.has(moduleId)) {
      failures.push(`module dependency cycle: ${[...trail, moduleId].join(' -> ')}`);
      return;
    }
    if (visited.has(moduleId)) return;
    visiting.add(moduleId);
    for (const dependency of modules.get(moduleId)?.dependencies || []) visit(dependency, [...trail, moduleId]);
    visiting.delete(moduleId);
    visited.add(moduleId);
  };
  for (const moduleId of modules.keys()) visit(moduleId, []);
}

function validateModuleImports() {
  const graph = new Map(MODULE_REGISTRY.map((module) => [module.id, new Set()]));
  const modulesRoot = path.join(root, 'apps', 'api', 'src', 'modules');
  for (const module of MODULE_REGISTRY) {
    const directory = path.join(modulesRoot, module.id);
    for (const file of walk(directory).filter((entry) => entry.endsWith('.mjs'))) {
      const source = fs.readFileSync(file, 'utf8');
      const specifiers = [
        ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
        ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
      ].map((match) => match[1]).filter((specifier) => specifier.startsWith('.'));
      for (const specifier of specifiers) {
        const resolved = normalize(path.resolve(path.dirname(file), specifier));
        const marker = `${normalize(modulesRoot)}/`;
        if (!resolved.startsWith(marker)) continue;
        const target = resolved.slice(marker.length).split('/')[0];
        if (!modules.has(target) || target === module.id) continue;
        graph.get(module.id).add(target);
        if (!module.dependencies.includes(target)) failures.push(`${relative(file)}: undeclared module dependency ${module.id} -> ${target}`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (moduleId, trail) => {
    if (visiting.has(moduleId)) {
      failures.push(`module import cycle: ${[...trail, moduleId].join(' -> ')}`);
      return;
    }
    if (visited.has(moduleId)) return;
    visiting.add(moduleId);
    for (const dependency of graph.get(moduleId) || []) visit(dependency, [...trail, moduleId]);
    visiting.delete(moduleId);
    visited.add(moduleId);
  };
  for (const moduleId of graph.keys()) visit(moduleId, []);
}

function changedFiles() {
  const changed = new Set();
  for (const args of [['diff', '--name-only'], ['diff', '--cached', '--name-only']]) {
    const run = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (run.status !== 0) failures.push(`git ${args.join(' ')} failed: ${run.stderr.trim()}`);
    for (const file of run.stdout.split(/\r?\n/).filter(Boolean)) changed.add(normalize(file));
  }
  const untracked = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (untracked.status !== 0) failures.push(`git ls-files failed: ${untracked.stderr.trim()}`);
  for (const file of untracked.stdout.split(/\r?\n/).filter(Boolean)) changed.add(normalize(file));
  return changed;
}

function featurePaths(feature) {
  return [
    ...feature.target_modules, ...feature.behavior_tests, ...feature.ui_tests,
    ...feature.evidence, ...feature.release_receipts
  ];
}

function allConcreteTests(feature) {
  return [...new Set([
    ...feature.tests.filter((entry) => entry.includes('/')),
    ...feature.behavior_tests,
    ...feature.ui_tests
  ])];
}

function sqlStatementCount(source) {
  return (source.match(/(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[A-Za-z_(]/gi) || []).length;
}

function sqlTableReferences(source) {
  return [...source.matchAll(/(?:FROM|INTO|UPDATE|JOIN|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+([a-z_][a-z0-9_]*)/gi)].map((match) => match[1].toLowerCase());
}

function rank(status) {
  return STATUS_FLOW.indexOf(status);
}

function requirePath(featureId, value, label) {
  const full = path.join(root, value);
  if (!fs.existsSync(full)) {
    failures.push(`${featureId}: mapped ${label} does not exist: ${value}`);
    return null;
  }
  return full;
}

function lineCount(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).length - 1;
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}

function normalize(value) {
  return String(value).replaceAll('\\', '/');
}

function relative(file) {
  return normalize(path.relative(root, file));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    failures.push(`failed to read ${relative(file)}: ${error.message}`);
    return {};
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
