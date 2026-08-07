import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const command = process.argv[2];
const audit = process.argv.includes('--audit');
const allowedCommands = new Set(['plan', 'catalog', 'coverage', 'impact']);
if (!allowedCommands.has(command)) fail(`unknown recovery governance command: ${command || '<empty>'}`);

const catalogPath = path.join(root, 'feature-catalog.json');
const catalog = readJson(catalogPath);
const features = catalog.features;
const failures = [];

if (catalog.schema_version !== 'aiws.v3.feature_catalog.v1') failures.push('catalog schema_version is invalid');
if (catalog.product_version !== '3.0.0') failures.push('catalog product_version must be 3.0.0');
if (!Array.isArray(features) || features.length === 0) failures.push('catalog contains no features');

const ids = new Set();
for (const feature of features || []) {
  for (const field of ['id', 'domain', 'name', 'status']) {
    if (typeof feature[field] !== 'string' || !feature[field]) failures.push(`${feature.id || '<unknown>'}: missing ${field}`);
  }
  for (const field of ['source_files', 'target_modules', 'tables', 'apis', 'ui', 'events', 'tests']) {
    if (!Array.isArray(feature[field])) failures.push(`${feature.id || '<unknown>'}: ${field} must be an array`);
  }
  if (ids.has(feature.id)) failures.push(`duplicate feature id: ${feature.id}`);
  ids.add(feature.id);
  if (!['implemented', 'planned', 'excluded'].includes(feature.status)) failures.push(`${feature.id}: invalid status`);
  if (!/^REC-D\d+-[A-Z]+-\d{3}$/.test(feature.id)) failures.push(`${feature.id}: invalid feature id`);
}

let result;
if (command === 'plan') result = checkPlan();
if (command === 'catalog') result = checkCatalog();
if (command === 'coverage') result = checkCoverage();
if (command === 'impact') result = checkImpact();

if (failures.length) fail(failures.join('\n'));

const receipt = {
  schema_version: 'aiws.v3.recovery_governance_receipt.v1',
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
process.stdout.write(`${JSON.stringify({ ...result, receipt: path.relative(root, receiptPath).replaceAll('\\', '/') }, null, 2)}\n`);

function checkPlan() {
  const documents = ['docs/开发计划v3功能恢复.md', 'docs/测试计划v3功能恢复.md'];
  for (const document of documents) {
    const full = path.join(root, document);
    if (!fs.existsSync(full) || fs.statSync(full).size < 500) failures.push(`missing or incomplete plan: ${document}`);
  }
  const requiredDomains = ['identity', 'setup', 'runner', 'mcp', 'project', 'workflow', 'execution', 'outcome', 'assist', 'repository', 'delivery', 'context', 'evidence', 'quality', 'operations'];
  const domains = new Set((features || []).map((feature) => feature.domain));
  for (const domain of requiredDomains) if (!domains.has(domain)) failures.push(`plan domain is not cataloged: ${domain}`);
  return { documents, domains: [...domains].sort(), feature_count: features?.length || 0 };
}

function checkCatalog() {
  const legacyRuntime = /(?:^|\/)(?:apps\/worker|apps\/mcp-gateway|bridge|prisma)(?:\/|$)|\/api\/v(?:2|12|13|14|15|16|17|18|19|20|21|22|23)(?:\/|$)/i;
  for (const feature of features || []) {
    for (const target of feature.target_modules || []) {
      if (legacyRuntime.test(target.replaceAll('\\', '/'))) failures.push(`${feature.id}: legacy runtime target ${target}`);
    }
  }
  return {
    feature_count: features?.length || 0,
    implemented: (features || []).filter((feature) => feature.status === 'implemented').length,
    planned: (features || []).filter((feature) => feature.status === 'planned').length,
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
    for (const testPath of feature.tests.filter((entry) => entry.includes('/'))) {
      if (!fs.existsSync(path.join(root, testPath))) failures.push(`${feature.id}: mapped test does not exist: ${testPath}`);
    }
  }
  return { feature_count: features?.length || 0, covered_features: (features || []).filter((feature) => feature.tests?.length).length, gates: byGate };
}

function checkImpact() {
  const changed = new Set();
  for (const args of [['diff', '--name-only'], ['diff', '--cached', '--name-only']]) {
    const run = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (run.status !== 0) failures.push(`git ${args.join(' ')} failed: ${run.stderr.trim()}`);
    for (const file of run.stdout.split(/\r?\n/).filter(Boolean)) changed.add(file.replaceAll('\\', '/'));
  }
  const untracked = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true });
  for (const file of untracked.stdout.split(/\r?\n/).filter(Boolean)) changed.add(file.replaceAll('\\', '/'));
  const mappings = [];
  const unmapped = [];
  const governance = /^(?:feature-catalog\.json|package\.json|docs\/|scripts\/(?:recovery-governance|recovery-evidence)\.mjs|apps\/api\/src\/schema\.mjs)/;
  for (const file of [...changed].sort()) {
    const matched = (features || []).filter((feature) => (feature.target_modules || []).some((target) => {
      const normalized = target.replaceAll('\\', '/');
      return file === normalized || file.startsWith(`${normalized}/`) || normalized.startsWith(`${file}/`);
    }) || (feature.tests || []).some((testPath) => testPath.replaceAll('\\', '/') === file)).map((feature) => feature.id);
    if (!matched.length && !governance.test(file)) unmapped.push(file);
    mappings.push({ file, features: matched });
  }
  if (audit && unmapped.length) failures.push(`unmapped changed files: ${unmapped.join(', ')}`);
  const selectedTests = [...new Set(mappings.flatMap((mapping) => mapping.features).flatMap((idValue) => features.find((feature) => feature.id === idValue)?.tests || []))].sort();
  return { audit, changed_files: mappings, unmapped_files: unmapped, selected_tests: selectedTests };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`failed to read ${path.relative(root, file)}: ${error.message}`); }
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
