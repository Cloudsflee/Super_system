import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openCleanDatabase } from '../../apps/api/src/clean/database.mjs';
import { sha256Hex } from '../../apps/api/src/clean/canonical.mjs';
import { buildPlan, runImport, verifyTarget } from '../../apps/importer/cli.mjs';

test('offline importer preserves schema v7 and maps schema 23 business rows with omitted secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-import-'));
  const v23 = path.join(root, 'v23.sqlite');
  const v3 = path.join(root, 'v7.sqlite');
  const target = path.join(root, 'v8.sqlite');
  createV23(v23);
  const v7 = openCleanDatabase(v3, { targetVersion: 7, receiptRoot: path.join(root, 'receipts') });
  const v7ActorCount = v7.get('SELECT COUNT(*) AS count FROM actors').count;
  v7.close();
  const options = { v23, v3, target, targetCas: path.join(root, 'target-cas') };
  try {
    const first = buildPlan(options);
    const second = buildPlan(options);
    assert.deepEqual(first, second);
    assert.deepEqual(first.plan.blocking_conflicts, []);
    const result = await runImport(options);
    assert.equal(result.status, 'sealed');
    const verified = verifyTarget(options);
    assert.equal(verified.status, 'passed', JSON.stringify(verified));
    assert.equal(verified.user_version, 8);
    assert.equal(verified.credentials.secret_values_persisted, false);
    const imported = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(imported.prepare('SELECT COUNT(*) AS count FROM actors').get().count, v7ActorCount + 1);
      assert.equal(imported.prepare("SELECT COUNT(*) AS count FROM projects WHERE metadata_json LIKE '%\"source_family\":\"v23\"%'").get().count, 1);
      assert.equal(imported.prepare("SELECT status FROM credential_refs WHERE metadata_json LIKE '%\"imported\":true%'").get().status, 'rebind_required');
      assert.equal(imported.prepare('SELECT COUNT(*) AS count FROM import_id_map').get().count, 8);
    } finally { imported.close(); }
    assert.equal(fs.readFileSync(target).includes(Buffer.from('legacy-secret-value-12345')), false);
    assert.equal(fs.readFileSync(target).includes(Buffer.from('C:\\legacy\\absolute\\project')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('resume verifies signed checkpoint target hash and continues after a domain boundary interruption', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-import-resume-'));
  const v23 = path.join(root, 'v23.sqlite');
  const v3 = path.join(root, 'v7.sqlite');
  const target = path.join(root, 'v8.sqlite');
  createV23(v23);
  openCleanDatabase(v3, { targetVersion: 7, receiptRoot: path.join(root, 'receipts') }).close();
  const options = { v23, v3, target, targetCas: path.join(root, 'target-cas'), checkpointKey: 'p8-import-checkpoint-test-key' };
  try {
    const interrupted = importerCli('run', options, ['--fail-after-domain', 'Project']);
    assert.equal(interrupted.status, 1);
    assert.match(interrupted.stderr, /import_injected_failure:Project/);
    const checkpoint = checkpointMutation(target, 'tamper');
    const rejected = importerCli('resume', options);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /resume_checkpoint_signature_invalid/);
    checkpointMutation(target, 'restore', checkpoint);
    const resumedProcess = importerCli('resume', options);
    assert.equal(resumedProcess.status, 0, resumedProcess.stderr);
    const resumed = JSON.parse(resumedProcess.stdout);
    assert.equal(resumed.status, 'sealed');
    assert.equal(verifyTarget(options).status, 'passed');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('unknown schema 23 table blocks before target creation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-import-block-'));
  const v23 = path.join(root, 'v23.sqlite');
  const v3 = path.join(root, 'v7.sqlite');
  const target = path.join(root, 'v8.sqlite');
  const legacy = new DatabaseSync(v23);
  legacy.exec('CREATE TABLE unknown_business(id TEXT PRIMARY KEY) STRICT; PRAGMA user_version=23');
  legacy.close();
  openCleanDatabase(v3, { targetVersion: 7, receiptRoot: path.join(root, 'receipts') }).close();
  try {
    const plan = buildPlan({ v23, v3, target });
    assert.deepEqual(plan.plan.blocking_conflicts, [{ kind: 'unknown_table', table: 'unknown_business' }]);
    await assert.rejects(() => runImport({ v23, v3, target }), /import_plan_blocked/);
    assert.equal(fs.existsSync(target), false);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

function createV23(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,status TEXT,revision INTEGER,created_at TEXT,updated_at TEXT) STRICT;
    CREATE TABLE credential_refs(id TEXT PRIMARY KEY,provider TEXT,label TEXT,secret_ref TEXT,created_at TEXT) STRICT;
    CREATE TABLE codex_profiles(id TEXT PRIMARY KEY,user_id TEXT,label TEXT,model TEXT,wire_api TEXT,reasoning TEXT,timeout_ms INTEGER,credential_ref TEXT,created_at TEXT,updated_at TEXT) STRICT;
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,description TEXT,status TEXT,revision INTEGER,created_at TEXT,updated_at TEXT) STRICT;
    CREATE TABLE brief_revisions(project_id TEXT,revision INTEGER,content_json TEXT,content_hash TEXT,created_at TEXT,PRIMARY KEY(project_id,revision)) STRICT;
    CREATE TABLE repository_bindings(id TEXT PRIMARY KEY,project_id TEXT,local_path TEXT,remote_url TEXT,head_sha TEXT,revision INTEGER,created_at TEXT,updated_at TEXT) STRICT;
    CREATE TABLE workflow_revisions(project_id TEXT,revision INTEGER,name TEXT,tasks_json TEXT,graph_hash TEXT,created_at TEXT,PRIMARY KEY(project_id,revision)) STRICT;
    CREATE TABLE context_sources(id TEXT PRIMARY KEY,project_id TEXT,kind TEXT,path TEXT,title TEXT,content TEXT,content_hash TEXT,created_at TEXT) STRICT;
    INSERT INTO users VALUES('legacy_user','Legacy Owner','active',2,'2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z');
    INSERT INTO credential_refs VALUES('legacy_credential','codex','Legacy Codex','legacy-secret-value-12345','2026-01-01T00:00:00.000Z');
    INSERT INTO codex_profiles VALUES('legacy_profile','legacy_user','Default','gpt-fixture','responses','medium',120000,'legacy_credential','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO projects VALUES('legacy_project','Imported project','Schema 23 project','active',4,'2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z');
    INSERT INTO brief_revisions VALUES('legacy_project',1,'{"objective":"imported"}','${'a'.repeat(64)}','2026-01-01T00:00:00.000Z');
    INSERT INTO repository_bindings VALUES('legacy_repository','legacy_project','C:\\legacy\\absolute\\project','https://example.invalid/fixture/repo.git','${'b'.repeat(40)}',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO workflow_revisions VALUES('legacy_project',1,'Imported workflow','[{"id":"task","title":"Task"}]','${'c'.repeat(64)}','2026-01-01T00:00:00.000Z');
    INSERT INTO context_sources VALUES('legacy_context','legacy_project','note','C:\\legacy\\absolute\\note.txt','Imported note','bounded context','${sha256Hex('bounded context')}','2026-01-01T00:00:00.000Z');
    PRAGMA user_version=23;
  `);
  db.close();
}

function importerCli(command, options, extra = []) {
  const args = [path.resolve('apps/importer/cli.mjs'), command, '--v23', options.v23, '--v3', options.v3, '--target', options.target, '--targetCas', options.targetCas, '--checkpointKey', options.checkpointKey, ...extra];
  return spawnSync(process.execPath, args, { cwd: path.resolve('.'), encoding: 'utf8', timeout: 30_000 });
}

function checkpointMutation(file, mode, checkpoint = {}) {
  const code = "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);const trigger=\"CREATE TRIGGER immutable_import_checkpoint_update BEFORE UPDATE ON import_checkpoints BEGIN SELECT RAISE(ABORT,'immutable_import_checkpoint'); END\";let row;db.exec('DROP TRIGGER immutable_import_checkpoint_update');try{if(process.argv[2]==='tamper'){row=db.prepare('SELECT id,signature FROM import_checkpoints ORDER BY fsynced_at DESC,id DESC LIMIT 1').get();db.prepare(\"UPDATE import_checkpoints SET signature='bad' WHERE id=?\").run(row.id);}else{row={id:process.argv[3],signature:process.argv[4]};db.prepare('UPDATE import_checkpoints SET signature=? WHERE id=?').run(row.signature,row.id);}}finally{db.exec(trigger);db.close();}process.stdout.write(JSON.stringify(row));";
  const result = spawnSync(process.execPath, ['-e', code, file, mode, checkpoint.id || '', checkpoint.signature || ''], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
