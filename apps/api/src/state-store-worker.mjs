import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

import {
  canonicalJson,
  canonicalJsonHash,
  stateRecordIdentity,
  V23_SPECIALIZED_COLLECTIONS
} from './state-migration-v23.mjs';

const SPECIAL_TABLES = Object.freeze({
  context_nodes: 'context_nodes',
  context_document_versions: 'context_document_versions',
  context_edges: 'context_edges',
  context_projection_jobs: 'context_projection_jobs',
  context_selections: 'context_selections'
});
let database = null,
  databasePath = null,
  stateCollections = [],
  storeSchemaVersion = 22;
parentPort.on('message', (message) => {
  const { id, type, payload } = message || {};
  try {
    const value = handlers[type]?.(payload || {});
    if (!handlers[type]) throw storeError('state_store_operation_unknown', { type });
    parentPort.postMessage({ id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        code: safeCode(error),
        message: String(error?.message || error),
        details: error?.details || null
      }
    });
  }
});

const handlers = {
  initialize(payload) {
    databasePath = path.resolve(payload.databasePath);
    ((stateCollections = [...payload.collections]), (storeSchemaVersion = Number(payload.store_schema_version || 22)));
    if (![22, 23].includes(storeSchemaVersion)) throw storeError('state_database_schema_invalid');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    recoverManagedMigrationDatabase(payload.sourceStateHash || null);
    if (!fs.existsSync(databasePath)) {
      if (!payload.state) throw storeError('state_database_missing');
      createDatabaseAtomically(payload.state, payload.sourceStateHash || null, payload.migration || null);
    }
    database = openDatabase(databasePath);
    verifyDatabase(database);
    const loaded = readWholeState(database);
    return {
      state: loaded.state,
      revision: loaded.revision,
      integrity: 'ok',
      source_state_hash: metaValue(database, '__source_state_hash'),
      canonical_state_hash: metaValue(database, '__canonical_state_hash'),
      migration: metaValue(database, '__migration')
    };
  },

  read() {
    requireDatabase();
    return readWholeState(database);
  },

  revision() {
    requireDatabase();
    return { revision: Number(metaValue(database, '__revision') || 0) };
  },

  apply(payload) {
    requireDatabase();
    const currentRevision = Number(metaValue(database, '__revision') || 0);
    if (currentRevision !== Number(payload.expectedRevision))
      throw storeError('state_revision_conflict', {
        expected: Number(payload.expectedRevision),
        actual: currentRevision
      });
    const nextRevision = currentRevision + 1;
    database.exec('BEGIN IMMEDIATE');
    try {
      applyMetaChanges(database, payload.meta || [], payload.metaDeletes || []);
      for (const change of payload.collections || []) applyCollectionChanges(database, change);
      setMeta(database, '__revision', nextRevision);
      setMeta(database, '__updated_at', new Date().toISOString());
      setMeta(database, '__canonical_state_hash', null);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { revision: nextRevision };
  },

  replace(payload) {
    requireDatabase();
    const currentRevision = Number(metaValue(database, '__revision') || 0);
    if (payload.expectedRevision != null && currentRevision !== Number(payload.expectedRevision))
      throw storeError('state_revision_conflict', { expected: payload.expectedRevision, actual: currentRevision });
    const nextRevision = currentRevision + 1;
    database.exec('BEGIN IMMEDIATE');
    try {
      clearStateRows(database);
      insertWholeState(database, payload.state);
      setMeta(database, '__revision', nextRevision);
      setMeta(database, '__updated_at', new Date().toISOString());
      setMeta(database, '__canonical_state_hash', canonicalJsonHash(payload.state));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    verifyStoredState(database, payload.state);
    return { revision: nextRevision };
  },

  health() {
    requireDatabase();
    const schemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version);
    const integrity = String(database.prepare('PRAGMA quick_check').get().quick_check || '');
    let writable = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      database.prepare("UPDATE state_meta SET value_json = value_json WHERE key = '__revision'").run();
      database.exec('ROLLBACK');
      writable = true;
    } catch {
      try {
        database.exec('ROLLBACK');
      } catch {}
    }
    return {
      healthy: schemaVersion === storeSchemaVersion && integrity === 'ok',
      writable,
      migration_complete: metaValue(database, '__migration_complete') === true,
      schema_version: schemaVersion,
      revision: Number(metaValue(database, '__revision') || 0),
      integrity
    };
  },

  hasRunnableProjectionJobs(payload) {
    requireDatabase();
    const timestamp = String(payload.timestamp || new Date().toISOString());
    const row = database
      .prepare(
        `SELECT 1 AS runnable
           FROM context_projection_jobs
          WHERE status = 'pending'
             OR (status = 'failed' AND attempts < 3 AND (next_retry_at IS NULL OR next_retry_at <= ?))
             OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          LIMIT 1`
      )
      .get(timestamp, timestamp);
    return Boolean(row?.runnable);
  },

  checkpoint() {
    requireDatabase();
    const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return { checkpointed: true, ...row };
  },

  close() {
    if (!database) return { closed: true };
    database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    database.close();
    database = null;
    return { closed: true };
  }
};

function createDatabaseAtomically(state, sourceStateHash, migration) {
  const temporary = `${databasePath}.migrating-${process.pid}-${randomUUID()}.tmp`;
  const db = openDatabase(temporary, { create: true });
  try {
    createSchema(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      insertWholeState(db, state);
      setMeta(db, '__store_schema', storeSchemaVersion);
      setMeta(db, '__revision', 1);
      setMeta(db, '__migration_complete', true);
      setMeta(db, '__source_state_hash', sourceStateHash);
      setMeta(db, '__canonical_state_hash', canonicalJsonHash(state));
      setMeta(db, '__migration', migration);
      setMeta(db, '__created_at', new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    verifyStoredState(db, state);
    if (String(db.prepare('PRAGMA integrity_check').get().integrity_check) !== 'ok')
      throw storeError('state_database_integrity_failed');
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.close();
    syncFile(temporary);
    fs.renameSync(temporary, databasePath);
    syncDirectory(path.dirname(databasePath));
  } catch (error) {
    try {
      db.close();
    } catch {}
    removeDatabaseFamily(temporary);
    throw error;
  }
}

function recoverManagedMigrationDatabase(sourceStateHash) {
  const directory = path.dirname(databasePath),
    prefix = `${path.basename(databasePath)}.migrating-`;
  const candidates = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.tmp'))
    .map((entry) => path.join(directory, entry.name));
  if (fs.existsSync(databasePath)) {
    for (const candidate of candidates) removeDatabaseFamily(candidate);
    return;
  }
  const recoverable = [];
  for (const candidate of candidates) {
    let db,
      valid = false;
    try {
      db = openDatabase(candidate);
      const complete = metaValue(db, '__migration_complete') === true,
        sourceMatches = !sourceStateHash || metaValue(db, '__source_state_hash') === sourceStateHash,
        integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check) === 'ok';
      valid = complete && sourceMatches && integrity;
    } catch {
    } finally {
      try {
        db?.close();
      } catch {}
    }
    if (valid) recoverable.push(candidate);
    else removeDatabaseFamily(candidate);
  }
  if (recoverable.length > 1)
    throw storeError('state_database_recovery_ambiguous', { candidates: recoverable.map(path.basename) });
  if (recoverable.length === 1) {
    fs.renameSync(recoverable[0], databasePath);
    syncDirectory(directory);
  }
}

function openDatabase(file, { create = false } = {}) {
  const db = new DatabaseSync(file, { open: true, readOnly: false, enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  if (!create && Number(db.prepare('PRAGMA user_version').get().user_version) !== storeSchemaVersion) {
    db.close();
    throw storeError('state_database_schema_invalid');
  }
  return db;
}

function createSchema(db) {
  db.exec(`
    PRAGMA user_version = ${storeSchemaVersion};
    CREATE TABLE state_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      sha256 TEXT NOT NULL
    ) STRICT;
    CREATE TABLE state_records (
      collection TEXT NOT NULL,
      record_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      value_json TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY (collection, record_key),
      UNIQUE (collection, ordinal)
    ) STRICT;
    CREATE INDEX state_records_collection_order ON state_records(collection, ordinal);
    CREATE TABLE context_nodes (
      record_key TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT,
      parent_id TEXT,
      source_collection TEXT,
      source_id TEXT,
      status TEXT,
      source_hash TEXT,
      source_generation INTEGER NOT NULL DEFAULT 0,
      value_json TEXT NOT NULL,
      sha256 TEXT NOT NULL
    ) STRICT;
    CREATE INDEX context_nodes_project_status ON context_nodes(project_id, status, ordinal);
    CREATE INDEX context_nodes_parent ON context_nodes(parent_id, ordinal);
    CREATE INDEX context_nodes_source ON context_nodes(source_collection, source_id);
    CREATE TABLE context_document_versions (
      record_key TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE,
      id TEXT NOT NULL UNIQUE,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      source_hash TEXT,
      content_sha256 TEXT,
      value_json TEXT NOT NULL,
      sha256 TEXT NOT NULL
    ) STRICT;
    CREATE INDEX context_versions_node_version ON context_document_versions(node_id, version DESC);
    CREATE INDEX context_versions_content ON context_document_versions(content_sha256);
    CREATE TABLE context_edges (
      record_key TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE,
      id TEXT NOT NULL UNIQUE,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      edge_type TEXT,
      value_json TEXT NOT NULL,
      sha256 TEXT NOT NULL
    ) STRICT;
    CREATE INDEX context_edges_source ON context_edges(source_node_id, edge_type, target_node_id);
    CREATE INDEX context_edges_target ON context_edges(target_node_id, edge_type, source_node_id);
    CREATE TABLE context_projection_jobs (
      record_key TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE,
      id TEXT NOT NULL UNIQUE,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      lease_holder TEXT,
      lease_expires_at TEXT,
      source_hash TEXT,
      source_generation INTEGER NOT NULL DEFAULT 0,
      value_json TEXT NOT NULL,
      sha256 TEXT NOT NULL
    ) STRICT;
    CREATE INDEX context_jobs_runnable ON context_projection_jobs(status, next_retry_at, lease_expires_at, ordinal);
    CREATE INDEX context_jobs_node ON context_projection_jobs(node_id, status);
    CREATE TABLE context_selections (
      record_key TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE,
      id TEXT NOT NULL UNIQUE,
      actor_id TEXT,
      project_id TEXT,
      created_at TEXT,
      value_json TEXT NOT NULL,
      sha256 TEXT NOT NULL
    ) STRICT;
    CREATE INDEX context_selections_actor_project ON context_selections(actor_id, project_id, created_at DESC);
  `);
}

function insertWholeState(db, state) {
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value) && stateCollections.includes(key)) continue;
    setMeta(db, key, value);
  }
  for (const collection of stateCollections) {
    const records = state[collection];
    if (!Array.isArray(records)) throw storeError('state_collection_invalid', { collection });
    const identities = new Set();
    for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
      const identity = stateRecordIdentity(collection, records[ordinal]);
      if (identities.has(identity)) throw storeError('state_record_identity_duplicate', { collection, identity });
      identities.add(identity);
      upsertRecord(db, collection, identity, ordinal, records[ordinal]);
    }
  }
}

function clearStateRows(db) {
  db.prepare("DELETE FROM state_meta WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\'").run();
  db.prepare('DELETE FROM state_records').run();
  for (const table of Object.values(SPECIAL_TABLES)) db.prepare(`DELETE FROM ${table}`).run();
}

function applyMetaChanges(db, changed, deleted) {
  for (const key of deleted) db.prepare('DELETE FROM state_meta WHERE key = ?').run(key);
  for (const entry of changed) setMeta(db, entry.key, entry.value);
}

function applyCollectionChanges(db, change) {
  const { collection } = change;
  if (!stateCollections.includes(collection)) throw storeError('state_collection_unknown', { collection });
  const table = SPECIAL_TABLES[collection];
  if (change.reindex) {
    if (table) database.prepare(`UPDATE ${table} SET ordinal = ordinal + 1000000000`).run();
    else
      database.prepare('UPDATE state_records SET ordinal = ordinal + 1000000000 WHERE collection = ?').run(collection);
  }
  const deleteStatement = table
    ? database.prepare(`DELETE FROM ${table} WHERE record_key = ?`)
    : database.prepare('DELETE FROM state_records WHERE collection = ? AND record_key = ?');
  for (const identity of change.deletes || [])
    table ? deleteStatement.run(identity) : deleteStatement.run(collection, identity);
  for (const record of change.upserts || [])
    upsertRecord(db, collection, record.identity, record.ordinal, record.value);
}

function upsertRecord(db, collection, identity, ordinal, value) {
  const valueJson = JSON.stringify(value),
    hash = canonicalJsonHash(value),
    table = SPECIAL_TABLES[collection];
  if (!table) {
    db.prepare(
      `INSERT INTO state_records(collection, record_key, ordinal, value_json, sha256)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(collection, record_key) DO UPDATE SET
         ordinal = excluded.ordinal, value_json = excluded.value_json, sha256 = excluded.sha256`
    ).run(collection, identity, ordinal, valueJson, hash);
    return;
  }
  const fields = specializedFields(collection, value);
  const columns = ['record_key', 'ordinal', ...Object.keys(fields), 'value_json', 'sha256'];
  const assignments = columns
    .filter((column) => column !== 'record_key')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  db.prepare(
    `INSERT INTO ${table}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT(record_key) DO UPDATE SET ${assignments}`
  ).run(identity, ordinal, ...Object.values(fields), valueJson, hash);
}

function specializedFields(collection, value) {
  switch (collection) {
    case 'context_nodes':
      return {
        id: value.id,
        project_id: value.project_id ?? null,
        parent_id: value.parent_id ?? null,
        source_collection: value.source_collection ?? null,
        source_id: value.source_id ?? null,
        status: value.status ?? null,
        source_hash: value.source_hash ?? null,
        source_generation: integer(value.source_generation)
      };
    case 'context_document_versions':
      return {
        id: value.id,
        node_id: value.node_id,
        version: integer(value.version),
        source_hash: value.source_hash ?? null,
        content_sha256: value.content_sha256 ?? null
      };
    case 'context_edges':
      return {
        id: value.id,
        source_node_id: value.source_node_id,
        target_node_id: value.target_node_id,
        edge_type: value.type ?? value.edge_type ?? null
      };
    case 'context_projection_jobs':
      return {
        id: value.id,
        node_id: value.node_id,
        status: value.status,
        attempts: integer(value.attempts),
        next_retry_at: value.next_retry_at ?? null,
        lease_holder: value.lease?.holder ?? null,
        lease_expires_at: value.lease?.expires_at ?? null,
        source_hash: value.source_hash ?? null,
        source_generation: integer(value.source_generation)
      };
    case 'context_selections':
      return {
        id: value.id,
        actor_id: value.actor_id ?? null,
        project_id: value.project_id ?? null,
        created_at: value.created_at ?? null
      };
    default:
      throw storeError('state_specialized_collection_unknown', { collection });
  }
}

function readWholeState(db) {
  const state = Object.fromEntries(stateCollections.map((collection) => [collection, []]));
  for (const row of db.prepare("SELECT key, value_json FROM state_meta WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\'").all())
    state[row.key] = JSON.parse(row.value_json);
  const generic = db.prepare('SELECT collection, value_json FROM state_records ORDER BY collection, ordinal').all();
  for (const row of generic) state[row.collection].push(JSON.parse(row.value_json));
  for (const collection of V23_SPECIALIZED_COLLECTIONS) {
    const table = SPECIAL_TABLES[collection];
    state[collection] = db
      .prepare(`SELECT value_json FROM ${table} ORDER BY ordinal`)
      .all()
      .map((row) => JSON.parse(row.value_json));
  }
  return { state, revision: Number(metaValue(db, '__revision') || 0) };
}

function verifyStoredState(db, expected) {
  const actual = readWholeState(db).state;
  for (const collection of stateCollections) {
    const expectedRecords = expected[collection] || [],
      actualRecords = actual[collection] || [];
    if (expectedRecords.length !== actualRecords.length)
      throw storeError('state_migration_count_mismatch', {
        collection,
        expected: expectedRecords.length,
        actual: actualRecords.length
      });
    for (let index = 0; index < expectedRecords.length; index += 1) {
      const expectedIdentity = stateRecordIdentity(collection, expectedRecords[index]),
        actualIdentity = stateRecordIdentity(collection, actualRecords[index]);
      if (
        expectedIdentity !== actualIdentity ||
        canonicalJson(expectedRecords[index]) !== canonicalJson(actualRecords[index])
      )
        throw storeError('state_migration_record_mismatch', { collection, index, expectedIdentity, actualIdentity });
    }
  }
  if (canonicalJsonHash(expected) !== canonicalJsonHash(actual)) {
    const expectedRoot = Object.fromEntries(Object.entries(expected).filter(([, value]) => !Array.isArray(value))),
      actualRoot = Object.fromEntries(Object.entries(actual).filter(([, value]) => !Array.isArray(value)));
    throw storeError('state_migration_hash_mismatch', {
      expected_hash: canonicalJsonHash(expected),
      actual_hash: canonicalJsonHash(actual),
      expected_root_hash: canonicalJsonHash(expectedRoot),
      actual_root_hash: canonicalJsonHash(actualRoot),
      expected_root_keys: Object.keys(expectedRoot).sort(),
      actual_root_keys: Object.keys(actualRoot).sort(),
      expected_array_keys: Object.entries(expected)
        .filter(([, value]) => Array.isArray(value))
        .map(([key]) => key)
        .sort(),
      actual_array_keys: Object.entries(actual)
        .filter(([, value]) => Array.isArray(value))
        .map(([key]) => key)
        .sort()
    });
  }
}

function verifyDatabase(db) {
  if (Number(db.prepare('PRAGMA user_version').get().user_version) !== storeSchemaVersion)
    throw storeError('state_database_schema_invalid');
  if (metaValue(db, '__migration_complete') !== true) throw storeError('state_database_migration_incomplete');
  const integrity = String(db.prepare('PRAGMA integrity_check').get().integrity_check || '');
  if (integrity !== 'ok') throw storeError('state_database_integrity_failed', { integrity });
}

function setMeta(db, key, value) {
  const valueJson = JSON.stringify(value);
  db.prepare(
    `INSERT INTO state_meta(key, value_json, sha256) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, sha256 = excluded.sha256`
  ).run(key, valueJson, canonicalJsonHash(value));
}

function metaValue(db, key) {
  const row = db.prepare('SELECT value_json FROM state_meta WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : null;
}

function requireDatabase() {
  if (!database) throw storeError('state_database_not_initialized');
}

function removeDatabaseFamily(file) {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`])
    try {
      fs.rmSync(candidate, { force: true });
    } catch {}
}

function syncFile(file) {
  const descriptor = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {}
}

function integer(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) ? number : 0;
}

function storeError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function safeCode(error) {
  return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? String(error.code) : 'state_store_worker_failed';
}
