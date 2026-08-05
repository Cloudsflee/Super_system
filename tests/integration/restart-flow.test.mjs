import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../../apps/api/src/database.mjs';

test('database worker can close and reopen without loading an in-memory snapshot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v3-restart-'));
  const file = path.join(directory, 'state.sqlite');
  let db = await openDatabase(file);
  await db.run('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)', ['prj_restart', 'Restart', 'now', 'now']);
  await db.close();
  db = await openDatabase(file);
  assert.equal((await db.get('SELECT name FROM projects WHERE id=?', ['prj_restart'])).name, 'Restart');
  assert.deepEqual((await db.integrity()).integrity, ['ok']);
  await db.close();
});
