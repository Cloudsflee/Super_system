import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from './migration-service.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

const file = path.resolve(workerData.file);
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const migration = migrateDatabase({ file });
const db = new DatabaseSync(file);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');

function normalize(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value;
}

function runStatement(statement) {
  const prepared = db.prepare(statement.sql);
  const result = prepared.run(...(statement.params ?? []));
  if (statement.expect_changes != null && Number(result.changes) !== Number(statement.expect_changes)) {
    const error = new Error('transaction_precondition_failed');
    error.name = 'TransactionPreconditionError';
    throw error;
  }
  return normalize({ changes: result.changes, lastInsertRowid: result.lastInsertRowid });
}

function handle(message) {
  switch (message.op) {
    case 'query':
      return normalize(db.prepare(message.sql).all(...(message.params ?? [])));
    case 'get':
      return normalize(db.prepare(message.sql).get(...(message.params ?? [])) ?? null);
    case 'run':
      return runStatement(message);
    case 'exec':
      db.exec(message.sql);
      return null;
    case 'transaction': {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = (message.statements ?? []).map(runStatement);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
        throw error;
      }
    }
    case 'integrity': {
      const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
      const journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
      const synchronous = db.prepare('PRAGMA synchronous').get().synchronous;
      const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
      const migrationVersion = Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version);
      return { integrity, journal_mode: journal, synchronous: Number(synchronous), user_version: userVersion, migration_version: migrationVersion };
    }
    case 'close':
      db.close();
      return null;
    default:
      throw new Error(`unknown_database_operation:${message.op}`);
  }
}

parentPort.postMessage({ type: 'ready', user_version: SCHEMA_VERSION, migration });
parentPort.on('message', (message) => {
  if (message.op === 'close') {
    try {
      handle(message);
      parentPort.postMessage({ id: message.id, ok: true, value: null });
    } finally {
      process.exit(0);
    }
    return;
  }
  try {
    parentPort.postMessage({ id: message.id, ok: true, value: handle(message) });
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: { message: error.message, name: error.name } });
  }
});
