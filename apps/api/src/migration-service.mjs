import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrationChecksum } from './migrations/index.mjs';

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0)
) STRICT;
CREATE TRIGGER IF NOT EXISTS immutable_schema_migrations_update
  BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;
CREATE TRIGGER IF NOT EXISTS immutable_schema_migrations_delete
  BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'immutable_record'); END;`;

export function migrateDatabase({ file, migrations = MIGRATIONS, snapshotRoot, now = () => new Date() } = {}) {
  const databaseFile = path.resolve(String(file || ''));
  if (!file) throw new Error('migration_database_file_required');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  validateMigrationSet(migrations);
  const db = new DatabaseSync(databaseFile);
  registerMigrationFunctions(db);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  let snapshot = null;
  try {
    const targetVersion = migrations.at(-1)?.version || 0;
    const currentVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    const applicationTables = listApplicationTables(db);
    const hasLedger = applicationTables.includes('schema_migrations');
    const isEmpty = applicationTables.every((table) => table === 'schema_migrations');

    if (!isEmpty && currentVersion === 0) throw new Error('legacy_database_rejected:unversioned_nonempty_database');
    if (currentVersion > targetVersion) throw new Error(`legacy_database_rejected:user_version=${currentVersion}`);

    if (!isEmpty && (!hasLedger || currentVersion < targetVersion)) {
      snapshot = createMigrationSnapshot({
        db,
        databaseFile,
        snapshotRoot,
        fromVersion: currentVersion,
        toVersion: targetVersion,
        createdAt: now()
      });
    }

    if (!hasLedger && !isEmpty) {
      const baseline = migrations.find((migration) => migration.version === currentVersion);
      if (!baseline) throw new Error(`migration_baseline_missing:user_version=${currentVersion}`);
      const expectedFingerprint = expectedSchemaFingerprint(baseline.sql);
      const actualFingerprint = schemaFingerprint(db);
      if (actualFingerprint !== expectedFingerprint) {
        throw new Error(`migration_baseline_fingerprint_mismatch:expected=${expectedFingerprint}:actual=${actualFingerprint}`);
      }
      applyLedgerBaseline(db, baseline, now());
    } else {
      db.exec(MIGRATION_TABLE_SQL);
    }

    const applied = readAppliedMigrations(db);
    verifyAppliedMigrations(applied, migrations);
    const ledgerVersion = Number(applied.at(-1)?.version || 0);
    if (ledgerVersion !== currentVersion) throw new Error(`migration_user_version_mismatch:ledger=${ledgerVersion}:user_version=${currentVersion}`);
    const appliedVersions = new Set(applied.map((row) => Number(row.version)));
    const newlyApplied = [];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      applyMigration(db, migration, now());
      newlyApplied.push(migration.version);
    }
    return {
      from_version: currentVersion,
      to_version: targetVersion,
      applied_versions: newlyApplied,
      baseline_registered: !hasLedger && !isEmpty,
      schema_fingerprint: schemaFingerprint(db),
      snapshot
    };
  } finally {
    db.close();
  }
}

function registerMigrationFunctions(db) {
  db.function('aiws_sha256', { deterministic: true }, (value) => sha256(String(value ?? '')));
  db.function('aiws_canonical_hash', { deterministic: true }, (value) => {
    let parsed;
    try { parsed = JSON.parse(String(value ?? 'null')); } catch { parsed = String(value ?? ''); }
    return sha256(JSON.stringify(canonicalize(parsed)));
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function restoreMigrationSnapshot({ file, manifestPath }) {
  const databaseFile = path.resolve(String(file || ''));
  const fullManifestPath = path.resolve(String(manifestPath || ''));
  if (!file || !manifestPath) throw new Error('migration_restore_input_required');
  const manifest = JSON.parse(fs.readFileSync(fullManifestPath, 'utf8'));
  if (manifest.schema_version !== 'aiws.v3.migration_snapshot.v1') throw new Error('migration_snapshot_manifest_invalid');
  const snapshotFile = path.resolve(path.dirname(fullManifestPath), manifest.snapshot_file);
  const actualSnapshotHash = sha256(fs.readFileSync(snapshotFile));
  if (actualSnapshotHash !== manifest.snapshot_sha256) throw new Error('migration_snapshot_checksum_mismatch');
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  const temporary = `${databaseFile}.restore-${randomUUID()}.tmp`;
  fs.copyFileSync(snapshotFile, temporary);
  fs.copyFileSync(temporary, databaseFile);
  fs.rmSync(temporary, { force: true });
  fs.rmSync(`${databaseFile}-wal`, { force: true });
  fs.rmSync(`${databaseFile}-shm`, { force: true });
  const restoredHash = sha256(fs.readFileSync(databaseFile));
  if (restoredHash !== manifest.snapshot_sha256) throw new Error('migration_snapshot_restore_mismatch');
  const restored = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const integrity = restored.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    const version = Number(restored.prepare('PRAGMA user_version').get().user_version);
    if (integrity.some((value) => value !== 'ok') || version !== Number(manifest.from_version)) throw new Error('migration_snapshot_restore_invalid');
  } finally {
    restored.close();
  }
  return { database_file: databaseFile, sha256: restoredHash, from_version: manifest.from_version };
}

export function schemaFingerprint(db) {
  const rows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' AND tbl_name <> 'schema_migrations'
    ORDER BY type,name`).all();
  const normalized = rows.map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: normalizeSql(row.sql || '')
  }));
  return sha256(JSON.stringify(normalized));
}

export function expectedSchemaFingerprint(sql) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    return schemaFingerprint(db);
  } finally {
    db.close();
  }
}

function applyLedgerBaseline(db, migration, createdAt) {
  const started = performance.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(MIGRATION_TABLE_SQL);
    db.prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at,duration_ms) VALUES(?,?,?,?,?)')
      .run(migration.version, migration.name, migrationChecksum(migration), createdAt.toISOString(), elapsed(started));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* retain migration failure */ }
    throw error;
  }
}

function applyMigration(db, migration, createdAt) {
  const started = performance.now();
  const toggleForeignKeys = migration.disableForeignKeys === true;
  // SQLite does not permit changing foreign_keys inside an open transaction.
  // R3's projects table replacement therefore opts into a scoped FK pause; the
  // transaction still gives the DDL and ledger row one atomic commit point.
  if (toggleForeignKeys) db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(migrationDdl(migration.sql));
    db.prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at,duration_ms) VALUES(?,?,?,?,?)')
      .run(migration.version, migration.name, migrationChecksum(migration), createdAt.toISOString(), elapsed(started));
    db.exec(`PRAGMA user_version = ${migration.version}`);
    if (toggleForeignKeys) {
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error('migration_foreign_key_check_failed');
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* retain migration failure */ }
    if (toggleForeignKeys) db.exec('PRAGMA foreign_keys = ON');
    throw error;
  }
  if (toggleForeignKeys) {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function createMigrationSnapshot({ db, databaseFile, snapshotRoot, fromVersion, toVersion, createdAt }) {
  const directory = path.resolve(snapshotRoot || path.join(path.dirname(databaseFile), 'migration-snapshots'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  const basename = `pre-v${fromVersion}-to-v${toVersion}-${stamp}-${randomUUID()}`;
  const snapshotFile = path.join(directory, `${basename}.sqlite`);
  db.exec(`VACUUM INTO '${snapshotFile.replaceAll("'", "''")}'`);
  const manifest = {
    schema_version: 'aiws.v3.migration_snapshot.v1',
    created_at: createdAt.toISOString(),
    source_file: databaseFile,
    from_version: fromVersion,
    to_version: toVersion,
    snapshot_file: path.basename(snapshotFile),
    snapshot_sha256: sha256(fs.readFileSync(snapshotFile))
  };
  const manifestFile = path.join(directory, `${basename}.manifest.json`);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { file: snapshotFile, manifest: manifestFile, sha256: manifest.snapshot_sha256 };
}

function readAppliedMigrations(db) {
  return db.prepare('SELECT version,name,checksum,applied_at,duration_ms FROM schema_migrations ORDER BY version').all();
}

function verifyAppliedMigrations(applied, migrations) {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = byVersion.get(Number(row.version));
    if (!migration) throw new Error(`migration_unknown_applied_version:${row.version}`);
    if (row.name !== migration.name || row.checksum !== migrationChecksum(migration)) {
      throw new Error(`migration_checksum_conflict:version=${row.version}`);
    }
  }
  for (let index = 0; index < applied.length; index += 1) {
    if (Number(applied[index].version) !== migrations[index]?.version) {
      throw new Error(`migration_history_gap:version=${applied[index].version}`);
    }
  }
}

function validateMigrationSet(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) throw new Error('migration_set_empty');
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration.version !== index + 1 || !/^[a-z][a-z0-9_]{2,80}$/.test(migration.name) || !String(migration.sql).trim()) {
      throw new Error(`migration_set_invalid:index=${index}`);
    }
  }
}

function listApplicationTables(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase();
}

function migrationDdl(sql) {
  return String(sql).replace(/^\s*PRAGMA\s+(?:foreign_keys|journal_mode|synchronous|busy_timeout)\s*=.*?;\s*$/gim, '');
}

function elapsed(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
