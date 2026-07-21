import fs from 'node:fs';
import path from 'node:path';
import { collections } from '../apps/api/src/config.mjs';

const root = process.cwd();
const errors = [];
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = readJson('package.json');
let catalog, coverage, impact, suites;
for (const [key, file] of Object.entries({ catalog: 'tests/v19/catalog.json', coverage: 'tests/v19/coverage-map.json', impact: 'tests/v19/impact-map.json', suites: 'tests/v19/suites.json' })) {
  try {
    const value = readJson(file);
    if (key === 'catalog') catalog = value;
    if (key === 'coverage') coverage = value;
    if (key === 'impact') impact = value;
    if (key === 'suites') suites = value;
  } catch (error) { errors.push(`${file}: ${error.message}`); }
}
for (const [file, anchors] of [
  ['开发计划v1.9.md', ['AIWS 开发计划 V1.9', 'state schema：`18`', 'project:create', 'deletion intent', 'Context Pack']],
  ['测试计划v1.9.md', ['AIWS 测试计划 V1.9', 'PASS / FAIL / BLOCKED / SKIPPED / FLAKY', 'project_memberships', 'Exchange', '.ai-workspace/test-reports/v1.9/']]
]) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`${file}: missing`);
  else for (const anchor of anchors) if (!readText(file).includes(anchor)) errors.push(`${file}: missing anchor ${anchor}`);
}
if (catalog) {
  if (catalog.version !== '1.9' || catalog.product_version !== '1.9.0' || catalog.state_schema !== 18) errors.push('catalog header must pin V1.9.0/schema 18');
  for (const name of ['plan', 'pr', 'full', 'live', 'release', 'soak']) if (!Number.isFinite(Number(catalog.budgets_ms?.[name])) || Number(catalog.budgets_ms[name]) < 1000) errors.push(`catalog budget missing: ${name}`);
  const ids = new Set();
  for (const item of catalog.tests || []) {
    if (!/^V19-L[0-6]-[A-Z0-9]+-\d{3}$/.test(item.id || '')) errors.push(`invalid test id ${item.id}`);
    if (ids.has(item.id)) errors.push(`duplicate test id ${item.id}`); ids.add(item.id);
    for (const key of ['layer', 'domain', 'priority', 'command', 'suites', 'covers']) if (!item[key] || !item[key].length) errors.push(`${item.id}: missing ${key}`);
    if (!Number.isFinite(Number(item.timeout_ms)) || Number(item.timeout_ms) < 1000) errors.push(`${item.id}: invalid timeout_ms`);
    if (!['none', 'browser', 'docker', 'github'].includes(item.external_effects)) errors.push(`${item.id}: invalid external_effects`);
    if (!Array.isArray(item.requires_env)) errors.push(`${item.id}: requires_env must be an array`);
    const commandFile = item.command?.[0] === 'node' ? item.command[1] : null;
    if (commandFile && !fs.existsSync(path.join(root, commandFile))) errors.push(`${item.id}: command file missing ${commandFile}`);
  }
  for (let i = 0; i <= 6; i += 1) if (!(catalog.tests || []).some((item) => item.layer === `L${i}`)) errors.push(`catalog missing L${i}`);
}
if (coverage) {
  const plannedCollections = new Set(['project_memberships', 'project_invitations', 'canonical_repositories', 'project_repository_bindings', 'repository_deletion_intents', 'exchange_requests', 'exchange_grants', 'repository_workspaces', 'pull_request_intents']);
  for (const collection of coverage.collections || []) if (!collections.includes(collection) && !plannedCollections.has(collection) && !['context_packs'].includes(collection)) errors.push(`coverage collection not registered: ${collection}`);
  for (const role of ['owner', 'collaborator', 'viewer']) if (!coverage.roles?.includes(role)) errors.push(`coverage role missing: ${role}`);
  for (const scope of ['project:create', 'exchange:write']) if (!coverage.scopes?.includes(scope)) errors.push(`coverage scope missing: ${scope}`);
}
if (impact && (impact.version !== '1.9' || impact.match_mode !== 'all' || !impact.mappings?.length)) errors.push('impact map header invalid');
if (suites) for (const name of ['pr', 'full', 'live', 'release', 'soak']) {
  if (!Array.isArray(suites[name]) || !suites[name].length) { errors.push(`suite missing: ${name}`); continue; }
  for (const id of suites[name]) {
    const item = catalog?.tests?.find((entry) => entry.id === id);
    if (!item) errors.push(`${name}: unknown test ${id}`);
    else if (!item.suites.includes(name)) errors.push(`${name}: ${id} catalog suite mismatch`);
  }
}
const live = catalog?.tests?.find((item) => item.id === 'V19-L6-LIVE-001');
if (live?.command?.[1] !== 'scripts/mcp-live-project-smoke.mjs' || !live.requires_env?.includes('AIWS_MCP_LIVE_SMOKE_CONFIRM')) errors.push('live suite must explicitly gate the destructive MCP smoke');
for (const [file, anchors] of [
  ['scripts/v19-runner.mjs', ['limitedLog', '测试结果v1.9.md', "['pr', 'full', 'live', 'release', 'soak']"]],
  ['scripts/mcp-live-project-smoke.mjs', ['AIWS_MCP_LIVE_SMOKE_CONFIRM', 'create-private-github-repository']]
]) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`${file}: missing`);
  else for (const anchor of anchors) if (!readText(file).includes(anchor)) errors.push(`${file}: missing anchor ${anchor}`);
}
for (const name of ['pr', 'full', 'live', 'release', 'soak']) if (!manifest.scripts?.[`test:v19:${name}`]?.includes(`v19-runner.mjs ${name}`)) errors.push(`package script test:v19:${name} must use the V1.9 runner`);
if (errors.length) { console.error(`V1.9 plan validation failed (${errors.length}):\n${errors.map((item) => `- ${item}`).join('\n')}`); process.exit(1); }
console.log(`V1.9 plan validation passed (${catalog.tests.length} catalog cases, schema 18)`);
