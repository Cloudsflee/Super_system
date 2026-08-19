import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CLEAN_MIGRATION_REGISTRY,
  CLEAN_P2_TABLE_OWNERS,
  CLEAN_COMMAND_OWNERS,
  CLEAN_EVENT_OWNERS,
  createCleanCommandRegistry,
  createCleanRuntime,
  openCleanDatabase,
  AuthorizationService
} from '../apps/api/src/clean/index.mjs';

const root = process.cwd();
const evidenceRelative = 'docs/evidence/v3-clean-p2-identity-acl-20260819';
const evidence = path.join(root, evidenceRelative);
const p1EvidenceRelative = 'docs/evidence/v3-clean-p1-gate-contract-complete-20260819';
const p1Evidence = path.join(root, p1EvidenceRelative);
const p1BoundaryRelative = '.ai-workspace/v3-clean-p1-gate-contract-complete-baseline-20260819';
const p1Boundary = path.join(root, p1BoundaryRelative);
const p1Patch = path.join(p1Evidence, 'change.patch');
const sensitiveFixtureValues = new Set();
const scopeRoots = [
  'apps/api/src/clean', 'apps/api/clean-server.mjs', 'apps/api/server.mjs',
  'apps/api/src/modules/registry.mjs', 'apps/web/src/api.ts', 'apps/web/src/App.tsx',
  'apps/web/src/styles.css', 'apps/web/src/features/identity', 'apps/web/src/test/identity-access.test.tsx',
  'packages/contracts/src/clean-v2.mjs', 'packages/contracts/package.json',
  'tests/p2', 'docs/architecture/v3-clean-break.md', 'docs/architecture/v23-capability-matrix.md',
  'docs/architecture/clean-schema.md', 'docs/architecture/import-contract.md',
  'docs/architecture/api-v2-contract.md', 'docs/architecture/decision-log.md',
  'docs/architecture/v3-clean-development-plan.md', 'docs/testing.md', 'feature-catalog.json',
  'scripts/v3-clean-architecture-scan.mjs', 'scripts/recovery-governance.mjs', 'scripts/check.mjs',
  'scripts/verify.mjs', 'scripts/v3-clean-p2-evidence.mjs', 'scripts/lib/v3-clean-p1-scope.mjs', 'package.json'
];

fs.mkdirSync(evidence, { recursive: true });

const baselineCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p2-baseline-'));
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p2-probe-'));
const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p2-rollback-'));
const records = { baseline: [], commands: [], rollback: [] };
let scopeFiles = [];
let changedPaths = [];

try {
  prepareBaseline();
  scopeFiles = collectScopeFiles();
  const inventories = buildInventories(scopeFiles);
  changedPaths = inventories.modified.files.map((entry) => entry.path).concat(inventories.modified.deleted_files || []);
  writeJson('original-hashes.json', inventories.original);
  writeJson('modified-artifact.json', inventories.modified);
  fs.writeFileSync(path.join(evidence, 'change.patch'), buildPatch(changedPaths), { mode: 0o600 });
  writeJson('schema-snapshot.json', schemaSnapshot());
  writeJson('schema-diff.json', schemaDiff());
  writeJson('owner-inventory.json', ownerInventory());
  writeJson('route-inventory.json', routeInventory());
  writeJson('authorization-inventory.json', authorizationInventory());
  writeJson('isolation-receipt.json', await isolationProbe());
  writeJson('rebind-receipt.json', await rebindProbe());
  writeJson('gateway-denial-receipt.json', await gatewayDenialProbe());
  fs.writeFileSync(path.join(evidence, 'rollback.ps1'), rollbackScript(), { mode: 0o600 });

  records.baseline.push(run('git', ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--check', p1Patch], { cwd: baselineCopy }));
  const gates = [
    ['corepack', ['pnpm', 'check']],
    ['corepack', ['pnpm', 'scan:clean']],
    ['corepack', ['pnpm', 'test:p2']],
    ['corepack', ['pnpm', 'test:p1']],
    ['corepack', ['pnpm', '--filter', '@aiws/web', 'test']],
    ['corepack', ['pnpm', 'test']],
    ['corepack', ['pnpm', 'test:integration']],
    ['corepack', ['pnpm', 'test:security']],
    ['corepack', ['pnpm', 'verify']],
    ['git', ['diff', '--check']]
  ];
  for (const [command, args] of gates) {
    const record = run(command, args, { timeout: 900000 });
    records.commands.push(record);
    if (!record.ok) break;
  }
  records.rollback = verifyRollback(changedPaths);
  const all = [...records.baseline, ...records.commands, ...(records.rollback.commands || [])];
  const eligible = all.every((record) => record.ok) && changedPaths.length > 0;
  const verification = {
    schema_version: 'aiws.v3-clean.p2-identity-acl-verification.v1',
    phase: 'P2',
    status: 'failed',
    provisional: true,
    generated_at: new Date().toISOString(),
    baseline: {
      source: p1BoundaryRelative,
      parent_evidence: p1EvidenceRelative,
      commands: records.baseline
    },
    commands: records.commands,
    rollback: records.rollback,
    probes: {
      isolation: 'isolation-receipt.json',
      rebind: 'rebind-receipt.json',
      gateway_denial: 'gateway-denial-receipt.json'
    },
    secret_scan: { passed: false, checked_roots: ['database', 'wal', 'shm', 'cas', 'vault', 'events', 'audit', 'evidence'] },
    changed_paths: changedPaths,
    literal_failure_notes: all.filter((record) => !record.ok).map((record) => `${record.command} exited ${record.exit_status}`),
    artifacts: {
      modified_artifact: 'modified-artifact.json', patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1'
    }
  };
  writeJson('verification.json', verification);
  const scanPassed = secretScan();
  const valid = eligible && scanPassed;
  verification.status = valid ? 'verified' : 'failed';
  verification.provisional = !valid;
  verification.secret_scan.passed = scanPassed;
  if (!scanPassed) verification.literal_failure_notes.push('redaction scan failed');
  writeJson('verification.json', verification);
  writeManifest(valid ? 'verified' : 'failed');
  if (!valid) process.exitCode = 1;
} catch (error) {
  writeJson('failure.json', { schema_version: 'aiws.v3-clean.p2-failure.v1', status: 'failed', error: sanitize(error?.stack || error), generated_at: new Date().toISOString() });
  process.stderr.write(`${sanitize(error?.stack || error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(baselineCopy, { recursive: true, force: true });
  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.rmSync(rollbackRoot, { recursive: true, force: true });
}

function prepareBaseline() {
  if (!fs.existsSync(p1Boundary) || !fs.existsSync(p1Patch)) throw new Error('p1_verified_boundary_missing');
  copyTree(p1Boundary, baselineCopy);
  const applied = run('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', p1Patch], { cwd: baselineCopy });
  records.baseline.push(applied);
  if (!applied.ok) throw new Error(`p1_boundary_apply_failed:${applied.stderr}`);
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
  const original = { schema_version: 'aiws.v3-clean.p2-original-hashes.v1', source: p1BoundaryRelative, parent_patch: p1EvidenceRelative + '/change.patch', files: [], missing: [] };
  const modified = { schema_version: 'aiws.v3-clean.p2-modified-artifact.v1', phase: 'P2', parent_evidence: p1EvidenceRelative, baseline: p1BoundaryRelative, files: [], deleted_files: [] };
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

function schemaSnapshot() {
  const dbFile = path.join(probeRoot, 'schema', 'state.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = openCleanDatabase(dbFile, { targetVersion: 2, receiptRoot: path.join(probeRoot, 'receipts') });
  const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name);
  const sqliteSchema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name");
  const migrations = db.query('SELECT migration_id,version,family,name,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version');
  const userVersion = db.integrity().user_version;
  db.close();
  return { schema_version: 'aiws.v3-clean.p2-schema-snapshot.v1', family: 'v3-clean', user_version: userVersion, migrations, tables, p2_tables: tables.filter((table) => Object.hasOwn(CLEAN_P2_TABLE_OWNERS, table)), sqlite_schema: sqliteSchema, migration_registry: CLEAN_MIGRATION_REGISTRY.map((migration) => ({ id: migration.id, version: migration.version, checksum: migration.checksum })) };
}

function schemaDiff() {
  const baselineFile = path.join(p1Evidence, 'schema-snapshot.json');
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : { tables: [] };
  const current = schemaSnapshot();
  const before = new Set(baseline.tables || []);
  const after = new Set(current.tables || []);
  return { schema_version: 'aiws.v3-clean.p2-schema-diff.v1', from_user_version: baseline.user_version || 1, to_user_version: current.user_version, added_tables: [...after].filter((table) => !before.has(table)).sort(), removed_tables: [...before].filter((table) => !after.has(table)).sort(), migration: '002-identity-acl' };
}

function ownerInventory() {
  return { schema_version: 'aiws.v3-clean.p2-owner-inventory.v1', tables: Object.fromEntries(Object.entries(CLEAN_P2_TABLE_OWNERS).sort()), commands: Object.fromEntries(Object.entries(CLEAN_COMMAND_OWNERS).sort()), events: Object.fromEntries(Object.entries(CLEAN_EVENT_OWNERS).sort()), ownership_policy: 'one owner per table, command, and event; Exchange grants remain read-only to Identity' };
}

function routeInventory() {
  const registry = createCleanCommandRegistry();
  return { schema_version: 'aiws.v3-clean.p2-route-inventory.v1', count: registry.entries.length, routes: registry.entries.map((entry) => ({ command_id: entry.command_id, method: entry.method, path: entry.path, owner: entry.owner, scope: entry.scope, project_scoped: entry.project_scoped, idempotency: entry.idempotency, expected_revision: entry.expected_revision, input_schema: entry.input_schema, output_schema: entry.output_schema, long_running: entry.long_running, events: entry.events })) };
}

function authorizationInventory() {
  return { schema_version: 'aiws.v3-clean.p2-authorization-inventory.v1', predicate: 'authorize(principal, action, project, resource, policy_revision)', order: ['authentication', 'scope', 'project_resolver', 'team_or_project_membership', 'explicit_deny', 'explicit_allow', 'role_ceiling', 'exchange_narrowing', 'client_allowlist', 'operation_ownership'], roles: { team: ['owner', 'admin', 'member', 'observer'], project: ['owner', 'admin', 'editor', 'runner', 'reviewer', 'viewer'] }, explicit_deny_precedence: true, exchange_can_expand: false, gateway_business_persistence: false };
}

async function isolationProbe() {
  const rootPath = path.join(probeRoot, 'isolation');
  const config = probeConfig(rootPath);
  const runtime = createCleanRuntime({ config, projectScopeResolver: (id) => id === 'project_isolated' });
  const setup = await runtime.identity.setupComplete({ display_name: 'P2 owner', team_name: 'P2 team', idempotency_key: 'evidence-isolation-setup' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  const allowed = await runtime.identity.grantProjectMembership('project_isolated', { actor_id: principal.actorId, role: 'owner', idempotency_key: 'evidence-isolation-owner' }, principal);
  const decisionBefore = runtime.authorization.authorize(principal, 'read', 'project_isolated', {});
  await runtime.identity.setAclEntry('project_isolated', { principal_actor_id: principal.actorId, resource: '*', action: 'read', effect: 'deny', expected_revision: 0, idempotency_key: 'evidence-isolation-deny' }, principal);
  const decisionAfter = runtime.authorization.authorize(principal, 'read', 'project_isolated', {}, 1);
  const foreign = runtime.authorization.authorize(principal, 'read', 'project_foreign', {});
  runtime.close();
  return { schema_version: 'aiws.v3-clean.p2-isolation-receipt.v1', status: decisionBefore.allowed && !decisionAfter.allowed && !foreign.allowed ? 'passed' : 'failed', checks: { team_project_allowed_before_deny: decisionBefore.allowed, explicit_deny_after_owner: !decisionAfter.allowed && decisionAfter.code === 'permission_denied', cross_project_denied: !foreign.allowed && foreign.code === 'project_denied', membership_revision: allowed.membership.revision }, redactions: ['session_proof', 'absolute_paths'] };
}

async function rebindProbe() {
  const rootPath = path.join(probeRoot, 'rebind');
  const config = probeConfig(rootPath);
  const runtime = createCleanRuntime({ config });
  const setup = await runtime.identity.setupComplete({ display_name: 'P2 owner', team_name: 'P2 team', idempotency_key: 'evidence-rebind-setup' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  const created = await runtime.identity.createCredential({ provider: 'codex', external_ref: 'opaque-evidence-ref', idempotency_key: 'evidence-credential-create' }, principal);
  const sentinel = `fixture-${sha256(`${rootPath}:provider-proof`)}`;
  sensitiveFixtureValues.add(sentinel);
  const result = await runtime.identity.rebindCredential(created.credential.id, { proof: sentinel, expected_revision: 1, idempotency_key: 'evidence-credential-rebind' }, principal);
  const dbBytes = persistedBytes(config.databaseFile);
  const vaultFiles = walk(config.vaultRoot).filter((file) => file.endsWith('.vault'));
  const eventValues = runtime.db.query('SELECT data_json AS value FROM events UNION ALL SELECT data_json FROM audit_events UNION ALL SELECT payload_json AS value FROM receipt_manifests').map((row) => row.value).join('\n');
  const persisted = dbBytes.some((bytes) => bytes.includes(Buffer.from(sentinel))) || vaultFiles.some((file) => fs.readFileSync(file).includes(Buffer.from(sentinel))) || eventValues.includes(sentinel);
  const entries = runtime.vault.entries().length;
  runtime.close();
  return { schema_version: 'aiws.v3-clean.p2-rebind-receipt.v1', status: result.status === 'succeeded' && !persisted ? 'passed' : 'failed', credential_status: 'active', operation_status: result.status, vault_entry_count: entries, proof_persisted: persisted, redactions: ['proof', 'ciphertext', 'session_cookie', 'absolute_paths'] };
}

async function gatewayDenialProbe() {
  const rootPath = path.join(probeRoot, 'gateway');
  const config = probeConfig(rootPath);
  const runtime = createCleanRuntime({ config, projectScopeResolver: (id) => id === 'project_gateway' });
  const setup = await runtime.identity.setupComplete({ display_name: 'P2 owner', team_name: 'P2 team', idempotency_key: 'evidence-gateway-setup' });
  const principal = runtime.identity.authenticateProof(setup.session.proof);
  await runtime.identity.grantProjectMembership('project_gateway', { actor_id: principal.actorId, role: 'owner', idempotency_key: 'evidence-gateway-owner' }, principal);
  const gatewayAuthorization = new AuthorizationService({ db: runtime.db, projectScopeResolver: (id) => id === 'project_gateway', clientAllowlist: () => false });
  const decision = gatewayAuthorization.authorize(principal, 'read', 'project_gateway', { resource: 'gateway.fixture' });
  runtime.close();
  return { schema_version: 'aiws.v3-clean.p2-gateway-denial-receipt.v1', status: !decision.allowed && decision.code === 'permission_denied' ? 'passed' : 'failed', decision: { allowed: decision.allowed, code: decision.code, message: decision.message }, persistence: 'no Gateway business table or write path', redactions: ['proof', 'absolute_paths'] };
}

function probeConfig(base) {
  const cursorSecret = `fixture-${sha256(`${base}:cursor`)}`;
  const sessionSecret = `fixture-${sha256(`${base}:session`)}`;
  const vaultMasterKey = `fixture-${sha256(`${base}:vault`)}`;
  sensitiveFixtureValues.add(cursorSecret);
  sensitiveFixtureValues.add(sessionSecret);
  sensitiveFixtureValues.add(vaultMasterKey);
  return { runtime: 'v3-clean', apiVersion: '2', home: base, databaseFile: path.join(base, 'data', 'state.sqlite'), casRoot: path.join(base, 'cas'), receiptRoot: path.join(base, 'receipts'), vaultRoot: path.join(base, 'vault'), cursorSecret, sessionSecret, vaultMasterKey, runtimeBuild: 'p2-evidence', maxBodyBytes: 100000 };
}

function verifyRollback(paths) {
  const result = [];
  const source = path.join(rollbackRoot, 'workspace');
  copyTree(baselineCopy, source);
  const patchPath = path.join(rollbackRoot, 'change.patch');
  fs.copyFileSync(path.join(evidence, 'change.patch'), patchPath);
  const evidenceCopy = path.join(source, evidenceRelative);
  fs.mkdirSync(evidenceCopy, { recursive: true });
  fs.copyFileSync(path.join(evidence, 'rollback.ps1'), path.join(evidenceCopy, 'rollback.ps1'));
  fs.copyFileSync(patchPath, path.join(evidenceCopy, 'change.patch'));
  result.push(run('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', patchPath], { cwd: source }));
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  result.push(run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(evidenceCopy, 'rollback.ps1')], { cwd: source }));
  result.push(run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(evidenceCopy, 'rollback.ps1'), '-Apply'], { cwd: source }));
  const mismatches = [];
  for (const file of paths) {
    const before = path.join(baselineCopy, file);
    const after = path.join(source, file);
    if (fs.existsSync(before) !== fs.existsSync(after) || (fs.existsSync(before) && hashFile(before) !== hashFile(after))) mismatches.push(file);
  }
  return { schema_version: 'aiws.v3-clean.p2-rollback-receipt.v1', status: result.every((entry) => entry.ok) && mismatches.length === 0 ? 'passed' : 'failed', commands: result, files_checked: paths.length, byte_exact_mismatches: mismatches, actual_apply_isolated: true, down_migration: false };
}

function rollbackScript() {
  return `param([switch]$Apply)\n$ErrorActionPreference = 'Stop'\n$Evidence = Split-Path -Parent $MyInvocation.MyCommand.Path\n$Root = (Resolve-Path (Join-Path $Evidence '..\\..\\..')).Path\n$Patch = Join-Path $Evidence 'change.patch'\nPush-Location $Root\ntry {\n  git -c core.autocrlf=false apply --reverse --check $Patch\n  if ($LASTEXITCODE -ne 0) { throw 'rollback_dry_run_failed' }\n  if ($Apply) { git -c core.autocrlf=false apply --reverse --whitespace=nowarn $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_apply_failed' } }\n  [ordered]@{ schema_version='aiws.v3-clean.p2-rollback.v1'; status=$(if ($Apply) { 'applied' } else { 'dry_run_passed' }); patch='change.patch'; parent='${p1EvidenceRelative}'; down_migration=$false; verified_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 5\n} finally { Pop-Location }\n`;
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

function writeManifest(status) {
  const artifacts = {};
  for (const file of fs.readdirSync(evidence).sort()) {
    if (file === 'manifest.json') continue;
    const full = path.join(evidence, file);
    if (fs.statSync(full).isFile()) artifacts[file] = hashFile(full);
  }
  writeJson('manifest.json', { schema_version: 'aiws.v3-clean.p2-identity-acl-manifest.v1', batch: path.basename(evidence), phase: 'P2', status, parent: p1EvidenceRelative, artifacts, modified_artifact: 'modified-artifact.json', patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1' });
}

function secretScan() {
  const files = walk(evidence).filter((file) => fs.statSync(file).isFile());
  const forbidden = [/aiws_session=[A-Za-z0-9_-]{20,}/i, /Bearer\s+[A-Za-z0-9_-]{20,}/i];
  const hostPaths = [root, baselineCopy, probeRoot, rollbackRoot]
    .flatMap((value) => [value, value.replaceAll('\\', '/')])
    .map((value) => value.toLowerCase());
  return !files.some((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const folded = content.toLowerCase();
    return forbidden.some((pattern) => pattern.test(content))
      || hostPaths.some((value) => folded.includes(value))
      || [...sensitiveFixtureValues].some((value) => content.includes(value));
  });
}

function run(command, args, { cwd = root, allowed = [0], timeout = 120000 } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' && (command === 'corepack' || command === 'pnpm'), timeout, maxBuffer: 64 * 1024 * 1024 });
  const exitStatus = result.status == null ? 1 : result.status;
  return { command: sanitize([command, ...args].join(' ')), cwd: cwd === root ? 'repository-root' : sanitize(path.relative(root, cwd)), stdout: sanitize(result.stdout || ''), stderr: sanitize(result.stderr || result.error?.message || ''), exit_status: exitStatus, expected_exit_statuses: allowed, signal: result.signal || null, ok: allowed.includes(exitStatus) };
}

function persistedBytes(file) { return [file, `${file}-wal`, `${file}-shm`].filter((candidate) => fs.existsSync(candidate)).map((candidate) => fs.readFileSync(candidate)); }
function fileHash(file, relativePath) { const bytes = fs.readFileSync(file); return { path: relativePath, sha256: sha256(bytes), bytes: bytes.length }; }
function hashFile(file) { return sha256(fs.readFileSync(file)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function writeJson(name, value) { fs.writeFileSync(path.join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function sanitize(value) {
  return String(value || '')
    .replaceAll(root, 'HOST')
    .replaceAll(root.replaceAll('\\', '/'), 'HOST')
    .replaceAll(baselineCopy, 'BASELINE_COPY')
    .replaceAll(baselineCopy.replaceAll('\\', '/'), 'BASELINE_COPY')
    .replaceAll(probeRoot, 'PROBE_VOLUME')
    .replaceAll(probeRoot.replaceAll('\\', '/'), 'PROBE_VOLUME')
    .replaceAll(rollbackRoot, 'ROLLBACK_VOLUME')
    .replaceAll(rollbackRoot.replaceAll('\\', '/'), 'ROLLBACK_VOLUME')
    .replace(/(^|[^A-Za-z0-9])(?:file:\/\/\/)?[A-Za-z]:[\\/](?![\\/])[^\r\n"']+/gm, '$1HOST_PATH')
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/var\/)[^\s"']+/g, 'HOST_PATH');
}
function normalize(value) { return String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''); }
function relative(file) { return normalize(path.relative(root, file)); }
function walk(directory) { if (!fs.existsSync(directory)) return []; const output = []; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) output.push(...walk(full)); else output.push(full); } return output; }
function copyTree(source, destination) { fs.mkdirSync(destination, { recursive: true }); for (const entry of fs.readdirSync(source, { withFileTypes: true })) { const from = path.join(source, entry.name); const to = path.join(destination, entry.name); if (entry.isDirectory()) copyTree(from, to); else fs.copyFileSync(from, to); } }
