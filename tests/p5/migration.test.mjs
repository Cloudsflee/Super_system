import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CLEAN_P5_MIGRATION_REGISTRY } from '../../apps/api/src/clean/migration-service.mjs';
import { openCleanDatabase, schemaSnapshotHash } from '../../apps/api/src/clean/database.mjs';
import { createFormalVerificationPlan } from '../../scripts/verify.mjs';

export const P5_TABLES = [
  'assist_sessions', 'assist_turns', 'assist_messages', 'assist_goals', 'assist_configurations',
  'assist_references', 'attachments', 'file_refs', 'file_change_batches', 'file_change_items',
  'runtime_approvals', 'runtime_user_inputs', 'semantic_proposals', 'terminal_sessions',
  'terminal_events', 'bridge_devices', 'bridge_transfers'
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-clean-p5-migration-'));
  return { root, file: path.join(root, 'state.sqlite'), receipts: path.join(root, 'receipts') };
}

function rows(database) {
  return database.query('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version');
}

test('005 upgrades Clean versions 0 through 4 without rewriting prior migration rows', () => {
  assert.deepEqual(CLEAN_P5_MIGRATION_REGISTRY.map(({ version, id }) => [version, id]), [
    [1, '001-clean-baseline'], [2, '002-identity-acl'], [3, '003-project-workflow'],
    [4, '004-context-projection-mcp'], [5, '005-assist-files-terminal-bridge']
  ]);
  for (const startVersion of [0, 1, 2, 3, 4]) {
    const state = fixture(); let database;
    try {
      let prior = [];
      if (startVersion) {
        database = openCleanDatabase(state.file, { targetVersion: startVersion, receiptRoot: state.receipts });
        prior = rows(database); database.close(); database = null;
      }
      database = openCleanDatabase(state.file, { targetVersion: 5, receiptRoot: state.receipts });
      assert.equal(database.integrity().user_version, 5);
      assert.deepEqual(rows(database).slice(0, prior.length), prior);
      assert.deepEqual(database.query('PRAGMA foreign_key_check'), []);
      for (const table of P5_TABLES) assert.equal(database.get("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name=?", [table]).count, 1, table);
      assert.equal(database.get('SELECT snapshot_sha256 FROM schema_migrations WHERE version=5').snapshot_sha256, schemaSnapshotHash(database.db));
      database.close(); database = openCleanDatabase(state.file, { targetVersion: 5, receiptRoot: state.receipts });
      assert.equal(rows(database).length, 5);
    } finally { database?.close(); fs.rmSync(state.root, { recursive: true, force: true }); }
  }
});

test('005 DDL, ledger, receipt and commit faults preserve the v4 logical volume', () => {
  for (const stage of ['ddl', 'ledger', 'receipt', 'commit']) {
    const state = fixture(); let database;
    try {
      database = openCleanDatabase(state.file, { targetVersion: 4, receiptRoot: state.receipts });
      const prior = rows(database); database.close(); database = null;
      assert.throws(() => openCleanDatabase(state.file, { targetVersion: 5, receiptRoot: state.receipts, failAt: `migration_005_${stage}` }), (error) => error.code === 'not_ready' && error.details.migration_id === '005-assist-files-terminal-bridge');
      const raw = new DatabaseSync(state.file, { readOnly: true });
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 4);
      assert.deepEqual(raw.prepare('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version').all().map(normalize), prior);
      for (const table of P5_TABLES) assert.equal(raw.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name=?").get(table).count, 0, `${stage}:${table}`);
      assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
      raw.close();
      database = openCleanDatabase(state.file, { targetVersion: 5, receiptRoot: state.receipts });
      assert.equal(database.integrity().user_version, 5);
    } finally { database?.close(); fs.rmSync(state.root, { recursive: true, force: true }); }
  }
});

test('005 checksum and live schema snapshot drift stop startup', () => {
  for (const drift of ['checksum', 'snapshot']) {
    const state = fixture(); let database;
    try {
      database = openCleanDatabase(state.file, { targetVersion: 5, receiptRoot: state.receipts });
      database.close(); database = null;
      const raw = new DatabaseSync(state.file);
      if (drift === 'checksum') {
        raw.exec('DROP TRIGGER immutable_schema_migrations_update');
        raw.prepare('UPDATE schema_migrations SET checksum=? WHERE version=5').run('0'.repeat(64));
      } else raw.exec('CREATE TABLE p5_snapshot_drift(id TEXT PRIMARY KEY) STRICT');
      raw.close();
      assert.throws(() => openCleanDatabase(state.file, { targetVersion: 5, receiptRoot: state.receipts }), (error) => error.code === 'not_ready' && error.details.reason === (drift === 'checksum' ? 'checksum_drift' : 'snapshot_mismatch'));
    } finally { database?.close(); fs.rmSync(state.root, { recursive: true, force: true }); }
  }
});

test('verification gate checks immutable P5 Evidence without publishing a rerun', () => {
  const evidenceSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'v3-clean-p5-evidence.mjs'), 'utf8');
  const plan = createFormalVerificationPlan();
  const evidence = plan.find((entry) => entry.id === 'evidence-p5');
  assert.deepEqual(evidence.invocation.args.slice(-3), ['evidence:p5', '--', '--verify']);
  assert.equal(plan.some((entry) => /v3-clean-p5-(?:assist|bridge)-probe\.mjs/.test(entry.invocation.args.join(' '))), false);
  assert.match(evidenceSource, /const verifyOnly = process\.argv\.includes\('--verify'\)/);
  assert.match(evidenceSource, /aiws\.v3-clean\.p5-evidence-verify\.v1/);
  assert.ok(evidenceSource.indexOf("write('verification.json', verification)") < evidenceSource.indexOf("write('artifact-reopen.json', artifactReopen)"));
  assert.match(evidenceSource, /if \(artifactReopen\.status !== 'passed'\) throw new Error\('artifact_reopen_failed'\)/);
});

function normalize(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'bigint' ? Number(item) : item]));
}
