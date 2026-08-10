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
import { MIGRATIONS, migrationChecksum } from '../../apps/api/src/migrations/index.mjs';
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
  const migrations = [
    MIGRATIONS[0],
    { version: 2, name: 'add_migration_probe', sql: 'CREATE TABLE migration_probe(id TEXT PRIMARY KEY) STRICT;' }
  ];
  try {
    const first = migrateDatabase({ file: fixture.file, migrations });
    assert.deepEqual(first.applied_versions, [1, 2]);
    assert.equal(first.from_version, 0);
    assert.equal(first.to_version, 2);
    assert.equal(first.snapshot, null);
    const rows = inspect(fixture.file, (db) => db.prepare('SELECT * FROM schema_migrations ORDER BY version').all());
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2]);
    assert.deepEqual(rows.map((row) => row.checksum), migrations.map(migrationChecksum));
    assert.ok(rows.every((row) => Number(row.duration_ms) >= 0));
    assert.equal(inspect(fixture.file, (db) => Number(db.prepare('PRAGMA user_version').get().user_version)), 2);
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
    assert.deepEqual(replay.applied_versions, [1]);
    assert.equal(inspect(fixture.file, (db) => Number(db.prepare('PRAGMA user_version').get().user_version)), 1);
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
    assert.deepEqual(result.applied_versions, []);
    assert.ok(fs.existsSync(result.snapshot.file));
    assert.ok(fs.existsSync(result.snapshot.manifest));
    const ledger = inspect(fixture.file, (db) => db.prepare('SELECT version,name,checksum FROM schema_migrations').get());
    assert.equal(Number(ledger.version), 1);
    assert.equal(ledger.name, MIGRATIONS[0].name);
    assert.equal(ledger.checksum, migrationChecksum(MIGRATIONS[0]));

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
    const changed = [{ ...MIGRATIONS[0], sql: `${MIGRATIONS[0].sql}\n-- checksum drift` }];
    assert.throws(() => migrateDatabase({ file: fixture.file, migrations: changed }), /migration_checksum_conflict:version=1/);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('failed DDL rolls back its schema and ledger row atomically', () => {
  const fixture = temporaryDatabase('aiws-ddl-migration-');
  try {
    migrateDatabase({ file: fixture.file });
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
    migrateDatabase({ file: fixture.file });
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
