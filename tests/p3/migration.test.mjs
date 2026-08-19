import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CLEAN_MIGRATION_REGISTRY } from '../../apps/api/src/clean/migration-service.mjs';
import { openCleanDatabase, schemaSnapshotHash } from '../../apps/api/src/clean/database.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p3-migration-'));
  return { root, file: path.join(root, 'state.sqlite'), receipts: path.join(root, 'receipts') };
}

function closeAndRemove(fixtureState, database) {
  database?.close();
  fs.rmSync(fixtureState.root, { recursive: true, force: true });
}

function migrationRows(database) {
  return database.query(
    'SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version'
  );
}

test('003 registry upgrades empty, P1 and P2 volumes without rewriting prior ledgers', () => {
  assert.deepEqual(
    CLEAN_MIGRATION_REGISTRY.map((migration) => [migration.version, migration.id]),
    [
      [1, '001-clean-baseline'],
      [2, '002-identity-acl'],
      [3, '003-project-workflow']
    ]
  );

  for (const startVersion of [0, 1, 2]) {
    const f = fixture();
    let database;
    try {
      let prior = [];
      if (startVersion > 0) {
        database = openCleanDatabase(f.file, { targetVersion: startVersion, receiptRoot: f.receipts });
        prior = migrationRows(database);
        database.close();
      }
      database = openCleanDatabase(f.file, { targetVersion: 3, receiptRoot: f.receipts });
      assert.equal(database.integrity().user_version, 3);
      assert.equal(database.integrity().semantic.valid, true);
      assert.deepEqual(database.query('PRAGMA foreign_key_check'), []);
      assert.deepEqual(migrationRows(database).slice(0, prior.length), prior);
      assert.deepEqual(
        migrationRows(database).map((row) => row.migration_id),
        ['001-clean-baseline', '002-identity-acl', '003-project-workflow']
      );
      assert.equal(
        database.get('SELECT snapshot_sha256 FROM schema_migrations WHERE version=3').snapshot_sha256,
        schemaSnapshotHash(database.db)
      );
      database.close();
      database = openCleanDatabase(f.file, { targetVersion: 3, receiptRoot: f.receipts });
      assert.equal(database.get('SELECT count(*) AS count FROM schema_migrations').count, 3);
    } finally {
      closeAndRemove(f, database);
    }
  }
});

test('003 DDL, ledger, receipt and commit faults roll back and restart cleanly', () => {
  for (const stage of ['ddl', 'ledger', 'receipt', 'commit']) {
    const f = fixture();
    let database;
    try {
      database = openCleanDatabase(f.file, { targetVersion: 2, receiptRoot: f.receipts });
      const prior = migrationRows(database);
      database.close();
      database = null;

      assert.throws(
        () => openCleanDatabase(f.file, { targetVersion: 3, receiptRoot: f.receipts, failAt: `migration_003_${stage}` }),
        (error) =>
          error.code === 'not_ready' &&
          error.details.reason === 'migration_failed' &&
          error.details.migration_id === '003-project-workflow'
      );

      const raw = new DatabaseSync(f.file, { readOnly: true });
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
      assert.deepEqual(
        raw.prepare('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version').all().map(normalize),
        prior
      );
      assert.equal(
        raw.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='projects'").get().count,
        0
      );
      raw.close();

      database = openCleanDatabase(f.file, { targetVersion: 3, receiptRoot: f.receipts });
      assert.equal(database.integrity().user_version, 3);
      assert.equal(database.get('SELECT count(*) AS count FROM schema_migrations').count, 3);
    } finally {
      closeAndRemove(f, database);
    }
  }
});

test('003 checksum and latest schema snapshot drift stop restart before serving', () => {
  for (const drift of ['checksum', 'snapshot']) {
    const f = fixture();
    let database;
    try {
      database = openCleanDatabase(f.file, { targetVersion: 3, receiptRoot: f.receipts });
      database.close();
      database = null;
      const raw = new DatabaseSync(f.file);
      if (drift === 'checksum') {
        raw.exec('DROP TRIGGER immutable_schema_migrations_update');
        raw.prepare('UPDATE schema_migrations SET checksum=? WHERE version=3').run('0'.repeat(64));
      } else {
        raw.exec('CREATE TABLE p3_snapshot_drift(id TEXT PRIMARY KEY) STRICT');
      }
      raw.close();
      assert.throws(
        () => openCleanDatabase(f.file, { targetVersion: 3, receiptRoot: f.receipts }),
        (error) =>
          error.code === 'not_ready' &&
          error.details.reason === (drift === 'checksum' ? 'checksum_drift' : 'snapshot_mismatch') &&
          error.details.migration_id === '003-project-workflow'
      );
    } finally {
      closeAndRemove(f, database);
    }
  }
});

function normalize(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, typeof item === 'bigint' ? Number(item) : item])
  );
}
