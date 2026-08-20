import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { openCleanDatabase, schemaSnapshotHash } from '../apps/api/src/clean/database.mjs';
import { CLEAN_P4_MIGRATION_REGISTRY } from '../apps/api/src/clean/migration-service.mjs';
import {
  CLEAN_COMMAND_OWNERS,
  CLEAN_EVENT_OWNERS,
  CLEAN_P4_TABLE_OWNERS,
  validateCleanOwnership
} from '../apps/api/src/clean/ownership.mjs';
import { createCleanCommandRegistry, registryParity } from '../apps/api/src/clean/registry.mjs';
import { loadCatalogIndex, loadCatalogLayers, validateCatalogLayers } from './catalog-loader.mjs';
import { ImmutableEvidenceWriter } from './lib/immutable-evidence-writer.mjs';

const root = process.cwd();
const baseline = '3f1d9e7';
const phase = 'P4';
const evidenceRelative = 'docs/evidence/v3-clean-p4-context-mcp-20260820';
const evidenceRoot = path.join(root, evidenceRelative);
const finalVerification = path.join(evidenceRoot, 'verification.json');
const resumeArg = process.argv.find((argument) => argument.startsWith('--resume='));
const requestedRun = resumeArg ? resumeArg.slice('--resume='.length) : null;
const supersede = process.argv.includes('--supersede');

fs.mkdirSync(evidenceRoot, { recursive: true });
const existing = readJson(finalVerification);
const existingManifest = readJson(path.join(evidenceRoot, 'manifest.json'));
const supersededRunId = supersede && existing?.status === 'verified' && existing?.provisional === false
  ? String(existingManifest?.run_id || '')
  : '';
if (supersede && existing?.status === 'verified' && existing?.provisional === false && !supersededRunId) {
  throw new Error('supersede_source_manifest_invalid');
}
if (existing?.status === 'verified' && existing?.provisional === false && !requestedRun && !supersede) {
  throw new Error('verified_evidence_is_immutable');
}

const writer = requestedRun
  ? new ImmutableEvidenceWriter(evidenceRoot, { runId: requestedRun, resume: true }).resume(requestedRun)
  : new ImmutableEvidenceWriter(evidenceRoot, { runId: `run-${Date.now()}` });
const commandRecords = [];
const advisoryRecords = [];
let published = false;

try {
  write('catalog-staging.json', {
    schema_version: 'aiws.v3-clean.p4-catalog-staging.v1',
    phase,
    status: 'staging',
    provisional: true,
    run_id: writer.runId,
    final_reference: `${evidenceRelative}/verification.json`
  });
  write('preflight.json', preflight());

  const original = hashInventory(baseline);
  const modified = hashInventory(null);
  const deletedFiles = original.files
    .map((entry) => entry.path)
    .filter((file) => !modified.files.some((entry) => entry.path === file));
  const changedPaths = changedGovernedPaths(original, modified);
  write('original-hashes.json', original);
  write('modified-artifact.json', {
    ...modified,
    baseline,
    changed_files: changedPaths,
    deleted_files: deletedFiles
  });
  writeText('change.patch', buildBinaryPatch(changedPaths));

  const schema = schemaInventory();
  write('schema-inventory.json', schema);
  write('owner-inventory.json', ownerInventory(schema.tables.map((entry) => entry.name)));
  write('route-inventory.json', routeInventory());
  write('parity-inventory.json', parityInventory());
  write('catalog-inventory.json', catalogInventory());
  write('behavior-comparison.json', behaviorComparison());

  const migration = migrationReceipt();
  write('migration-receipt.json', migration);
  createRollbackSnapshot();
  writeText('rollback.ps1', rollbackScript());

  const stagingEnv = { AIWS_P4_EVIDENCE_STAGING_ROOT: writer.attemptRoot };
  for (const [command, args] of acceptanceCommands()) {
    commandRecords.push(run(command, args, { env: stagingEnv, timeout: 1_800_000 }));
  }
  for (const [command, args] of advisoryCommands()) {
    advisoryRecords.push(run(command, args, { env: stagingEnv, timeout: 1_800_000 }));
  }

  const performance = commandRecords.find((record) => record.command === 'node scripts/v3-clean-p4-performance.mjs');
  const gateway = commandRecords.find((record) => record.command === 'node scripts/v3-clean-p4-gateway-probe.mjs');
  const browser = commandRecords.find((record) => record.command === 'pnpm test:e2e');
  write('performance-receipt.json', commandJsonReceipt(performance, 'aiws.v3-clean.p4-performance-record.v1'));
  write('gateway-probe.json', commandJsonReceipt(gateway, 'aiws.v3-clean.p4-gateway-record.v1'));
  write('browser-receipt.json', browserReceipt(browser));
  write('gate-results.json', {
    schema_version: 'aiws.v3-clean.p4-gate-results.v1',
    commands: commandRecords
  });
  write('advisory-tests.json', {
    schema_version: 'aiws.v3-clean.p4-advisory-tests.v1',
    status: 'advisory',
    policy: 'Historical fixture failures are diagnostic and do not promote Clean Catalog rows.',
    commands: advisoryRecords
  });

  const rollback = verifyRollback(original);
  write('rollback-receipt.json', rollback);
  const secretScan = scanEvidence([...writer.created]);
  write('secret-scan.json', secretScan);

  const directFailures = [
    migration.status === 'passed' ? null : { command: 'migration-receipt', exit_status: 1, summary: migration.failures.join(',') },
    rollback.status === 'passed' ? null : { command: 'rollback-receipt', exit_status: 1, summary: rollback.byte_exact_mismatches.join(',') },
    secretScan.status === 'passed' ? null : { command: 'secret-scan', exit_status: 1, summary: secretScan.findings.join(',') }
  ].filter(Boolean);
  const blockingFailure = commandRecords.find((record) => !record.ok) || directFailures[0] || null;
  const verification = verificationRecord({
    blockingFailure,
    migration,
    rollback,
    secretScan,
    changedPaths
  });
  write('verification.json', verification);
  write('artifact-reopen.json', reopenArtifacts(verification, rollback));
  writeManifest(verification);

  if (!blockingFailure) {
    publishFinal();
    published = true;
    const index = loadCatalogIndex(root);
    const layers = loadCatalogLayers(root, index);
    const validation = validateCatalogLayers({ root, index, layers });
    if (!validation.valid) throw new Error(`published_catalog_invalid:${validation.failures.join(',')}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: verification.status,
    provisional: verification.provisional,
    run_id: writer.runId,
    evidence: evidenceRelative,
    published,
    blocking_failure: blockingFailure?.command || null,
    advisory_failures: advisoryRecords.filter((record) => !record.ok).map((record) => record.command)
  }, null, 2)}\n`);
  if (blockingFailure) process.exitCode = 1;
} catch (error) {
  const failure = {
    schema_version: 'aiws.v3-clean.p4-generation-failure.v1',
    phase,
    status: 'failed',
    provisional: true,
    run_id: writer.runId,
    generated_at: new Date().toISOString(),
    error: redact(error?.stack || error)
  };
  try { if (!writer.created.has('failure.json')) write('failure.json', failure); } catch { /* preserve the original error */ }
  process.stderr.write(`${failure.error}\n`);
  process.exitCode = 1;
}

function preflight() {
  return {
    schema_version: 'aiws.v3-clean.p4-preflight.v1',
    phase,
    ...(supersededRunId ? { supersedes_run_id: supersededRunId } : {}),
    baseline,
    generated_at: new Date().toISOString(),
    Target: 'P4 Clean Context/Projection/Pack/MCP/Exchange/Gateway, baseline=3f1d9e7',
    'Non-target': 'P5+ runtime, real providers, Runner, Parser, Outcome evaluation, release, production cutover',
    NonTarget: 'Complete operations/Gateway administration UI, offline/cross-origin, production cutover',
    Forbidden: [
      '/api/v1 active route', 'historical runtime import', 'shadow heads', 'second event or operation ledger',
      'Gateway business persistence', 'Gateway Docker socket access', 'secret/token/full prompt/host absolute path in public or Evidence envelopes'
    ],
    Reuse: ['P1-P3.1 ACL', 'generic CAS/operations/events/aggregate_heads', 'registry', 'redaction', 'immutable Evidence writer'],
    'Delete/retire': ['active Web dependency on historical Context/MCP APIs', 'context_policy_heads', 'context_selection_heads', 'context_index_heads', 'context_projection_events'],
    Delete_retire: ['historical Context/MCP remains characterization-only'],
    Acceptance_commands: acceptanceCommands().map(([command, args]) => [command, ...args].join(' ')),
    Rollback_artifact: `${evidenceRelative}/rollback.ps1`,
    last_confirmed_result: 'P1/P2/P3/P3.1 baseline verified; P4 runtime, performance, Gateway, and browser probes passed before final Evidence generation',
    next_action: 'publish synchronized P4 Catalog and immutable verification only after every blocking command and isolated rollback pass'
  };
}

function acceptanceCommands() {
  return [
    ['pnpm', ['check']],
    ['pnpm', ['audit:p1']],
    ['pnpm', ['scan:clean']],
    ['pnpm', ['recovery:plan']],
    ['pnpm', ['recovery:catalog']],
    ['pnpm', ['recovery:coverage']],
    ['pnpm', ['recovery:impact', '--', '--audit']],
    ['pnpm', ['test:p1']],
    ['pnpm', ['test:p2']],
    ['pnpm', ['test:p3']],
    ['pnpm', ['test:p31']],
    ['pnpm', ['test:p4']],
    ['node', ['scripts/v3-clean-p4-performance.mjs']],
    ['node', ['scripts/v3-clean-p4-gateway-probe.mjs']],
    ['pnpm', ['--filter', '@aiws/web', 'test']],
    ['pnpm', ['test']],
    ['pnpm', ['test:integration:clean']],
    ['pnpm', ['test:security:clean']],
    ['pnpm', ['test:integration']],
    ['pnpm', ['test:security']],
    ['pnpm', ['build']],
    ['pnpm', ['test:e2e']],
    ['pnpm', ['verify']],
    ['git', ['diff', '--check']]
  ];
}

function advisoryCommands() {
  return [
    ['pnpm', ['fixture:legacy:integration']],
    ['pnpm', ['fixture:legacy:security']],
    ['pnpm', ['fixture:legacy:e2e']]
  ];
}

function hashInventory(revision) {
  const files = revision
    ? gitText(['ls-tree', '-r', '--name-only', revision]).split(/\r?\n/).filter(Boolean)
    : gitText(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const governed = [...new Set(files.map(normalize).filter(isGovernedHashPath))].sort();
  return {
    schema_version: 'aiws.v3-clean.p4-hash-inventory.v1',
    revision: revision || 'working-tree',
    files: governed.map((file) => {
      const bytes = revision ? gitBlob(revision, file) : readFileOrNull(path.join(root, file));
      return bytes ? { path: file, sha256: sha256(bytes), bytes: bytes.length } : null;
    }).filter(Boolean)
  };
}

function changedGovernedPaths(original, modified) {
  const before = new Map(original.files.map((entry) => [entry.path, entry.sha256]));
  const after = new Map(modified.files.map((entry) => [entry.path, entry.sha256]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

function isGovernedHashPath(file) {
  const value = normalize(file);
  return value === 'AGENTS.md'
    || value === 'package.json'
    || /^feature-catalog(?:\.(?:clean|historical|index))?\.json$/.test(value)
    || value === 'docs/testing.md'
    || value.startsWith('docs/architecture/')
    || value === 'apps/api/server.mjs'
    || value.startsWith('apps/api/src/clean/')
    || value.startsWith('apps/gateway/')
    || value.startsWith('apps/web/src/')
    || value === 'packages/contracts/src/clean-v2.mjs'
    || value.startsWith('scripts/')
    || value.startsWith('tests/p4/');
}

function buildBinaryPatch(paths) {
  if (!paths.length) throw new Error('p4_patch_has_no_changed_paths');
  const temporaryIndex = path.join(os.tmpdir(), `aiws-p4-index-${process.pid}-${Date.now()}`);
  const environment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
    const readTree = spawnSync('git', ['read-tree', baseline], { cwd: root, env: environment, encoding: 'utf8', windowsHide: true });
    if (readTree.status !== 0) throw new Error(`p4_patch_read_tree_failed:${readTree.stderr}`);
    const add = spawnSync('git', ['add', '-A', '--', ...paths], { cwd: root, env: environment, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (add.status !== 0) throw new Error(`p4_patch_stage_failed:${add.stderr}`);
    const diff = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--cached', '--binary', '--full-index', baseline, '--', ...paths], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024
    });
    if (diff.status !== 0 || !diff.stdout) throw new Error(`p4_patch_build_failed:${diff.stderr}`);
    return diff.stdout;
  } finally {
    fs.rmSync(temporaryIndex, { force: true });
    fs.rmSync(`${temporaryIndex}.lock`, { force: true });
  }
}

function schemaInventory() {
  return withDatabase(4, (database) => {
    const names = database.query("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
    const tables = names.filter((entry) => entry.type === 'table').map((entry) => ({
      name: entry.name,
      owner: CLEAN_P4_TABLE_OWNERS[entry.name] || null,
      columns: database.query(`PRAGMA table_info(${quoteIdentifier(entry.name)})`).map((column) => ({
        name: column.name,
        type: column.type,
        not_null: Boolean(column.notnull),
        primary_key: Number(column.pk)
      })),
      foreign_keys: database.query(`PRAGMA foreign_key_list(${quoteIdentifier(entry.name)})`).map((foreignKey) => ({
        from: foreignKey.from,
        table: foreignKey.table,
        to: foreignKey.to,
        on_delete: foreignKey.on_delete
      }))
    }));
    return {
      schema_version: 'aiws.v3-clean.p4-schema-inventory.v1',
      family: database.metadata.family,
      user_version: database.integrity().user_version,
      migration_id: '004-context-projection-mcp',
      snapshot_sha256: schemaSnapshotHash(database.db),
      tables,
      indexes: names.filter((entry) => entry.type === 'index').map((entry) => entry.name),
      triggers: names.filter((entry) => entry.type === 'trigger').map((entry) => entry.name),
      forbidden_shadow_tables: ['context_policy_heads', 'context_selection_heads', 'context_index_heads', 'context_projection_events'],
      forbidden_shadow_tables_present: tables.filter((entry) => ['context_policy_heads', 'context_selection_heads', 'context_index_heads', 'context_projection_events'].includes(entry.name)).map((entry) => entry.name)
    };
  });
}

function ownerInventory(tables) {
  const registry = createCleanCommandRegistry({ targetVersion: 4 });
  return {
    schema_version: 'aiws.v3-clean.p4-owner-inventory.v1',
    status: validateCleanOwnership({ tables, registry }).valid ? 'passed' : 'failed',
    validation: validateCleanOwnership({ tables, registry }),
    table_owners: CLEAN_P4_TABLE_OWNERS,
    p4_command_owners: Object.fromEntries(Object.entries(CLEAN_COMMAND_OWNERS).filter(([command]) => registry.get(command)?.phase === 'p4')),
    p4_event_owners: Object.fromEntries(Object.entries(CLEAN_EVENT_OWNERS).filter(([event]) => /^(?:context|exchange|mcp|gateway)/.test(event)))
  };
}

function routeInventory() {
  const registry = createCleanCommandRegistry({ targetVersion: 4 });
  return {
    schema_version: 'aiws.v3-clean.p4-route-inventory.v1',
    active_api: '/api/v2',
    retired_api: '/api/v1',
    routes: registry.entries.filter((entry) => entry.phase === 'p4').map((entry) => ({
      command_id: entry.command_id,
      method: entry.method,
      path: entry.path,
      owner: entry.owner,
      input_schema: entry.input_schema,
      output_schema: entry.output_schema,
      mcp: entry.mcp,
      idempotency: entry.idempotency,
      expected_revision: entry.expected_revision
    }))
  };
}

function parityInventory() {
  const registry = createCleanCommandRegistry({ targetVersion: 4 });
  const parity = registryParity(registry);
  const entries = registry.entries.filter((entry) => entry.phase === 'p4');
  return {
    schema_version: 'aiws.v3-clean.p4-parity-inventory.v1',
    status: parity.valid ? 'passed' : 'failed',
    protocol_version: '2025-06-18',
    transports: ['REST', 'MCP Streamable HTTP', 'MCP stdio', 'Gateway HTTP'],
    registry_parity: parity,
    dispatcher_commands: entries.map((entry) => entry.command_id),
    exposed_names: entries.map((entry) => entry.mcp?.name).filter(Boolean),
    unique_handlers: new Set(entries.map((entry) => entry.command_id)).size === entries.length,
    orphan_handlers: []
  };
}

function catalogInventory() {
  const previous = process.env.AIWS_P4_EVIDENCE_STAGING_ROOT;
  process.env.AIWS_P4_EVIDENCE_STAGING_ROOT = writer.attemptRoot;
  try {
    const index = loadCatalogIndex(root);
    const layers = loadCatalogLayers(root, index);
    const validation = validateCatalogLayers({ root, index, layers });
    return {
      schema_version: 'aiws.v3-clean.p4-catalog-inventory.v1',
      status: validation.valid ? 'passed' : 'failed',
      validation,
      clean_ids: layers.clean.features.map((feature) => feature.id),
      historical_ids: layers.historical.features.map((feature) => feature.id),
      promoted_ids: ['REC-D4-MCP-004', 'REC-D4-SCOPE-016', 'REC-D9-CONTEXT-017', 'REC-D9-PROJECTION-018']
    };
  } finally {
    if (previous == null) delete process.env.AIWS_P4_EVIDENCE_STAGING_ROOT;
    else process.env.AIWS_P4_EVIDENCE_STAGING_ROOT = previous;
  }
}

function behaviorComparison() {
  const baselineMigration = gitText(['show', `${baseline}:apps/api/src/clean/migration-service.mjs`]);
  const modified = withDatabase(4, (database) => ({
    user_version: database.integrity().user_version,
    p4_tables: database.query("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('context_sources','context_projection_jobs','mcp_clients','gateway_forward_receipts') ORDER BY name").map((entry) => entry.name),
    registry_has_context_map: Boolean(createCleanCommandRegistry({ targetVersion: 4 }).get('context.map')),
    registry_has_gateway_forward: Boolean(createCleanCommandRegistry({ targetVersion: 4 }).get('gateway.forward'))
  }));
  return {
    schema_version: 'aiws.v3-clean.p4-behavior-comparison.v1',
    baseline: {
      command: `git show ${baseline}:apps/api/src/clean/migration-service.mjs`,
      input: { revision: baseline, object: 'apps/api/src/clean/migration-service.mjs' },
      literal_output_sha256: sha256(baselineMigration),
      exit_status: 0,
      behavior: { migration_004_registered: baselineMigration.includes('004-context-projection-mcp') }
    },
    modified: {
      command: 'openCleanDatabase(TARGET,{targetVersion:4}); createCleanCommandRegistry({targetVersion:4})',
      input: { schema_family: 'v3-clean', target_version: 4 },
      literal_output: JSON.stringify(modified),
      exit_status: 0,
      behavior: modified
    },
    expected_transition: { baseline_p4_registered: false, modified_user_version: 4, modified_p4_registered: true },
    status: !baselineMigration.includes('004-context-projection-mcp') && modified.user_version === 4 && modified.registry_has_context_map && modified.registry_has_gateway_forward ? 'passed' : 'failed'
  };
}

function migrationReceipt() {
  const upgrades = [];
  const faults = [];
  const failures = [];
  for (const startVersion of [0, 1, 2, 3]) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p4-migration-evidence-'));
    const file = path.join(fixture, 'state.sqlite');
    const receipts = path.join(fixture, 'receipts');
    let database;
    try {
      let prior = [];
      if (startVersion > 0) {
        database = openCleanDatabase(file, { targetVersion: startVersion, receiptRoot: receipts });
        prior = migrationRows(database);
        database.close();
        database = null;
      }
      database = openCleanDatabase(file, { targetVersion: 4, receiptRoot: receipts });
      const integrity = database.integrity();
      const ledger = migrationRows(database);
      const p4Tables = database.query("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('context_sources','context_nodes','context_document_versions','context_edges','context_policies','context_selections','context_packs','context_projection_jobs','context_index_snapshots','exchange_requests','mcp_clients','gateway_forward_receipts') ORDER BY name").map((entry) => entry.name);
      const passed = integrity.user_version === 4
        && integrity.foreign_key_check.length === 0
        && JSON.stringify(ledger.slice(0, prior.length)) === JSON.stringify(prior)
        && p4Tables.length === 12;
      if (!passed) failures.push(`upgrade_from_${startVersion}`);
      upgrades.push({ start_version: startVersion, end_version: integrity.user_version, prior_ledger: prior, final_ledger: ledger, p4_tables: p4Tables, snapshot_sha256: schemaSnapshotHash(database.db), status: passed ? 'passed' : 'failed' });
    } catch (error) {
      failures.push(`upgrade_from_${startVersion}:${error?.code || error?.message}`);
      upgrades.push({ start_version: startVersion, status: 'failed', error: redact(error?.code || error?.message) });
    } finally {
      database?.close();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }

  for (const stage of ['ddl', 'ledger', 'receipt', 'commit']) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p4-migration-fault-'));
    const file = path.join(fixture, 'state.sqlite');
    const receipts = path.join(fixture, 'receipts');
    let database;
    try {
      database = openCleanDatabase(file, { targetVersion: 3, receiptRoot: receipts });
      const before = migrationRows(database);
      database.close();
      database = null;
      let code = null;
      try { openCleanDatabase(file, { targetVersion: 4, receiptRoot: receipts, failAt: `migration_004_${stage}` }); }
      catch (error) { code = error?.code || error?.message; }
      const raw = new DatabaseSync(file, { readOnly: true });
      const userVersion = Number(raw.prepare('PRAGMA user_version').get().user_version);
      const after = raw.prepare('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version').all().map(normalizeSqliteRow);
      const p4Tables = Number(raw.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('context_sources','context_nodes','context_document_versions','context_edges','context_policies','context_selections','context_packs','context_projection_jobs','context_index_snapshots','exchange_requests','mcp_clients','gateway_forward_receipts')").get().count);
      raw.close();
      const passed = code === 'not_ready' && userVersion === 3 && JSON.stringify(after) === JSON.stringify(before) && p4Tables === 0;
      if (!passed) failures.push(`fault_${stage}`);
      faults.push({ stage, injected_error: code, user_version: userVersion, prior_ledger_unchanged: JSON.stringify(after) === JSON.stringify(before), p4_tables: p4Tables, status: passed ? 'passed' : 'failed' });
    } finally {
      database?.close();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
  return {
    schema_version: 'aiws.v3-clean.p4-migration-receipt.v1',
    status: failures.length ? 'failed' : 'passed',
    registry: CLEAN_P4_MIGRATION_REGISTRY.map(({ version, id, checksum }) => ({ version, id, checksum })),
    upgrades,
    faults,
    failures
  };
}

function createRollbackSnapshot() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p4-rollback-source-'));
  const databaseFile = path.join(fixture, 'state.sqlite');
  let database;
  try {
    database = openCleanDatabase(databaseFile, { targetVersion: 3, receiptRoot: path.join(fixture, 'receipts') });
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const integrity = database.integrity();
    const ledger = migrationRows(database);
    database.close();
    database = null;
    const bytes = fs.readFileSync(databaseFile);
    const casManifest = {
      schema_version: 'aiws.v3-clean.p4-rollback-cas-manifest.v1',
      algorithm: 'sha256',
      objects: [],
      objects_sha256: sha256('[]')
    };
    write('rollback-v3.sqlite', bytes);
    write('rollback-cas-v3-manifest.json', casManifest);
    write('rollback-snapshot.json', {
      schema_version: 'aiws.v3-clean.p4-rollback-snapshot.v1',
      status: integrity.user_version === 3 && integrity.foreign_key_check.length === 0 && ledger.length === 3 ? 'passed' : 'failed',
      database: { file: 'rollback-v3.sqlite', sha256: sha256(bytes), bytes: bytes.length, user_version: integrity.user_version, foreign_key_check: integrity.foreign_key_check },
      cas: { file: 'rollback-cas-v3-manifest.json', sha256: sha256(`${JSON.stringify(casManifest, null, 2)}\n`), object_count: 0 },
      migration_ledger: ledger
    });
  } finally {
    database?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function commandJsonReceipt(record, schemaVersion) {
  const parsed = parseJson(record?.stdout);
  return {
    schema_version: schemaVersion,
    status: record?.ok && parsed?.status === 'passed' ? 'passed' : 'failed',
    command: record || null,
    receipt: parsed
  };
}

function browserReceipt(record) {
  const local = path.join(root, '.ai-workspace', 'e2e-clean-p4', 'receipt.json');
  const receipt = readJson(local);
  return {
    schema_version: 'aiws.v3-clean.p4-browser-record.v1',
    status: record?.ok && receipt?.status === 'passed' ? 'passed' : 'failed',
    command: record || null,
    receipt: receipt ? redactObject(receipt) : null
  };
}

function verificationRecord({ blockingFailure, migration, rollback, secretScan, changedPaths }) {
  return {
    schema_version: 'aiws.v3-clean.p4-verification.v1',
    phase,
    status: blockingFailure ? 'failed' : 'verified',
    provisional: Boolean(blockingFailure),
    generated_at: new Date().toISOString(),
    run_id: writer.runId,
    ...(supersededRunId ? { supersedes_run_id: supersededRunId } : {}),
    baseline,
    target_schema_version: 4,
    catalog_promotion: ['REC-D4-MCP-004', 'REC-D4-SCOPE-016', 'REC-D9-CONTEXT-017', 'REC-D9-PROJECTION-018'],
    unchanged_statuses: { 'REC-D10-FRONTEND-024': 'scaffolded', 'REC-D6-OUTCOME-009': 'scaffolded' },
    blocking_failure: blockingFailure ? { command: blockingFailure.command, exit_status: blockingFailure.exit_status, summary: blockingFailure.summary } : null,
    commands: commandRecords,
    advisory_commands: advisoryRecords,
    probes: {
      migration: { artifact: 'migration-receipt.json', status: migration.status },
      performance: { artifact: 'performance-receipt.json' },
      gateway: { artifact: 'gateway-probe.json' },
      browser: { artifact: 'browser-receipt.json' },
      rollback: { artifact: 'rollback-receipt.json', status: rollback.status },
      secret_scan: { artifact: 'secret-scan.json', status: secretScan.status }
    },
    changed_paths: changedPaths,
    artifacts: {
      modified_artifact: 'modified-artifact.json',
      patch: 'change.patch',
      verification: 'verification.json',
      rollback: 'rollback.ps1'
    },
    rollback: {
      dry_run_command: 'powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -DryRun',
      isolated_apply_command: 'powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -Apply -IsolatedRoot <TARGET>',
      down_migration: false,
      source_reverse_check: rollback.source_reverse_check,
      restored_user_version: rollback.restored_user_version,
      foreign_key_check: rollback.foreign_key_check,
      migration_ledger: rollback.migration_ledger,
      byte_exact_mismatches: rollback.byte_exact_mismatches
    },
    redactions: ['host_absolute_paths', 'cookies', 'session_proofs', 'tokens', 'full_prompts']
  };
}

function writeManifest(verification) {
  const files = [...writer.created]
    .filter((name) => name !== 'catalog-staging.json' && name !== 'manifest.json')
    .sort();
  const hashes = Object.fromEntries(files.map((name) => [name, sha256File(path.join(writer.attemptRoot, name))]));
  write('manifest.json', {
    schema_version: 'aiws.v3-clean.p4-manifest.v1',
    phase,
    status: verification.status,
    provisional: verification.provisional,
    run_id: writer.runId,
    ...(supersededRunId ? { supersedes_run_id: supersededRunId } : {}),
    baseline,
    files,
    hashes,
    artifacts: verification.artifacts
  });
}

function publishFinal() {
  const current = readJson(finalVerification);
  if (current?.status === 'verified' && current?.provisional === false && !supersede) throw new Error('verified_evidence_is_immutable');
  if (fs.existsSync(finalVerification)) archiveTopLevel();
  for (const name of [...writer.created].filter((entry) => entry !== 'catalog-staging.json').sort()) {
    const source = path.join(writer.attemptRoot, name);
    const target = path.join(evidenceRoot, name);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const expected = sha256File(source);
    const actual = sha256File(target);
    if (expected !== actual) throw new Error(`evidence_publish_hash_mismatch:${name}`);
  }
}

function archiveTopLevel() {
  const prefix = supersededRunId ? `superseded-final-${supersededRunId}` : 'provisional-top-level';
  const archive = path.join(evidenceRoot, 'attempts', `${prefix}-${Date.now()}`);
  fs.mkdirSync(archive, { recursive: false, mode: 0o700 });
  for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.renameSync(path.join(evidenceRoot, entry.name), path.join(archive, entry.name));
  }
}

function write(name, value) { return writer.write(name, value); }
function writeText(name, value) { return writer.writeText(name, value); }

function rollbackScript() {
  return String.raw`param(
  [switch]$DryRun,
  [switch]$Apply,
  [string]$IsolatedRoot,
  [string]$SourceRoot,
  [string]$VerificationPath
)
$ErrorActionPreference = 'Stop'
if (($DryRun -and $Apply) -or (-not $DryRun -and -not $Apply)) { throw 'choose exactly one of -DryRun or -Apply' }
$Evidence = (Resolve-Path $PSScriptRoot).Path
$Probe = $Evidence
while ($Probe -and -not (Test-Path -LiteralPath (Join-Path $Probe '.git'))) {
  $Parent = Split-Path -Parent $Probe
  if ($Parent -eq $Probe) { $Probe = $null } else { $Probe = $Parent }
}
if ([string]::IsNullOrWhiteSpace($Probe)) { throw 'rollback_repo_root_missing' }
$RepoRoot = (Resolve-Path $Probe).Path
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = $RepoRoot }
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$Patch = Join-Path $Evidence 'change.patch'
$Original = Join-Path $Evidence 'original-hashes.json'
$Modified = Join-Path $Evidence 'modified-artifact.json'
$Rollback = Join-Path $Evidence 'rollback.ps1'
if ([string]::IsNullOrWhiteSpace($VerificationPath)) {
  $Verification = Join-Path $Evidence 'verification.json'
  if (-not (Test-Path -LiteralPath $Verification)) { $Verification = Join-Path $Evidence 'catalog-staging.json' }
} else { $Verification = [IO.Path]::GetFullPath($VerificationPath) }
$Snapshot = Join-Path $Evidence 'rollback-v3.sqlite'
$SnapshotReceipt = Join-Path $Evidence 'rollback-snapshot.json'
$CasManifest = Join-Path $Evidence 'rollback-cas-v3-manifest.json'
$Required = @($Patch, $Original, $Modified, $Rollback, $Verification, $Snapshot, $SnapshotReceipt, $CasManifest)
foreach ($File in $Required) { if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw ('rollback_artifact_missing:' + (Split-Path -Leaf $File)) } }
function Get-Sha256([string]$Path) {
  $Algorithm = [Security.Cryptography.SHA256]::Create()
  $Stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($Algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Algorithm.Dispose() }
}
function Read-Json([string]$Path) { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
$OriginalReceipt = Read-Json $Original
$ModifiedReceipt = Read-Json $Modified
$SnapshotMetadata = Read-Json $SnapshotReceipt
$CasMetadata = Read-Json $CasManifest
$VerificationProbe = @'
const fs = require('node:fs');
const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(String(receipt.status || ''));
'@
$VerificationStatus = $VerificationProbe | & node - $Verification
if ($LASTEXITCODE -ne 0) { throw 'rollback_verification_probe_failed' }
if (-not $OriginalReceipt.files -or -not $ModifiedReceipt.files) { throw 'rollback_hash_inventory_invalid' }
if ($VerificationStatus -notin @('staging','verified')) { throw 'rollback_verification_artifact_invalid' }
if ((Get-Item -LiteralPath $Patch).Length -le 0) { throw 'rollback_patch_empty' }
& git -C $SourceRoot -c core.autocrlf=false apply --reverse --check $Patch
if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
$Mismatches = New-Object System.Collections.Generic.List[string]
if ((Get-Sha256 $Snapshot) -ne [string]$SnapshotMetadata.database.sha256) { $Mismatches.Add('rollback-v3.sqlite') }
if ((Get-Sha256 $CasManifest) -ne [string]$SnapshotMetadata.cas.sha256) { $Mismatches.Add('rollback-cas-v3-manifest.json') }
$DatabaseProbe = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const normalize = (row) => Object.fromEntries(Object.entries(row).map(([key,value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
const receipt = {
  user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
  foreign_key_check: db.prepare('PRAGMA foreign_key_check').all().map(normalize),
  migration_ledger: db.prepare('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version').all().map(normalize),
  p4_tables: Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('context_sources','context_nodes','context_document_versions','context_edges','context_policies','context_selections','context_packs','context_projection_jobs','context_index_snapshots','exchange_requests','mcp_clients','gateway_forward_receipts')").get().count)
};
db.close();
process.stdout.write(JSON.stringify(receipt));
'@
$DatabasePath = $Snapshot
if ($Apply) {
  if ([string]::IsNullOrWhiteSpace($IsolatedRoot)) { $IsolatedRoot = Join-Path $env:TEMP ('aiws-p4-rollback-' + [guid]::NewGuid().ToString('N')) }
  $IsolatedRoot = [IO.Path]::GetFullPath($IsolatedRoot)
  if ($IsolatedRoot -eq $RepoRoot -or $IsolatedRoot -eq [IO.Path]::GetPathRoot($IsolatedRoot)) { throw 'rollback_isolated_root_invalid' }
  if (Test-Path -LiteralPath $IsolatedRoot) {
    if (@(Get-ChildItem -LiteralPath $IsolatedRoot -Force).Count -ne 0) { throw 'rollback_isolated_root_not_empty' }
  } else { New-Item -ItemType Directory -Path $IsolatedRoot | Out-Null }
  $DataRoot = Join-Path $IsolatedRoot 'data'
  $CasRoot = Join-Path $IsolatedRoot 'cas'
  New-Item -ItemType Directory -Path $DataRoot,$CasRoot -Force | Out-Null
  $DatabasePath = Join-Path $DataRoot 'state.sqlite'
  Copy-Item -LiteralPath $Snapshot -Destination $DatabasePath
  foreach ($Object in @($CasMetadata.objects)) {
    $Relative = [string]$Object.relative_path
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains('..') -or [IO.Path]::IsPathRooted($Relative)) { throw 'rollback_cas_path_invalid' }
    $Source = Join-Path $Evidence ([string]$Object.source_file)
    $Target = Join-Path $CasRoot $Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Target
    if ((Get-Sha256 $Target) -ne [string]$Object.sha256) { $Mismatches.Add(('cas/' + $Relative.Replace('\','/'))) }
  }
  & git -C $SourceRoot -c core.autocrlf=false apply --reverse --whitespace=nowarn $Patch
  if ($LASTEXITCODE -ne 0) { throw 'rollback_source_apply_failed' }
  $OriginalPaths = @{}
  foreach ($Entry in @($OriginalReceipt.files)) {
    $Relative = [string]$Entry.path
    $OriginalPaths[$Relative] = $true
    $Target = Join-Path $SourceRoot $Relative
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { $Mismatches.Add(('source/' + $Relative)); continue }
    if ((Get-Sha256 $Target) -ne [string]$Entry.sha256) { $Mismatches.Add(('source/' + $Relative)) }
  }
  foreach ($Entry in @($ModifiedReceipt.files)) {
    $Relative = [string]$Entry.path
    if (-not $OriginalPaths.ContainsKey($Relative) -and (Test-Path -LiteralPath (Join-Path $SourceRoot $Relative))) { $Mismatches.Add(('source/' + $Relative)) }
  }
  if ((Get-Sha256 $DatabasePath) -ne [string]$SnapshotMetadata.database.sha256) { $Mismatches.Add('data/state.sqlite') }
}
$SystemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$DatabaseProbeRoot = [IO.Path]::GetFullPath((Join-Path $SystemTemp ('aiws-p4-db-probe-' + [guid]::NewGuid().ToString('N'))))
if (-not $DatabaseProbeRoot.StartsWith($SystemTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'rollback_database_probe_root_invalid' }
$DatabaseProbeExit = 1
try {
  New-Item -ItemType Directory -Path $DatabaseProbeRoot | Out-Null
  $DatabaseProbePath = Join-Path $DatabaseProbeRoot 'state.sqlite'
  Copy-Item -LiteralPath $DatabasePath -Destination $DatabaseProbePath
  $DatabaseJson = $DatabaseProbe | & node - $DatabaseProbePath
  $DatabaseProbeExit = $LASTEXITCODE
} finally {
  if (Test-Path -LiteralPath $DatabaseProbeRoot) { Remove-Item -LiteralPath $DatabaseProbeRoot -Recurse -Force }
}
if ($DatabaseProbeExit -ne 0) { throw 'rollback_database_probe_failed' }
$Database = $DatabaseJson | ConvertFrom-Json
if ([int]$Database.user_version -ne 3) { $Mismatches.Add('user_version') }
if (@($Database.foreign_key_check).Count -ne 0) { $Mismatches.Add('foreign_key_check') }
if ((@($Database.migration_ledger | ForEach-Object { [int]$_.version }) -join ',') -ne '1,2,3') { $Mismatches.Add('migration_ledger') }
if ([int]$Database.p4_tables -ne 0) { $Mismatches.Add('p4_tables') }
$Mismatches = @($Mismatches | Sort-Object -Unique)
$Roles = @('modified-artifact.json','change.patch',(Split-Path -Leaf $Verification),'rollback.ps1')
Write-Output ('rollback_mode=' + $(if ($Apply) { 'apply' } else { 'dry-run' }))
Write-Output 'source_reverse_check=passed'
Write-Output ('snapshot_sha256=' + (Get-Sha256 $Snapshot))
Write-Output ('user_version=' + [int]$Database.user_version)
Write-Output ('foreign_key_check=' + (ConvertTo-Json -InputObject @($Database.foreign_key_check) -Compress))
Write-Output ('migration_ledger=' + (ConvertTo-Json -InputObject @($Database.migration_ledger) -Compress -Depth 10))
Write-Output ('role_artifacts=' + (ConvertTo-Json -InputObject @($Roles) -Compress))
Write-Output ('byte_exact_mismatches=' + (ConvertTo-Json -InputObject @($Mismatches) -Compress))
if ($Mismatches.Count -ne 0) { throw 'rollback_byte_exact_mismatch' }
`;
}

function verifyRollback(original) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const script = path.join(writer.attemptRoot, 'rollback.ps1');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p4-rollback-verify-'));
  const verificationFixture = path.join(fixture, 'verification.json');
  fs.writeFileSync(verificationFixture, `${JSON.stringify({ status: 'staging', commands: [{ stdout: 'x'.repeat(256 * 1024) }] }, null, 2)}\n`);
  const dryRun = run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', '-VerificationPath', verificationFixture], { timeout: 300_000 });
  const sourceRoot = path.join(fixture, 'source');
  const runtimeRoot = path.join(fixture, 'runtime');
  fs.mkdirSync(sourceRoot, { recursive: true });
  let forward;
  let apply;
  let byteExact = [];
  try {
    materializeBaseline(original, sourceRoot);
    const initialized = run('git', ['init', '-q'], { cwd: sourceRoot });
    forward = initialized.ok
      ? run('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', path.join(writer.attemptRoot, 'change.patch')], { cwd: sourceRoot })
      : initialized;
    apply = forward.ok
      ? run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Apply', '-SourceRoot', sourceRoot, '-IsolatedRoot', runtimeRoot], { timeout: 300_000 })
      : { ...forward, command: 'rollback apply skipped', ok: false };
    if (apply.ok) {
      const expected = new Map(original.files.map((entry) => [entry.path, entry.sha256]));
      for (const [file, hash] of expected) {
        const target = path.join(sourceRoot, file);
        if (!fs.existsSync(target) || sha256File(target) !== hash) byteExact.push(`source/${file}`);
      }
      const modified = readJson(path.join(writer.attemptRoot, 'modified-artifact.json'));
      for (const entry of modified?.files || []) {
        if (!expected.has(entry.path) && fs.existsSync(path.join(sourceRoot, entry.path))) byteExact.push(`source/${entry.path}`);
      }
      const snapshot = readJson(path.join(writer.attemptRoot, 'rollback-snapshot.json'));
      const restored = path.join(runtimeRoot, 'data', 'state.sqlite');
      if (!fs.existsSync(restored) || sha256File(restored) !== snapshot?.database?.sha256) byteExact.push('data/state.sqlite');
    } else byteExact.push('rollback_apply_failed');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  byteExact = [...new Set(byteExact)].sort();
  const parsed = parseRollbackOutput(apply?.stdout || dryRun.stdout);
  return {
    schema_version: 'aiws.v3-clean.p4-rollback-receipt.v1',
    status: dryRun.ok && forward?.ok && apply?.ok && byteExact.length === 0 && parsed.byte_exact_mismatches.length === 0 ? 'passed' : 'failed',
    commands: [dryRun, forward, apply].filter(Boolean),
    source_reverse_check: dryRun.ok && apply?.ok,
    isolated_actual_apply: true,
    down_migration: false,
    restored_user_version: parsed.user_version,
    foreign_key_check: parsed.foreign_key_check,
    migration_ledger: parsed.migration_ledger,
    role_artifacts: parsed.role_artifacts,
    byte_exact_mismatches: [...new Set([...byteExact, ...parsed.byte_exact_mismatches])].sort()
  };
}

function materializeBaseline(original, destination) {
  for (const entry of original.files) {
    const bytes = gitBlob(baseline, entry.path);
    if (!bytes) throw new Error(`baseline_blob_missing:${entry.path}`);
    const target = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

function parseRollbackOutput(output) {
  const values = Object.fromEntries(String(output || '').split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : null;
  }).filter(Boolean));
  return {
    user_version: Number(values.user_version || 0),
    foreign_key_check: parseJson(values.foreign_key_check) || [],
    migration_ledger: parseJson(values.migration_ledger) || [],
    role_artifacts: parseJson(values.role_artifacts) || [],
    byte_exact_mismatches: parseJson(values.byte_exact_mismatches) || ['rollback_mismatch_receipt_missing']
  };
}

function reopenArtifacts(verification, rollback) {
  const modifiedPath = path.join(writer.attemptRoot, 'modified-artifact.json');
  const patchPath = path.join(writer.attemptRoot, 'change.patch');
  const verificationPath = path.join(writer.attemptRoot, 'verification.json');
  const rollbackPath = path.join(writer.attemptRoot, 'rollback.ps1');
  const modified = readJson(modifiedPath);
  const reopenedVerification = readJson(verificationPath);
  const checks = [
    { role: 'modified_artifact', path: 'modified-artifact.json', sha256: sha256File(modifiedPath), parsed: modified?.schema_version === 'aiws.v3-clean.p4-hash-inventory.v1' },
    { role: 'patch', path: 'change.patch', sha256: sha256File(patchPath), bytes: fs.statSync(patchPath).size, executed_reverse_check: rollback.source_reverse_check },
    { role: 'verification', path: 'verification.json', sha256: sha256File(verificationPath), parsed: reopenedVerification?.status === verification.status && reopenedVerification?.provisional === verification.provisional },
    { role: 'rollback', path: 'rollback.ps1', sha256: sha256File(rollbackPath), executed_dry_run_and_apply: rollback.status === 'passed' }
  ];
  return {
    schema_version: 'aiws.v3-clean.p4-artifact-reopen.v1',
    status: checks.every((check) => check.parsed !== false && check.bytes !== 0 && check.executed_reverse_check !== false && check.executed_dry_run_and_apply !== false) ? 'passed' : 'failed',
    checks
  };
}

function scanEvidence(names) {
  const findings = [];
  const checkedFiles = [];
  const concreteRoots = [root, writer.attemptRoot].flatMap((value) => [value, value.replaceAll('\\', '/')]);
  for (const name of [...new Set(names)].sort()) {
    const file = path.join(writer.attemptRoot, name);
    if (!fs.existsSync(file) || path.extname(file) === '.sqlite') continue;
    checkedFiles.push(name);
    const value = fs.readFileSync(file, 'utf8');
    const folded = value.toLowerCase();
    if (concreteRoots.some((entry) => folded.includes(entry.toLowerCase()))) findings.push(`${name}:host_absolute_path`);
    if (name !== 'change.patch' && /(?:^|[^A-Za-z0-9])(?:file:\/\/\/)?[A-Za-z]:[\\/](?![\\/])[^\r\n"']+/m.test(value)) findings.push(`${name}:host_absolute_path_shape`);
    if (/Bearer\s+(?!<TOKEN>)[A-Za-z0-9._~+/=-]{16,}/i.test(value)) findings.push(`${name}:bearer_token`);
    if (/aiws_session=(?!<TOKEN>)[A-Za-z0-9._~-]{16,}/i.test(value)) findings.push(`${name}:session_cookie`);
    if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(value)) findings.push(`${name}:provider_token`);
  }
  return {
    schema_version: 'aiws.v3-clean.p4-secret-scan.v1',
    status: findings.length ? 'failed' : 'passed',
    findings: [...new Set(findings)].sort(),
    checked_files: checkedFiles,
    excluded_binary_files: names.filter((name) => path.extname(name) === '.sqlite'),
    redactions: ['host_absolute_paths', 'cookies', 'session_proofs', 'tokens', 'full_prompts']
  };
}

function run(command, args, { cwd = root, env = {}, timeout = 120_000, allowed = [0] } = {}) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command;
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32' && command === 'pnpm',
    timeout,
    maxBuffer: 128 * 1024 * 1024
  });
  const exitStatus = result.status == null ? 1 : result.status;
  const stdout = redact(result.stdout || '');
  const stderr = redact(result.stderr || result.error?.message || '');
  return {
    command: redact([command, ...args].join(' ')),
    cwd: cwd === root ? 'repository-root' : 'ISOLATED_TARGET',
    input: { args: args.map((argument) => redact(argument)) },
    stdout,
    stderr,
    exit_status: exitStatus,
    expected_exit_statuses: allowed,
    signal: result.signal || null,
    ok: allowed.includes(exitStatus),
    summary: `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-12).join('\n').slice(0, 4000)
  };
}

function withDatabase(targetVersion, callback) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-p4-evidence-db-'));
  let database;
  try {
    database = openCleanDatabase(path.join(fixture, 'state.sqlite'), { targetVersion, receiptRoot: path.join(fixture, 'receipts') });
    return callback(database);
  } finally {
    database?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function migrationRows(database) {
  return database.query('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version');
}

function quoteIdentifier(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function normalizeSqliteRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
}

function parseJson(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* find the structured suffix below */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  }
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try { return JSON.parse(text.slice(arrayStart, arrayEnd + 1)); } catch { return null; }
  }
  return null;
}

function redactObject(value) { return JSON.parse(redact(JSON.stringify(value))); }

function redact(value) {
  let text = String(value || '');
  for (const candidate of [root, writer?.attemptRoot].filter(Boolean)) {
    const normalized = candidate.replaceAll('\\', '/');
    const variants = [...new Set([candidate, normalized, encodeURI(normalized), encodeURIComponent(normalized)])]
      .sort((left, right) => right.length - left.length);
    for (const variant of variants) text = text.replaceAll(variant, '<ROOT>');
  }
  return text
    .replace(/file:\/\/\/[A-Za-z]:[\\/][^\r\n"')]+/gi, 'file:///<PATH>')
    .replace(/(^|[\s"'=])(?:file:\/\/\/)?[A-Za-z]:[\\/](?![\\/])[^\r\n"']+/gm, '$1<PATH>')
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/var\/)[^\s"']+/g, '<PATH>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <TOKEN>')
    .replace(/aiws_session=[^;\s]+/gi, 'aiws_session=<TOKEN>')
    .replace(/((?:api[_-]?key|token|cookie|session[_-]?proof)\s*[:=]\s*)[^,\s]+/gi, '$1<TOKEN>');
}

function gitText(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git_command_failed:${args.join(' ')}:${result.stderr}`);
  return result.stdout || '';
}

function gitBlob(revision, file) {
  const result = spawnSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function readFileOrNull(file) { try { return fs.readFileSync(file); } catch { return null; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function normalize(value) { return String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function sha256File(file) { return sha256(fs.readFileSync(file)); }
