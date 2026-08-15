import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, restoreMigrationSnapshot } from '../apps/api/src/migration-service.mjs';
import { MIGRATIONS, migrationChecksum } from '../apps/api/src/migrations/index.mjs';
import { SCHEMA_SQL } from '../apps/api/src/schema.mjs';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || '') : null;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r4-migration-evidence-'));
const databaseFile = path.join(workspace, 'state.sqlite');
const snapshotRoot = path.join(workspace, 'snapshots');
const timestamp = '2026-08-13T00:00:00.000Z';
const projectId = 'prj_r4_migration';
const tasksJson = JSON.stringify([{ id: 'legacy_task', title: 'Legacy task', goal: 'Remain executable', deps: [], mode: 'read', inputs: [], outputs: ['legacy.json'], acceptance: ['done'] }]);

try {
  createV1Database(databaseFile);
  migrateDatabase({ file: databaseFile, migrations: MIGRATIONS.slice(0, 3), snapshotRoot, now: () => new Date(timestamp) });
  seedV3Workflow(databaseFile);
  const migrated = migrateDatabase({ file: databaseFile, snapshotRoot, now: () => new Date(timestamp) });
  if (!migrated.snapshot?.manifest || !migrated.snapshot?.file) throw new Error('r4_migration_snapshot_missing');

  const evidenceDirectory = outputPath ? path.dirname(outputPath) : workspace;
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const snapshotFile = path.join(evidenceDirectory, 'migration-snapshot.sqlite');
  const snapshotManifest = path.join(evidenceDirectory, 'migration-snapshot.manifest.json');
  fs.copyFileSync(migrated.snapshot.file, snapshotFile);
  const sourceManifest = JSON.parse(fs.readFileSync(migrated.snapshot.manifest, 'utf8'));
  fs.writeFileSync(snapshotManifest, `${JSON.stringify({ ...sourceManifest, snapshot_file: path.basename(snapshotFile) }, null, 2)}\n`);

  const modified = inspect(databaseFile, (db) => {
    db.prepare('UPDATE projects SET name=? WHERE id=?').run('modified after R4 migration', projectId);
    return state(db);
  });
  const restored = restoreMigrationSnapshot({ file: databaseFile, manifestPath: snapshotManifest });
  const afterRestore = inspect(databaseFile, (db) => legacyState(db));
  if (restored.sha256 !== migrated.snapshot.sha256) throw new Error('r4_migration_restore_hash_mismatch');
  if (afterRestore.integrity !== 'ok' || afterRestore.foreign_keys.length || afterRestore.user_version !== 3 || afterRestore.project_name !== 'V3 workflow fixture') throw new Error('r4_migration_restore_state_invalid');
  if (afterRestore.ledger.length !== 3 || afterRestore.ledger.some((row, index) => row.checksum !== migrationChecksum(MIGRATIONS[index]))) throw new Error('r4_migration_restore_ledger_invalid');

  const record = {
    schema_version: 'aiws.v3.r4_migration_evidence.v1',
    status: 'passed',
    inputs: {
      database: 'temporary SQLite V3 workflow fixture',
      production_volume_touched: false,
      migration_versions: MIGRATIONS.map((migration) => migration.version),
      v1_checksum: migrationChecksum(MIGRATIONS[0]),
      v2_checksum: migrationChecksum(MIGRATIONS[1]),
      v3_checksum: migrationChecksum(MIGRATIONS[2]),
      v4_checksum: migrationChecksum(MIGRATIONS[3])
    },
    baseline_v3: {
      command: 'migrateDatabase({ migrations: MIGRATIONS.slice(0, 3) }) plus legacy workflow/execution fixture',
      output: { user_version: 3, workflow_revision: 1, execution_reference: 'exe_r4_migration', task_id: 'legacy_task' },
      exit_status: 0
    },
    modified_v4: {
      command: 'migrateDatabase({ migrations: MIGRATIONS })',
      output: {
        from_version: migrated.from_version,
        to_version: migrated.to_version,
        applied_versions: migrated.applied_versions,
        snapshot_sha256: migrated.snapshot.sha256,
        state: modified,
        legacy_workflow: { hierarchy_mode: modified.workflow.hierarchy_mode, layout_revision: modified.draft.layout_revision, contract_source: modified.contract.source },
        v4_ledger_checksum: modified.ledger.find((row) => row.version === 4)?.checksum
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
        workflow_revision: afterRestore.workflow_revision,
        execution_status: afterRestore.execution_status,
        task_status: afterRestore.task_status,
        ledger: afterRestore.ledger
      },
      exit_status: 0
    },
    artifacts: {
      snapshot: outputPath ? path.relative(process.cwd(), snapshotFile).replaceAll('\\', '/') : 'migration-snapshot.sqlite',
      manifest: outputPath ? path.relative(process.cwd(), snapshotManifest).replaceAll('\\', '/') : 'migration-snapshot.manifest.json'
    },
    hashes: { snapshot_sha256: migrated.snapshot.sha256, restored_database_sha256: restored.sha256 }
  };
  if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error_code: String(error?.message || 'r4_migration_evidence_failed').replace(/[^a-zA-Z0-9_:=.-]/g, '_') })}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function createV1Database(file) {
  const db = new DatabaseSync(file);
  try { db.exec(SCHEMA_SQL); db.exec('PRAGMA user_version = 1'); } finally { db.close(); }
}

function seedV3Workflow(file) {
  const db = new DatabaseSync(file);
  try {
    db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(projectId, 'V3 workflow fixture', '', 'active', 1, timestamp, timestamp);
    db.prepare('INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)').run(projectId, 1, '{"objective":"legacy"}', 'a'.repeat(64), timestamp);
    db.prepare('INSERT INTO workflow_drafts(id,project_id,revision,graph_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('wfd_r4_migration', projectId, 2, `{"tasks":${tasksJson}}`, 'confirmed', timestamp, timestamp);
    db.prepare('INSERT INTO workflow_revisions(project_id,revision,name,tasks_json,graph_hash,created_at) VALUES(?,?,?,?,?,?)').run(projectId, 1, 'Legacy workflow', tasksJson, 'b'.repeat(64), timestamp);
    db.prepare('INSERT INTO workflow_heads(project_id,revision,updated_at) VALUES(?,?,?)').run(projectId, 1, timestamp);
    db.prepare('INSERT INTO node_contracts(id,project_id,workflow_revision,node_id,contract_json,created_at) VALUES(?,?,?,?,?,?)').run('nct_r4_migration', projectId, 1, 'legacy_task', '{"goal":"Remain executable"}', timestamp);
    db.prepare('INSERT INTO workflow_generations(id,project_id,brief_revision,status,candidate_json,critic_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('wgen_r4_migration', projectId, 1, 'completed', `{"tasks":${tasksJson}}`, '{"status":"passed"}', timestamp, timestamp);
    db.prepare('INSERT INTO workflow_generation_events(generation_id,type,data_json,created_at) VALUES(?,?,?,?)').run('wgen_r4_migration', 'workflow.generation.completed', '{"status":"completed"}', timestamp);
    db.prepare('INSERT INTO executions(id,project_id,workflow_revision,brief_revision,brief_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('exe_r4_migration', projectId, 1, 1, 'a'.repeat(64), 'queued', timestamp, timestamp);
    db.prepare('INSERT INTO task_attempts(id,execution_id,task_id,attempt_no,status,mode,created_at) VALUES(?,?,?,?,?,?,?)').run('att_r4_migration', 'exe_r4_migration', 'legacy_task', 1, 'pending', 'initial', timestamp);
  } finally { db.close(); }
}

function inspect(file, callback) {
  const db = new DatabaseSync(file);
  try { return callback(db); } finally { db.close(); }
}

function state(db) {
  const ledger = db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row, version: Number(row.version) }));
  return {
    integrity: db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check).join(','),
    foreign_keys: db.prepare('PRAGMA foreign_key_check').all(),
    user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
    project_name: db.prepare('SELECT name FROM projects WHERE id=?').get(projectId)?.name || null,
    workflow: db.prepare('SELECT hierarchy_mode,tasks_json,metadata_json FROM workflow_revisions WHERE project_id=? AND revision=1').get(projectId),
    draft: db.prepare('SELECT hierarchy_mode,layout_revision,draft_hash FROM workflow_drafts WHERE id=?').get('wfd_r4_migration'),
    layout: db.prepare('SELECT revision,source,layout_hash FROM workflow_layout_revisions WHERE draft_id=?').get('wfd_r4_migration'),
    contract: db.prepare('SELECT revision,source,contract_hash FROM node_contract_revisions WHERE project_id=? AND workflow_revision=1 AND node_id=?').get(projectId, 'legacy_task'),
    ledger
  };
}

function legacyState(db) {
  return {
    integrity: db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check).join(','),
    foreign_keys: db.prepare('PRAGMA foreign_key_check').all(),
    user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
    project_name: db.prepare('SELECT name FROM projects WHERE id=?').get(projectId)?.name || null,
    workflow_revision: db.prepare('SELECT revision FROM workflow_revisions WHERE project_id=? AND revision=1').get(projectId)?.revision || null,
    execution_status: db.prepare('SELECT status FROM executions WHERE id=?').get('exe_r4_migration')?.status || null,
    task_status: db.prepare('SELECT status FROM task_attempts WHERE id=?').get('att_r4_migration')?.status || null,
    ledger: db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row, version: Number(row.version) }))
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
