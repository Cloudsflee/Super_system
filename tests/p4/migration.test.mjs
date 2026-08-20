import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CLEAN_P4_MIGRATION_REGISTRY } from '../../apps/api/src/clean/migration-service.mjs';
import { openCleanDatabase, schemaSnapshotHash } from '../../apps/api/src/clean/database.mjs';

const P4_TABLES = [
  'context_sources', 'context_nodes', 'context_document_versions', 'context_edges',
  'context_policies', 'context_selections', 'context_packs', 'context_projection_jobs',
  'context_index_snapshots', 'exchange_requests', 'mcp_clients', 'gateway_forward_receipts'
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p4-migration-'));
  return { root, file: path.join(root, 'state.sqlite'), receipts: path.join(root, 'receipts') };
}

function rows(database) {
  return database.query('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version');
}

test('004 upgrades Clean versions 0 through 3 without rewriting prior migration rows', () => {
  assert.deepEqual(CLEAN_P4_MIGRATION_REGISTRY.map(({ version, id }) => [version, id]), [
    [1, '001-clean-baseline'], [2, '002-identity-acl'], [3, '003-project-workflow'], [4, '004-context-projection-mcp']
  ]);
  for (const startVersion of [0, 1, 2, 3]) {
    const f = fixture(); let database;
    try {
      let prior = [];
      if (startVersion) {
        database = openCleanDatabase(f.file, { targetVersion: startVersion, receiptRoot: f.receipts });
        prior = rows(database); database.close(); database = null;
      }
      database = openCleanDatabase(f.file, { targetVersion: 4, receiptRoot: f.receipts });
      assert.equal(database.integrity().user_version, 4);
      assert.deepEqual(rows(database).slice(0, prior.length), prior);
      assert.deepEqual(database.query('PRAGMA foreign_key_check'), []);
      for (const table of P4_TABLES) assert.equal(database.get("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name=?", [table]).count, 1, table);
      assert.equal(database.get('SELECT snapshot_sha256 FROM schema_migrations WHERE version=4').snapshot_sha256, schemaSnapshotHash(database.db));
      database.close(); database = openCleanDatabase(f.file, { targetVersion: 4, receiptRoot: f.receipts });
      assert.equal(rows(database).length, 4);
    } finally { database?.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('004 DDL, ledger, receipt and commit faults leave the v3 volume byte-logically unchanged', () => {
  for (const stage of ['ddl', 'ledger', 'receipt', 'commit']) {
    const f = fixture(); let database;
    try {
      database = openCleanDatabase(f.file, { targetVersion: 3, receiptRoot: f.receipts });
      const prior = rows(database); database.close(); database = null;
      assert.throws(() => openCleanDatabase(f.file, { targetVersion: 4, receiptRoot: f.receipts, failAt: `migration_004_${stage}` }), (error) => error.code === 'not_ready' && error.details.migration_id === '004-context-projection-mcp');
      const raw = new DatabaseSync(f.file, { readOnly: true });
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
      assert.deepEqual(raw.prepare('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version').all().map(normalize), prior);
      for (const table of P4_TABLES) assert.equal(raw.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name=?").get(table).count, 0, `${stage}:${table}`);
      raw.close();
      database = openCleanDatabase(f.file, { targetVersion: 4, receiptRoot: f.receipts });
      assert.equal(database.integrity().user_version, 4);
    } finally { database?.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('004 checksum and live schema snapshot drift stop startup', () => {
  for (const drift of ['checksum', 'snapshot']) {
    const f = fixture(); let database;
    try {
      database = openCleanDatabase(f.file, { targetVersion: 4, receiptRoot: f.receipts });
      database.close(); database = null;
      const raw = new DatabaseSync(f.file);
      if (drift === 'checksum') {
        raw.exec('DROP TRIGGER immutable_schema_migrations_update');
        raw.prepare('UPDATE schema_migrations SET checksum=? WHERE version=4').run('0'.repeat(64));
      } else raw.exec('CREATE TABLE p4_snapshot_drift(id TEXT PRIMARY KEY) STRICT');
      raw.close();
      assert.throws(() => openCleanDatabase(f.file, { targetVersion: 4, receiptRoot: f.receipts }), (error) => error.code === 'not_ready' && error.details.reason === (drift === 'checksum' ? 'checksum_drift' : 'snapshot_mismatch'));
    } finally { database?.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

function normalize(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'bigint' ? Number(item) : item]));
}
