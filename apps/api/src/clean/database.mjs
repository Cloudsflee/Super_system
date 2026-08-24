import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256Hex, utcNow, opaqueId } from './canonical.mjs';
import {
  CLEAN_BASELINE_ID,
  CLEAN_BASELINE_SQL,
  CLEAN_BASELINE_CHECKSUM,
  CLEAN_MIGRATIONS,
  CLEAN_SCHEMA_FAMILY,
  CLEAN_TOOL_VERSION,
  CLEAN_USER_VERSION
} from './migrations/001-clean-baseline.mjs';
import { IDENTITY_MIGRATION, IDENTITY_MIGRATION_VERSION, IDENTITY_TOOL_VERSION } from './migrations/002-identity-acl.mjs';
import { PROJECT_WORKFLOW_MIGRATION, PROJECT_WORKFLOW_MIGRATION_VERSION, PROJECT_WORKFLOW_TOOL_VERSION } from './migrations/003-project-workflow.mjs';
import { CONTEXT_PROJECTION_MCP_MIGRATION, CONTEXT_PROJECTION_MCP_MIGRATION_VERSION, CONTEXT_PROJECTION_MCP_TOOL_VERSION } from './migrations/004-context-projection-mcp.mjs';
import { ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION, ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_VERSION, ASSIST_FILES_TERMINAL_BRIDGE_TOOL_VERSION } from './migrations/005-assist-files-terminal-bridge.mjs';
import { RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION, RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_VERSION, RUNNER_EXECUTION_CHECKPOINT_REPLAY_TOOL_VERSION } from './migrations/006-runner-execution-checkpoint-replay.mjs';

export const CLEAN_P2_USER_VERSION = IDENTITY_MIGRATION_VERSION;
export const CLEAN_P2_TOOL_VERSION = IDENTITY_TOOL_VERSION;
export const CLEAN_P3_USER_VERSION = PROJECT_WORKFLOW_MIGRATION_VERSION;
export const CLEAN_P3_TOOL_VERSION = PROJECT_WORKFLOW_TOOL_VERSION;
export const CLEAN_P4_USER_VERSION = CONTEXT_PROJECTION_MCP_MIGRATION_VERSION;
export const CLEAN_P4_TOOL_VERSION = CONTEXT_PROJECTION_MCP_TOOL_VERSION;
export const CLEAN_P5_USER_VERSION = ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION_VERSION;
export const CLEAN_P5_TOOL_VERSION = ASSIST_FILES_TERMINAL_BRIDGE_TOOL_VERSION;
export const CLEAN_P6_USER_VERSION = RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION_VERSION;
export const CLEAN_P6_TOOL_VERSION = RUNNER_EXECUTION_CHECKPOINT_REPLAY_TOOL_VERSION;

export class CleanDatabaseError extends Error {
  constructor(code, message, details = {}, status = 503) {
    super(message);
    this.name = 'CleanDatabaseError';
    this.code = code;
    this.status = status;
    this.retryable = code === 'not_ready';
    this.details = details;
  }
}

export class CleanNotReadyError extends CleanDatabaseError {
  constructor(message, details = {}) {
    super('not_ready', message, details, 503);
  }
}

export class CleanDatabase {
  constructor(file, db, metadata) {
    this.file = path.resolve(file);
    this.db = db;
    this.metadata = Object.freeze(metadata);
    this.closed = false;
    this.transactionTail = Promise.resolve();
    this.commitHooks = null;
  }

  query(sql, params = []) { return normalize(this.db.prepare(sql).all(...params)); }
  get(sql, params = []) { return normalize(this.db.prepare(sql).get(...params) ?? null); }
  run(sql, params = [], expectChanges = null) {
    const result = this.db.prepare(sql).run(...params);
    const changes = Number(result.changes);
    if (expectChanges != null && changes !== Number(expectChanges)) {
      const error = new Error('transaction_precondition_failed');
      error.name = 'TransactionPreconditionError';
      error.changes = changes;
      throw error;
    }
    return normalize({ changes, lastInsertRowid: result.lastInsertRowid });
  }
  exec(sql) { this.db.exec(sql); return null; }
  transaction(statements = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => this.run(statement.sql, statement.params || [], statement.expect_changes));
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }
  withTransaction(callback) {
    const execute = async () => {
      this.db.exec('BEGIN IMMEDIATE');
      const hooks = [];
      this.commitHooks = hooks;
      try {
        const result = callback(this);
        if (result && typeof result.then === 'function') {
          const error = new CleanDatabaseError('transaction_callback_async', 'transaction callback must be synchronous', {}, 400);
          throw error;
        }
        this.db.exec('COMMIT');
        this.commitHooks = null;
        for (const hook of hooks) queueMicrotask(hook);
        return result;
      } catch (error) {
        this.commitHooks = null;
        try { this.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
        throw error;
      }
    };
    const queued = this.transactionTail.then(execute, execute);
    this.transactionTail = queued.catch(() => undefined);
    return queued;
  }
  afterCommit(callback) {
    if (typeof callback !== 'function') throw new TypeError('commit_hook_required');
    if (this.commitHooks) this.commitHooks.push(callback);
    else queueMicrotask(callback);
  }
  integrity() {
    const integrity = this.db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
    const semantic = semanticIntegrity(this.db);
    return {
      integrity,
      foreign_key_check: foreignKeys,
      semantic,
      journal_mode: this.db.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: Number(this.db.prepare('PRAGMA synchronous').get().synchronous),
      user_version: Number(this.db.prepare('PRAGMA user_version').get().user_version)
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function openCleanDatabase(file, options = {}) {
  if (!file) throw new TypeError('clean_database_file_required');
  const databaseFile = path.resolve(String(file));
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(databaseFile) && fs.statSync(databaseFile).size > 0;
  if (existed) inspectExistingFamily(databaseFile, options);
  const db = new DatabaseSync(databaseFile);
  configure(db);
  try {
    const metadata = ensureBaseline(db, { ...options, targetVersion: targetVersionFor(options) });
    return new CleanDatabase(databaseFile, db, metadata);
  } catch (error) {
    try { db.close(); } catch { /* retain initialization error */ }
    throw error;
  }
}

function targetVersionFor(options = {}) {
  if (options.targetVersion != null) return Number(options.targetVersion);
  if (options.phase === 'p1' || options.cleanPhase === 'p1') return CLEAN_USER_VERSION;
  if (options.phase === 'p2' || options.cleanPhase === 'p2') return CLEAN_P2_USER_VERSION;
  if (options.phase === 'p3' || options.cleanPhase === 'p3') return CLEAN_P3_USER_VERSION;
  if (options.phase === 'p4' || options.cleanPhase === 'p4') return CLEAN_P4_USER_VERSION;
  if (options.phase === 'p5' || options.cleanPhase === 'p5') return CLEAN_P5_USER_VERSION;
  if (options.phase === 'p6' || options.cleanPhase === 'p6') return CLEAN_P6_USER_VERSION;
  // The low-level database helper remains useful for reproducing the frozen
  // baseline.  The runtime always supplies its current target explicitly.
  return CLEAN_USER_VERSION;
}

export function initializeCleanDatabase({ file, options = {} } = {}) {
  const database = openCleanDatabase(file, options);
  const integrity = database.integrity();
  if (integrity.integrity.some((value) => value !== 'ok') || integrity.foreign_key_check.length || !integrity.semantic.valid) {
    database.close();
    throw new CleanNotReadyError('clean database integrity check failed', { integrity, reason: integrity.semantic.valid ? 'integrity_failed' : 'semantic_integrity_failed' });
  }
  return { database, metadata: database.metadata, integrity };
}

export const migrateCleanDatabase = initializeCleanDatabase;

function configure(db) {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
}

function inspectExistingFamily(databaseFile, options) {
  let db;
  try {
    db = new DatabaseSync(databaseFile, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
    if (tables.length === 0 && userVersion === 0) return;
    const hasMeta = tables.includes('schema_meta');
    if (!hasMeta) throw historicalSchema(databaseFile, tables, options);
    const meta = db.prepare('SELECT family,baseline_id FROM schema_meta WHERE id=1').get();
    if (!meta || meta.family !== CLEAN_SCHEMA_FAMILY || meta.baseline_id !== CLEAN_BASELINE_ID) {
      throw historicalSchema(databaseFile, tables, options, meta || null);
    }
  } catch (error) {
    if (error instanceof CleanDatabaseError) throw error;
    if (String(error?.code) === 'SQLITE_CANTOPEN' || String(error?.message).includes('not a database')) {
      throw historicalSchema(databaseFile, [], options, { reason: 'unreadable_or_non_sqlite' });
    }
    throw error;
  } finally {
    try { db?.close(); } catch { /* no-op */ }
  }
}

function historicalSchema(databaseFile, tables, options, observed = null) {
  const receipt = writeImporterRequestReceipt(databaseFile, {
    tables,
    observed,
    receiptRoot: options.receiptRoot,
    now: options.now
  });
  return new CleanNotReadyError('historical schema requires offline importer', {
    reason: 'historical_schema',
    importer_command: 'import.inspect',
    receipt_reference: receipt.reference,
    schema_family: observed?.family || 'unknown'
  });
}

function ensureBaseline(db, options) {
  const now = typeof options.now === 'function' ? options.now : utcNow;
  const suppliedTimestamp = now();
  const timestamp = typeof suppliedTimestamp === 'string' ? suppliedTimestamp : new Date(suppliedTimestamp).toISOString();
  const targetVersion = Number(options.targetVersion ?? CLEAN_USER_VERSION);
  if (![CLEAN_USER_VERSION, CLEAN_P2_USER_VERSION, CLEAN_P3_USER_VERSION, CLEAN_P4_USER_VERSION, CLEAN_P5_USER_VERSION, CLEAN_P6_USER_VERSION].includes(targetVersion)) {
    throw new CleanNotReadyError('clean schema version is unsupported', { reason: 'version_mismatch', expected: CLEAN_P6_USER_VERSION, actual: targetVersion });
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  if (tables.length === 0) return applyFreshMigrations(db, options, timestamp, targetVersion);

  const meta = db.prepare('SELECT * FROM schema_meta WHERE id=1').get();
  if (!meta || meta.family !== CLEAN_SCHEMA_FAMILY || meta.baseline_id !== CLEAN_BASELINE_ID) {
    throw new CleanNotReadyError('clean schema family marker is invalid', { reason: 'family_mismatch', observed: meta || null });
  }
  let version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version < CLEAN_USER_VERSION || version > CLEAN_P6_USER_VERSION) {
    throw new CleanNotReadyError('clean schema version is unsupported', { reason: 'version_mismatch', expected: targetVersion, actual: version });
  }
  verifyMigrationRow(db, version);
  while (version < targetVersion) {
    const migration = migrationForVersion(version + 1);
    applyMigration(db, migration, options, timestamp);
    version = migration.version;
  }
  if (version !== targetVersion) {
    throw new CleanNotReadyError('clean schema version is unsupported', { reason: 'version_mismatch', expected: targetVersion, actual: version });
  }
  verifyMigrationRow(db, version);
  const integrity = checkSqliteIntegrity(db);
  if (integrity.integrity.some((value) => value !== 'ok') || integrity.foreignKeys.length) {
    throw new CleanNotReadyError('clean database integrity check failed', { reason: 'integrity_failed', integrity });
  }
  const migration = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(version);
  return metadataFromMigration(db, meta, migration, version);
}

function applyFreshMigrations(db, options, timestamp, targetVersion) {
  const started = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const baseline = CLEAN_MIGRATIONS[0];
    db.exec(stripPragmas(baseline.sql));
    if (options.failAt === 'ddl') throw new Error('injected_ddl_failure');
    const baselineSnapshot = schemaSnapshotHash(db);
    const baselineVerification = {
      family: CLEAN_SCHEMA_FAMILY,
      baseline_id: CLEAN_BASELINE_ID,
      user_version: CLEAN_USER_VERSION,
      schema_sha256: baselineSnapshot,
      foreign_key_check: []
    };
    const baselineVerificationSha = sha256Hex(canonicalJson(baselineVerification));
    db.prepare(`INSERT INTO schema_meta(id,family,baseline_id,runtime_build,canonicalization_version,created_at,updated_at)
      VALUES(1,?,?,?,?,?,?)`).run(CLEAN_SCHEMA_FAMILY, CLEAN_BASELINE_ID, options.runtimeBuild || (targetVersion > 1 ? IDENTITY_TOOL_VERSION : CLEAN_TOOL_VERSION), 'canonical-json-v1', timestamp, timestamp);
    if (options.failAt === 'metadata') throw new Error('injected_metadata_failure');
    db.prepare(`INSERT INTO schema_migrations(migration_id,version,family,name,checksum,tool_version,snapshot_sha256,verification_receipt_sha256,applied_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(baseline.id, baseline.version, baseline.family, baseline.name, baseline.checksum, baseline.toolVersion, baselineSnapshot, baselineVerificationSha, timestamp);
    if (options.failAt === 'ledger') throw new Error('injected_ledger_failure');
    const bootstrapId = options.bootstrapActorId || 'actor_system_bootstrap';
    const metadataJson = canonicalJson({ bootstrap: true });
    db.prepare(`INSERT INTO actors(id,kind,display_name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(bootstrapId, 'system', 'System Bootstrap', 'active', metadataJson, sha256Hex(metadataJson), 1, timestamp, timestamp, null, null);
    db.prepare(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('receipt_migration_001_clean_baseline', 'migration.baseline', 'verified', canonicalJson(baselineVerification), baselineVerificationSha, null, timestamp, null);
    for (const migration of [IDENTITY_MIGRATION, PROJECT_WORKFLOW_MIGRATION, CONTEXT_PROJECTION_MCP_MIGRATION, ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION, RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION]) {
      if (targetVersion >= migration.version) applyMigrationInTransaction(db, migration, timestamp, options);
    }
    if (options.failAt === 'commit') throw new Error('injected_commit_failure');
    db.exec(`PRAGMA user_version = ${targetVersion}`);
    db.exec('COMMIT');
    const migration = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(targetVersion);
    return {
      family: CLEAN_SCHEMA_FAMILY,
      baseline_id: CLEAN_BASELINE_ID,
      user_version: targetVersion,
      migration_id: migration.migration_id,
      checksum: migration.checksum,
      schema_sha256: migration.snapshot_sha256,
      verification_sha256: migration.verification_receipt_sha256,
      applied_at: migration.applied_at,
      duration_ms: Date.now() - started,
      bootstrap_actor_id: bootstrapId
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration failure */ }
    throw new CleanNotReadyError('clean migration rolled back', {
      reason: 'migration_failed',
      migration_id: targetVersion >= CLEAN_P6_USER_VERSION ? RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION.id : (targetVersion >= CLEAN_P5_USER_VERSION ? ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION.id : (targetVersion >= CLEAN_P4_USER_VERSION ? CONTEXT_PROJECTION_MCP_MIGRATION.id : (targetVersion >= CLEAN_P3_USER_VERSION ? PROJECT_WORKFLOW_MIGRATION.id : (targetVersion >= CLEAN_P2_USER_VERSION ? IDENTITY_MIGRATION.id : CLEAN_BASELINE_ID)))),
      cause: String(error?.message || error)
    });
  }
}

function applyMigration(db, migration, options, timestamp) {
  db.exec('BEGIN IMMEDIATE');
  try {
    applyMigrationInTransaction(db, migration, timestamp, options);
    if (migrationFaultMatches(options.failAt, migration, 'commit')) throw new Error(`injected_${migration.version}_commit_failure`);
    db.exec(`PRAGMA user_version = ${migration.version}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration failure */ }
    throw new CleanNotReadyError('clean migration rolled back', { reason: 'migration_failed', migration_id: migration.id, cause: String(error?.message || error) });
  }
}

function applyMigrationInTransaction(db, migration, timestamp, options = {}) {
  db.exec(stripPragmas(migration.sql));
  if (migrationFaultMatches(options.failAt, migration, 'ddl')) throw new Error(`injected_${migration.version}_ddl_failure`);
  const snapshot = schemaSnapshotHash(db);
  const verification = {
    family: CLEAN_SCHEMA_FAMILY,
    migration_id: migration.id,
    user_version: migration.version,
    schema_sha256: snapshot,
    foreign_key_check: db.prepare('PRAGMA foreign_key_check').all()
  };
  const verificationSha = sha256Hex(canonicalJson(verification));
  db.prepare(`INSERT INTO schema_migrations(migration_id,version,family,name,checksum,tool_version,snapshot_sha256,verification_receipt_sha256,applied_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(migration.id, migration.version, migration.family, migration.name, migration.checksum, migration.toolVersion, snapshot, verificationSha, timestamp);
  if (migrationFaultMatches(options.failAt, migration, 'ledger')) throw new Error(`injected_${migration.version}_ledger_failure`);
  db.prepare(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(`receipt_migration_${migration.id}`, 'migration.applied', 'verified', canonicalJson(verification), verificationSha, null, timestamp, null);
  if (migrationFaultMatches(options.failAt, migration, 'receipt')) throw new Error(`injected_${migration.version}_receipt_failure`);
}

function migrationFaultMatches(failAt, migration, stage) {
  const version = String(migration.version);
  return failAt === `migration_${version}_${stage}` || failAt === `migration_${version.padStart(3, '0')}_${stage}`;
}

function verifyMigrationRow(db, version) {
  const expected = migrationForVersion(version);
  const row = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(version);
  if (!row || row.migration_id !== expected.id || row.checksum !== expected.checksum) {
    throw new CleanNotReadyError('clean migration checksum drift detected', { reason: 'checksum_drift', migration_id: expected.id, expected: expected.checksum, actual: row?.checksum || null });
  }
  const actualSnapshot = schemaSnapshotHash(db);
  if (version === Number(db.prepare('PRAGMA user_version').get().user_version) && actualSnapshot !== row.snapshot_sha256) {
    // The latest migration snapshot covers the live schema.  Older migration
    // snapshots remain immutable but are not compared to later DDL.
    throw new CleanNotReadyError('clean schema snapshot drift detected', { reason: 'snapshot_mismatch', migration_id: expected.id, expected: row.snapshot_sha256, actual: actualSnapshot });
  }
}

function migrationForVersion(version) {
  if (Number(version) === CLEAN_USER_VERSION) return CLEAN_MIGRATIONS[0];
  if (Number(version) === CLEAN_P2_USER_VERSION) return IDENTITY_MIGRATION;
  if (Number(version) === CLEAN_P3_USER_VERSION) return PROJECT_WORKFLOW_MIGRATION;
  if (Number(version) === CLEAN_P4_USER_VERSION) return CONTEXT_PROJECTION_MCP_MIGRATION;
  if (Number(version) === CLEAN_P5_USER_VERSION) return ASSIST_FILES_TERMINAL_BRIDGE_MIGRATION;
  if (Number(version) === CLEAN_P6_USER_VERSION) return RUNNER_EXECUTION_CHECKPOINT_REPLAY_MIGRATION;
  throw new CleanNotReadyError('clean schema version is unsupported', { reason: 'version_mismatch', expected: CLEAN_P6_USER_VERSION, actual: version });
}

function checkSqliteIntegrity(db) {
  return {
    integrity: db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check),
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all()
  };
}

function metadataFromMigration(db, meta, migration, version) {
  return {
    family: meta.family,
    baseline_id: meta.baseline_id,
    user_version: version,
    migration_id: migration.migration_id,
    checksum: migration.checksum,
    schema_sha256: migration.snapshot_sha256,
    verification_sha256: migration.verification_receipt_sha256,
    applied_at: migration.applied_at,
    bootstrap_actor_id: db.prepare("SELECT id FROM actors WHERE kind='system' ORDER BY created_at,id LIMIT 1").get()?.id || 'actor_system_bootstrap'
  };
}

function stripPragmas(sql) {
  return String(sql).replace(/^\s*PRAGMA\s+(?:foreign_keys|journal_mode|synchronous|busy_timeout|user_version)\s*=.*?;\s*$/gim, '');
}

export function schemaSnapshot(db) {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all().map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: normalizeSql(row.sql || '')
  }));
}

export function schemaSnapshotHash(db) {
  return sha256Hex(canonicalJson(schemaSnapshot(db)));
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase();
}

export function semanticIntegrity(db) {
  const failures = [];
  const heads = db.prepare('SELECT aggregate_type,aggregate_id,current_revision,current_hash,last_event_sequence FROM aggregate_heads ORDER BY aggregate_type,aggregate_id').all();
  for (const head of heads) {
    const revision = db.prepare('SELECT payload_sha256 FROM aggregate_revisions WHERE aggregate_type=? AND aggregate_id=? AND revision=?').get(head.aggregate_type, head.aggregate_id, head.current_revision);
    if (!revision || revision.payload_sha256 !== head.current_hash) failures.push({ kind: 'head_revision_mismatch', aggregate_type: head.aggregate_type, aggregate_id: head.aggregate_id, revision: Number(head.current_revision) });
    if (Number(head.last_event_sequence) > 0) {
      const event = db.prepare('SELECT aggregate_type,aggregate_id FROM events WHERE sequence=?').get(head.last_event_sequence);
      if (!event || event.aggregate_type !== head.aggregate_type || event.aggregate_id !== head.aggregate_id) failures.push({ kind: 'head_event_mismatch', aggregate_type: head.aggregate_type, aggregate_id: head.aggregate_id, sequence: Number(head.last_event_sequence) });
    }
  }
  return { valid: failures.length === 0, failures };
}

function writeImporterRequestReceipt(databaseFile, { tables, observed, receiptRoot, now = utcNow }) {
  const root = path.resolve(receiptRoot || path.join(path.dirname(databaseFile), 'receipts'));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const payload = {
    schema_version: 'aiws.v3-clean.importer-request.v1',
    receipt_id: opaqueId('receipt'),
    command: 'import.inspect',
    status: 'not_ready',
    observed_family: observed?.family || 'unknown',
    tables: [...tables].sort(),
    source_sha256: sha256Hex(fs.readFileSync(databaseFile)),
    created_at: typeof now() === 'string' ? now() : new Date(now()).toISOString()
  };
  const name = `importer-request-${payload.receipt_id}.json`;
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return { reference: path.relative(path.dirname(databaseFile), file).replaceAll('\\', '/'), file, payload };
}

function normalize(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value;
}

export { CLEAN_SCHEMA_FAMILY, CLEAN_BASELINE_ID, CLEAN_USER_VERSION, CLEAN_BASELINE_CHECKSUM };
