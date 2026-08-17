import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, restoreMigrationSnapshot } from '../apps/api/src/migration-service.mjs';
import { MIGRATIONS, migrationChecksum } from '../apps/api/src/migrations/index.mjs';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] || '') : null;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r5-migration-evidence-'));
const databaseFile = path.join(workspace, 'state.sqlite');
const snapshotRoot = path.join(workspace, 'snapshots');
const timestamp = '2026-08-16T00:00:00.000Z';
const checksums = Object.fromEntries(MIGRATIONS.map((migration) => [`v${migration.version}`, migrationChecksum(migration)]));

try {
  migrateDatabase({ file: databaseFile, migrations: MIGRATIONS.slice(0, 4), snapshotRoot, now: () => new Date(timestamp) });
  seedV4(databaseFile);
  const baseline = inspect(databaseFile, v4State);
  const migrated = migrateDatabase({ file: databaseFile, snapshotRoot, now: () => new Date(timestamp) });
  if (!migrated.snapshot?.file || !migrated.snapshot?.manifest) throw new Error('r5_migration_snapshot_missing');

  const evidenceDirectory = outputPath ? path.dirname(outputPath) : workspace;
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const snapshotFile = path.join(evidenceDirectory, 'migration-snapshot-v4.sqlite');
  const snapshotManifest = path.join(evidenceDirectory, 'migration-snapshot-v4.manifest.json');
  fs.copyFileSync(migrated.snapshot.file, snapshotFile);
  const originalManifest = JSON.parse(fs.readFileSync(migrated.snapshot.manifest, 'utf8'));
  fs.writeFileSync(snapshotManifest, `${JSON.stringify({
    ...originalManifest,
    source_file: 'synthetic-v4-state.sqlite',
    snapshot_file: path.basename(snapshotFile)
  }, null, 2)}\n`);

  const modified = inspect(databaseFile, v5State);
  const repeated = migrateDatabase({ file: databaseFile });
  inspect(databaseFile, (db) => db.prepare('UPDATE projects SET name=? WHERE id=?').run('post-migration mutation', 'prj_r5_evidence'));
  const restored = restoreMigrationSnapshot({ file: databaseFile, manifestPath: snapshotManifest });
  const rollback = inspect(databaseFile, v4State);
  const ledgerValid = rollback.ledger.every((row, index) => row.checksum === migrationChecksum(MIGRATIONS[index]));
  if (modified.user_version !== 5 || modified.integrity !== 'ok' || modified.foreign_keys.length || !modified.bytes_preserved || !Object.values(modified.immutable_triggers).every(Boolean)) throw new Error('r5_migration_v5_state_invalid');
  if (repeated.applied_versions.length || rollback.user_version !== 4 || rollback.integrity !== 'ok' || rollback.foreign_keys.length || rollback.project_name !== 'R5 migration fixture' || !ledgerValid) throw new Error('r5_migration_rollback_state_invalid');

  const relative = (file) => outputPath ? path.relative(process.cwd(), file).replaceAll('\\', '/') : path.basename(file);
  const record = {
    schema_version: 'aiws.v3.r5_migration_evidence.v1',
    status: 'passed',
    created_at: timestamp,
    inputs: {
      database: 'synthetic SQLite v4 fixture',
      production_volume_touched: false,
      baseline_commit: 'f26c6950a0bf266b0114f99fc9dc683430da21a3',
      migration_checksums: checksums
    },
    baseline_v4: {
      command: 'migrateDatabase({ migrations: MIGRATIONS.slice(0, 4) }) plus legacy Context/MCP fixture',
      output: baseline,
      exit_status: 0
    },
    modified_v5: {
      command: 'migrateDatabase({ migrations: MIGRATIONS })',
      output: { from_version: migrated.from_version, to_version: migrated.to_version, applied_versions: migrated.applied_versions, repeated_applied_versions: repeated.applied_versions, snapshot_sha256: migrated.snapshot.sha256, state: modified },
      exit_status: 0
    },
    rollback_v4: {
      command: 'restoreMigrationSnapshot({ file, manifestPath })',
      output: { status: 'restored', sha256: restored.sha256, from_version: restored.from_version, ledger_valid: ledgerValid, state: rollback },
      exit_status: 0
    },
    artifacts: { snapshot: relative(snapshotFile), manifest: relative(snapshotManifest) },
    hashes: { snapshot_sha256: migrated.snapshot.sha256, restored_database_sha256: restored.sha256 }
  };
  if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error_code: String(error?.message || 'r5_migration_evidence_failed').replace(/[^a-zA-Z0-9_:=.-]/g, '_') })}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function seedV4(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.prepare('INSERT INTO users(id,display_name,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('usr_r5_evidence', 'R5 migration user', 'active', 1, timestamp, timestamp);
    db.prepare('INSERT INTO projects(id,name,description,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('prj_r5_evidence', 'R5 migration fixture', '', 'active', 1, timestamp, timestamp);
    db.prepare('INSERT INTO context_nodes(id,project_id,parent_id,uri,title,kind,sensitivity,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('ctx_r5_evidence', 'prj_r5_evidence', null, 'aiws://context/prj_r5_evidence/note/legacy', 'Legacy node', 'note', 'normal', timestamp, timestamp);
    db.prepare('INSERT INTO context_document_versions(id,node_id,version,content_hash,content,created_at) VALUES(?,?,?,?,?,?)').run('cdv_r5_evidence', 'ctx_r5_evidence', 1, 'c'.repeat(64), 'legacy_fixture_payload', timestamp);
    db.prepare('INSERT INTO context_selections(id,project_id,session_id,node_ids_json,retrieval_plan_json,created_at) VALUES(?,?,?,?,?,?)').run('csel_r5_evidence', 'prj_r5_evidence', null, '["ctx_r5_evidence"]', '{"strategy":"legacy"}', timestamp);
    db.prepare('INSERT INTO context_packs(id,project_id,source_ids_json,pack_json,pack_hash,created_at) VALUES(?,?,?,?,?,?)').run('pack_r5_evidence', 'prj_r5_evidence', '["src_r5_evidence"]', '{"schema_version":"legacy_pack_fixture"}', 'f'.repeat(64), timestamp);
    db.prepare('INSERT INTO mcp_clients(id,user_id,name,transport,endpoint,token_hash,scope_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('mcp_r5_evidence', 'usr_r5_evidence', 'Legacy MCP', 'stdio', '', 'd'.repeat(64), '{"project_ids":["prj_r5_evidence"]}', 'available', timestamp, timestamp);
    db.prepare('INSERT INTO exchange_requests(id,project_id,scope_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?)').run('mreq_r5_evidence', 'prj_r5_evidence', '{"project_ids":["prj_r5_evidence"]}', 'granted', timestamp, '2027-08-16T00:00:00.000Z');
    db.prepare('INSERT INTO exchange_grants(id,request_id,token_hash,scope_json,expires_at,revoked_at) VALUES(?,?,?,?,?,?)').run('mgrant_r5_evidence', 'mreq_r5_evidence', 'e'.repeat(64), '{"project_ids":["prj_r5_evidence"]}', '2027-08-16T00:00:00.000Z', null);
  } finally { db.close(); }
}

function inspect(file, callback) {
  const db = new DatabaseSync(file);
  try { return callback(db); } finally { db.close(); }
}

function commonState(db) {
  return {
    user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    foreign_keys: db.prepare('PRAGMA foreign_key_check').all(),
    project_name: db.prepare('SELECT name FROM projects WHERE id=?').get('prj_r5_evidence')?.name || null,
    ledger: db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row, version: Number(row.version) }))
  };
}

function v4State(db) {
  const common = commonState(db);
  return {
    ...common,
    context_version_hash: db.prepare('SELECT content_hash FROM context_document_versions WHERE id=?').get('cdv_r5_evidence')?.content_hash || null,
    pack_hash: db.prepare('SELECT pack_hash FROM context_packs WHERE id=?').get('pack_r5_evidence')?.pack_hash || null,
    client_hash: db.prepare('SELECT token_hash FROM mcp_clients WHERE id=?').get('mcp_r5_evidence')?.token_hash || null,
    grant_hash: db.prepare('SELECT token_hash FROM exchange_grants WHERE id=?').get('mgrant_r5_evidence')?.token_hash || null
  };
}

function v5State(db) {
  const common = commonState(db);
  const version = db.prepare('SELECT content_hash,source_hash,storage_kind,renderer_version FROM context_document_versions WHERE id=?').get('cdv_r5_evidence');
  const selection = db.prepare('SELECT schema_version,compatibility FROM context_selections WHERE id=?').get('csel_r5_evidence');
  const pack = db.prepare('SELECT pack_hash,compatibility FROM context_packs WHERE id=?').get('pack_r5_evidence');
  const client = db.prepare('SELECT token_hash,compatibility,project_allowlist_json FROM mcp_clients WHERE id=?').get('mcp_r5_evidence');
  const grant = db.prepare('SELECT token_hash,compatibility FROM exchange_grants WHERE id=?').get('mgrant_r5_evidence');
  return {
    ...common,
    v5_checksum: common.ledger.find((row) => row.version === 5)?.checksum || null,
    compatibility: { version_storage: version.storage_kind, renderer: version.renderer_version, selection: selection.compatibility, selection_schema: selection.schema_version, pack: pack.compatibility, client: client.compatibility, grant: grant.compatibility },
    bytes_preserved: version.content_hash === 'c'.repeat(64) && version.source_hash === 'c'.repeat(64) && pack.pack_hash === 'f'.repeat(64) && client.token_hash === 'd'.repeat(64) && grant.token_hash === 'e'.repeat(64),
    immutable_triggers: {
      document_version: immutable(db, "UPDATE context_document_versions SET content='changed' WHERE id='cdv_r5_evidence'"),
      selection: immutable(db, "UPDATE context_selections SET compatibility='native_v5' WHERE id='csel_r5_evidence'"),
      pack: immutable(db, "UPDATE context_packs SET compatibility='native_v5' WHERE id='pack_r5_evidence'")
    }
  };
}

function immutable(db, sql) {
  try { db.exec(sql); return false; } catch (error) { return String(error?.message || '').includes('immutable_record'); }
}
