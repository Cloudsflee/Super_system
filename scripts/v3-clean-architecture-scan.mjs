import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCleanCommandRegistry, registryParity } from '../apps/api/src/clean/registry.mjs';
import { validateCleanOwnership } from '../apps/api/src/clean/ownership.mjs';
import { CLEAN_P3_TABLE_OWNERS } from '../apps/api/src/clean/ownership.mjs';
import { CLEAN_MIGRATION_REGISTRY } from '../apps/api/src/clean/migration-service.mjs';
import { auditWorkspace } from './v3-clean-workspace-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanRoot = path.join(root, 'apps', 'api', 'src', 'clean');
const entrypoint = path.join(root, 'apps', 'api', 'server.mjs');
const cleanServer = path.join(root, 'apps', 'api', 'clean-server.mjs');
const forbidden = [
  { pattern: /legacy_compat|native_v5|native_v6|ASSIST_NATIVE_V6/i, label: 'legacy runtime switch' },
  { pattern: /assist_operations/i, label: 'second operation ledger' },
  { pattern: /(?:^|[\\/])(?:src[\\/])?migrations[\\/](?:00[4-9]|0[1-9][0-9])/i, label: 'unregistered future migration import' },
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
if (fs.existsSync(path.join(root, 'apps', 'api', 'server-clean.mjs'))) findings.push({ label: 'duplicate clean entry alias', file: 'apps/api/server-clean.mjs' });
visit(entrypoint);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  if (!/^(?:dev|start)(?::clean)?$/.test(name)) continue;
  if (/apps[\\/]api[\\/](?!server\.mjs\b)[^\s'"`]+\.mjs/i.test(String(command))) findings.push({ label: 'non-unique clean process script', script: name, command });
}

const tableText = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
if (/CREATE\s+TABLE[^;]*\b(?:assist|project|workflow|execution|domain)_heads\b/i.test(tableText)) findings.push({ label: 'shadow head model', file: 'clean schema' });
if (/CREATE\s+TABLE[^;]*\bassist_operations\b/i.test(tableText)) findings.push({ label: 'second operation ledger', file: 'clean schema' });

const migrationIds = CLEAN_MIGRATION_REGISTRY.map((migration) => migration.id);
if (JSON.stringify(migrationIds) !== JSON.stringify(['001-clean-baseline', '002-identity-acl', '003-project-workflow'])) {
  findings.push({ label: 'P3 migration registry is not exactly forward-only 001 -> 002 -> 003', migrations: migrationIds });
}
if (!files.some((file) => relative(file) === 'apps/api/src/clean/authorization.mjs') || !/authorize\s*\(/.test(tableText)) {
  findings.push({ label: 'unified authorization predicate missing', expected: 'authorize(principal, action, project, resource, policy_revision)' });
}
if (!Object.hasOwn(CLEAN_P3_TABLE_OWNERS, 'project_invitations') || Object.hasOwn(CLEAN_P3_TABLE_OWNERS, 'invitations')) {
  findings.push({ label: 'P2 invitation table ownership is not canonical', expected: 'project_invitations' });
}

let registryReport = { valid: false, mismatches: ['registry_unavailable'] };
let ownershipReport = { valid: false, missing_tables: ['ownership_unavailable'] };
try {
  const registry = createCleanCommandRegistry({ targetVersion: 3 });
  registryReport = registryParity(registry);
  const tables = extractTables(tableText);
  ownershipReport = validateCleanOwnership({ tables, registry });
  if (!registryReport.valid) findings.push({ label: 'registry parity mismatch', mismatches: registryReport.mismatches });
  if (!ownershipReport.valid) findings.push({ label: 'clean ownership mismatch', ownership: ownershipReport });
} catch (error) {
  findings.push({ label: 'registry validation failed', error: String(error?.message || error) });
}

const result = {
  schema_version: 'aiws.v3-clean.architecture-scan.v3',
  entrypoints: ['apps/api/server.mjs'],
  files: files.map(relative),
  registry: registryReport,
  ownership: ownershipReport,
  phase_metadata: {
    baseline_phase: 'P1',
    active_phase: 'P3',
    migration_registry: CLEAN_MIGRATION_REGISTRY.map((migration) => ({ id: migration.id, version: migration.version })),
    p3_table_owners: Object.keys(CLEAN_P3_TABLE_OWNERS).sort(),
    authorization_predicate: 'authorize(principal, action, project, resource, policy_revision)',
    evidence_directory: 'docs/evidence/v3-clean-p3-project-workflow-20260819',
    evidence_present: fs.existsSync(path.join(root, 'docs', 'evidence', 'v3-clean-p3-project-workflow-20260819'))
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
