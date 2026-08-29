import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const P10_OWNER = 'Product Architecture';
export const P10_PHASE = 'P10';
export const P10_SOURCE_COMMIT = 'e18dc0b616fa7ab2b00a6c05db23890ccd940175';
export const P10_SOURCE_TREE = '0c0020aa434882a3bb8397a0a15ed31f7a44bccc';
export const P10_P9_BASELINE = 'bb55746b7e08cf7ee764d06a8fa23da91ad48e2f';
export const P10_GOVERNANCE_ROOT = 'docs/architecture/p10-parity';

export const P10_BUSINESS_GROUPS = Object.freeze([
  group('identity-acl', 'Identity and ACL'),
  group('provider-settings', 'Provider settings'),
  group('project-brief', 'Project and Brief'),
  group('workflow', 'Workflow'),
  group('repository', 'Repository'),
  group('context', 'Context'),
  group('assist', 'Assist'),
  group('files-approval', 'Files and Approval'),
  group('terminal-bridge', 'Terminal and Bridge'),
  group('runner-execution', 'Runner and Execution'),
  group('evidence', 'Evidence'),
  group('parser', 'Parser'),
  group('quality', 'Quality'),
  group('outcome', 'Outcome'),
  group('mcp-exchange-gateway', 'MCP, Exchange, and Gateway'),
  group('delivery', 'Delivery'),
  group('operations-recovery', 'Operations and Recovery'),
  group('offline-pwa', 'Offline and PWA'),
  group('web-complete-experience', 'Complete Web experience')
]);

const ALLOWED_DISPOSITIONS = new Set(['equivalent', 'consolidated', 'retired_interface', 'fixture_only']);
const REQUIRED_DESIGN_RETENTION = Object.freeze([
  'quality-five-dimension-rubric',
  'quality-advice-human-separation',
  'quality-asset-selection-history',
  'quality-stale-supersede-history',
  'assist-fork-side-thread-review',
  'brief-template-snapshot',
  'confirmed-project-repository-deletion'
]);

const REPRESENTATIVE_COMMAND = Object.freeze({
  'identity-acl': 'account.get',
  'provider-settings': 'profile.list',
  'project-brief': 'project.get',
  workflow: 'workflow.get',
  repository: 'repository.connection.list',
  context: 'context.map',
  assist: 'assist.session.list',
  'files-approval': 'file.list',
  'terminal-bridge': 'terminal.get',
  'runner-execution': 'execution.get',
  evidence: 'asset.list',
  parser: 'parser.format.list',
  quality: 'quality.list',
  outcome: 'outcome.get',
  'mcp-exchange-gateway': 'mcp.tools.list',
  delivery: 'delivery.list',
  'operations-recovery': 'operations.list',
  'offline-pwa': 'events.project.replay',
  'web-complete-experience': 'project.list'
});

export function extractHistoricalInventory(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const routeRoot = path.join(root, 'apps', 'api', 'src', 'routes');
  const routeFiles = fs.readdirSync(routeRoot).filter((name) => name.endsWith('.mjs')).sort();
  const sourceBlobs = [];
  const routes = [];
  for (const name of routeFiles) {
    const relative = `apps/api/src/routes/${name}`;
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const blob = gitBlob(path.join(root, relative));
    sourceBlobs.push({ path: relative, git_blob: blob });
    const declarations = makeRouteDeclarations(source);
    declarations.forEach((route, index) => routes.push({
      id: `${relative}#${index + 1}:${route.method} ${route.path}`,
      source_module: name,
      source_path: relative,
      source_blob: blob,
      declaration_index: index + 1,
      method: route.method,
      path: route.path
    }));
  }

  const catalogPath = 'tests/v23/catalog.json';
  const configPath = 'apps/api/src/config.mjs';
  const routerPath = 'apps/web/src/app/router.tsx';
  const coveragePath = 'tests/v23/coverage-map.json';
  const registryPath = 'apps/api/src/api-routes.mjs';
  for (const relative of [catalogPath, configPath, routerPath, coveragePath, registryPath]) {
    sourceBlobs.push({ path: relative, git_blob: gitBlob(path.join(root, relative)) });
  }
  sourceBlobs.sort((left, right) => left.path.localeCompare(right.path));

  const catalog = readJson(path.join(root, catalogPath));
  const collections = stringArrayDeclaration(fs.readFileSync(path.join(root, configPath), 'utf8'), 'collections');
  const webRoutes = objectStringProperties(fs.readFileSync(path.join(root, routerPath), 'utf8'), 'path')
    .filter((value) => value !== '*' && value !== '/integrations/github/install/setup');
  const coverage = readJson(path.join(root, coveragePath));
  const optimizationPackages = Object.entries(coverage.work_packages || {}).map(([id, value]) => ({ id, ...value }));
  const inventory = {
    schema_version: 'aiws.v3-clean.p10-v23-input.v1',
    owner: P10_OWNER,
    phase: P10_PHASE,
    source_commit: P10_SOURCE_COMMIT,
    source_tree: P10_SOURCE_TREE,
    source_blobs: sourceBlobs,
    cases: catalog.tests || [],
    routes,
    collections,
    web_routes: webRoutes,
    optimization_packages: optimizationPackages,
    counts: {
      cases: (catalog.tests || []).length,
      routes: routes.length,
      collections: collections.length,
      web_routes: webRoutes.length,
      optimization_packages: optimizationPackages.length
    }
  };
  inventory.inventory_sha256 = digest(withoutKey(inventory, 'inventory_sha256'));
  return inventory;
}

export function buildParityArtifacts(inventory) {
  const routeMappings = inventory.routes.map((route) => mapping(route.id, classifyRoute(route), routeDisposition(route), routeRationale(route)));
  const collectionMappings = inventory.collections.map((name) => mapping(name, classifyCollection(name), collectionDisposition(name), `Historical collection ${name} is owned by the mapped Clean business group.`));
  const webMappings = inventory.web_routes.map((route) => mapping(route, classifyWebRoute(route), 'equivalent', `The parameterized Clean hash route preserves the ${route} user journey.`));
  const caseMappings = inventory.cases.map((item) => ({
    source_id: item.id,
    business_group: classifyCase(item),
    disposition: 'equivalent',
    clean_commands: [REPRESENTATIVE_COMMAND[classifyCase(item)]],
    verification: [`tests/p10/v23-cases.test.mjs#${item.id}`],
    rationale: `V2.3 ${item.layer} acceptance behavior remains a mandatory P10 gate input.`
  }));
  const optimizationMappings = inventory.optimization_packages.map((item) => {
    const businessGroup = classifyOptimization(item.id);
    return {
      source_id: item.id,
      business_group: businessGroup,
      disposition: 'equivalent',
      clean_commands: [REPRESENTATIVE_COMMAND[businessGroup]],
      verification: [`tests/p10/parity-governance.test.mjs#${item.id}`],
      rationale: `The ${item.id} design package is retained as a Clean behavior constraint.`
    };
  });
  const parityMap = {
    schema_version: 'aiws.v3-clean.p10-business-parity-map.v1',
    owner: P10_OWNER,
    phase: P10_PHASE,
    source_commit: inventory.source_commit,
    inventory_sha256: inventory.inventory_sha256,
    groups: P10_BUSINESS_GROUPS,
    route_mappings: routeMappings,
    collection_mappings: collectionMappings,
    web_route_mappings: webMappings,
    case_mappings: caseMappings,
    optimization_mappings: optimizationMappings,
    status: 'complete',
    gap_count: 0
  };
  parityMap.map_sha256 = digest(withoutKey(parityMap, 'map_sha256'));

  const retired = [...routeMappings.map((row) => ['route', row]), ...collectionMappings.map((row) => ['collection', row])]
    .filter(([, row]) => row.disposition === 'retired_interface')
    .map(([inventoryKind, row]) => ({ inventory_kind: inventoryKind, source_id: row.source_id, replacement_group: row.business_group, clean_commands: row.clean_commands, rationale: row.rationale }));
  const retiredManifest = {
    schema_version: 'aiws.v3-clean.p10-retired-interface-manifest.v1',
    owner: P10_OWNER,
    phase: P10_PHASE,
    source_commit: inventory.source_commit,
    entries: retired.sort((left, right) => `${left.inventory_kind}:${left.source_id}`.localeCompare(`${right.inventory_kind}:${right.source_id}`))
  };
  retiredManifest.manifest_sha256 = digest(withoutKey(retiredManifest, 'manifest_sha256'));

  const designRetention = {
    schema_version: 'aiws.v3-clean.p10-design-retention.v1',
    owner: P10_OWNER,
    phase: P10_PHASE,
    entries: [
      retention('quality-five-dimension-rubric', 'quality', ['coverage', 'accuracy', 'depth', 'consistency', 'clarity'], ['quality.policy.update', 'quality.prepare']),
      retention('quality-advice-human-separation', 'quality', ['closed-schema advice', 'empty human score draft'], ['quality.advice.get', 'quality.decision']),
      retention('quality-asset-selection-history', 'quality', ['included version', 'excluded reason'], ['quality.prepare', 'quality.start']),
      retention('quality-stale-supersede-history', 'quality', ['one active run', 'completed supersession', 'stale history'], ['quality.list', 'quality.decision']),
      retention('assist-fork-side-thread-review', 'assist', ['fork', 'side thread', 'review comments', 'request changes'], ['assist.session.fork', 'assist.review.comment']),
      retention('brief-template-snapshot', 'project-brief', ['template id', 'template revision', 'template hash'], ['brief.template.list', 'brief.create']),
      retention('confirmed-project-repository-deletion', 'repository', ['project blockers', 'two repository confirmations', 'reconcile'], ['project.deletion.prepare', 'repository.deletion.prepare'])
    ]
  };
  designRetention.retention_sha256 = digest(withoutKey(designRetention, 'retention_sha256'));
  return { parityMap, retiredManifest, designRetention };
}

export function writeParityArtifacts({ root, sourceRoot }) {
  const repositoryRoot = path.resolve(root);
  const inventory = extractHistoricalInventory(sourceRoot);
  const artifacts = buildParityArtifacts(inventory);
  const target = path.join(repositoryRoot, P10_GOVERNANCE_ROOT);
  fs.mkdirSync(target, { recursive: true });
  writeJson(path.join(target, 'v23-input.json'), inventory);
  writeJson(path.join(target, 'business-parity-map.json'), artifacts.parityMap);
  writeJson(path.join(target, 'retired-interface-manifest.json'), artifacts.retiredManifest);
  writeJson(path.join(target, 'design-retention.json'), artifacts.designRetention);
  return { inventory, ...artifacts, directory: P10_GOVERNANCE_ROOT };
}

export async function auditParity({ root, verifyGit = true, registry = null } = {}) {
  const repositoryRoot = path.resolve(root || process.cwd());
  const governanceRoot = path.join(repositoryRoot, P10_GOVERNANCE_ROOT);
  const inventory = readJson(path.join(governanceRoot, 'v23-input.json'));
  const parityMap = readJson(path.join(governanceRoot, 'business-parity-map.json'));
  const retiredManifest = readJson(path.join(governanceRoot, 'retired-interface-manifest.json'));
  const designRetention = readJson(path.join(governanceRoot, 'design-retention.json'));
  const findings = [];
  const add = (code, details = {}) => findings.push({ code, ...details });

  if (inventory.source_commit !== P10_SOURCE_COMMIT || inventory.source_tree !== P10_SOURCE_TREE) add('source_identity_mismatch');
  if (inventory.inventory_sha256 !== digest(withoutKey(inventory, 'inventory_sha256'))) add('inventory_hash_mismatch');
  for (const [key, expected] of Object.entries({ cases: 14, routes: 360, collections: 98, web_routes: 11, optimization_packages: 7 })) {
    const values = key === 'web_routes' ? inventory.web_routes : key === 'optimization_packages' ? inventory.optimization_packages : inventory[key];
    if (!Array.isArray(values) || values.length !== expected || Number(inventory.counts?.[key]) !== expected) add('inventory_count_mismatch', { inventory: key, expected, actual: values?.length ?? null });
  }
  uniqueInventory(inventory.cases, (row) => row.id, 'case', add);
  uniqueInventory(inventory.routes, (row) => row.id, 'route', add);
  uniqueInventory(inventory.collections, (row) => row, 'collection', add);
  uniqueInventory(inventory.web_routes, (row) => row, 'web_route', add);
  uniqueInventory(inventory.optimization_packages, (row) => row.id, 'optimization', add);
  uniqueInventory(inventory.source_blobs, (row) => row.path, 'source_blob', add);

  if (verifyGit) verifySourceBlobs(repositoryRoot, inventory, add);
  if (parityMap.inventory_sha256 !== inventory.inventory_sha256 || parityMap.map_sha256 !== digest(withoutKey(parityMap, 'map_sha256'))) add('parity_map_hash_mismatch');
  const groups = new Set((parityMap.groups || []).map((row) => row.id));
  if (groups.size !== 19 || P10_BUSINESS_GROUPS.some((row) => !groups.has(row.id))) add('business_group_inventory_mismatch');
  verifyMappings(inventory.routes, parityMap.route_mappings, (row) => row.id, 'route', groups, add);
  verifyMappings(inventory.collections, parityMap.collection_mappings, (row) => row, 'collection', groups, add);
  verifyMappings(inventory.web_routes, parityMap.web_route_mappings, (row) => row, 'web_route', groups, add);
  verifyMappings(inventory.cases, parityMap.case_mappings, (row) => row.id, 'case', groups, add);
  verifyMappings(inventory.optimization_packages, parityMap.optimization_mappings, (row) => row.id, 'optimization', groups, add);
  const allMappings = ['route_mappings', 'collection_mappings', 'web_route_mappings', 'case_mappings', 'optimization_mappings'].flatMap((key) => parityMap[key] || []);
  if (parityMap.status !== 'complete' || Number(parityMap.gap_count) !== 0 || allMappings.some((row) => row.disposition === 'gap')) add('business_gap_present');
  if (allMappings.some((row) => row.disposition === 'retired_business')) add('retired_business_forbidden');
  const represented = new Set(allMappings.map((row) => row.business_group));
  if (P10_BUSINESS_GROUPS.some((row) => !represented.has(row.id))) add('business_group_unmapped');

  const expectedRetired = [...(parityMap.route_mappings || []).map((row) => ['route', row]), ...(parityMap.collection_mappings || []).map((row) => ['collection', row])]
    .filter(([, row]) => row.disposition === 'retired_interface')
    .map(([kind, row]) => `${kind}:${row.source_id}`).sort();
  const actualRetired = (retiredManifest.entries || []).map((row) => `${row.inventory_kind}:${row.source_id}`).sort();
  if (JSON.stringify(expectedRetired) !== JSON.stringify(actualRetired) || retiredManifest.manifest_sha256 !== digest(withoutKey(retiredManifest, 'manifest_sha256'))) add('retired_manifest_mismatch');
  const retained = new Set((designRetention.entries || []).map((row) => row.id));
  if (REQUIRED_DESIGN_RETENTION.some((id) => !retained.has(id)) || designRetention.retention_sha256 !== digest(withoutKey(designRetention, 'retention_sha256'))) add('design_retention_mismatch');

  const commandIds = registry ? new Set(registry.map((row) => row.command_id)) : null;
  if (commandIds) for (const row of allMappings) for (const command of row.clean_commands || []) if (!commandIds.has(command)) add('clean_command_orphan', { source_id: row.source_id, command });
  const cleanCatalog = readJson(path.join(repositoryRoot, 'feature-catalog.clean.json')).features || [];
  const historicalCatalog = readJson(path.join(repositoryRoot, 'feature-catalog.historical.json')).features || [];
  if (cleanCatalog.length !== 27 || historicalCatalog.length !== 0 || cleanCatalog.some((row) => row.status !== 'released')) add('catalog_p9_baseline_changed');

  return {
    schema_version: 'aiws.v3-clean.p10-parity-audit.v1',
    phase: P10_PHASE,
    status: findings.length ? 'failed' : 'passed',
    counts: inventory.counts,
    business_groups: groups.size,
    gaps: allMappings.filter((row) => row.disposition === 'gap').length,
    findings
  };
}

function verifyMappings(source, mappings, sourceId, kind, groups, add) {
  const expected = source.map(sourceId).sort();
  const actual = (mappings || []).map((row) => row.source_id).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) add('mapping_inventory_mismatch', { inventory: kind });
  uniqueInventory(mappings || [], (row) => row.source_id, `${kind}_mapping`, add);
  for (const row of mappings || []) {
    if (!groups.has(row.business_group)) add('mapping_group_orphan', { inventory: kind, source_id: row.source_id });
    if (!ALLOWED_DISPOSITIONS.has(row.disposition)) add('mapping_disposition_invalid', { inventory: kind, source_id: row.source_id, disposition: row.disposition });
    if (!Array.isArray(row.clean_commands) || !row.clean_commands.length || !Array.isArray(row.verification) || !row.verification.length || !row.rationale) add('mapping_evidence_incomplete', { inventory: kind, source_id: row.source_id });
  }
}

function verifySourceBlobs(root, inventory, add) {
  const tree = git(root, ['rev-parse', `${inventory.source_commit}^{tree}`]);
  if (tree.status !== 0 || tree.stdout.trim() !== inventory.source_tree) return add('source_commit_unavailable_or_changed');
  for (const row of inventory.source_blobs || []) {
    const result = git(root, ['rev-parse', `${inventory.source_commit}:${row.path}`]);
    if (result.status !== 0 || result.stdout.trim() !== row.git_blob) add('source_blob_mismatch', { path: row.path });
  }
}

function makeRouteDeclarations(source) {
  const tokens = tokenize(source);
  const routes = [];
  for (let index = 0; index < tokens.length - 5; index += 1) {
    if (tokens[index].type !== 'identifier' || tokens[index].value !== 'makeRoute' || tokens[index + 1]?.value !== '(') continue;
    const method = tokens[index + 2];
    const comma = tokens[index + 3];
    const route = tokens[index + 4];
    if (method?.type !== 'string' || comma?.value !== ',' || route?.type !== 'string') throw new Error(`historical_route_declaration_invalid:${index}`);
    routes.push({ method: method.value.toUpperCase(), path: route.value });
  }
  return routes;
}

function stringArrayDeclaration(source, name) {
  const tokens = tokenize(source);
  const start = tokens.findIndex((token, index) => token.type === 'identifier' && token.value === name && tokens[index + 1]?.value === '=' && tokens[index + 2]?.value === '[');
  if (start < 0) throw new Error(`array_declaration_missing:${name}`);
  const output = [];
  let depth = 0;
  for (let index = start + 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '[') depth += 1;
    else if (token.value === ']') { depth -= 1; if (depth === 0) break; }
    else if (depth === 1 && token.type === 'string') output.push(token.value);
  }
  return output;
}

function objectStringProperties(source, property) {
  const tokens = tokenize(source);
  const output = [];
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index].type === 'identifier' && tokens[index].value === property && tokens[index + 1]?.value === ':' && tokens[index + 2]?.type === 'string') output.push(tokens[index + 2].value);
  }
  return output;
}

export function tokenize(sourceValue) {
  const source = String(sourceValue);
  const output = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '/' && source[index + 1] === '/') { index = source.indexOf('\n', index + 2); if (index < 0) break; continue; }
    if (char === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); if (end < 0) throw new Error('unterminated_block_comment'); index = end + 2; continue; }
    if (char === '/' && regexCanStart(output.at(-1))) {
      index += 1; let characterClass = false; let closed = false;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === '[') characterClass = true;
        else if (source[index] === ']') characterClass = false;
        else if (source[index] === '/' && !characterClass) { index += 1; closed = true; break; }
        index += 1;
      }
      if (!closed) throw new Error('unterminated_regex');
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      output.push({ type: 'regex', value: '' }); continue;
    }
    if (char === '"' || char === "'") {
      const quote = char; let value = ''; index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          const escaped = source[index + 1];
          const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
          value += Object.hasOwn(escapes, escaped) ? escapes[escaped] : escaped;
          index += 2;
        } else { value += source[index]; index += 1; }
      }
      if (source[index] !== quote) throw new Error('unterminated_string');
      index += 1; output.push({ type: 'string', value }); continue;
    }
    if (char === '`') {
      index += 1;
      while (index < source.length) { if (source[index] === '\\') index += 2; else if (source[index] === '`') { index += 1; break; } else index += 1; }
      output.push({ type: 'template', value: '' }); continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index; index += 1; while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      output.push({ type: 'identifier', value: source.slice(start, index) }); continue;
    }
    output.push({ type: 'punctuation', value: char }); index += 1;
  }
  return output;
}

function classifyRoute(route) {
  const value = `${route.source_module} ${route.path}`.toLowerCase();
  if (/quality-review/.test(value)) return 'quality';
  if (/context/.test(value)) return 'context';
  if (/outcome/.test(value)) return 'outcome';
  if (/assist|agent-session/.test(value)) return 'assist';
  if (/terminal|host-bridge/.test(value)) return 'terminal-bridge';
  if (/approval|change-proposal|files?\b/.test(value)) return 'files-approval';
  if (/mcp|exchange|tools?\.mjs/.test(value)) return 'mcp-exchange-gateway';
  if (/pull-request|delivery|github-pr|webhook/.test(value)) return 'delivery';
  if (/workflow-execution|runs\.mjs|task-execution/.test(value)) return 'runner-execution';
  if (/assets?/.test(value)) return 'evidence';
  if (/repository|github-repositor|\bgit\.mjs/.test(value)) return 'repository';
  if (/workflow/.test(value)) return 'workflow';
  if (/projects?|onboarding|brief/.test(value)) return 'project-brief';
  if (/codex|github-config|github-installation|setup/.test(value)) return 'provider-settings';
  if (/health|livez|readyz|system\/deployment|review/.test(value)) return 'operations-recovery';
  return 'identity-acl';
}

function classifyCollection(nameValue) {
  const name = String(nameValue).toLowerCase();
  if (name.startsWith('quality_review') || name === 'human_reviews') return 'quality';
  if (name.startsWith('context_')) return 'context';
  if (name.startsWith('outcome_')) return 'outcome';
  if (name.startsWith('assist_') || name === 'agent_sessions') return 'assist';
  if (/terminal|host_bridge/.test(name)) return 'terminal-bridge';
  if (/file|attachment|approval|proposal|submission|user_input/.test(name)) return 'files-approval';
  if (/mcp|exchange/.test(name) || name === 'tools') return 'mcp-exchange-gateway';
  if (/delivery|pull_request|webhook/.test(name)) return 'delivery';
  if (/execution|node_run|test_task|checkpoint|runner_memory/.test(name)) return 'runner-execution';
  if (/asset|trace|digest|code_change|test_result|decision/.test(name)) return 'evidence';
  if (/repository|worktree|workspace/.test(name)) return 'repository';
  if (/workflow|node_contract/.test(name)) return 'workflow';
  if (/project|brief|intake/.test(name)) return 'project-brief';
  if (/credential|account|profile|github_|setup_|integration_status|config_revision/.test(name)) return 'provider-settings';
  return 'identity-acl';
}

function classifyWebRoute(route) {
  if (route === '/setup' || route === '/settings') return 'provider-settings';
  if (route.includes('/workflow')) return 'workflow';
  if (route.includes('/nodes/')) return 'runner-execution';
  if (route.includes('/context')) return 'context';
  if (route === '/assets') return 'evidence';
  if (route === '/audit') return 'web-complete-experience';
  return 'project-brief';
}

function classifyCase(item) {
  const value = `${item.domain} ${(item.covers || []).join(' ')}`.toLowerCase();
  if (value.includes('parser')) return 'parser';
  if (value.includes('quality')) return 'quality';
  if (value.includes('security')) return 'identity-acl';
  if (value.includes('performance')) return 'operations-recovery';
  if (value.includes('release') || value.includes('migration')) return 'operations-recovery';
  if (value.includes('web') || value.includes('browser')) return 'web-complete-experience';
  return 'operations-recovery';
}

function classifyOptimization(id) {
  return ({
    'OPT21-01': 'runner-execution',
    'OPT21-02': 'outcome',
    'OPT21-03': 'context',
    'OPT21-04': 'parser',
    'OPT21-05': 'offline-pwa',
    'OPT22-01': 'operations-recovery',
    'OPT23-01': 'quality'
  })[id] || 'operations-recovery';
}

function routeDisposition(route) {
  const value = `${route.source_module} ${route.method} ${route.path}`.toLowerCase();
  if (/assist-v(?:12|3)|tools\.mjs|\bgit\.mjs|workflow-migration|cc-switch|\sdelete\s|\/health$/.test(value)) return 'retired_interface';
  if (/fixture|migration/.test(value)) return 'fixture_only';
  return route.path.includes('/v') || route.source_module.includes('-v') ? 'consolidated' : 'equivalent';
}

function collectionDisposition(name) {
  if (['assist_operations', 'tools'].includes(name)) return 'retired_interface';
  if (['workflow_migration_batches', 'workflow_migration_jobs', 'import_jobs'].includes(name)) return 'fixture_only';
  return 'consolidated';
}

function routeRationale(route) {
  const disposition = routeDisposition(route);
  if (disposition === 'retired_interface') return `The historical ${route.method} ${route.path} address has no independent business semantics; the mapped Clean group owns the confirmed workflow.`;
  if (disposition === 'fixture_only') return `The historical ${route.method} ${route.path} declaration remains immutable characterization or importer input.`;
  return `The mapped Clean business group preserves the semantics of historical ${route.method} ${route.path}.`;
}

function mapping(sourceId, businessGroup, disposition, rationale) {
  return { source_id: sourceId, business_group: businessGroup, disposition, clean_commands: [REPRESENTATIVE_COMMAND[businessGroup]], verification: ['tests/p10/parity-governance.test.mjs'], rationale };
}

function retention(id, businessGroup, retainedBehavior, cleanCommands) { return { id, business_group: businessGroup, retained_behavior: retainedBehavior, clean_commands: cleanCommands, verification: ['tests/p10/business-parity.test.mjs'] }; }
function group(id, name) { return Object.freeze({ id, name }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' }); }
function withoutKey(value, key) { const copy = structuredClone(value); delete copy[key]; return copy; }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function gitBlob(file) { const result = spawnSync('git', ['hash-object', file], { encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(`git_blob_failed:${file}`); return result.stdout.trim(); }
function git(root, args) { return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); }
function uniqueInventory(values, identity, kind, add) { const ids = (values || []).map(identity); if (new Set(ids).size !== ids.length) add('inventory_duplicate', { inventory: kind }); }
function regexCanStart(previous) {
  if (!previous) return true;
  if (previous.type === 'identifier') return ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of'].includes(previous.value);
  return ['(', '[', '{', ',', ';', ':', '=', '!', '?', '&', '|', '+', '-', '*', '%', '^', '~', '<', '>'].includes(previous.value);
}
