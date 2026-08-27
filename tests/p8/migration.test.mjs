import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
import { openCleanDatabase } from '../../apps/api/src/clean/database.mjs';
import { CLEAN_P8_TABLE_OWNERS } from '../../apps/api/src/clean/ownership.mjs';

const p8Tables = Object.keys(CLEAN_P8_TABLE_OWNERS).filter((name) => !['delivery_policies'].includes(name) ? ['deliveries','pull_request_intents','delivery_events','deployment_candidates','deployment_verifications','backup_manifests','import_batches','import_checkpoints','import_id_map','import_conflicts'].includes(name) : true).sort();

test('forward-only migration upgrades every supported version to v8', () => {
  for (let version=0;version<=7;version+=1) { const root=fs.mkdtempSync(path.join(os.tmpdir(),`p8-v${version}-`)); const file=path.join(root,'state.sqlite'); let db; try { if (version) { db=openCleanDatabase(file,{targetVersion:version,receiptRoot:path.join(root,'receipts')}); db.close(); } db=openCleanDatabase(file,{targetVersion:8,receiptRoot:path.join(root,'receipts')}); assert.equal(db.integrity().user_version,8); assert.deepEqual(db.integrity().foreign_key_check,[]); const names=db.query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").map(r=>r.name); assert.deepEqual(p8Tables.filter(x=>names.includes(x)),p8Tables); assert.equal(db.query('SELECT version FROM schema_migrations ORDER BY version').length,8); } finally { db?.close(); fs.rmSync(root,{recursive:true,force:true}); } }
});

test('each v8 migration fault preserves v7 bytes and leaves all 11 tables absent', () => {
  for (const stage of ['ddl','ledger','receipt','commit']) { const root=fs.mkdtempSync(path.join(os.tmpdir(),`p8-fault-${stage}-`)); const file=path.join(root,'state.sqlite'); let db=openCleanDatabase(file,{targetVersion:7,receiptRoot:path.join(root,'receipts')}); db.close(); const before=fs.readFileSync(file); assert.throws(()=>openCleanDatabase(file,{targetVersion:8,receiptRoot:path.join(root,'receipts'),failAt:`migration_008_${stage}`}),error=>error.code==='not_ready'&&error.details.migration_id==='008-delivery-deployment-importer-operations'); assert.deepEqual(fs.readFileSync(file),before); const raw=new DatabaseSync(file,{readOnly:true}); try { assert.equal(raw.prepare('PRAGMA user_version').get().user_version,7); const names=raw.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name); assert.deepEqual(p8Tables.filter(x=>names.includes(x)),[]); } finally { raw.close(); fs.rmSync(root,{recursive:true,force:true}); } }
});
