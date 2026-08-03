import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { now } from '../../../packages/shared/index.mjs';
import { collections, DATA_DIR, STATE_DB_FILE, STATE_FILE } from './config.mjs';
import { materializeContextDocumentsInState } from './context-projection.mjs';
import {
  canonicalJsonHash,
  createState23Sentinel,
  isState23Sentinel,
  migrateState22To23,
  normalizeState23Defaults,
  stateRecordIdentity,
  validateState23,
  V23_SPECIALIZED_COLLECTIONS
} from './state-migration-v23.mjs';

const STATE_FILE_REPLACE_RETRIES = 100;

export async function prepareStateStoreInitialization(bootstrapState) {
  const databaseExists = fs.existsSync(STATE_DB_FILE);
  if (fs.existsSync(STATE_FILE)) {
    const originalBytes = await fsp.readFile(STATE_FILE),
      parsed = parseStateFile(originalBytes);
    if (isState23Sentinel(parsed)) {
      if (!databaseExists) throw stateRuntimeFailure('state_database_missing_for_sentinel');
      return { state: null, sourceStateHash: null, sentinel: true, originalBytes, migration: null };
    }
    if (isLegacySqliteSentinel(parsed, 22)) {
      const source = await readLegacySqliteState(path.join(DATA_DIR, 'state-v22.sqlite'));
      return migratePrepared(source, originalBytes, 22);
    }
    return migratePrepared(parsed, originalBytes, Number(parsed?.schema_version || 13));
  }
  if (databaseExists)
    return {
      state: null,
      sourceStateHash: null,
      sentinel: false,
      originalBytes: null,
      migration: { recovered: true, from_version: 23, to_version: 23, migrated_at: now() }
    };
  const state = bootstrapState();
  normalizeState23Defaults(state, now());
  await materializeContextDocumentsInState(state, { maxJobs: 0 });
  validateState23(state);
  return {
    state,
    sourceStateHash: null,
    sentinel: false,
    originalBytes: null,
    migration: { migrated: false, bootstrapped: true, from_version: null, to_version: 23, migrated_at: now() }
  };
}

export async function commitState23Sentinel(prepared, initialized) {
  let migration = prepared.migration;
  if (prepared.originalBytes && prepared.sourceStateHash) {
    const directory = path.join(DATA_DIR, 'migrations');
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = String(prepared.migration?.migrated_at || now()).replace(/[:.]/g, '-'),
      fromVersion = prepared.migration?.from_version ?? 'legacy',
      stem = `state-schema${fromVersion}-to23-${stamp}-${prepared.sourceStateHash.slice(0, 12)}`,
      backupPath = path.join(directory, `${stem}.json`),
      manifestPath = path.join(directory, `${stem}.manifest.json`);
    await writeExclusiveAndSync(backupPath, prepared.originalBytes).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const manifest = {
      migration: `aiws-state-${fromVersion}-to-23-sqlite`,
      status: 'committed',
      from_schema: fromVersion,
      to_schema: 23,
      source_state_sha256: prepared.sourceStateHash,
      migrated_state_sha256: initialized.canonical_state_hash,
      database_file: path.basename(STATE_DB_FILE),
      backup_file: path.basename(backupPath),
      revision: initialized.revision,
      committed_at: now()
    };
    await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    migration = { ...prepared.migration, backup_path: backupPath, manifest_path: manifestPath, manifest };
  }
  await atomicWriteStateSentinel(
    createState23Sentinel({
      revision: initialized.revision,
      stateHash: initialized.canonical_state_hash,
      migratedFrom: prepared.migration?.from_version || 22,
      migratedAt: prepared.migration?.migrated_at || now()
    })
  );
  return migration;
}

export async function recoverManagedStateTemp() {
  const temporary = `${STATE_FILE}.tmp`;
  if (!fs.existsSync(temporary)) return;
  const temporaryBytes = await fsp.readFile(temporary);
  if (!fs.existsSync(STATE_FILE)) {
    parseStateFile(temporaryBytes);
    await replaceStateFile(temporary, STATE_FILE);
    return;
  }
  const currentBytes = await fsp.readFile(STATE_FILE);
  if (currentBytes.equals(temporaryBytes)) {
    await fsp.rm(temporary, { force: true });
    return;
  }
  const currentValue = tryParse(currentBytes),
    temporaryValue = tryParse(temporaryBytes);
  if (isState23Sentinel(currentValue) && fs.existsSync(STATE_DB_FILE)) {
    await fsp.rm(temporary, { force: true });
    return;
  }
  if (Number(currentValue?.schema_version) === 22 && Number(temporaryValue?.schema_version) === 22) {
    await fsp.rm(temporary, { force: true });
    return;
  }
  if (!temporaryValue) throw stateRuntimeFailure('state_temp_recovery_invalid');
  throw stateRuntimeFailure('state_temp_recovery_ambiguous', {
    state_file: path.basename(STATE_FILE),
    temp_file: path.basename(temporary)
  });
}

async function migratePrepared(source, originalBytes, fromVersion) {
  const sourceHash = canonicalJsonHash(source),
    result = migrateState22To23(source, { timestamp: now() });
  await materializeContextDocumentsInState(result.state, { maxJobs: 0 });
  validateState23(result.state);
  return {
    state: result.state,
    sourceStateHash: sourceHash,
    sentinel: false,
    originalBytes,
    migration: {
      ...result,
      from_version: fromVersion,
      to_version: 23,
      source_state_hash: sourceHash,
      migrated_state_hash: canonicalJsonHash(result.state)
    }
  };
}

function parseStateFile(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('state_root_invalid');
    return value;
  } catch (error) {
    throw stateRuntimeFailure('state_json_invalid', {}, error);
  }
}

function tryParse(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function isLegacySqliteSentinel(value, version) {
  return Number(value?.schema_version) === version && value?.storage?.authoritative === `state-v${version}.sqlite`;
}

export function readLegacySqliteState(databasePath) {
  if (!fs.existsSync(databasePath)) throw stateRuntimeFailure('state_database_missing_for_schema_22');
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
        if (identities.has(key)) throw stateRuntimeFailure('state_record_identity_duplicate', { collection, key });
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

async function atomicWriteStateSentinel(sentinel) {
  const temporary = `${STATE_FILE}.tmp`,
    bytes = Buffer.from(`${JSON.stringify(sentinel, null, 2)}\n`, 'utf8'),
    handle = await fsp.open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceStateFile(temporary, STATE_FILE);
}

async function writeExclusiveAndSync(file, bytes) {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceStateFile(source, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= STATE_FILE_REPLACE_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}

function stateRuntimeFailure(code, details = {}, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  error.details = details;
  return error;
}
