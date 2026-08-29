import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openCleanDatabase } from '../../apps/api/src/clean/database.mjs';
import { CLEAN_P10_TABLE_OWNERS } from '../../apps/api/src/clean/ownership.mjs';
import { P10_PARSER_IMAGE_DIGEST } from '../../apps/api/src/clean/migrations/009-final-business-parity-governance.mjs';

const p10Tables = ['brief_templates','brief_template_revisions','workflow_quality_policies','quality_review_asset_selections','quality_review_advices','assist_review_comments','project_deletion_intents','repository_deletion_intents'].sort();
const p10Columns = {
  provider_profiles: ['lifecycle_status','disabled_at'],
  brief_revisions: ['template_id','template_revision','template_sha256'],
  assist_sessions: ['title','mode','parent_session_id','fork_source_turn_id','pinned_at','archived_at','deleted_at'],
  quality_review_runs: ['policy_revision','policy_snapshot_json','policy_sha256','reviewer_profile_id','reviewer_profile_revision','reviewer_snapshot_json','reviewer_snapshot_sha256','supersedes_quality_review_id','superseded_by_quality_review_id','stale_at','stale_reason']
};

test('forward-only migration upgrades v0-v8 to schema v9 and ledger 1..9', () => {
  assert.deepEqual(p10Tables.map((name) => CLEAN_P10_TABLE_OWNERS[name]).filter(Boolean).length, 8);
  for (let version = 0; version <= 8; version += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `p10-v${version}-`));
    const file = path.join(root, 'state.sqlite');
    let db;
    try {
      if (version) { db = openCleanDatabase(file, { targetVersion: version, receiptRoot: path.join(root, 'receipts') }); db.close(); }
      db = openCleanDatabase(file, { targetVersion: 9, receiptRoot: path.join(root, 'receipts') });
      assert.equal(db.integrity().user_version, 9);
      assert.deepEqual(db.integrity().foreign_key_check, []);
      assert.deepEqual(db.query('SELECT version FROM schema_migrations ORDER BY version').map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9]);
      assert.equal(db.get("SELECT count(*) AS n FROM parser_formats WHERE worker_version='node24-p10' AND worker_image_digest=?", [P10_PARSER_IMAGE_DIGEST]).n, 21);
      const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table'").map((row) => row.name);
      assert.deepEqual(p10Tables.filter((name) => tables.includes(name)), p10Tables);
      for (const [table, expected] of Object.entries(p10Columns)) {
        const actual = db.query(`PRAGMA table_info(${table})`).map((row) => row.name);
        assert.deepEqual(expected.filter((name) => actual.includes(name)), expected);
      }
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('v9 DDL, ledger, receipt, and commit faults preserve byte-exact v8', () => {
  for (const stage of ['ddl','ledger','receipt','commit']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `p10-fault-${stage}-`));
    const file = path.join(root, 'state.sqlite');
    let db = openCleanDatabase(file, { targetVersion: 8, receiptRoot: path.join(root, 'receipts') });
    db.close();
    const before = fs.readFileSync(file);
    assert.throws(() => openCleanDatabase(file, { targetVersion: 9, receiptRoot: path.join(root, 'receipts'), failAt: `migration_009_${stage}` }), (error) => error.code === 'not_ready' && error.details.migration_id === '009-final-business-parity-governance');
    assert.deepEqual(fs.readFileSync(file), before);
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 8);
      const names = raw.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name);
      assert.deepEqual(p10Tables.filter((name) => names.includes(name)), []);
    } finally { raw.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('v9 immutable revision, selection, advice, comment, and terminal intent triggers reject mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-immutable-'));
  const file = path.join(root, 'state.sqlite');
  const db = openCleanDatabase(file, { targetVersion: 9, receiptRoot: path.join(root, 'receipts') });
  try {
    const triggers = db.query("SELECT name FROM sqlite_schema WHERE type='trigger'").map((row) => row.name);
    for (const name of ['immutable_brief_revision_update','immutable_brief_template_revision_update','immutable_workflow_quality_policy_update','immutable_quality_asset_selection_update','immutable_quality_advice_update','immutable_assist_review_comment_update','immutable_terminal_project_deletion_intent_update','immutable_terminal_repository_deletion_intent_update']) assert.ok(triggers.includes(name), name);
    assert.deepEqual(db.integrity().foreign_key_check, []);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
