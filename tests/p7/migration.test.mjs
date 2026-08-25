import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openCleanDatabase } from '../../apps/api/src/clean/database.mjs';

const TABLES = [
  'parser_formats', 'parser_runs', 'assets', 'asset_versions', 'asset_blobs',
  'asset_relations', 'asset_attestations', 'traces', 'digests', 'code_changes',
  'test_results', 'quality_review_runs', 'quality_review_reports',
  'quality_review_events', 'human_reviews', 'outcome_evaluations', 'outcome_waivers'
];

test('007 migrates every Clean version forward once and seeds the bounded format inventory', () => {
  for (let version = 0; version <= 6; version += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `p7-migration-${version}-`));
    const file = path.join(root, 'state.sqlite');
    let db;
    try {
      if (version > 0) { db = openCleanDatabase(file, { targetVersion: version, receiptRoot: path.join(root, 'receipts') }); db.close(); }
      db = openCleanDatabase(file, { targetVersion: 7, receiptRoot: path.join(root, 'receipts') });
      assert.equal(db.integrity().user_version, 7);
      assert.deepEqual(db.integrity().foreign_key_check, []);
      assert.deepEqual(db.query('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version), [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(db.get('SELECT count(*) AS count FROM parser_formats').count, 21);
      for (const table of TABLES) assert.equal(db.get("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name=?", [table]).count, 1);
      db.close();
      db = openCleanDatabase(file, { targetVersion: 7, receiptRoot: path.join(root, 'receipts') });
      assert.equal(db.get('SELECT count(*) AS count FROM schema_migrations WHERE version=7').count, 1);
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('007 DDL, ledger, receipt and commit faults preserve closed v6 database bytes', () => {
  for (const stage of ['ddl', 'ledger', 'receipt', 'commit']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `p7-fault-${stage}-`));
    const file = path.join(root, 'state.sqlite');
    let db;
    try {
      db = openCleanDatabase(file, { targetVersion: 6, receiptRoot: path.join(root, 'receipts') }); db.close(); db = null;
      const before = fs.readFileSync(file);
      assert.throws(() => openCleanDatabase(file, { targetVersion: 7, receiptRoot: path.join(root, 'receipts'), failAt: `migration_007_${stage}` }), (error) => error.code === 'not_ready' && error.details.migration_id === '007-evidence-quality-parser-outcome');
      assert.deepEqual(fs.readFileSync(file), before);
      const raw = new DatabaseSync(file, { readOnly: true });
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 6);
      for (const table of TABLES) assert.equal(raw.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name=?").get(table).count, 0);
      raw.close();
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('007 checksum and snapshot drift block startup', () => {
  for (const mode of ['checksum', 'snapshot']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `p7-drift-${mode}-`));
    const file = path.join(root, 'state.sqlite');
    try {
      const db = openCleanDatabase(file, { targetVersion: 7, receiptRoot: path.join(root, 'receipts') }); db.close();
      const raw = new DatabaseSync(file);
      if (mode === 'checksum') { raw.exec('DROP TRIGGER immutable_schema_migrations_update'); raw.prepare('UPDATE schema_migrations SET checksum=? WHERE version=7').run('0'.repeat(64)); }
      else raw.exec('CREATE TABLE p7_snapshot_drift(id TEXT PRIMARY KEY) STRICT');
      raw.close();
      assert.throws(() => openCleanDatabase(file, { targetVersion: 7, receiptRoot: path.join(root, 'receipts') }), (error) => error.code === 'not_ready' && error.details.reason === (mode === 'checksum' ? 'checksum_drift' : 'snapshot_mismatch'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
