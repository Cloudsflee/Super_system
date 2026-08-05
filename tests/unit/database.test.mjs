import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../../apps/api/src/database.mjs';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-db-'));
  const db = await openDatabase(path.join(directory, 'data', 'state.sqlite'));
  return { db, directory };
}

test('fresh database uses strict v3 settings and FTS5', async () => {
  const { db } = await fixture();
  const integrity = await db.integrity();
  assert.deepEqual(integrity.integrity, ['ok']);
  assert.equal(integrity.user_version, 1);
  assert.equal(integrity.journal_mode, 'wal');
  assert.equal(integrity.synchronous, 2);
  assert.ok((await db.get("SELECT name FROM sqlite_master WHERE name='context_source_fts'")));
  await db.close();
});

test('transaction rolls back as one unit', async () => {
  const { db } = await fixture();
  await assert.rejects(() => db.transaction([
    { sql: 'INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', params: ['prj_rollback', 'rollback', 'now', 'now'] },
    { sql: 'INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', params: ['prj_rollback', 'duplicate', 'now', 'now'] }
  ]));
  assert.equal((await db.get('SELECT count(*) AS count FROM projects')).count, 0);
  await db.close();
});

test('brief revisions are immutable', async () => {
  const { db } = await fixture();
  await db.run('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', ['prj_immutable', 'immutable', 'now', 'now']);
  await db.run('INSERT INTO brief_revisions(project_id,revision,content_json,content_hash,created_at) VALUES(?,?,?,?,?)', ['prj_immutable', 1, '{}', '0'.repeat(64), 'now']);
  await assert.rejects(() => db.run('UPDATE brief_revisions SET content_json=? WHERE project_id=?', ['{"changed":true}', 'prj_immutable']), /immutable_record/);
  await db.close();
});

test('human review decisions are immutable', async () => {
  const { db } = await fixture();
  await db.run('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', ['prj_decision', 'decision', 'now', 'now']);
  await db.run('INSERT INTO reviews(id,project_id,kind,model_status,suggestion_json,input_hash,created_at) VALUES(?,?,?,?,?,?,?)', ['rev_immutable', 'prj_decision', 'task', 'unavailable', '{}', '0'.repeat(64), 'now']);
  await db.run('INSERT INTO review_decisions(id,review_id,decision,note,created_at) VALUES(?,?,?,?,?)', ['dec_immutable', 'rev_immutable', 'approved', '', 'now']);
  await assert.rejects(() => db.run('UPDATE review_decisions SET decision=? WHERE id=?', ['rejected', 'dec_immutable']), /immutable_record/);
  await assert.rejects(() => db.run('DELETE FROM review_decisions WHERE id=?', ['dec_immutable']), /immutable_record/);
  await db.close();
});
