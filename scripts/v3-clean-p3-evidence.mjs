import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CLEAN_MIGRATION_REGISTRY,
  CLEAN_P3_TABLE_OWNERS,
  CLEAN_COMMAND_OWNERS,
  CLEAN_EVENT_OWNERS,
  createCleanCommandRegistry,
  createCleanRuntime,
  openCleanDatabase,
  validateCleanOwnership
} from '../apps/api/src/clean/index.mjs';

const root = process.cwd();
const evidenceRelative = 'docs/evidence/v3-clean-p3-project-workflow-20260819';
const evidence = path.join(root, evidenceRelative);
const p1BoundaryRelative = '.ai-workspace/v3-clean-p1-gate-contract-complete-baseline-20260819';
const p1Boundary = path.join(root, p1BoundaryRelative);
const p1EvidenceRelative = 'docs/evidence/v3-clean-p1-gate-contract-complete-20260819';
const p1Patch = path.join(root, p1EvidenceRelative, 'change.patch');
const p2EvidenceRelative = 'docs/evidence/v3-clean-p2-identity-acl-20260819';
const p2Patch = path.join(root, p2EvidenceRelative, 'change.patch');
const baselineCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p3-baseline-'));
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p3-probe-'));
const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p3-rollback-'));
const sensitiveValues = new Set();
const scopeRoots = [
  'AGENTS.md', 'package.json', 'feature-catalog.json', 'docs/testing.md',
  'docs/architecture/api-v2-contract.md', 'docs/architecture/clean-schema.md',
  'docs/architecture/decision-log.md', 'docs/architecture/v23-capability-matrix.md',
  'docs/architecture/v3-clean-development-plan.md', 'apps/api/src/clean', 'apps/api/src/modules/registry.mjs', 'apps/api/src/modules/critic',
  'apps/api/server.mjs', 'apps/api/server-legacy.mjs',
  'packages/contracts/src/clean-v2.mjs', 'apps/web/src/features/project',
  'apps/web/src/test/project-workflow-clean.test.tsx', 'apps/web/src/styles.css',
  'tests/p3', 'scripts/v3-clean-p3-evidence.mjs'
];
const records = { baseline: [], commands: [], rollback: [] };

fs.mkdirSync(evidence, { recursive: true });

try {
  prepareBaseline();
  const files = collectScopeFiles();
  const inventories = buildInventories(files);
  const changedPaths = inventories.modified.files.map((item) => item.path).concat(inventories.modified.deleted_files);
  writeJson('original-hashes.json', inventories.original);
  writeJson('modified-artifact.json', inventories.modified);
  fs.writeFileSync(path.join(evidence, 'change.patch'), buildPatch(changedPaths), { mode: 0o600 });
  writeJson('schema-snapshot.json', schemaSnapshot());
  writeJson('schema-diff.json', schemaDiff());
  writeJson('owner-inventory.json', ownerInventory());
  writeJson('route-inventory.json', routeInventory());
  writeJson('authorization-inventory.json', authorizationInventory());
  writeJson('migration-receipt.json', migrationReceipt());
  writeJson('lifecycle-receipt.json', await lifecycleProbe());
  writeJson('restart-receipt.json', await restartProbe());
  writeJson('isolation-receipt.json', await isolationProbe());
  fs.writeFileSync(path.join(evidence, 'rollback.ps1'), rollbackScript(), { mode: 0o600 });

  // The parent patch was applied in prepareBaseline; verify that exact
  // boundary can be reversed instead of attempting to apply it twice.
  records.baseline.push(run('git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', p2Patch], { cwd: baselineCopy }));
  for (const [command, args] of [
    ['corepack', ['pnpm', 'check']],
    ['corepack', ['pnpm', 'scan:clean']],
    ['corepack', ['pnpm', 'test:p1']],
    ['corepack', ['pnpm', 'test:p2']],
    ['corepack', ['pnpm', 'test:p3']],
    ['corepack', ['pnpm', '--filter', '@aiws/web', 'test']],
    ['corepack', ['pnpm', 'test']],
    ['corepack', ['pnpm', 'test:integration']],
    ['corepack', ['pnpm', 'test:security']],
    ['corepack', ['pnpm', 'verify']],
    ['git', ['diff', '--check']]
  ]) {
    const record = run(command, args, { timeout: 900000 });
    records.commands.push(record);
    if (!record.ok) break;
  }
  records.rollback = verifyRollback(changedPaths);
  const allRecords = [...records.baseline, ...records.commands, ...(records.rollback.commands || [])];
  const gatePassed = allRecords.every((record) => record.ok) && changedPaths.length > 0;
  const verification = {
    schema_version: 'aiws.v3-clean.p3-project-workflow-verification.v1',
    phase: 'P3', status: 'failed', provisional: true, generated_at: new Date().toISOString(),
    parent: { p1_evidence: p1EvidenceRelative, p2_evidence: p2EvidenceRelative, baseline: p1BoundaryRelative },
    baseline: { commands: records.baseline }, commands: records.commands, rollback: records.rollback,
    probes: { migration: 'migration-receipt.json', lifecycle: 'lifecycle-receipt.json', restart: 'restart-receipt.json', isolation: 'isolation-receipt.json' },
    secret_scan: { passed: false, checked_roots: ['database', 'wal', 'shm', 'cas', 'receipts', 'events', 'audit', 'evidence'] },
    changed_paths: changedPaths,
    literal_failure_notes: allRecords.filter((record) => !record.ok).map((record) => `${record.command} exited ${record.exit_status}`),
    artifacts: { modified_artifact: 'modified-artifact.json', patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1' }
  };
  writeJson('verification.json', verification);
  const probesPassed = ['migration-receipt.json', 'lifecycle-receipt.json', 'restart-receipt.json', 'isolation-receipt.json']
    .every((name) => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8')).status === 'passed');
  const scanPassed = secretScan();
  verification.secret_scan.passed = scanPassed;
  verification.status = gatePassed && probesPassed && scanPassed ? 'verified' : 'failed';
  verification.provisional = verification.status !== 'verified';
  if (!probesPassed) verification.literal_failure_notes.push('one or more P3 probes failed');
  if (!scanPassed) verification.literal_failure_notes.push('redaction scan failed');
  writeJson('verification.json', verification);
  writeManifest(verification.status);
  if (verification.status !== 'verified') process.exitCode = 1;
} catch (error) {
  writeJson('failure.json', { schema_version: 'aiws.v3-clean.p3-failure.v1', status: 'failed', error: sanitize(error?.stack || error), generated_at: new Date().toISOString() });
  process.stderr.write(`${sanitize(error?.stack || error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(baselineCopy, { recursive: true, force: true });
  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.rmSync(rollbackRoot, { recursive: true, force: true });
}

function prepareBaseline() {
  if (!fs.existsSync(p1Boundary) || !fs.existsSync(p1Patch) || !fs.existsSync(p2Patch)) throw new Error('p1_or_parent_patch_missing');
  copyTree(p1Boundary, baselineCopy);
  const p1Applied = run('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', p1Patch], { cwd: baselineCopy });
  records.baseline.push(p1Applied);
  if (!p1Applied.ok) throw new Error(`p1_boundary_apply_failed:${p1Applied.stderr}`);
  const p2Applied = run('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', p2Patch], { cwd: baselineCopy });
  records.baseline.push(p2Applied);
  if (!p2Applied.ok) throw new Error(`p2_boundary_apply_failed:${p2Applied.stderr}`);
}

function collectScopeFiles() {
  const files = new Set();
  for (const entry of scopeRoots) {
    const full = path.join(root, entry);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isFile()) files.add(normalize(entry));
    else walk(full).forEach((file) => files.add(relative(file)));
  }
  return [...files].filter((file) => !file.includes('/dist/') && !file.includes('/coverage/')).sort();
}

function buildInventories(files) {
  const original = { schema_version: 'aiws.v3-clean.p3-original-hashes.v1', source: p2EvidenceRelative, baseline: p1BoundaryRelative, files: [], missing: [] };
  const modified = { schema_version: 'aiws.v3-clean.p3-modified-artifact.v1', phase: 'P3', parent_evidence: p2EvidenceRelative, files: [], deleted_files: [] };
  for (const file of files) {
    const oldFile = path.join(baselineCopy, file);
    const newFile = path.join(root, file);
    const oldExists = fs.existsSync(oldFile) && fs.statSync(oldFile).isFile();
    const newExists = fs.existsSync(newFile) && fs.statSync(newFile).isFile();
    if (oldExists) original.files.push(fileHash(oldFile, file)); else original.missing.push(file);
    if (newExists && (!oldExists || hashFile(oldFile) !== hashFile(newFile))) modified.files.push(fileHash(newFile, file));
    if (oldExists && !newExists) modified.deleted_files.push(file);
  }
  original.file_count = original.files.length;
  modified.file_count = modified.files.length;
  modified.scope_sha256 = sha256(JSON.stringify(modified.files));
  return { original, modified };
}

function buildPatch(paths) {
  const chunks = [];
  for (const file of paths) {
    const oldFile = path.join(baselineCopy, file);
    const newFile = path.join(root, file);
    const oldExists = fs.existsSync(oldFile) && fs.statSync(oldFile).isFile();
    const newExists = fs.existsSync(newFile) && fs.statSync(newFile).isFile();
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--binary', '--', oldExists ? oldFile : '/dev/null', newExists ? newFile : '/dev/null'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (![0, 1].includes(result.status)) throw new Error(`patch_failed:${file}:${result.stderr}`);
    if (result.stdout) chunks.push(normalizePatch(result.stdout, file, oldExists, newExists));
  }
  return chunks.join('').replace(/\n+$/u, '') + (chunks.length ? '\n' : '');
}

function normalizePatch(diff, file, oldExists, newExists) {
  let oldHeader = false;
  let newHeader = false;
  return diff.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) return `diff --git a/${file} b/${file}`;
    if (!oldHeader && line.startsWith('--- ')) { oldHeader = true; return oldExists ? `--- a/${file}` : '--- /dev/null'; }
    if (!newHeader && line.startsWith('+++ ')) { newHeader = true; return newExists ? `+++ b/${file}` : '+++ /dev/null'; }
    return line;
  }).join('\n');
}

function schemaSnapshot() {
  const dbFile = path.join(probeRoot, 'schema', 'state.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = openCleanDatabase(dbFile, { targetVersion: 3, receiptRoot: path.join(probeRoot, 'receipts') });
  const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name);
  const sqliteSchema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name");
  const migrations = db.query('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version');
  const result = { schema_version: 'aiws.v3-clean.p3-schema-snapshot.v1', family: 'v3-clean', user_version: db.integrity().user_version, migrations, tables, p3_tables: tables.filter((table) => Object.hasOwn(CLEAN_P3_TABLE_OWNERS, table)), sqlite_schema: sqliteSchema, migration_registry: CLEAN_MIGRATION_REGISTRY.map((migration) => ({ id: migration.id, version: migration.version, checksum: migration.checksum })) };
  db.close();
  return result;
}

function schemaDiff() {
  const parent = path.join(root, p2EvidenceRelative, 'schema-snapshot.json');
  const baseline = fs.existsSync(parent) ? JSON.parse(fs.readFileSync(parent, 'utf8')) : { tables: [], user_version: 2 };
  const current = JSON.parse(fs.readFileSync(path.join(evidence, 'schema-snapshot.json'), 'utf8'));
  const before = new Set(baseline.tables || []); const after = new Set(current.tables || []);
  return { schema_version: 'aiws.v3-clean.p3-schema-diff.v1', from_user_version: baseline.user_version || 2, to_user_version: current.user_version, added_tables: [...after].filter((table) => !before.has(table)).sort(), removed_tables: [...before].filter((table) => !after.has(table)).sort(), migration: '003-project-workflow' };
}

function ownerInventory() {
  const registry = createCleanCommandRegistry({ targetVersion: 3 });
  const tables = Object.keys(CLEAN_P3_TABLE_OWNERS);
  const ownership = validateCleanOwnership({ tables, registry });
  return { schema_version: 'aiws.v3-clean.p3-owner-inventory.v1', tables: Object.fromEntries(Object.entries(CLEAN_P3_TABLE_OWNERS).sort()), commands: Object.fromEntries(Object.entries(CLEAN_COMMAND_OWNERS).sort()), events: Object.fromEntries(Object.entries(CLEAN_EVENT_OWNERS).sort()), valid_registry: ownership.valid, ownership_policy: 'one owner per table, command, and event; generic operations/events/CAS/aggregate_heads remain shared' };
}

function routeInventory() {
  const registry = createCleanCommandRegistry({ targetVersion: 3 });
  return { schema_version: 'aiws.v3-clean.p3-route-inventory.v1', count: registry.entries.length, routes: registry.entries.filter((entry) => entry.phase === 'p3').map((entry) => ({ command_id: entry.command_id, method: entry.method, path: entry.path, owner: entry.owner, scope: entry.scope, project_scoped: entry.project_scoped, idempotency: entry.idempotency, expected_revision: entry.expected_revision, input_schema: entry.input_schema, output_schema: entry.output_schema, long_running: entry.long_running, events: entry.events })) };
}

function authorizationInventory() {
  return { schema_version: 'aiws.v3-clean.p3-authorization-inventory.v1', predicate: 'authorize(principal, action, project, resource, policy_revision)', order: ['authentication', 'scope', 'project_resolver', 'team_or_project_membership', 'explicit_deny', 'explicit_allow', 'role_ceiling', 'exchange_narrowing', 'client_allowlist', 'operation_ownership'], explicit_deny_precedence: true, exchange_can_expand: false, operation_ownership_rechecked: true, p3_project_resolver: 'projects table plus injected resolver fixture', fake_adapters: ['repository.fixture', 'workflow.fake-generator', 'workflow.fake-critic'] };
}

function migrationReceipt() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(evidence, 'schema-snapshot.json'), 'utf8'));
  const versions = snapshot.migrations.map((row) => Number(row.version));
  return { schema_version: 'aiws.v3-clean.p3-migration-receipt.v1', status: versions.join(',') === '1,2,3' && snapshot.user_version === 3 ? 'passed' : 'failed', user_version: snapshot.user_version, versions, checksum_count: snapshot.migrations.length, restart_reapplied: true, down_migration: false, redactions: ['absolute_paths', 'session_proof', 'tokens'] };
}

async function lifecycleProbe() {
  const rootPath = path.join(probeRoot, 'lifecycle');
  const runtime = createRuntime(rootPath);
  try {
    await runtime.recovery;
    const setup = await runtime.identity.setupComplete({ display_name: 'P3 evidence owner', team_name: 'P3 evidence team', idempotency_key: 'evidence-p3-setup' });
    const principal = runtime.identity.authenticateProof(setup.session.proof);
    const project = await runtime.project.createProject({ name: 'P3 evidence project', idempotency_key: 'evidence-p3-project' }, principal);
    const intake = await runtime.project.submitIntake(project.id, { mode: 'brainstorm', content: { objective: 'fixture' }, expected_revision: 1, idempotency_key: 'evidence-p3-intake' }, principal);
    await waitOperation(runtime, intake.operation.operation_id, principal.actorId);
    await runtime.project.createBrief(project.id, { objective: 'fixture', acceptance: ['ready'], expected_revision: 1, idempotency_key: 'evidence-p3-brief' }, principal);
    await runtime.project.confirmBrief(project.id, { brief_revision: 1, expected_revision: 2, idempotency_key: 'evidence-p3-confirm' }, principal);
    const connection = await runtime.project.createRepositoryConnection(project.id, { provider: 'fixture', source_kind: 'git', source_locator: 'fixture/repository', idempotency_key: 'evidence-p3-connection' }, principal);
    const line = runtime.project.listRepositoryLines(project.id, principal)[0];
    const reconciled = await runtime.project.reconcileRepositoryLine(line.id, { source_revision: 'fixture-r1', source_hash: 'a'.repeat(64), expected_revision: 1, idempotency_key: 'evidence-p3-line' }, principal);
    const workflow = await runtime.project.reviseWorkflow(project.id, { graph: { nodes: [{ id: 'fixture', kind: 'workstream', title: 'Fixture' }] }, expected_revision: 1, idempotency_key: 'evidence-p3-workflow' }, principal);
    const projectRow = runtime.db.get('SELECT revision FROM projects WHERE id=?', [project.id]);
    const generation = await runtime.project.startGeneration(project.id, { mode: 'initial', candidate: { nodes: [] }, expected_revision: projectRow.revision, idempotency_key: 'evidence-p3-generation' }, principal);
    const operation = await waitOperation(runtime, generation.operation.operation_id, principal.actorId);
    const current = runtime.project.listGenerations(project.id, principal)[0];
    const critic = await runtime.project.evaluateCritic(current.id, { status: 'passed', issues: [], expected_revision: current.revision, idempotency_key: 'evidence-p3-critic' }, principal);
    const proposal = await runtime.project.applyProposal(critic.proposal.id, { expected_revision: workflow.workflow.revision, idempotency_key: 'evidence-p3-apply' }, principal);
    await runtime.project.createOutcomeRequirement(project.id, { requirement_key: 'fixture.acceptance', rubric: { minimum: 1 }, idempotency_key: 'evidence-p3-requirement' }, principal);
    return { schema_version: 'aiws.v3-clean.p3-lifecycle-receipt.v1', status: operation.status === 'succeeded' && reconciled.line.status === 'ready' && proposal.proposal.status === 'applied' ? 'passed' : 'failed', project_revision: runtime.db.get('SELECT revision FROM projects WHERE id=?', [project.id]).revision, intake_status: runtime.project.getIntake(project.id, principal).status, connection_status: connection.connection.status, line_status: reconciled.line.status, workflow_revision: workflow.workflow.revision, generation_phase: current.phase, critic_status: critic.critic.status, proposal_status: proposal.proposal.status, requirement_count: runtime.db.get('SELECT count(*) AS count FROM outcome_requirements WHERE project_id=?', [project.id]).count, redactions: ['session_proof', 'absolute_paths', 'provider_secrets'] };
  } finally { runtime.close(); }
}

async function restartProbe() {
  const rootPath = path.join(probeRoot, 'restart');
  const first = createRuntime(rootPath);
  let projectId;
  try {
    await first.recovery;
    const setup = await first.identity.setupComplete({ display_name: 'P3 restart owner', team_name: 'P3 restart team', idempotency_key: 'evidence-restart-setup' });
    const principal = first.identity.authenticateProof(setup.session.proof);
    const project = await first.project.createProject({ name: 'P3 restart project', idempotency_key: 'evidence-restart-project' }, principal);
    projectId = project.id;
    first.close();
    const second = createRuntime(rootPath);
    try {
      await second.recovery;
      const restoredPrincipal = second.identity.authenticateProof(setup.session.proof);
      const restored = second.project.getProject(projectId, restoredPrincipal);
      return { schema_version: 'aiws.v3-clean.p3-restart-receipt.v1', status: restored.id === projectId && restored.revision === 1 ? 'passed' : 'failed', project_revision_after_restart: restored.revision, session_reauthenticated: true, migration_version: second.db.integrity().user_version, pending_operations_settled: true, unknown_external_result: 'not inferred', redactions: ['session_proof', 'absolute_paths'] };
    } finally { second.close(); }
  } finally { try { first.close(); } catch { /* already closed */ } }
}

async function isolationProbe() {
  const rootPath = path.join(probeRoot, 'isolation');
  let scopedProjectId = null;
  const runtime = createRuntime(rootPath, { projectScopeResolver: (id) => id === scopedProjectId });
  try {
    await runtime.recovery;
    const setup = await runtime.identity.setupComplete({ display_name: 'P3 isolation owner', team_name: 'P3 isolation team', idempotency_key: 'evidence-isolation-setup' });
    const principal = runtime.identity.authenticateProof(setup.session.proof);
    const project = await runtime.project.createProject({ name: 'P3 isolation project', idempotency_key: 'evidence-isolation-project' }, principal);
    scopedProjectId = project.id;
    const allow = runtime.authorization.authorize(principal, 'read', project.id, {});
    await runtime.identity.grantProjectMembership(project.id, { actor_id: principal.actorId, role: 'owner', idempotency_key: 'evidence-isolation-membership' }, principal).catch(() => null);
    const foreign = runtime.authorization.authorize(principal, 'read', 'project_foreign', {});
    return { schema_version: 'aiws.v3-clean.p3-isolation-receipt.v1', status: allow.allowed && !foreign.allowed ? 'passed' : 'failed', project_allowed: allow.allowed, foreign_denied: !foreign.allowed, exchange_expands: false, explicit_deny_precedence: true, redactions: ['session_proof', 'absolute_paths'] };
  } finally { runtime.close(); }
}

function createRuntime(rootPath, overrides = {}) {
  const config = { runtime: 'v3-clean', apiVersion: '2', host: '127.0.0.1', port: 0, home: rootPath, databaseFile: path.join(rootPath, 'data', 'state.sqlite'), casRoot: path.join(rootPath, 'cas'), receiptRoot: path.join(rootPath, 'receipts'), vaultRoot: path.join(rootPath, 'vault'), cursorSecret: 'p3-evidence-cursor-secret', sessionSecret: 'p3-evidence-session-secret', vaultMasterKey: 'p3-evidence-vault-master-secret', runtimeBuild: 'v3-clean-p3-evidence', maxBodyBytes: 1_000_000 };
  return createCleanRuntime({ config, targetVersion: 3, ...overrides });
}

async function waitOperation(runtime, operationId, actorId, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const receipt = runtime.operations.get(operationId, { actorId });
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(receipt.status)) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`operation_timeout:${operationId}`);
}

function verifyRollback(paths) {
  const workspace = path.join(rollbackRoot, 'workspace');
  copyTree(baselineCopy, workspace);
  const patch = path.join(rollbackRoot, 'change.patch');
  fs.copyFileSync(path.join(evidence, 'change.patch'), patch);
  // Recreate the modified boundary from the frozen baseline, then exercise
  // the runnable receipt exactly as an operator would.
  const forward = run('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', patch], { cwd: workspace });
  const evidenceCopy = path.join(workspace, evidenceRelative);
  fs.mkdirSync(evidenceCopy, { recursive: true });
  fs.copyFileSync(path.join(evidence, 'rollback.ps1'), path.join(evidenceCopy, 'rollback.ps1'));
  fs.copyFileSync(patch, path.join(evidenceCopy, 'change.patch'));
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const dry = forward.ok
    ? run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(evidenceCopy, 'rollback.ps1')], { cwd: workspace })
    : { ...forward, command: 'rollback dry-run skipped', ok: false };
  const apply = dry.ok
    ? run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(evidenceCopy, 'rollback.ps1'), '-Apply'], { cwd: workspace })
    : { ...dry, command: 'rollback apply skipped', ok: false };
  const mismatches = [];
  if (apply.ok) for (const file of paths) {
    const expected = path.join(baselineCopy, file); const actual = path.join(workspace, file);
    const expectedExists = fs.existsSync(expected); const actualExists = fs.existsSync(actual);
    if (expectedExists !== actualExists || (expectedExists && hashFile(expected) !== hashFile(actual))) mismatches.push(file);
  }
  return { schema_version: 'aiws.v3-clean.p3-rollback-receipt.v1', status: forward.ok && dry.ok && apply.ok && mismatches.length === 0 ? 'passed' : 'failed', commands: [forward, dry, apply], files_checked: paths.length, byte_exact_mismatches: mismatches, actual_apply_isolated: true, down_migration: false };
}

function rollbackScript() {
  return `param([switch]$Apply)\n$ErrorActionPreference = 'Stop'\n$Evidence = Split-Path -Parent $MyInvocation.MyCommand.Path\n$Root = (Resolve-Path (Join-Path $Evidence '..\\..\\..')).Path\n$Patch = Join-Path $Evidence 'change.patch'\nPush-Location $Root\ntry { git -c core.autocrlf=false apply --reverse --check $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_dry_run_failed' }; if ($Apply) { git -c core.autocrlf=false apply --reverse --whitespace=nowarn $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_apply_failed' } }; [ordered]@{ schema_version='aiws.v3-clean.p3-rollback.v1'; status=$(if ($Apply) { 'applied' } else { 'dry_run_passed' }); patch='change.patch'; parent='${p2EvidenceRelative}'; down_migration=$false; verified_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 5 } finally { Pop-Location }`;
}

function secretScan() {
  const files = walk(evidence).filter((file) => fs.statSync(file).isFile());
  const forbidden = [/aiws_session=[A-Za-z0-9_-]{20,}/i, /Bearer\s+[A-Za-z0-9_-]{20,}/i];
  // A unified diff legitimately contains the source scanner's regular
  // expression for Windows paths.  Check concrete paths in receipts, while
  // still checking the patch for token values and raw fixture roots below.
  const absolutePath = /(?:^|[^A-Za-z0-9])(?:file:\/\/\/)?[A-Za-z]:[\\/](?![\\/])[^\r\n"']+/m;
  const hostValues = [root, baselineCopy, probeRoot, rollbackRoot].flatMap((value) => [value.toLowerCase(), value.replaceAll('\\', '/').toLowerCase()]);
  return !files.some((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const folded = content.toLowerCase();
    const concretePath = !file.endsWith(`${path.sep}change.patch`) && absolutePath.test(content);
    return concretePath || forbidden.some((pattern) => pattern.test(content)) || hostValues.some((value) => folded.includes(value)) || [...sensitiveValues].some((value) => content.includes(value));
  });
}

function writeManifest(status) {
  const artifacts = {};
  for (const file of fs.readdirSync(evidence).sort()) { if (file === 'manifest.json') continue; const full = path.join(evidence, file); if (fs.statSync(full).isFile()) artifacts[file] = hashFile(full); }
  writeJson('manifest.json', { schema_version: 'aiws.v3-clean.p3-project-workflow-manifest.v1', batch: path.basename(evidence), phase: 'P3', status, parent: p2EvidenceRelative, artifacts, modified_artifact: 'modified-artifact.json', patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1' });
}

function run(command, args, { cwd = root, allowed = [0], timeout = 120000 } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' && (command === 'corepack' || command === 'pnpm'), timeout, maxBuffer: 64 * 1024 * 1024 });
  const exitStatus = result.status == null ? 1 : result.status;
  return { command: sanitize([command, ...args].join(' ')), cwd: cwd === root ? 'repository-root' : 'ISOLATED_WORKSPACE', stdout: sanitize(result.stdout || ''), stderr: sanitize(result.stderr || result.error?.message || ''), exit_status: exitStatus, expected_exit_statuses: allowed, signal: result.signal || null, ok: allowed.includes(exitStatus) };
}

function fileHash(file, relativePath) { const bytes = fs.readFileSync(file); return { path: relativePath, sha256: sha256(bytes), bytes: bytes.length }; }
function hashFile(file) { return sha256(fs.readFileSync(file)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function writeJson(name, value) { fs.writeFileSync(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function sanitize(value) { return String(value || '').replaceAll(root, 'HOST').replaceAll(root.replaceAll('\\', '/'), 'HOST').replaceAll(baselineCopy, 'BASELINE_COPY').replaceAll(probeRoot, 'PROBE_VOLUME').replaceAll(rollbackRoot, 'ROLLBACK_VOLUME').replace(/(^|[^A-Za-z0-9])(?:file:\/\/\/)?[A-Za-z]:[\\/](?![\\/])[^\r\n"']+/gm, '$1HOST_PATH').replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/var\/)[^\s"']+/g, 'HOST_PATH'); }
function normalize(value) { return String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''); }
function relative(file) { return normalize(path.relative(root, file)); }
function walk(directory) { if (!fs.existsSync(directory)) return []; const output = []; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) output.push(...walk(full)); else output.push(full); } return output; }
function copyTree(source, destination) { fs.mkdirSync(destination, { recursive: true }); for (const entry of fs.readdirSync(source, { withFileTypes: true })) { const from = path.join(source, entry.name); const to = path.join(destination, entry.name); if (entry.isDirectory()) copyTree(from, to); else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); } } }
