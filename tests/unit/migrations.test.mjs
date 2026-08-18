import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  migrateDatabase,
  schemaFingerprint
} from '../../apps/api/src/migration-service.mjs';
import { MIGRATIONS, V1_MIGRATION_CHECKSUM, V5_MIGRATION_CHECKSUM, V6_MIGRATION_CHECKSUM, migrationChecksum } from '../../apps/api/src/migrations/index.mjs';
import { SCHEMA_SQL } from '../../apps/api/src/schema.mjs';

function temporaryDatabase(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { home, file: path.join(home, 'state.sqlite') };
}

function legacyV1(file, projectName = null) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_SQL);
  db.exec('PRAGMA user_version = 1');
  if (projectName) {
    const timestamp = '2026-08-10T00:00:00.000Z';
    db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('prj_migration_fixture', projectName, '', 'active', 1, timestamp, timestamp);
  }
  db.close();
}

function inspect(file, callback) {
  const db = new DatabaseSync(file);
  try { return callback(db); } finally { db.close(); }
}

test('empty databases apply every forward migration and record checksums once', () => {
  const fixture = temporaryDatabase('aiws-empty-migrations-');
  const migrations = MIGRATIONS;
  try {
    const first = migrateDatabase({ file: fixture.file, migrations });
    assert.deepEqual(first.applied_versions, [1, 2, 3, 4, 5, 6]);
    assert.equal(first.from_version, 0);
    assert.equal(first.to_version, 6);
    assert.equal(first.snapshot, null);
    const rows = inspect(fixture.file, (db) => db.prepare('SELECT * FROM schema_migrations ORDER BY version').all());
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(rows.map((row) => row.checksum), migrations.map(migrationChecksum));
    assert.ok(rows.every((row) => Number(row.duration_ms) >= 0));
    assert.equal(inspect(fixture.file, (db) => Number(db.prepare('PRAGMA user_version').get().user_version)), 6);
    assert.throws(() => inspect(fixture.file, (db) => db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('0'.repeat(64))), /immutable_record/);
    assert.throws(() => inspect(fixture.file, (db) => db.prepare('DELETE FROM schema_migrations WHERE version=1').run()), /immutable_record/);

    const repeated = migrateDatabase({ file: fixture.file, migrations });
    assert.deepEqual(repeated.applied_versions, []);
    assert.equal(repeated.baseline_registered, false);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('startup resumes when an interrupted first run left only an empty migration ledger', () => {
  const fixture = temporaryDatabase('aiws-first-interruption-migration-');
  try {
    inspect(fixture.file, (db) => db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY CHECK(version > 0), name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK(length(checksum) = 64), applied_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0)) STRICT;`));
    const replay = migrateDatabase({ file: fixture.file });
    assert.deepEqual(replay.applied_versions, [1, 2, 3, 4, 5, 6]);
    assert.equal(inspect(fixture.file, (db) => Number(db.prepare('PRAGMA user_version').get().user_version)), 6);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('a fingerprint-matching V1 database is registered as a baseline with a restorable snapshot', () => {
  const fixture = temporaryDatabase('aiws-baseline-migration-');
  try {
    legacyV1(fixture.file, 'Before migration');
    const result = migrateDatabase({ file: fixture.file });
    assert.equal(result.baseline_registered, true);
    assert.deepEqual(result.applied_versions, [2, 3, 4, 5, 6]);
    assert.ok(fs.existsSync(result.snapshot.file));
    assert.ok(fs.existsSync(result.snapshot.manifest));
    const ledger = inspect(fixture.file, (db) => db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all());
    assert.deepEqual(ledger.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6]);
    assert.equal(ledger[0].name, MIGRATIONS[0].name);
    assert.equal(ledger[0].checksum, V1_MIGRATION_CHECKSUM);

    inspect(fixture.file, (db) => db.prepare('UPDATE projects SET name=? WHERE id=?').run('After migration', 'prj_migration_fixture'));
    const restore = spawnSync(process.execPath, ['scripts/restore-migration-snapshot.mjs', '--database', fixture.file, '--manifest', result.snapshot.manifest], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);
    const restored = JSON.parse(restore.stdout);
    assert.equal(restored.status, 'restored');
    assert.equal(restored.sha256, result.snapshot.sha256);
    assert.equal(inspect(fixture.file, (db) => db.prepare('SELECT name FROM projects WHERE id=?').get('prj_migration_fixture').name), 'Before migration');
    assert.equal(inspect(fixture.file, (db) => db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get().count), 0);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('baseline registration rejects a V1 schema whose fingerprint has drifted', () => {
  const fixture = temporaryDatabase('aiws-fingerprint-migration-');
  try {
    legacyV1(fixture.file);
    inspect(fixture.file, (db) => db.exec('CREATE TABLE rogue_table(id TEXT PRIMARY KEY) STRICT;'));
    assert.throws(() => migrateDatabase({ file: fixture.file }), /migration_baseline_fingerprint_mismatch/);
    assert.equal(inspect(fixture.file, (db) => db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get().count), 0);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('applied migration checksum changes are rejected before startup', () => {
  const fixture = temporaryDatabase('aiws-checksum-migration-');
  try {
    migrateDatabase({ file: fixture.file });
    const changed = [{ ...MIGRATIONS[0], sql: `${MIGRATIONS[0].sql}\n-- checksum drift` }, ...MIGRATIONS.slice(1)];
    assert.throws(() => migrateDatabase({ file: fixture.file, migrations: changed }), /migration_checksum_conflict:version=1/);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('failed DDL rolls back its schema and ledger row atomically', () => {
  const fixture = temporaryDatabase('aiws-ddl-migration-');
  try {
    migrateDatabase({ file: fixture.file, migrations: [MIGRATIONS[0]] });
    const migrations = [
      MIGRATIONS[0],
      { version: 2, name: 'failing_transaction_probe', sql: 'CREATE TABLE transaction_probe(id TEXT PRIMARY KEY) STRICT; CREATE TABLE projects(id TEXT);' }
    ];
    assert.throws(() => migrateDatabase({ file: fixture.file, migrations }), /already exists/);
    const state = inspect(fixture.file, (db) => ({
      probe: Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='transaction_probe'").get().count),
      migrations: Number(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count),
      version: Number(db.prepare('PRAGMA user_version').get().user_version)
    }));
    assert.deepEqual(state, { probe: 0, migrations: 1, version: 1 });
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('an interrupted SQLite transaction is rolled back before migration replay', () => {
  const fixture = temporaryDatabase('aiws-interrupted-migration-');
  const migrations = [
    MIGRATIONS[0],
    { version: 2, name: 'interruption_replay_probe', sql: 'CREATE TABLE interruption_probe(id TEXT PRIMARY KEY) STRICT;' }
  ];
  try {
    migrateDatabase({ file: fixture.file, migrations: [MIGRATIONS[0]] });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE; CREATE TABLE abandoned_probe(id TEXT PRIMARY KEY) STRICT;');
      process.exit(17);
    `, fixture.file], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 17, child.stderr);
    const replay = migrateDatabase({ file: fixture.file, migrations });
    assert.deepEqual(replay.applied_versions, [2]);
    const state = inspect(fixture.file, (db) => ({
      abandoned: Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='abandoned_probe'").get().count),
      replayed: Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='interruption_probe'").get().count),
      fingerprint: schemaFingerprint(db)
    }));
    assert.equal(state.abandoned, 0);
    assert.equal(state.replayed, 1);
    assert.match(state.fingerprint, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('registered V1 checksum is frozen while V2 state survives the V4 migration', () => {
  const fixture = temporaryDatabase('aiws-v2-state-map-');
  const timestamp = '2026-08-10T00:00:00.000Z';
  try {
    legacyV1(fixture.file);
    inspect(fixture.file, (db) => {
      db.prepare('INSERT INTO users(id,display_name,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run('usr_local_owner', 'Local owner', 'active', 1, timestamp, timestamp);
      db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,last_seen_at,revoked_at) VALUES(?,?,?,?,?,?)')
        .run('ses_legacy1234', 'usr_local_owner', 'a'.repeat(64), '2026-08-11T00:00:00.000Z', timestamp, null);
      db.prepare('INSERT INTO credential_refs(id,provider,label,secret_ref,expires_at,created_at) VALUES(?,?,?,?,?,?)')
        .run('cred_vault_legacy', 'github', 'Legacy', 'vault:legacy.vault', timestamp, timestamp);
    });

    const result = migrateDatabase({ file: fixture.file });
    assert.deepEqual(result.applied_versions, [2, 3, 4, 5, 6]);
    const mapped = inspect(fixture.file, (db) => ({
      checksum: db.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get().checksum,
      session: { ...db.prepare('SELECT revision,created_at,updated_at FROM sessions WHERE id=?').get('ses_legacy1234') },
      credential: { ...db.prepare('SELECT kind,origin,status,revision,secret_version,expires_at,revoked_at,updated_at FROM credential_refs WHERE id=?').get('cred_vault_legacy') }
    }));
    assert.equal(mapped.checksum, V1_MIGRATION_CHECKSUM);
    assert.deepEqual(mapped.session, { revision: 1, created_at: timestamp, updated_at: timestamp });
    assert.deepEqual(mapped.credential, {
      kind: 'github_webhook_secret', origin: 'vault', status: 'revoked', revision: 1,
      secret_version: 1, expires_at: null, revoked_at: timestamp, updated_at: timestamp
    });
    assert.deepEqual(migrateDatabase({ file: fixture.file }).applied_versions, []);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('V2 project, brief, and repository binding backfill into the R3 intake graph', () => {
  const fixture = temporaryDatabase('aiws-v2-r3-backfill-');
  const timestamp = '2026-08-10T00:00:00.000Z';
  try {
    migrateDatabase({ file: fixture.file, migrations: MIGRATIONS.slice(0, 2) });
    inspect(fixture.file, (db) => {
      db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run('prj_r3_backfill', 'Backfill fixture', '', 'active', 4, timestamp, timestamp);
      db.prepare('INSERT INTO project_intakes(id,project_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run('int_r3_backfill', 'prj_r3_backfill', 'ready', '{"mode":"existing"}', timestamp, timestamp);
      db.prepare('INSERT INTO workflow_drafts(id,project_id,revision,graph_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run('wfd_r3_backfill', 'prj_r3_backfill', 3, '{}', 'draft', timestamp, timestamp);
      db.prepare('INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)')
        .run('prj_r3_backfill', 1, '{"objective":"legacy"}', 'a'.repeat(64), timestamp);
      db.prepare('INSERT INTO brief_heads(project_id,revision,updated_at) VALUES(?,?,?)')
        .run('prj_r3_backfill', 1, timestamp);
      db.prepare('INSERT INTO repository_bindings(id,project_id,local_path,remote_url,head_sha,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run('repo_r3_backfill', 'prj_r3_backfill', 'projects/prj_r3_backfill', 'https://github.com/fixture/repository', 'b'.repeat(40), 2, timestamp, timestamp);
    });

    const migrated = migrateDatabase({ file: fixture.file });
    assert.deepEqual(migrated.applied_versions, [3, 4, 5, 6]);
    assert.ok(migrated.snapshot?.file && migrated.snapshot?.manifest);
    const state = inspect(fixture.file, (db) => ({
      project: { ...db.prepare('SELECT status,onboarding_state,confirmed_brief_revision,confirmed_brief_hash,workflow_draft_id FROM projects WHERE id=?').get('prj_r3_backfill') },
      intake: { ...db.prepare('SELECT status,mode,revision,attempt,completed_at FROM project_intakes WHERE project_id=?').get('prj_r3_backfill') },
      head: { ...db.prepare('SELECT revision,confirmed_revision,confirmation_revision,confirmed_by,confirmed_hash FROM brief_heads WHERE project_id=?').get('prj_r3_backfill') },
      connection: { ...db.prepare('SELECT id,source_kind,source_locator,revision,read_only FROM repository_connections WHERE project_id=?').get('prj_r3_backfill') },
      target: { ...db.prepare('SELECT id,baseline_sha,managed_relative_path FROM repository_targets WHERE connection_id=?').get('con_repo_r3_backfill') },
      line: { ...db.prepare('SELECT id,line_kind,baseline_sha,managed_relative_path,status FROM repository_lines WHERE project_id=? AND line_kind=?').get('prj_r3_backfill', 'managed_checkout') },
      ledger: db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all(),
      version: Number(db.prepare('PRAGMA user_version').get().user_version)
    }));
    assert.deepEqual(state.project, { status: 'active', onboarding_state: 'confirmed', confirmed_brief_revision: 1, confirmed_brief_hash: 'a'.repeat(64), workflow_draft_id: 'wfd_r3_backfill' });
    assert.equal(state.intake.status, 'ready');
    assert.equal(state.intake.mode, 'existing');
    assert.equal(state.intake.revision, 1);
    assert.equal(state.intake.attempt, 0);
    assert.equal(state.intake.completed_at, timestamp);
    assert.deepEqual(state.head, { revision: 1, confirmed_revision: 1, confirmation_revision: 1, confirmed_by: 'migration', confirmed_hash: 'a'.repeat(64) });
    assert.deepEqual(state.connection, { id: 'con_repo_r3_backfill', source_kind: 'git', source_locator: 'https://github.com/fixture/repository', revision: 1, read_only: 1 });
    assert.deepEqual(state.target, { id: 'tgt_repo_r3_backfill', baseline_sha: 'b'.repeat(40), managed_relative_path: 'projects/prj_r3_backfill' });
    assert.deepEqual(state.line, { id: 'lin_repo_r3_backfill', line_kind: 'managed_checkout', baseline_sha: 'b'.repeat(40), managed_relative_path: 'projects/prj_r3_backfill', status: 'ready' });
    assert.equal(state.version, 6);
    assert.equal(state.ledger[0].checksum, V1_MIGRATION_CHECKSUM);
    assert.equal(state.ledger[1].checksum, migrationChecksum(MIGRATIONS[1]));
    assert.deepEqual(migrateDatabase({ file: fixture.file }).applied_versions, []);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('V5 Assist bytes backfill into immutable V6 snapshots and heads', () => {
  const fixture = temporaryDatabase('aiws-v6-assist-');
  try {
    migrateDatabase({ file: fixture.file, migrations: MIGRATIONS.slice(0, 5) });
    const timestamp = '2026-08-17T00:00:00.000Z';
    const snapshotJson = '{"scope_id":"prj_v6","project_id":"prj_v6","note":"byte-stable"}';
    const goalJson = '{"objective":"legacy"}';
    const planJson = '[{"step":"retain"}]';
    const eventJson = '{"role":"user","sequence_no":1}';
    inspect(fixture.file, (db) => {
      db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('prj_v6', 'V6 project', '', 'active', 1, timestamp, timestamp);
      db.prepare('INSERT INTO assist_sessions(id,project_id,scope,scope_id,snapshot_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('ast_v6', 'prj_v6', 'project', 'prj_v6', snapshotJson, 'active', timestamp, timestamp);
      db.prepare('INSERT INTO assist_turns(id,session_id,turn_no,status,goal_json,plan_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('atr_v6', 'ast_v6', 1, 'failed', goalJson, planJson, timestamp, timestamp);
      db.prepare('INSERT INTO assist_messages(id,turn_id,role,content,sequence_no,created_at) VALUES(?,?,?,?,?,?)').run('ams_v6', 'atr_v6', 'user', 'legacy body', 1, timestamp);
      db.prepare('INSERT INTO assist_events(session_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?)').run('ast_v6', 'atr_v6', 'assist.message', eventJson, timestamp);
      db.prepare('INSERT INTO assist_operations(id,session_id,kind,status,receipt_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('aop_v6', 'ast_v6', 'turn', 'failed', '{"error_code":"legacy"}', timestamp, timestamp);
    });

    const migrated = migrateDatabase({ file: fixture.file });
    assert.deepEqual(migrated.applied_versions, [6]);
    inspect(fixture.file, (db) => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
      assert.equal(db.prepare('SELECT checksum FROM schema_migrations WHERE version=6').get().checksum, V6_MIGRATION_CHECKSUM);
      assert.equal(db.prepare('SELECT snapshot_json FROM assist_sessions WHERE id=?').get('ast_v6').snapshot_json, snapshotJson);
      assert.equal(db.prepare('SELECT goal_json,plan_json FROM assist_turns WHERE id=?').get('atr_v6').goal_json, goalJson);
      assert.equal(db.prepare('SELECT plan_json FROM assist_turns WHERE id=?').get('atr_v6').plan_json, planJson);
      assert.equal(db.prepare('SELECT content FROM assist_messages WHERE id=?').get('ams_v6').content, 'legacy body');
      assert.equal(db.prepare('SELECT attempt FROM assist_messages WHERE id=?').get('ams_v6').attempt, 1);
      db.prepare('INSERT INTO assist_messages(id,turn_id,role,content,attempt,sequence_no,created_at) VALUES(?,?,?,?,?,?,?)').run('ams_v6_retry', 'atr_v6', 'user', 'retry body', 2, 1, timestamp);
      assert.throws(() => db.prepare('INSERT INTO assist_messages(id,turn_id,role,content,attempt,sequence_no,created_at) VALUES(?,?,?,?,?,?,?)').run('ams_v6_duplicate', 'atr_v6', 'user', 'duplicate', 2, 1, timestamp), /UNIQUE/);
      assert.equal(db.prepare('SELECT data_json FROM assist_events WHERE turn_id=?').get('atr_v6').data_json, eventJson);
      assert.equal(db.prepare('SELECT receipt_json FROM assist_operations WHERE id=?').get('aop_v6').receipt_json, '{"error_code":"legacy"}');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assist_session_snapshots WHERE session_id=?').get('ast_v6').count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assist_turn_snapshots WHERE turn_id=?').get('atr_v6').count, 1);
      assert.throws(() => db.prepare("UPDATE assist_turn_snapshots SET status='completed' WHERE turn_id='atr_v6'").run(), /immutable_record/);
      assert.throws(() => db.prepare("UPDATE assist_turns SET status='running' WHERE id='atr_v6'").run(), /assist_turn_transition_invalid/);
      assert.throws(() => db.prepare("UPDATE assist_turn_heads SET revision=revision-1 WHERE turn_id='atr_v6'").run(), /assist_turn_head_mismatch/);
      db.prepare('INSERT INTO assist_event_cursors(session_id,consumer_id,cursor,revision,updated_at) VALUES(?,?,?,?,?)').run('ast_v6', 'test', 2, 1, timestamp);
      assert.throws(() => db.prepare("UPDATE assist_event_cursors SET cursor=1 WHERE session_id='ast_v6'").run(), /cursor_regression/);
    });
    assert.deepEqual(migrateDatabase({ file: fixture.file }).applied_versions, []);
  } finally { fs.rmSync(fixture.home, { recursive: true, force: true }); }
});

test('V3 workflows, generations, contracts, and execution references survive the V4 migration', () => {
  const fixture = temporaryDatabase('aiws-v3-r4-workflow-backfill-');
  const timestamp = '2026-08-11T00:00:00.000Z';
  const tasks = JSON.stringify([{ id: 'legacy_task', title: 'Legacy task', goal: 'Remain executable', deps: [], mode: 'read', inputs: [], outputs: ['legacy.json'], acceptance: ['done'] }]);
  try {
    migrateDatabase({ file: fixture.file, migrations: MIGRATIONS.slice(0, 3) });
    inspect(fixture.file, (db) => {
      db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run('prj_v3_workflow', 'V3 workflow fixture', '', 'active', 1, timestamp, timestamp);
      db.prepare('INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)')
        .run('prj_v3_workflow', 1, '{"objective":"legacy"}', 'a'.repeat(64), timestamp);
      db.prepare('INSERT INTO workflow_drafts(id,project_id,revision,graph_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run('wfd_v3_workflow', 'prj_v3_workflow', 2, `{"tasks":${tasks}}`, 'confirmed', timestamp, timestamp);
      db.prepare('INSERT INTO workflow_revisions(project_id,revision,name,tasks_json,graph_hash,created_at) VALUES(?,?,?,?,?,?)')
        .run('prj_v3_workflow', 1, 'Legacy workflow', tasks, 'b'.repeat(64), timestamp);
      db.prepare('INSERT INTO workflow_heads(project_id,revision,updated_at) VALUES(?,?,?)')
        .run('prj_v3_workflow', 1, timestamp);
      db.prepare('INSERT INTO node_contracts(id,project_id,workflow_revision,node_id,contract_json,created_at) VALUES(?,?,?,?,?,?)')
        .run('nct_v3_workflow', 'prj_v3_workflow', 1, 'legacy_task', '{"goal":"Remain executable"}', timestamp);
      db.prepare('INSERT INTO workflow_generations(id,project_id,brief_revision,status,candidate_json,critic_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run('wgen_v3_workflow', 'prj_v3_workflow', 1, 'completed', `{"tasks":${tasks}}`, '{"status":"passed"}', timestamp, timestamp);
      db.prepare('INSERT INTO workflow_generation_events(generation_id,type,data_json,created_at) VALUES(?,?,?,?)')
        .run('wgen_v3_workflow', 'workflow.generation.completed', '{"status":"completed"}', timestamp);
      db.prepare('INSERT INTO executions(id,project_id,workflow_revision,brief_revision,brief_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run('exe_v3_workflow', 'prj_v3_workflow', 1, 1, 'a'.repeat(64), 'queued', timestamp, timestamp);
      db.prepare('INSERT INTO task_attempts(id,execution_id,task_id,attempt_no,status,mode,created_at) VALUES(?,?,?,?,?,?,?)')
        .run('att_v3_workflow', 'exe_v3_workflow', 'legacy_task', 1, 'pending', 'initial', timestamp);
    });

    const migrated = migrateDatabase({ file: fixture.file });
    assert.deepEqual(migrated.applied_versions, [4, 5, 6]);
    const state = inspect(fixture.file, (db) => ({
      version: Number(db.prepare('PRAGMA user_version').get().user_version),
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
      workflow: { ...db.prepare('SELECT hierarchy_mode,tasks_json,metadata_json FROM workflow_revisions WHERE project_id=? AND revision=1').get('prj_v3_workflow') },
      draft: { ...db.prepare('SELECT hierarchy_mode,layout_revision,draft_hash FROM workflow_drafts WHERE id=?').get('wfd_v3_workflow') },
      layout: { ...db.prepare('SELECT revision,source,layout_hash FROM workflow_layout_revisions WHERE draft_id=?').get('wfd_v3_workflow') },
      contract: { ...db.prepare('SELECT revision,source,contract_json,contract_hash FROM node_contract_revisions WHERE project_id=? AND workflow_revision=1 AND node_id=?').get('prj_v3_workflow', 'legacy_task') },
      generation: { ...db.prepare('SELECT phase,candidate_json FROM workflow_generations WHERE id=?').get('wgen_v3_workflow') },
      generationEvent: { ...db.prepare('SELECT type,data_json FROM workflow_generation_events WHERE generation_id=?').get('wgen_v3_workflow') },
      execution: { ...db.prepare('SELECT workflow_revision,status FROM executions WHERE id=?').get('exe_v3_workflow') },
      attempt: { ...db.prepare('SELECT task_id,status FROM task_attempts WHERE id=?').get('att_v3_workflow') }
    }));
    assert.equal(state.version, 6);
    assert.deepEqual(state.foreignKeys, []);
    assert.equal(state.workflow.hierarchy_mode, 'legacy_compat');
    assert.equal(state.workflow.tasks_json, tasks);
    assert.equal(state.workflow.metadata_json, '{"compatibility":"v3"}');
    assert.equal(state.draft.hierarchy_mode, 'legacy_compat');
    assert.equal(state.draft.layout_revision, 1);
    assert.match(state.draft.draft_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(state.layout, { revision: 1, source: 'legacy_compat', layout_hash: '0'.repeat(64) });
    assert.deepEqual(state.contract, { revision: 1, source: 'legacy_compat', contract_json: '{"goal":"Remain executable"}', contract_hash: '0'.repeat(64) });
    assert.deepEqual(state.generation, { phase: 'completed', candidate_json: `{"tasks":${tasks}}` });
    assert.deepEqual(state.generationEvent, { type: 'workflow.generation.completed', data_json: '{"status":"completed"}' });
    assert.deepEqual(state.execution, { workflow_revision: 1, status: 'queued' });
    assert.deepEqual(state.attempt, { task_id: 'legacy_task', status: 'pending' });
    assert.deepEqual(migrateDatabase({ file: fixture.file }).applied_versions, []);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('V4 Context, Pack, Selection, MCP client, and grant bytes survive the V5 migration', () => {
  const fixture = temporaryDatabase('aiws-v4-r5-context-backfill-');
  const timestamp = '2026-08-16T00:00:00.000Z';
  const content = 'legacy context bytes';
  const contentHash = 'c'.repeat(64);
  const packJson = '{"sources":[{"id":"src_legacy","content":"legacy pack bytes"}]}';
  const tokenHash = 'd'.repeat(64);
  const grantHash = 'e'.repeat(64);
  try {
    migrateDatabase({ file: fixture.file, migrations: MIGRATIONS.slice(0, 4) });
    inspect(fixture.file, (db) => {
      db.prepare('INSERT INTO users(id,display_name,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('usr_r5', 'R5 user', 'active', 1, timestamp, timestamp);
      db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('prj_r5', 'R5 project', '', 'active', 1, timestamp, timestamp);
      db.prepare('INSERT INTO context_nodes(id,project_id,parent_id,uri,title,kind,sensitivity,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('ctx_r5', 'prj_r5', null, 'aiws://context/prj_r5/note/legacy', 'Legacy node', 'note', 'normal', timestamp, timestamp);
      db.prepare('INSERT INTO context_document_versions(id,node_id,version,content_hash,content,created_at) VALUES(?,?,?,?,?,?)').run('cdv_r5', 'ctx_r5', 1, contentHash, content, timestamp);
      db.prepare('INSERT INTO context_selections(id,project_id,session_id,node_ids_json,retrieval_plan_json,created_at) VALUES(?,?,?,?,?,?)').run('csel_r5', 'prj_r5', null, '["ctx_r5"]', '{"strategy":"legacy"}', timestamp);
      db.prepare('INSERT INTO context_packs(id,project_id,source_ids_json,pack_json,pack_hash,created_at) VALUES(?,?,?,?,?,?)').run('pack_r5', 'prj_r5', '["src_legacy"]', packJson, 'f'.repeat(64), timestamp);
      db.prepare('INSERT INTO mcp_clients(id,user_id,name,transport,endpoint,token_hash,scope_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('mcp_r5', 'usr_r5', 'Legacy MCP', 'stdio', '', tokenHash, '{"project_ids":["prj_r5"]}', 'available', timestamp, timestamp);
      db.prepare('INSERT INTO exchange_requests(id,project_id,scope_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?)').run('mreq_r5', 'prj_r5', '{"project_ids":["prj_r5"]}', 'granted', timestamp, '2027-08-16T00:00:00.000Z');
      db.prepare('INSERT INTO exchange_grants(id,request_id,token_hash,scope_json,expires_at,revoked_at) VALUES(?,?,?,?,?,?)').run('mgrant_r5', 'mreq_r5', grantHash, '{"project_ids":["prj_r5"]}', '2027-08-16T00:00:00.000Z', null);
    });

    const migrated = migrateDatabase({ file: fixture.file });
    assert.deepEqual(migrated.applied_versions, [5, 6]);
    const state = inspect(fixture.file, (db) => ({
      version: Number(db.prepare('PRAGMA user_version').get().user_version),
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
      versionRow: { ...db.prepare('SELECT content,content_hash,source_hash,storage_kind,renderer_version FROM context_document_versions WHERE id=?').get('cdv_r5') },
      selection: { ...db.prepare('SELECT node_ids_json,retrieval_plan_json,schema_version,compatibility FROM context_selections WHERE id=?').get('csel_r5') },
      pack: { ...db.prepare('SELECT source_ids_json,pack_json,compatibility FROM context_packs WHERE id=?').get('pack_r5') },
      client: { ...db.prepare('SELECT token_hash,compatibility,project_allowlist_json FROM mcp_clients WHERE id=?').get('mcp_r5') },
      grant: { ...db.prepare('SELECT token_hash,compatibility FROM exchange_grants WHERE id=?').get('mgrant_r5') },
      checksum: db.prepare('SELECT checksum FROM schema_migrations WHERE version=5').get().checksum
    }));
    assert.equal(state.version, 6);
    assert.equal(state.integrity, 'ok');
    assert.deepEqual(state.foreignKeys, []);
    assert.deepEqual(state.versionRow, { content, content_hash: contentHash, source_hash: contentHash, storage_kind: 'inline_legacy', renderer_version: 'legacy-inline-v1' });
    assert.deepEqual(state.selection, { node_ids_json: '["ctx_r5"]', retrieval_plan_json: '{"strategy":"legacy"}', schema_version: 'aiws.context_selection.v1', compatibility: 'legacy_compat' });
    assert.deepEqual(state.pack, { source_ids_json: '["src_legacy"]', pack_json: packJson, compatibility: 'legacy_compat' });
    assert.deepEqual(state.client, { token_hash: tokenHash, compatibility: 'legacy_compat', project_allowlist_json: '[]' });
    assert.deepEqual(state.grant, { token_hash: grantHash, compatibility: 'legacy_compat' });
    assert.equal(state.checksum, V5_MIGRATION_CHECKSUM);
    inspect(fixture.file, (db) => {
      assert.throws(() => db.prepare("UPDATE context_document_versions SET content='changed' WHERE id='cdv_r5'").run(), /immutable_record/);
      assert.throws(() => db.prepare("UPDATE context_selections SET compatibility='native_v5' WHERE id='csel_r5'").run(), /immutable_record/);
      assert.throws(() => db.prepare("UPDATE context_packs SET compatibility='native_v5' WHERE id='pack_r5'").run(), /immutable_record/);
    });
    assert.deepEqual(migrateDatabase({ file: fixture.file }).applied_versions, []);
  } finally { fs.rmSync(fixture.home, { recursive: true, force: true }); }
});
