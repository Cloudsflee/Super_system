import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { collections } from './config.mjs';
import { stateRecordIdentity, V23_SPECIALIZED_COLLECTIONS } from './state-migration-v23.mjs';

let response;
try {
  response = { ok: true, state: readLegacySqliteState(workerData.databasePath) };
} catch (error) {
  response = { ok: false, error: serializeError(error) };
}
parentPort.postMessage(response);
parentPort.close();

function readLegacySqliteState(databasePath) {
  // immutable=1 prevents SQLite from creating -wal/-shm sidecars while a
  // V2.2 volume is mounted read-only during the V2.3 cutover audit.
  const database = new DatabaseSync(`${pathToFileURL(path.resolve(databasePath)).href}?immutable=1`, {
      readOnly: true
    }),
    state = Object.fromEntries(collections.map((collection) => [collection, []]));
  try {
    database.exec('PRAGMA foreign_keys = ON');
    for (const row of database
      .prepare("SELECT key, value_json FROM state_meta WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\'")
      .all())
      state[row.key] = JSON.parse(row.value_json);
    for (const row of database
      .prepare('SELECT collection, value_json FROM state_records ORDER BY collection, ordinal')
      .all())
      (state[row.collection] ||= []).push(JSON.parse(row.value_json));
    for (const collection of V23_SPECIALIZED_COLLECTIONS) {
      if (!tableExists(database, collection)) continue;
      state[collection] = database
        .prepare(`SELECT value_json FROM ${collection} ORDER BY ordinal`)
        .all()
        .map((row) => JSON.parse(row.value_json));
    }
    state.schema_version = Number(database.prepare('PRAGMA user_version').get().user_version) || 22;
    for (const collection of collections) {
      if (!Array.isArray(state[collection])) state[collection] = [];
      const identities = new Set();
      for (const record of state[collection]) {
        const key = stateRecordIdentity(collection, record);
        if (identities.has(key)) throw workerFailure('state_record_identity_duplicate', { collection, key });
        identities.add(key);
      }
    }
    return state;
  } finally {
    database.close();
  }
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function workerFailure(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function serializeError(error) {
  return {
    code: error?.code || 'state_database_read_failed',
    message: String(error?.message || error),
    details: error?.details || {}
  };
}
