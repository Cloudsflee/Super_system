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
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r3-migration-evidence-'));
const databaseFile = path.join(workspace, 'state.sqlite');
const snapshotRoot = path.join(workspace, 'snapshots');
const timestamp = '2026-08-11T00:00:00.000Z';
const projectId = 'prj_r3_migration';

try {
  createV1Database(databaseFile);
  const v2 = migrateDatabase({ file: databaseFile, migrations: MIGRATIONS.slice(0, 2), snapshotRoot, now: () => new Date(timestamp) });
  seedV2Project(databaseFile);
  const migrated = migrateDatabase({ file: databaseFile, snapshotRoot, now: () => new Date(timestamp) });
  if (!migrated.snapshot?.manifest || !migrated.snapshot?.file) throw new Error('r3_migration_snapshot_missing');

  const modified = inspect(databaseFile, (db) => {
    db.prepare('UPDATE projects SET name=? WHERE id=?').run('modified after R3 migration', projectId);
    return state(db);
  });
  const restored = restoreMigrationSnapshot({ file: databaseFile, manifestPath: migrated.snapshot.manifest });
  const afterRestore = inspect(databaseFile, (db) => legacyState(db));
  if (restored.sha256 !== migrated.snapshot.sha256) throw new Error('r3_migration_restore_hash_mismatch');
  if (afterRestore.integrity !== 'ok' || afterRestore.foreign_keys.length || afterRestore.user_version !== 2 || afterRestore.project_name !== 'V2 backfill fixture') {
    throw new Error('r3_migration_restore_state_invalid');
  }
  if (afterRestore.ledger.length !== 2 || afterRestore.ledger[0].checksum !== V1_MIGRATION_CHECKSUM || afterRestore.ledger[1].checksum !== migrationChecksum(MIGRATIONS[1])) {
    throw new Error('r3_migration_restore_ledger_invalid');
  }

  const record = {
    schema_version: 'aiws.v3.r3_migration_evidence.v1',
    status: 'passed',
    inputs: {
      database: 'temporary SQLite V2 fixture',
      production_volume_touched: false,
      migration_versions: MIGRATIONS.map((migration) => migration.version),
      v1_checksum: V1_MIGRATION_CHECKSUM,
      v2_checksum: migrationChecksum(MIGRATIONS[1]),
      v3_checksum: migrationChecksum(MIGRATIONS[2])
    },
    baseline_v2: {
      command: 'migrateDatabase({ migrations: MIGRATIONS.slice(0, 2) }) plus project/brief/binding fixture',
      output: { ...v2, state: inspect(databaseFile, (db) => legacyState(db)) },
      exit_status: 0
    },
    modified_v3: {
      command: 'migrateDatabase({ migrations: MIGRATIONS })',
      output: {
        from_version: migrated.from_version,
        to_version: migrated.to_version,
        applied_versions: migrated.applied_versions,
        snapshot_manifest: migrated.snapshot.manifest,
        state: modified,
        project_backfill: modified.project,
        intake_backfill: modified.intake,
        brief_backfill: modified.brief_head,
        repository_backfill: { connection: modified.connection, target: modified.target, line: modified.line }
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
        foreign_keys: afterRestore.foreign_keys,
        user_version: afterRestore.user_version,
        project_name: afterRestore.project_name,
        ledger: afterRestore.ledger
      },
      exit_status: 0
    },
    hashes: {
      snapshot_sha256: migrated.snapshot.sha256,
      restored_database_sha256: restored.sha256
    }
  };
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error_code: String(error?.message || 'r3_migration_evidence_failed').replace(/[^a-zA-Z0-9_:=.-]/g, '_') })}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function createV1Database(file) {
  const db = new DatabaseSync(file);
  try { db.exec(SCHEMA_SQL); db.exec('PRAGMA user_version = 1'); } finally { db.close(); }
}

function seedV2Project(file) {
  const db = new DatabaseSync(file);
  try {
    db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(projectId, 'V2 backfill fixture', '', 'active', 4, timestamp, timestamp);
    db.prepare('INSERT INTO project_intakes(id,project_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run('int_r3_migration', projectId, 'ready', '{"mode":"existing"}', timestamp, timestamp);
    db.prepare('INSERT INTO workflow_drafts(id,project_id,revision,graph_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('wfd_r3_migration', projectId, 3, '{}', 'draft', timestamp, timestamp);
    db.prepare('INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)')
      .run(projectId, 1, '{"objective":"legacy"}', 'a'.repeat(64), timestamp);
    db.prepare('INSERT INTO brief_heads(project_id,revision,updated_at) VALUES(?,?,?)').run(projectId, 1, timestamp);
    db.prepare('INSERT INTO repository_bindings(id,project_id,local_path,remote_url,head_sha,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('repo_r3_migration', projectId, `projects/${projectId}`, 'https://HOST/TARGET.git', 'b'.repeat(40), 2, timestamp, timestamp);
  } finally { db.close(); }
}

function inspect(file, callback) {
  const db = new DatabaseSync(file);
  try { return callback(db); } finally { db.close(); }
}

function state(db, { ledgerLimit = null } = {}) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check).join(',');
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  const project = db.prepare('SELECT status,onboarding_state,confirmed_brief_revision,confirmed_brief_hash,workflow_draft_id,name FROM projects WHERE id=?').get(projectId);
  const intake = db.prepare('SELECT status,mode,revision,attempt,completed_at FROM project_intakes WHERE project_id=?').get(projectId);
  const briefHead = db.prepare('SELECT revision,confirmed_revision,confirmation_revision,confirmed_by,confirmed_hash FROM brief_heads WHERE project_id=?').get(projectId);
  const connection = db.prepare('SELECT id,source_kind,source_locator,revision,read_only FROM repository_connections WHERE project_id=?').get(projectId);
  const target = connection ? db.prepare('SELECT id,baseline_sha,managed_relative_path FROM repository_targets WHERE connection_id=?').get(connection.id) : null;
  const line = db.prepare('SELECT id,line_kind,baseline_sha,managed_relative_path,status FROM repository_lines WHERE project_id=? AND line_kind=?').get(projectId, 'managed_checkout');
  let ledger = db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row, version: Number(row.version) }));
  if (ledgerLimit != null) ledger = ledger.slice(0, ledgerLimit);
  return {
    integrity,
    foreign_keys: foreignKeys,
    user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
    project_name: project?.name || null,
    project: project ? { ...project } : null,
    intake: intake ? { ...intake } : null,
    brief_head: briefHead ? { ...briefHead } : null,
    connection: connection ? { ...connection } : null,
    target: target ? { ...target } : null,
    line: line ? { ...line } : null,
    ledger
  };
}

function legacyState(db) {
  return {
    integrity: db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check).join(','),
    foreign_keys: db.prepare('PRAGMA foreign_key_check').all(),
    user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
    project_name: db.prepare('SELECT name FROM projects WHERE id=?').get(projectId)?.name || null,
    ledger: db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row, version: Number(row.version) }))
  };
}
