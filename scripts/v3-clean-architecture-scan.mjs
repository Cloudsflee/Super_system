import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCleanCommandRegistry, registryParity } from '../apps/api/src/clean/registry.mjs';
import { validateCleanOwnership } from '../apps/api/src/clean/ownership.mjs';
import { CLEAN_P6_TABLE_OWNERS } from '../apps/api/src/clean/ownership.mjs';
import { CLEAN_P6_MIGRATION_REGISTRY } from '../apps/api/src/clean/migration-service.mjs';
import { auditWorkspace } from './v3-clean-workspace-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanRoot = path.join(root, 'apps', 'api', 'src', 'clean');
const entrypoint = path.join(root, 'apps', 'api', 'server.mjs');
const cleanServer = path.join(root, 'apps', 'api', 'clean-server.mjs');
const gatewayServer = path.join(root, 'apps', 'gateway', 'server.mjs');
const brokerServer = path.join(root, 'apps', 'runner-broker', 'clean-server.mjs');
const bridgeServer = path.join(root, 'apps', 'windows-native-bridge', 'server.mjs');
const forbidden = [
  { pattern: /legacy_compat|native_v5|native_v6|ASSIST_NATIVE_V6/i, label: 'legacy runtime switch' },
  { pattern: /assist_operations/i, label: 'second operation ledger' },
  { pattern: /(?:^|[\\/])(?:src[\\/])?migrations[\\/](?:00[7-9]|0[1-9][0-9])/i, label: 'unregistered future migration import' },
  { pattern: /(?:^|[\\/])apps[\\/](?:worker|mcp-gateway)(?:[\\/]|$)/i, label: 'historical service import' },
  { pattern: /\/api\/v1(?:\/|['"`]|$)/i, label: 'legacy API route registration' },
  { pattern: /server-legacy\.mjs|server-clean\.mjs/i, label: 'historical or alias entry import' }
];

const visited = new Set();
const files = [];
const findings = [];
const workspace = auditWorkspace({
  root,
  verifyEvidence: process.argv.includes('--skip-evidence') ? false : undefined
});

if (!workspace.valid) findings.push({ label: 'workspace synchronization mismatch', findings: workspace.findings });

if (!fs.existsSync(entrypoint)) findings.push({ label: 'clean entrypoint missing', file: 'apps/api/server.mjs' });
if (!fs.existsSync(cleanServer)) findings.push({ label: 'clean server module missing', file: 'apps/api/clean-server.mjs' });
if (!fs.existsSync(gatewayServer)) findings.push({ label: 'P4 gateway entrypoint missing', file: 'apps/gateway/server.mjs' });
if (!fs.existsSync(brokerServer)) findings.push({ label: 'P6 Clean Broker entrypoint missing', file: 'apps/runner-broker/clean-server.mjs' });
if (!fs.existsSync(bridgeServer)) findings.push({ label: 'P6 Windows Bridge entrypoint missing', file: 'apps/windows-native-bridge/server.mjs' });
if (fs.existsSync(path.join(root, 'apps', 'api', 'server-clean.mjs'))) findings.push({ label: 'duplicate clean entry alias', file: 'apps/api/server-clean.mjs' });
visit(entrypoint);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  if (!/^(?:dev|start)(?::clean)?$/.test(name)) continue;
  if (/apps[\\/]api[\\/](?!server\.mjs\b)[^\s'"`]+\.mjs/i.test(String(command))) findings.push({ label: 'non-unique clean process script', script: name, command });
}
if (packageJson.scripts?.['dev:broker'] !== 'node apps/runner-broker/clean-server.mjs') findings.push({ label: 'P6 Clean Broker process script mismatch' });
if (packageJson.scripts?.['fixture:legacy:dev-broker'] !== 'node apps/runner-broker/server.mjs') findings.push({ label: 'historical Broker fixture script mismatch' });

const tableText = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
if (/CREATE\s+TABLE[^;]*\b(?:assist|project|workflow|execution|domain)_heads\b/i.test(tableText)) findings.push({ label: 'shadow head model', file: 'clean schema' });
if (/CREATE\s+TABLE[^;]*\bassist_operations\b/i.test(tableText)) findings.push({ label: 'second operation ledger', file: 'clean schema' });

const migrationIds = CLEAN_P6_MIGRATION_REGISTRY.map((migration) => migration.id);
if (JSON.stringify(migrationIds) !== JSON.stringify(['001-clean-baseline', '002-identity-acl', '003-project-workflow', '004-context-projection-mcp', '005-assist-files-terminal-bridge', '006-runner-execution-checkpoint-replay'])) {
  findings.push({ label: 'P6 migration registry is not exactly forward-only 001 -> 002 -> 003 -> 004 -> 005 -> 006', migrations: migrationIds });
}
if (!files.some((file) => relative(file) === 'apps/api/src/clean/authorization.mjs') || !/authorize\s*\(/.test(tableText)) {
  findings.push({ label: 'unified authorization predicate missing', expected: 'authorize(principal, action, project, resource, policy_revision)' });
}
if (!Object.hasOwn(CLEAN_P6_TABLE_OWNERS, 'project_invitations') || Object.hasOwn(CLEAN_P6_TABLE_OWNERS, 'invitations')) {
  findings.push({ label: 'P2 invitation table ownership is not canonical', expected: 'project_invitations' });
}

let registryReport = { valid: false, mismatches: ['registry_unavailable'] };
let ownershipReport = { valid: false, missing_tables: ['ownership_unavailable'] };
try {
  const registry = createCleanCommandRegistry({ targetVersion: 6 });
  registryReport = registryParity(registry);
  const tables = extractTables(tableText);
  ownershipReport = validateCleanOwnership({ tables, registry });
  if (!registryReport.valid) findings.push({ label: 'registry parity mismatch', mismatches: registryReport.mismatches });
  if (!ownershipReport.valid) findings.push({ label: 'clean ownership mismatch', ownership: ownershipReport });
} catch (error) {
  findings.push({ label: 'registry validation failed', error: String(error?.message || error) });
}

if (fs.existsSync(gatewayServer)) {
  const gatewayText = fs.readFileSync(gatewayServer, 'utf8');
  for (const [pattern, label] of [
    [/node:sqlite|sqlite3|better-sqlite3|database\.mjs/i, 'Gateway business persistence import'],
    [/docker(?:ode)?|\\\\\.\\pipe\\docker_engine|\/var\/run\/docker\.sock/i, 'Gateway Docker access'],
    [/cas\.mjs|context-service\.mjs|mcp-service\.mjs/i, 'Gateway domain owner import']
  ]) if (pattern.test(gatewayText)) findings.push({ label, file: 'apps/gateway/server.mjs' });
}

const result = {
  schema_version: 'aiws.v3-clean.architecture-scan.v6',
  entrypoints: ['apps/api/server.mjs', 'apps/gateway/server.mjs', 'apps/runner-broker/clean-server.mjs', 'apps/windows-native-bridge/server.mjs'],
  files: files.map(relative),
  registry: registryReport,
  ownership: ownershipReport,
  phase_metadata: {
    baseline_phase: 'P1',
    active_phase: 'P6',
    migration_registry: CLEAN_P6_MIGRATION_REGISTRY.map((migration) => ({ id: migration.id, version: migration.version })),
    p6_table_owners: Object.keys(CLEAN_P6_TABLE_OWNERS).sort(),
    authorization_predicate: 'authorize(principal, action, project, resource, policy_revision)',
    evidence_directory: 'docs/evidence/v3-clean-p6-runner-execution-20260824',
    evidence_present: fs.existsSync(path.join(root, 'docs', 'evidence', 'v3-clean-p6-runner-execution-20260824'))
  },
  workspace,
  forbidden_findings: findings,
  valid: findings.length === 0
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exitCode = 1;

function visit(file) {
  const resolved = resolveFile(file);
  if (!resolved || visited.has(resolved)) return;
  visited.add(resolved);
  files.push(resolved);
  const content = fs.readFileSync(resolved, 'utf8');
  for (const item of forbidden) if (item.pattern.test(content)) findings.push({ label: item.label, file: relative(resolved) });
  const staticImports = [...content.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)].map((match) => match[1]);
  const dynamicImports = [...content.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  for (const specifier of dynamicImports) findings.push({ label: 'dynamic relative import in clean graph', file: relative(resolved), target: specifier });
  for (const specifier of staticImports) {
    const target = path.resolve(path.dirname(resolved), specifier);
    const targetResolved = resolveFile(target);
    const allowed = resolved === entrypoint && targetResolved === cleanServer;
    if (!allowed && (!targetResolved || !targetResolved.startsWith(cleanRoot + path.sep))) {
      findings.push({ label: 'clean entry leaves clean module boundary', file: relative(resolved), target: specifier });
      continue;
    }
    visit(targetResolved || target);
  }
}

function resolveFile(file) {
  if (!file) return null;
  const candidates = [file, `${file}.mjs`, `${file}.js`, path.join(file, 'index.mjs')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function extractTables(text) {
  return [...text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)].map((match) => match[1]);
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}
