import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, restoreMigrationSnapshot } from '../apps/api/src/migration-service.mjs';
import { MIGRATIONS, V1_MIGRATION_CHECKSUM, migrationChecksum } from '../apps/api/src/migrations/index.mjs';
import { SCHEMA_SQL } from '../apps/api/src/schema.mjs';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || '') : null;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r2-migration-evidence-'));
const databaseFile = path.join(workspace, 'state.sqlite');
const snapshotRoot = path.join(workspace, 'snapshots');
const timestamp = '2026-08-11T00:00:00.000Z';

try {
  const baseline = createV1Database(databaseFile);
  const migrated = migrateDatabase({ file: databaseFile, snapshotRoot, now: () => new Date(timestamp) });
  const modified = inspect(databaseFile, (db) => {
    db.prepare('UPDATE projects SET name=? WHERE id=?').run('modified fixture', 'prj_r2_migration');
    return databaseState(db);
  });
  const snapshot = migrated.snapshot;
  if (!snapshot?.manifest || !snapshot?.file) throw new Error('migration_snapshot_missing');
  const restored = restoreMigrationSnapshot({ file: databaseFile, manifestPath: snapshot.manifest });
  const afterRestore = inspect(databaseFile, (db) => databaseState(db));
  if (restored.sha256 !== snapshot.sha256) throw new Error('migration_restore_hash_mismatch');
  if (afterRestore.integrity !== 'ok' || afterRestore.user_version !== 1 || afterRestore.project_name !== 'baseline fixture' || afterRestore.has_ledger) {
    throw new Error('migration_restore_state_invalid');
  }

  const record = {
    schema_version: 'aiws.v3.r2_migration_evidence.v1',
    status: 'passed',
    inputs: {
      database: 'temporary SQLite fixture',
      production_volume_touched: false,
      migration_versions: MIGRATIONS.map((migration) => migration.version),
      v1_checksum: V1_MIGRATION_CHECKSUM
    },
    baseline: {
      command: 'create fingerprint-matching V1 SQLite fixture',
      output: baseline,
      exit_status: 0
    },
    modified: {
      command: 'migrateDatabase({ file, migrations: [V1, V2] })',
      output: {
        from_version: migrated.from_version,
        to_version: migrated.to_version,
        applied_versions: migrated.applied_versions,
        baseline_registered: migrated.baseline_registered,
        schema_fingerprint: migrated.schema_fingerprint,
        ledger: modified.ledger,
        integrity: modified.integrity,
        v1_checksum_frozen: modified.ledger.find((row) => Number(row.version) === 1)?.checksum === V1_MIGRATION_CHECKSUM,
        v2_checksum: modified.ledger.find((row) => Number(row.version) === 2)?.checksum,
        v2_checksum_expected: migrationChecksum(MIGRATIONS[1])
      },
      exit_status: 0
    },
    rollback: {
      command: 'restoreMigrationSnapshot({ file, manifestPath })',
      output: {
        status: 'restored',
        sha256: restored.sha256,
        from_version: restored.from_version,
        integrity: afterRestore.integrity,
        user_version: afterRestore.user_version,
        project_name: afterRestore.project_name,
        ledger_removed: !afterRestore.has_ledger
      },
      exit_status: 0
    },
    hashes: {
      baseline_database_sha256: baseline.database_sha256,
      snapshot_sha256: snapshot.sha256,
      restored_database_sha256: restored.sha256
    }
  };
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error_code: String(error?.message || 'migration_evidence_failed').replace(/[^a-zA-Z0-9_:=.-]/g, '_') })}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function createV1Database(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA_SQL);
    db.exec('PRAGMA user_version = 1');
    db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('prj_r2_migration', 'baseline fixture', '', 'active', 1, timestamp, timestamp);
  } finally { db.close(); }
  return {
    database_sha256: sha256(fs.readFileSync(file)),
    state: inspect(file, (db) => databaseState(db))
  };
}

function databaseState(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check).join(',');
  const project = db.prepare('SELECT name FROM projects WHERE id=?').get('prj_r2_migration');
  const ledger = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get()
    ? db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row, version: Number(row.version) }))
    : [];
  return {
    integrity,
    user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
    project_name: project?.name || null,
    ledger,
    has_ledger: ledger.length > 0
  };
}

function inspect(file, callback) {
  const db = new DatabaseSync(file);
  try { return callback(db); } finally { db.close(); }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
