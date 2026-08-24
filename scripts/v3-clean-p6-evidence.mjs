import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openCleanDatabase, schemaSnapshotHash } from '../apps/api/src/clean/database.mjs';
import { CLEAN_P6_MIGRATION_REGISTRY } from '../apps/api/src/clean/migration-service.mjs';
import { CLEAN_P6_TABLE_OWNERS, CLEAN_COMMAND_OWNERS, CLEAN_EVENT_OWNERS, validateCleanOwnership } from '../apps/api/src/clean/ownership.mjs';
import { createCleanCommandRegistry, registryParity } from '../apps/api/src/clean/registry.mjs';
import { APP_SERVER_SCHEMA_SHA256 } from '../apps/api/src/clean/app-server-adapter.mjs';
import {
  RUNNER_JOB_SPEC_VERSION, RUNNER_RECEIPT_VERSION, RUNNER_RESOURCE_PROFILES, RUNNER_STAGES
} from '../apps/api/src/clean/runner-protocol.mjs';
import {
  loadCatalogIndex, loadCatalogLayers, validateCatalogLayers,
  validateP6EvidenceManifest
} from './catalog-loader.mjs';
import { ImmutableEvidenceWriter } from './lib/immutable-evidence-writer.mjs';

const root = process.cwd();
const baseline = '54381746da0f01fd60da2e11ed247f2ed2f11c8b';
const phase = 'P6';
const evidenceRelative = 'docs/evidence/v3-clean-p6-runner-execution-20260824';
const evidenceRoot = path.join(root, evidenceRelative);
const finalVerification = path.join(evidenceRoot, 'verification.json');
const P6_TABLES = Object.freeze([
  'execution_events', 'execution_inputs', 'execution_stage_checkpoints', 'executions',
  'job_specs', 'runner_profiles', 'runner_receipts', 'task_attempts'
]);
const resumeArg = process.argv.find((value) => value.startsWith('--resume='));
const requestedRun = resumeArg ? resumeArg.slice('--resume='.length) : null;
const supersede = process.argv.includes('--supersede');
const verifyOnly = process.argv.includes('--verify');
const existing = readJson(finalVerification);
const existingManifest = readJson(path.join(evidenceRoot, 'manifest.json'));
const supersededRunId = supersede && existing?.status === 'verified' && existing?.provisional === false ? String(existingManifest?.run_id || '') : '';
if (verifyOnly) {
  const result = verifyPublishedEvidence();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === 'passed' ? 0 : 1);
}
if (existing?.status === 'verified' && existing?.provisional === false && !requestedRun && !supersede) throw new Error('verified_evidence_is_immutable');
if (supersede && !supersededRunId) throw new Error('supersede_source_manifest_invalid');

fs.mkdirSync(evidenceRoot, { recursive: true });
const writer = requestedRun
  ? new ImmutableEvidenceWriter(evidenceRoot, { runId: requestedRun, resume: true }).resume(requestedRun)
  : new ImmutableEvidenceWriter(evidenceRoot, { runId: `run-${Date.now()}` });
const commandRecords = [];
let published = false;

try {
  write('catalog-staging.json', {
    schema_version: 'aiws.v3-clean.p6-catalog-staging.v1', phase, status: 'staging', provisional: true,
    run_id: writer.runId, final_reference: `${evidenceRelative}/verification.json`
  });
  write('preflight.json', {
    schema_version: 'aiws.v3-clean.p6-preflight.v1', phase, baseline, generated_at: new Date().toISOString(),
    Target: 'P6 Runner/Execution/Checkpoint/Replay synchronized receipt, baseline=54381746da0f01fd60da2e11ed247f2ed2f11c8b',
    '目标': 'schema v6, three real Runner adapters, recoverable seven-stage execution, Catalog 21/6/27, and immutable P6 Evidence',
    Goal: 'schema v6, Docker/Host/Windows Bridge runners, recoverable seven-stage execution and non-provisional P6 Evidence',
    'Non-target': 'P7 Parser/Quality/Outcome, P8 GitHub Delivery/Importer, P9 Offline/Release',
    '非目标': 'complete Evidence asset chain, real pull request, production cutover, and release claim',
    Forbidden: ['/api/v1 active route', 'legacy runtime import', 'second operation/event/CAS/head model', 'API Docker socket', 'secret/token/full prompt/host absolute path in public or Evidence envelope'],
    '禁止项': ['modify P1-P5 migrations or verified Evidence', 'overwrite existing worktree changes', 'promote a provisional receipt'],
    Reuse: ['P1-P5 operations/events/heads/idempotency/ACL/Vault/CAS/dispatcher/approval', 'Context Pack', 'repository workspace lease', 'Windows Bridge pairing'],
    '复用项': ['verified P5 runtime', 'generic ledger and CAS', 'Approval owner', 'Repository fencing lease', 'Bridge pairing'],
    'Delete/retire': ['active runtime dependency on historical Broker/execution contracts', 'active Web dependency on historical Runner/Execution APIs'],
    '删除/退役': ['historical Broker runtime dependency', 'historical Execution/Runner API dependency'],
    Acceptance_commands: acceptanceCommands().map(([command, args]) => [command, ...args].join(' ')),
    '验收命令': 'P1-P6 gates, P6 performance/probes, Web/Clean/full gates, evidence:p6, verify, and git diff --check',
    Rollback_artifact: `${evidenceRelative}/rollback.ps1`,
    '回滚工件': `${evidenceRelative}/rollback.ps1`,
    last_confirmed_result: 'Docker, Host, Windows Bridge and restart probes passed non-provisionally', next_action: 'run synchronized P6 gates and publish immutable Evidence'
  });

  const original = hashInventory(baseline);
  const modified = hashInventory(null);
  const changed = changedPaths(original, modified);
  write('original-hashes.json', original);
  write('modified-artifact.json', { ...modified, baseline, changed_files: changed });
  writeText('change.patch', buildPatch(changed));

  const schema = schemaInventory();
  write('schema-inventory.json', schema);
  write('owner-inventory.json', ownerInventory(schema.tables.map((entry) => entry.name)));
  write('route-inventory.json', routeInventory());
  write('protocol-inventory.json', protocolInventory());
  write('catalog-inventory.json', catalogInventory());
  write('migration-receipt.json', migrationReceipt());
  createRollbackSnapshot();
  writeText('rollback.ps1', rollbackScript());

  const previousStagingRoot = process.env.AIWS_P6_EVIDENCE_STAGING_ROOT;
  process.env.AIWS_P6_EVIDENCE_STAGING_ROOT = writer.attemptRoot;
  try {
    for (const [command, args] of acceptanceCommands()) commandRecords.push(run(command, args, { timeout: 1_800_000 }));
  } finally {
    if (previousStagingRoot == null) delete process.env.AIWS_P6_EVIDENCE_STAGING_ROOT;
    else process.env.AIWS_P6_EVIDENCE_STAGING_ROOT = previousStagingRoot;
  }
  const docker = commandJsonReceipt(commandRecords.find((record) => record.command.includes('p6-docker-runner-probe')), 'aiws.v3-clean.p6-docker-runner-probe-record.v1');
  const host = commandJsonReceipt(commandRecords.find((record) => record.command.includes('p6-host-runner-probe')), 'aiws.v3-clean.p6-host-runner-probe-record.v1');
  const bridge = commandJsonReceipt(commandRecords.find((record) => record.command.includes('p6-bridge-runner-probe')), 'aiws.v3-clean.p6-bridge-runner-probe-record.v1');
  const restart = commandJsonReceipt(commandRecords.find((record) => record.command.includes('p6-restart-probe')), 'aiws.v3-clean.p6-restart-probe-record.v1');
  const performance = commandJsonReceipt(commandRecords.find((record) => record.command.includes('p6-performance')), 'aiws.v3-clean.p6-performance-record.v1');
  const browser = browserReceipt(commandRecords.find((record) => record.command === 'pnpm test:e2e'));
  write('docker-runner-probe.json', docker);
  write('host-runner-probe.json', host);
  write('bridge-runner-probe.json', bridge);
  write('restart-probe.json', restart);
  write('performance-receipt.json', performance);
  write('browser-receipt.json', browser);
  write('gate-results.json', { schema_version: 'aiws.v3-clean.p6-gate-results.v1', commands: commandRecords });

  const rollback = verifyRollback();
  write('rollback-receipt.json', rollback);
  const secretScan = scanEvidence([...writer.created]);
  write('secret-scan.json', secretScan);
  const migration = readJson(path.join(writer.attemptRoot, 'migration-receipt.json'));
  const blockingFailure = commandRecords.find((record) => !record.ok)
    || (docker.status === 'passed' ? null : { command: 'docker-runner-probe', exit_status: 1, summary: 'failed' })
    || (host.status === 'passed' ? null : { command: 'host-runner-probe', exit_status: 1, summary: 'failed' })
    || (bridge.status === 'passed' ? null : { command: 'bridge-probe', exit_status: 1, summary: 'failed' })
    || (restart.status === 'passed' ? null : { command: 'restart-probe', exit_status: 1, summary: 'failed' })
    || (performance.status === 'passed' ? null : { command: 'performance-probe', exit_status: 1, summary: 'failed' })
    || (browser.status === 'passed' ? null : { command: 'browser-probe', exit_status: 1, summary: 'failed' })
    || (migration?.status === 'passed' ? null : { command: 'migration-receipt', exit_status: 1, summary: migration?.failures?.join(',') || 'failed' })
    || (rollback.status === 'passed' ? null : { command: 'rollback-receipt', exit_status: 1, summary: rollback.byte_exact_mismatches.join(',') })
    || (secretScan.status === 'passed' ? null : { command: 'secret-scan', exit_status: 1, summary: secretScan.findings.join(',') });
  const verification = {
    schema_version: 'aiws.v3-clean.p6-verification.v1', phase, status: blockingFailure ? 'failed' : 'verified', provisional: Boolean(blockingFailure),
    generated_at: new Date().toISOString(), run_id: writer.runId, ...(supersededRunId ? { supersedes_run_id: supersededRunId } : {}),
    baseline, target_schema_version: 6,
    catalog_promotion: ['REC-D3-RUNNER-003', 'REC-D6-EXECUTION-008'],
    implemented_only: [],
    unchanged_statuses: { 'REC-D10-FRONTEND-024': 'scaffolded', 'REC-D6-OUTCOME-009': 'scaffolded' },
    blocking_failure: blockingFailure ? { command: blockingFailure.command, exit_status: blockingFailure.exit_status, summary: blockingFailure.summary } : null,
    commands: commandRecords,
    probes: { docker: { artifact: 'docker-runner-probe.json', status: docker.status, provisional: docker.receipt?.provisional }, host: { artifact: 'host-runner-probe.json', status: host.status, provisional: host.receipt?.provisional }, bridge: { artifact: 'bridge-runner-probe.json', status: bridge.status, provisional: bridge.receipt?.provisional }, restart: { artifact: 'restart-probe.json', status: restart.status, provisional: restart.receipt?.provisional }, performance: { artifact: 'performance-receipt.json', status: performance.status }, browser: { artifact: 'browser-receipt.json', status: browser.status }, migration: { artifact: 'migration-receipt.json', status: migration?.status }, rollback: { artifact: 'rollback-receipt.json', status: rollback.status }, secret_scan: { artifact: 'secret-scan.json', status: secretScan.status } },
    changed_paths: changed,
    artifacts: { modified_artifact: 'modified-artifact.json', patch: 'change.patch', verification: 'verification.json', rollback: 'rollback.ps1' },
    rollback: { dry_run_command: 'powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -DryRun', isolated_apply_command: 'powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -Apply -IsolatedRoot <TARGET>', down_migration: false, source_reverse_check: rollback.source_reverse_check, restored_user_version: rollback.restored_user_version, foreign_key_check: rollback.foreign_key_check, migration_ledger: rollback.migration_ledger, p6_tables_absent: rollback.p6_tables_absent, restored_components: rollback.restored_components, byte_exact_mismatches: rollback.byte_exact_mismatches },
    redactions: ['host_absolute_paths', 'cookies', 'session_proofs', 'tokens', 'full_prompts', 'provider_credentials']
  };
  write('verification.json', verification);
  const artifactReopen = reopenArtifacts(verification);
  write('artifact-reopen.json', artifactReopen);
  if (artifactReopen.status !== 'passed') throw new Error('artifact_reopen_failed');
  writeManifest(verification);
  if (!blockingFailure) {
    publishFinal();
    published = true;
    const index = loadCatalogIndex(root); const layers = loadCatalogLayers(root, index); const validation = validateCatalogLayers({ root, index, layers });
    if (!validation.valid) throw new Error(`published_catalog_invalid:${validation.failures.join(',')}`);
  }
  process.stdout.write(`${JSON.stringify({ status: verification.status, provisional: verification.provisional, run_id: writer.runId, evidence: evidenceRelative, published, blocking_failure: blockingFailure?.command || null }, null, 2)}\n`);
  if (blockingFailure) process.exitCode = 1;
} catch (error) {
  const failure = { schema_version: 'aiws.v3-clean.p6-generation-failure.v1', phase, status: 'failed', provisional: true, run_id: writer.runId, generated_at: new Date().toISOString(), error: redact(error?.stack || error) };
  try { if (!writer.created.has('failure.json')) write('failure.json', failure); } catch {}
  process.stderr.write(`${failure.error}\n`); process.exitCode = 1;
}

function acceptanceCommands() {
  return [
    ['pnpm', ['check']], ['pnpm', ['scan:clean']], ['pnpm', ['test:p6']],
    ['node', ['scripts/v3-clean-p6-docker-runner-probe.mjs']], ['node', ['scripts/v3-clean-p6-host-runner-probe.mjs']],
    ['node', ['scripts/v3-clean-p6-bridge-runner-probe.mjs']], ['node', ['scripts/v3-clean-p6-restart-probe.mjs']], ['node', ['scripts/v3-clean-p6-performance.mjs']],
    ['pnpm', ['--filter', '@aiws/web', 'test']], ['pnpm', ['test:e2e']], ['git', ['diff', '--check']]
  ];
}

function verifyPublishedEvidence() {
  const failures = [];
  if (!existing || existing.status !== 'verified' || existing.provisional !== false) failures.push('final_verification_not_verified');
  if (!existingManifest || existingManifest.status !== 'verified' || existingManifest.provisional !== false) failures.push('final_manifest_not_verified');
  if (existing && existingManifest && existing.run_id !== existingManifest.run_id) failures.push('run_id_mismatch');
  for (const failure of validateP6EvidenceManifest(evidenceRoot, existing || {})) failures.push(`manifest:${failure}`);
  let catalog = null;
  try {
    const index = loadCatalogIndex(root);
    const layers = loadCatalogLayers(root, index);
    const validation = validateCatalogLayers({ root, index, layers });
    catalog = validation.counts;
    if (!validation.valid) failures.push(...validation.failures.map((failure) => `catalog:${failure}`));
  } catch (error) {
    failures.push(`catalog:${String(error?.message || error)}`);
  }
  return {
    schema_version: 'aiws.v3-clean.p6-evidence-verify.v1',
    status: failures.length ? 'failed' : 'passed',
    provisional: false,
    run_id: existing?.run_id || null,
    catalog,
    failures: [...new Set(failures)].sort()
  };
}

function schemaInventory() {
  return withDatabase(6, (database) => {
    const names = database.query("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
    const tables = names.filter((entry) => entry.type === 'table').map((entry) => ({ name: entry.name, owner: CLEAN_P6_TABLE_OWNERS[entry.name] || null, columns: database.query(`PRAGMA table_info('${String(entry.name).replaceAll("'", "''")}')`).map((column) => ({ name: column.name, type: column.type, not_null: Boolean(column.notnull), primary_key: Number(column.pk) })) }));
    return { schema_version: 'aiws.v3-clean.p6-schema-inventory.v1', family: database.metadata.family, user_version: database.integrity().user_version, migration_id: '006-runner-execution-checkpoint-replay', snapshot_sha256: schemaSnapshotHash(database.db), p6_tables: P6_TABLES, tables, indexes: names.filter((entry) => entry.type === 'index').map((entry) => entry.name), triggers: names.filter((entry) => entry.type === 'trigger').map((entry) => entry.name) };
  });
}

function ownerInventory(tables) {
  const registry = createCleanCommandRegistry({ targetVersion: 6 }); const validation = validateCleanOwnership({ tables, registry });
  return { schema_version: 'aiws.v3-clean.p6-owner-inventory.v1', status: validation.valid ? 'passed' : 'failed', validation, table_owners: Object.fromEntries(P6_TABLES.map((name) => [name, CLEAN_P6_TABLE_OWNERS[name]])), command_owners: Object.fromEntries(Object.entries(CLEAN_COMMAND_OWNERS).filter(([id]) => registry.get(id)?.phase === 'p6')), event_owners: Object.fromEntries(Object.entries(CLEAN_EVENT_OWNERS).filter(([id]) => /^(?:runner|execution|task)/.test(id))) };
}

function routeInventory() {
  const registry = createCleanCommandRegistry({ targetVersion: 6 });
  return { schema_version: 'aiws.v3-clean.p6-route-inventory.v1', active_api: '/api/v2', retired_api: '/api/v1', routes: registry.entries.filter((entry) => entry.phase === 'p6').map((entry) => ({ command_id: entry.command_id, method: entry.method, path: entry.path, owner: entry.owner, input_schema: entry.input_schema, output_schema: entry.output_schema, idempotency: entry.idempotency, expected_revision: entry.expected_revision, transport_allowlist: entry.transport_allowlist, mcp: entry.mcp })) };
}

function protocolInventory() {
  const registry = createCleanCommandRegistry({ targetVersion: 6 }); const parity = registryParity(registry);
  return { schema_version: 'aiws.v3-clean.p6-protocol-inventory.v1', status: parity.valid ? 'passed' : 'failed', transports: ['REST', 'Web', 'MCP Streamable HTTP', 'MCP stdio', 'Gateway HTTP'], registry_parity: parity, app_server_schema_sha256: APP_SERVER_SCHEMA_SHA256, job_spec: RUNNER_JOB_SPEC_VERSION, runner_receipt: RUNNER_RECEIPT_VERSION, stages: RUNNER_STAGES, resource_profiles: RUNNER_RESOURCE_PROFILES, broker_transport: 'timestamp-nonce-body-sha256-hmac', bridge_protocols: ['aiws.bridge.pairing.v1', 'aiws.windows-bridge.identity.v1', 'runner.job.submit/status/cancel.v1'] };
}

function catalogInventory() {
  const previous = process.env.AIWS_P6_EVIDENCE_STAGING_ROOT; process.env.AIWS_P6_EVIDENCE_STAGING_ROOT = writer.attemptRoot;
  try { const index = loadCatalogIndex(root); const layers = loadCatalogLayers(root, index); const validation = validateCatalogLayers({ root, index, layers }); return { schema_version: 'aiws.v3-clean.p6-catalog-inventory.v1', status: validation.valid ? 'passed' : 'failed', validation, clean_ids: layers.clean.features.map((feature) => feature.id), historical_ids: layers.historical.features.map((feature) => feature.id), promoted_ids: ['REC-D3-RUNNER-003', 'REC-D6-EXECUTION-008'], unchanged_statuses: { 'REC-D10-FRONTEND-024': 'scaffolded', 'REC-D6-OUTCOME-009': 'scaffolded' } }; }
  finally { if (previous == null) delete process.env.AIWS_P6_EVIDENCE_STAGING_ROOT; else process.env.AIWS_P6_EVIDENCE_STAGING_ROOT = previous; }
}

function migrationReceipt() {
  const upgrades = []; const failures = [];
  for (const startVersion of [0, 1, 2, 3, 4, 5]) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-migration-')); let database;
    try {
      const file = path.join(fixture, 'state.sqlite'); const receipts = path.join(fixture, 'receipts');
      if (startVersion > 0) { database = openCleanDatabase(file, { targetVersion: startVersion, receiptRoot: receipts }); database.close(); database = null; }
      database = openCleanDatabase(file, { targetVersion: 6, receiptRoot: receipts }); const integrity = database.integrity();
      const p6Tables = database.query(`SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${P6_TABLES.map(() => '?').join(',')}) ORDER BY name`, P6_TABLES).map((entry) => entry.name);
      const passed = integrity.user_version === 6 && integrity.foreign_key_check.length === 0 && JSON.stringify(p6Tables) === JSON.stringify(P6_TABLES);
      if (!passed) failures.push(`upgrade_from_${startVersion}`);
      upgrades.push({ start_version: startVersion, end_version: integrity.user_version, p6_tables: p6Tables, snapshot_sha256: schemaSnapshotHash(database.db), status: passed ? 'passed' : 'failed' });
    } catch (error) { failures.push(`upgrade_from_${startVersion}`); upgrades.push({ start_version: startVersion, status: 'failed', error: String(error?.code || error?.message || error) }); }
    finally { database?.close(); fs.rmSync(fixture, { recursive: true, force: true }); }
  }
  return { schema_version: 'aiws.v3-clean.p6-migration-receipt.v1', status: failures.length ? 'failed' : 'passed', registry: CLEAN_P6_MIGRATION_REGISTRY.map(({ version, id, checksum }) => ({ version, id, checksum })), upgrades, failures };
}

function createRollbackSnapshot() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-rollback-source-')); let database;
  try {
    const file = path.join(fixture, 'state.sqlite'); database = openCleanDatabase(file, { targetVersion: 5, receiptRoot: path.join(fixture, 'receipts') }); database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); const integrity = database.integrity(); const ledger = database.query('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version');
    const presentP6Tables = database.query(`SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${P6_TABLES.map(() => '?').join(',')}) ORDER BY name`, P6_TABLES).map((entry) => entry.name); database.close(); database = null;
    const bytes = fs.readFileSync(file);
    const componentInputs = {
      cas: { root: 'data/cas', files: [{ path: 'objects/p5-baseline-object', bytes: Buffer.from('p5-cas-object\n') }] },
      vault: { root: 'data/vault', files: [{ path: 'metadata.json', bytes: Buffer.from('{"schema_version":"aiws.v3-clean.rollback-vault.v1","credential_state":"rebind_required"}\n') }] },
      workspace: { root: 'workspace', files: [{ path: 'checkpoint.json', bytes: Buffer.from('{"schema_version":"aiws.v3-clean.rollback-workspace.v1","revision":5}\n') }] },
      broker: { root: 'broker', files: [{ path: 'identity.json', bytes: Buffer.from('{"schema_version":"aiws.v3-clean.rollback-broker.v1","identity":"public-metadata-only"}\n') }] },
      bridge: { root: 'bridge', files: [{ path: 'state.json', bytes: Buffer.from('{"schema_version":"aiws.v3-clean.rollback-bridge.v1","nonce_journal":[],"leases":[]}\n') }] }
    };
    const components = Object.fromEntries(Object.entries(componentInputs).map(([name, component]) => {
      const files = component.files.map((entry) => ({ path: entry.path, bytes: entry.bytes.length, sha256: sha256(entry.bytes), base64: entry.bytes.toString('base64') }));
      return [name, { root: component.root, files, tree_sha256: sha256(JSON.stringify(files.map(({ path: filePath, bytes: length, sha256: hash }) => ({ path: filePath, bytes: length, sha256: hash })))) }];
    }));
    const componentSnapshot = { schema_version: 'aiws.v3-clean.p6-rollback-components.v1', components };
    const componentBytes = Buffer.from(`${JSON.stringify(componentSnapshot, null, 2)}\n`);
    write('rollback-v5.sqlite', bytes); write('rollback-components-v5.json', componentSnapshot);
    write('rollback-snapshot.json', {
      schema_version: 'aiws.v3-clean.p6-rollback-snapshot.v1',
      status: integrity.user_version === 5 && integrity.foreign_key_check.length === 0 && presentP6Tables.length === 0 ? 'passed' : 'failed',
      database: { file: 'rollback-v5.sqlite', sha256: sha256(bytes), bytes: bytes.length, user_version: integrity.user_version, foreign_key_check: integrity.foreign_key_check },
      components: { file: 'rollback-components-v5.json', sha256: sha256(componentBytes), roles: ['cas', 'vault', 'workspace', 'broker', 'bridge'] },
      migration_ledger: ledger, present_p6_tables: presentP6Tables, p6_tables_absent: presentP6Tables.length === 0 ? P6_TABLES : P6_TABLES.filter((name) => !presentP6Tables.includes(name))
    });
  } finally { database?.close(); fs.rmSync(fixture, { recursive: true, force: true }); }
}

function rollbackScript() {
  return String.raw`param([switch]$DryRun,[switch]$Apply,[string]$IsolatedRoot,[string]$SourceRoot)
$ErrorActionPreference='Stop'
if (($DryRun -and $Apply) -or (-not $DryRun -and -not $Apply)) { throw 'choose_exactly_one_mode' }
$Evidence=(Resolve-Path $PSScriptRoot).Path
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot=$Evidence; while ($SourceRoot -and -not (Test-Path (Join-Path $SourceRoot '.git'))) { $Parent=Split-Path -Parent $SourceRoot; if ($Parent -eq $SourceRoot) { $SourceRoot=$null } else { $SourceRoot=$Parent } }; if (-not $SourceRoot) { throw 'rollback_repo_root_missing' } }
$SourceRoot=[IO.Path]::GetFullPath($SourceRoot); $Patch=Join-Path $Evidence 'change.patch'; $Original=Get-Content (Join-Path $Evidence 'original-hashes.json') -Raw | ConvertFrom-Json; $Modified=Get-Content (Join-Path $Evidence 'modified-artifact.json') -Raw | ConvertFrom-Json; $Snapshot=Join-Path $Evidence 'rollback-v5.sqlite'; $ComponentsFile=Join-Path $Evidence 'rollback-components-v5.json'; $SnapshotMeta=Get-Content (Join-Path $Evidence 'rollback-snapshot.json') -Raw | ConvertFrom-Json; $Components=Get-Content $ComponentsFile -Raw | ConvertFrom-Json
function Get-FileSha256([string]$Path) { $Stream=[IO.File]::OpenRead($Path); $Hasher=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-','').ToLowerInvariant() } finally { $Hasher.Dispose(); $Stream.Dispose() } }
function Get-BytesSha256([byte[]]$Bytes) { $Hasher=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $Hasher.Dispose() } }
function Resolve-Child([string]$Base,[string]$Relative) { if ([IO.Path]::IsPathRooted($Relative) -or (($Relative -split '[\\/]') -contains '..')) { throw 'rollback_relative_path_invalid' }; $BaseFull=[IO.Path]::GetFullPath($Base); $Target=[IO.Path]::GetFullPath((Join-Path $BaseFull $Relative)); $Prefix=$BaseFull.TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar; if (-not $Target.StartsWith($Prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'rollback_relative_path_invalid' }; return $Target }
$Mismatches=[Collections.Generic.List[string]]::new()
if ((Get-FileSha256 $Snapshot) -ne [string]$SnapshotMeta.database.sha256) { $Mismatches.Add('snapshot:sqlite') }
if ((Get-FileSha256 $ComponentsFile) -ne [string]$SnapshotMeta.components.sha256) { $Mismatches.Add('snapshot:components') }
foreach ($Property in $Components.components.PSObject.Properties) { foreach ($File in @($Property.Value.files)) { $Payload=[Convert]::FromBase64String([string]$File.base64); if ($Payload.Length -ne [int]$File.bytes -or (Get-BytesSha256 $Payload) -ne [string]$File.sha256) { $Mismatches.Add(('snapshot:'+ $Property.Name + ':' + [string]$File.path)) } } }
& git -C $SourceRoot -c core.autocrlf=false apply --reverse --check $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
if ($DryRun) { $MismatchJson=if ($Mismatches.Count -eq 0) { '[]' } else { @($Mismatches)|ConvertTo-Json -Compress }; Write-Output 'rollback_mode=dry-run'; Write-Output 'source_reverse_check=passed'; Write-Output ('byte_exact_mismatches='+$MismatchJson); if ($Mismatches.Count -ne 0) { throw 'rollback_snapshot_mismatch' }; exit 0 }
if ([string]::IsNullOrWhiteSpace($IsolatedRoot)) { $IsolatedRoot=Join-Path $env:TEMP ('aiws-p6-rollback-'+[guid]::NewGuid().ToString('N')) }
$IsolatedRoot=[IO.Path]::GetFullPath($IsolatedRoot); if ($IsolatedRoot -eq $SourceRoot -or $IsolatedRoot -eq $Evidence) { throw 'rollback_isolated_root_invalid' }; if ((Test-Path -LiteralPath $IsolatedRoot) -and (@(Get-ChildItem -LiteralPath $IsolatedRoot -Force).Count -gt 0)) { throw 'rollback_isolated_root_not_empty' }; New-Item -ItemType Directory -Path $IsolatedRoot -Force | Out-Null
& git -C $SourceRoot -c core.autocrlf=false apply --reverse --whitespace=nowarn $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_source_apply_failed' }
$OriginalMap=@{}; foreach ($Entry in @($Original.files)) { $OriginalMap[[string]$Entry.path]=$Entry }; foreach ($Relative in @($Modified.changed_files)) { $Target=Resolve-Child $SourceRoot ([string]$Relative); if ($OriginalMap.ContainsKey([string]$Relative)) { if (-not (Test-Path -LiteralPath $Target -PathType Leaf) -or (Get-FileSha256 $Target) -ne [string]$OriginalMap[[string]$Relative].sha256) { $Mismatches.Add(('source:'+ [string]$Relative)) } } elseif (Test-Path -LiteralPath $Target) { $Mismatches.Add(('source_orphan:'+ [string]$Relative)) } }
$Data=Join-Path $IsolatedRoot 'data'; New-Item -ItemType Directory -Path $Data -Force | Out-Null; $DatabaseTarget=Join-Path $Data 'state.sqlite'; Copy-Item $Snapshot $DatabaseTarget
$Restored=[ordered]@{sqlite=$false;cas=$false;vault=$false;workspace=$false;broker=$false;bridge=$false}; $Restored.sqlite=((Get-FileSha256 $DatabaseTarget) -eq [string]$SnapshotMeta.database.sha256)
foreach ($Property in $Components.components.PSObject.Properties) { $Name=$Property.Name; $Component=$Property.Value; $ComponentRoot=Resolve-Child $IsolatedRoot ([string]$Component.root); New-Item -ItemType Directory -Path $ComponentRoot -Force | Out-Null; $ComponentOk=$true; foreach ($File in @($Component.files)) { $Target=Resolve-Child $ComponentRoot ([string]$File.path); New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null; $Payload=[Convert]::FromBase64String([string]$File.base64); [IO.File]::WriteAllBytes($Target,$Payload); if ((Get-FileSha256 $Target) -ne [string]$File.sha256) { $Mismatches.Add(('component:'+ $Name + ':' + [string]$File.path)); $ComponentOk=$false } }; $Restored[$Name]=$ComponentOk }
$Probe=@'
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.argv[2],{readOnly:true});
const n=v=>Object.fromEntries(Object.entries(v).map(([k,x])=>[k,typeof x==='bigint'?Number(x):x]));
const p6=['execution_events','execution_inputs','execution_stage_checkpoints','executions','job_specs','runner_profiles','runner_receipts','task_attempts'];
const present=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x=>x.name));
const r={user_version:Number(db.prepare("PRAGMA user_version").get().user_version),foreign_key_check:db.prepare("PRAGMA foreign_key_check").all().map(n),migration_ledger:db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map(n),p6_tables_absent:p6.filter(x=>!present.has(x))};
db.close(); process.stdout.write(JSON.stringify(r));
'@
$ProbeJson=$Probe | & node - $DatabaseTarget; if ($LASTEXITCODE -ne 0) { throw 'rollback_database_probe_failed' }; $Db=$ProbeJson | ConvertFrom-Json; if ([int]$Db.user_version -ne 5) { $Mismatches.Add('user_version') }; if (@($Db.foreign_key_check).Count -ne 0) { $Mismatches.Add('foreign_key_check') }; $Ledger=@($Db.migration_ledger | % {[int]$_.version}); if (($Ledger -join ',') -ne '1,2,3,4,5') { $Mismatches.Add('migration_ledger') }; if ((@($Db.p6_tables_absent) -join ',') -ne 'execution_events,execution_inputs,execution_stage_checkpoints,executions,job_specs,runner_profiles,runner_receipts,task_attempts') { $Mismatches.Add('p6_tables_absent') }; foreach ($Role in @('sqlite','cas','vault','workspace','broker','bridge')) { if ($Restored[$Role] -ne $true) { $Mismatches.Add(('restored_component:'+ $Role)) } }
$ForeignKeyJson=if (@($Db.foreign_key_check).Count -eq 0) { '[]' } else { @($Db.foreign_key_check)|ConvertTo-Json -Compress }; $MismatchJson=if ($Mismatches.Count -eq 0) { '[]' } else { @($Mismatches)|ConvertTo-Json -Compress }; $LedgerJson=@($Ledger)|ConvertTo-Json -Compress; $P6AbsentJson=@($Db.p6_tables_absent)|ConvertTo-Json -Compress; $RestoredJson=$Restored|ConvertTo-Json -Compress
Write-Output 'rollback_mode=apply'; Write-Output 'source_reverse_check=passed'; Write-Output ('user_version='+[int]$Db.user_version); Write-Output ('foreign_key_check='+$ForeignKeyJson); Write-Output ('migration_ledger='+$LedgerJson); Write-Output ('p6_tables_absent='+$P6AbsentJson); Write-Output ('restored_components='+$RestoredJson); Write-Output ('byte_exact_mismatches='+$MismatchJson); if ($Mismatches.Count -ne 0) { throw 'rollback_byte_exact_mismatch' }`;
}

function verifyRollback() {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'; const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-rollback-verify-')); const source = path.join(fixture, 'source'); const isolated = path.join(fixture, 'isolated'); fs.mkdirSync(source, { recursive: true });
  let dry; let apply; const mismatches = [];
  try {
    materializeBaseline(source); run('git', ['init', '-q'], { cwd: source });
    dry = run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(writer.attemptRoot, 'rollback.ps1'), '-DryRun', '-SourceRoot', root], { timeout: 300_000 });
    const forward = run('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', path.join(writer.attemptRoot, 'change.patch')], { cwd: source, timeout: 300_000 });
    apply = forward.ok ? run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(writer.attemptRoot, 'rollback.ps1'), '-Apply', '-SourceRoot', source, '-IsolatedRoot', isolated], { timeout: 300_000 }) : forward;
    if (!dry.ok || !apply.ok || !String(apply.stdout || '').includes('byte_exact_mismatches=[]')) mismatches.push('rollback_execution');
    const snapshot = readJson(path.join(writer.attemptRoot, 'rollback-snapshot.json'));
    const components = readJson(path.join(writer.attemptRoot, 'rollback-components-v5.json'));
    const restoredComponents = { sqlite: false, cas: false, vault: false, workspace: false, broker: false, bridge: false };
    const restored = path.join(isolated, 'data', 'state.sqlite'); if (fs.existsSync(restored) && sha256(fs.readFileSync(restored)) === snapshot?.database?.sha256) restoredComponents.sqlite = true; else mismatches.push('restored_database');
    for (const [name, component] of Object.entries(components?.components || {})) {
      const valid = component.files.every((entry) => { const target = path.join(isolated, component.root, entry.path); return fs.existsSync(target) && sha256(fs.readFileSync(target)) === entry.sha256; });
      restoredComponents[name] = valid; if (!valid) mismatches.push(`restored_component:${name}`);
    }
    const original = readJson(path.join(writer.attemptRoot, 'original-hashes.json')); const modified = readJson(path.join(writer.attemptRoot, 'modified-artifact.json')); const originalMap = new Map((original?.files || []).map((entry) => [entry.path, entry.sha256]));
    for (const file of modified?.changed_files || []) { const target = path.join(source, file); const expected = originalMap.get(file); if (expected ? (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== expected) : fs.existsSync(target)) mismatches.push(`restored_source:${file}`); }
    let restoredUserVersion = null; let foreignKeyCheck = null; let migrationLedger = null; let p6TablesAbsent = [];
    if (fs.existsSync(restored)) { const db = new DatabaseSync(restored, { readOnly: true }); try { restoredUserVersion = Number(db.prepare('PRAGMA user_version').get().user_version); foreignKeyCheck = db.prepare('PRAGMA foreign_key_check').all().map(normalizeSqliteRow); migrationLedger = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((entry) => Number(entry.version)); const present = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((entry) => entry.name)); p6TablesAbsent = P6_TABLES.filter((name) => !present.has(name)); } finally { db.close(); } }
    if (restoredUserVersion !== 5) mismatches.push('restored_user_version');
    if (!Array.isArray(foreignKeyCheck) || foreignKeyCheck.length) mismatches.push('restored_foreign_key_check');
    if (JSON.stringify(migrationLedger) !== JSON.stringify([1, 2, 3, 4, 5])) mismatches.push('restored_migration_ledger');
    if (JSON.stringify(p6TablesAbsent) !== JSON.stringify(P6_TABLES)) mismatches.push('restored_p6_tables');
    for (const role of Object.keys(restoredComponents)) if (restoredComponents[role] !== true) mismatches.push(`restored_component:${role}`);
    const unique = [...new Set(mismatches)].sort();
    return { schema_version: 'aiws.v3-clean.p6-rollback-receipt.v1', status: unique.length ? 'failed' : 'passed', dry_run: dry, isolated_apply: apply, source_reverse_check: dry.ok && apply.ok && !unique.some((entry) => entry.startsWith('restored_source:')) ? 'passed' : 'failed', restored_user_version: restoredUserVersion, foreign_key_check: foreignKeyCheck, migration_ledger: migrationLedger, p6_tables_absent: p6TablesAbsent, restored_components: restoredComponents, byte_exact_mismatches: unique };
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

function materializeBaseline(destination) {
  const files = gitText(['ls-tree', '-r', '--name-only', baseline]).split(/\r?\n/).filter(Boolean);
  for (const file of files) { const bytes = gitBlob(baseline, file); if (!bytes) continue; const target = path.join(destination, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
}

function scanEvidence(names) {
  const findings = []; const checked = [];
  const hostPathExemptFiles = new Set(['change.patch']);
  const sensitiveFields = /^(?:assembled_prompt|full_prompt|provider_credential)$/i;
  const redactedValues = new Set(['', '<redacted>', '[redacted]', '<token>', 'memory_only']);
  const inspectStructured = (value, name) => {
    if (Array.isArray(value)) { for (const item of value) inspectStructured(item, name); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, fieldValue] of Object.entries(value)) {
      if (sensitiveFields.test(key) && fieldValue != null && !redactedValues.has(String(fieldValue).toLowerCase())) findings.push(`${name}:prompt_or_credential_field`);
      inspectStructured(fieldValue, name);
    }
  };
  for (const name of names) {
    const file = path.join(writer.attemptRoot, name);
    if (!fs.existsSync(file) || path.extname(name) === '.sqlite') continue;
    const value = fs.readFileSync(file, 'utf8'); checked.push(name);
    if (!hostPathExemptFiles.has(name) && /[A-Za-z]:\\[^\n]{2,}|\/(?:Users|home|root|tmp)\/[^\n]{2,}/i.test(value)) findings.push(`${name}:host_absolute_path`);
    if (/(?:Bearer\s+(?!<TOKEN>|\$\{)[A-Za-z0-9._~+/=-]{12,}|aiws_session=(?!<TOKEN>|\$\{)[A-Za-z0-9._~-]{12,}|sk-[A-Za-z0-9_-]{16,})/i.test(value)) findings.push(`${name}:secret_like_value`);
    if (path.extname(name) === '.json') { try { inspectStructured(JSON.parse(value), name); } catch { findings.push(`${name}:invalid_json`); } }
  }
  return { schema_version: 'aiws.v3-clean.p6-secret-scan.v1', status: findings.length ? 'failed' : 'passed', findings: [...new Set(findings)].sort(), checked_files: checked, host_path_exempt_files: { 'change.patch': 'source code contains container mount and redaction-fixture path literals' }, redactions: ['host_absolute_paths', 'cookies', 'session_proofs', 'tokens', 'full_prompts', 'provider_credentials'] };
}

function commandJsonReceipt(record, schemaVersion) { const parsed = parseJson(record?.stdout); return { schema_version: schemaVersion, status: record?.ok && parsed?.status === 'passed' && parsed?.provisional !== true ? 'passed' : 'failed', command: record || null, receipt: parsed }; }
function browserReceipt(record) {
  const local = path.join(root, '.ai-workspace', 'e2e-clean-p6', 'receipt.json');
  const receipt = readJson(local);
  const valid = receipt?.schema_version === 'aiws.v3-clean.p6-e2e-receipt.v1' && receipt?.status === 'passed' && receipt?.provisional === false
    && JSON.stringify(receipt?.viewports) === JSON.stringify(['mobile', 'laptop', 'desktop'])
    && ['execution', 'connections'].every((route) => receipt?.routes?.includes(route))
    && receipt?.legacy_api_v1_requests?.length === 0 && receipt?.browser_errors?.length === 0 && receipt?.http_errors?.length === 0
    && receipt?.layouts?.every((layout) => layout.horizontal_overflow === false && layout.overlaps?.length === 0)
    && receipt?.execution?.status === 'completed' && receipt?.execution?.generation === 2 && receipt?.execution?.approval_wait_resumed === true && receipt?.execution?.replayed_stage === 'deliver'
    && receipt?.runner_profile?.status === 'ready';
  return { schema_version: 'aiws.v3-clean.p6-browser-record.v1', status: record?.ok && valid ? 'passed' : 'failed', command: record || null, receipt: receipt ? redactObject(receipt) : null };
}
function reopenArtifacts(verification) { const roles = verification.artifacts; const checks = Object.entries(roles).map(([role, file]) => ({ role, file, exists: fs.existsSync(path.join(writer.attemptRoot, file)), sha256: fs.existsSync(path.join(writer.attemptRoot, file)) ? sha256(fs.readFileSync(path.join(writer.attemptRoot, file))) : null })); return { schema_version: 'aiws.v3-clean.p6-artifact-reopen.v1', status: checks.every((entry) => entry.exists) ? 'passed' : 'failed', checks }; }
function writeManifest(verification) { const files = [...writer.created].filter((name) => !['catalog-staging.json', 'manifest.json'].includes(name)).sort(); write('manifest.json', { schema_version: 'aiws.v3-clean.p6-manifest.v1', phase, status: verification.status, provisional: verification.provisional, run_id: writer.runId, ...(supersededRunId ? { supersedes_run_id: supersededRunId } : {}), baseline, files, hashes: Object.fromEntries(files.map((name) => [name, sha256(fs.readFileSync(path.join(writer.attemptRoot, name)))])), artifacts: verification.artifacts }); }
function publishFinal() { if (fs.existsSync(finalVerification)) archiveTopLevel(); for (const name of [...writer.created].filter((entry) => entry !== 'catalog-staging.json').sort()) { const source = path.join(writer.attemptRoot, name); const target = path.join(evidenceRoot, name); fs.copyFileSync(source, target); if (sha256(fs.readFileSync(source)) !== sha256(fs.readFileSync(target))) throw new Error(`evidence_publish_hash_mismatch:${name}`); } }
function archiveTopLevel() { const archive = path.join(evidenceRoot, 'attempts', `superseded-final-${supersededRunId || 'provisional'}-${Date.now()}`); fs.mkdirSync(archive, { recursive: false }); for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) if (entry.isFile()) fs.renameSync(path.join(evidenceRoot, entry.name), path.join(archive, entry.name)); }
function hashInventory(revision) { const files = revision ? gitText(['ls-tree', '-r', '--name-only', revision]).split(/\r?\n/).filter(Boolean) : gitText(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean); const governed = [...new Set(files.map(normalize).filter(isGoverned))].sort(); return { schema_version: 'aiws.v3-clean.p6-hash-inventory.v1', revision: revision || 'working-tree', files: governed.map((file) => { const bytes = revision ? gitBlob(revision, file) : readFile(path.join(root, file)); return bytes ? { path: file, sha256: sha256(bytes), bytes: bytes.length } : null; }).filter(Boolean) }; }
function isGoverned(file) { const value = normalize(file); return value === 'AGENTS.md' || value === 'package.json' || /^feature-catalog(?:\.(?:clean|historical|index))?\.json$/.test(value) || value === 'docs/testing.md' || value.startsWith('docs/architecture/') || value.startsWith('apps/api/') || value.startsWith('apps/runner-broker/') || value.startsWith('apps/windows-native-bridge/') || value.startsWith('apps/web/src/') || value.startsWith('packages/contracts/src/clean-v2.mjs') || value.startsWith('scripts/') || value.startsWith('tests/p1/') || value.startsWith('tests/p4/') || value.startsWith('tests/p5/') || value.startsWith('tests/p6/'); }
function changedPaths(original, modified) { const before = new Map(original.files.map((entry) => [entry.path, entry.sha256])); const after = new Map(modified.files.map((entry) => [entry.path, entry.sha256])); return [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file)).sort(); }
function buildPatch(paths) { if (!paths.length) throw new Error('p6_patch_has_no_changed_paths'); const index = path.join(os.tmpdir(), `aiws-p6-index-${process.pid}-${Date.now()}`); const env = { ...process.env, GIT_INDEX_FILE: index }; try { const tree = spawnSync('git', ['read-tree', baseline], { cwd: root, env, encoding: 'utf8', windowsHide: true }); if (tree.status !== 0) throw new Error('p6_patch_read_tree_failed'); const add = spawnSync('git', ['add', '-A', '--', ...paths], { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 }); if (add.status !== 0) throw new Error('p6_patch_stage_failed'); const diff = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--cached', '--binary', '--full-index', baseline, '--', ...paths], { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 }); if (diff.status !== 0 || !diff.stdout) throw new Error('p6_patch_build_failed'); return diff.stdout; } finally { fs.rmSync(index, { force: true }); fs.rmSync(`${index}.lock`, { force: true }); } }
function withDatabase(version, callback) { const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p6-evidence-db-')); let database; try { database = openCleanDatabase(path.join(fixture, 'state.sqlite'), { targetVersion: version, receiptRoot: path.join(fixture, 'receipts') }); return callback(database); } finally { database?.close(); fs.rmSync(fixture, { recursive: true, force: true }); } }
function run(command, args, { cwd = root, timeout = 120_000 } = {}) { const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command; const result = spawnSync(executable, args, { cwd, env: { ...process.env }, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' && command === 'pnpm', timeout, maxBuffer: 128 * 1024 * 1024 }); const exit_status = result.status == null ? 1 : result.status; const stdout = redact(result.stdout || ''); const stderr = redact(result.stderr || result.error?.message || ''); return { command: redact([command, ...args].join(' ')), cwd: cwd === root ? 'repository-root' : 'ISOLATED_TARGET', input: { args: args.map((value) => redact(value)) }, stdout, stderr, exit_status, expected_exit_statuses: [0], signal: result.signal || null, ok: exit_status === 0, summary: `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-12).join('\n').slice(0, 4000) }; }
function parseJson(value) { const text = String(value || '').trim(); try { return JSON.parse(text); } catch {} const start = text.indexOf('{'); const end = text.lastIndexOf('}'); if (start >= 0 && end > start) try { return JSON.parse(text.slice(start, end + 1)); } catch {} return null; }
function gitText(args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 }); if (result.status !== 0) throw new Error(`git_command_failed:${args.join(' ')}`); return result.stdout || ''; }
function gitBlob(revision, file) { const result = spawnSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024 }); return result.status === 0 ? result.stdout : null; }
function readFile(file) { try { return fs.readFileSync(file); } catch { return null; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function normalizeSqliteRow(value) { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'bigint' ? Number(item) : item])); }
function normalize(value) { return String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function redact(value) { let text = String(value || ''); for (const candidate of [root, writer?.attemptRoot].filter(Boolean)) text = text.replaceAll(candidate, '<ROOT>').replaceAll(candidate.replaceAll('\\', '/'), '<ROOT>'); return text.replace(/Bearer\s+\S+/gi, 'Bearer <TOKEN>').replace(/aiws_session=[^;\s]+/gi, 'aiws_session=<TOKEN>').replace(/(?:[A-Za-z]:\\|\/(?:Users|home|root|tmp)\/)[^\s"']+/g, '<PATH>'); }
function redactObject(value, key = '') { if (Array.isArray(value)) return value.map((item) => redactObject(item, key)); if (!value || typeof value !== 'object') return typeof value === 'string' ? redact(value) : value; if (/^(?:cookie|proof|token|credential|assembled_prompt|full_prompt)$/i.test(key)) return '<redacted>'; return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactObject(item, name)])); }
function write(name, value) { return writer.write(name, value); }
function writeText(name, value) { return writer.writeText(name, value); }
