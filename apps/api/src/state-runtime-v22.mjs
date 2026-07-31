import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { now } from '../../../packages/shared/index.mjs';
import { DATA_DIR, STATE_DB_FILE, STATE_FILE } from './config.mjs';
import { materializeContextDocumentsInState } from './context-projection.mjs';
import {
  canonicalJsonHash,
  canonicalStateHash,
  createState22Sentinel,
  isState22Sentinel,
  migrateState21To22,
  normalizeState22Defaults,
  validateState22
} from './state-migration-v22.mjs';

const STATE_FILE_REPLACE_RETRIES = 100;

export async function prepareStateStoreInitialization(bootstrapState) {
  const databaseExists = fs.existsSync(STATE_DB_FILE);
  if (!fs.existsSync(STATE_FILE)) {
    if (databaseExists)
      return {
        state: null,
        sourceStateHash: null,
        sentinel: false,
        originalBytes: null,
        migration: { recovered: true, from_version: 22, to_version: 22, migrated_at: now() }
      };
    const state = bootstrapState();
    normalizeState22Defaults(state, now());
    await materializeContextDocumentsInState(state, { maxJobs: 0 });
    validateState22(state);
    return {
      state,
      sourceStateHash: null,
      sentinel: false,
      originalBytes: null,
      migration: { migrated: false, bootstrapped: true, from_version: null, to_version: 22, migrated_at: now() }
    };
  }

  const originalBytes = await fsp.readFile(STATE_FILE);
  let parsed;
  try {
    parsed = JSON.parse(originalBytes.toString('utf8'));
  } catch (error) {
    throw stateRuntimeFailure('state_json_invalid', {}, error);
  }
  if (isState22Sentinel(parsed)) {
    if (!databaseExists) throw stateRuntimeFailure('state_database_missing_for_sentinel');
    return { state: null, sourceStateHash: null, sentinel: true, originalBytes, migration: null };
  }
  const sourceStateHash = canonicalStateHash(parsed),
    migrationResult = migrateState21To22(parsed, { timestamp: now() });
  return {
    state: migrationResult.state,
    sourceStateHash,
    sentinel: false,
    originalBytes,
    migration: {
      migrated: true,
      from_version: migrationResult.from_version,
      to_version: 22,
      migrated_at: migrationResult.migrated_at,
      source_state_hash: sourceStateHash,
      migrated_state_hash: canonicalJsonHash(migrationResult.state)
    }
  };
}

export async function commitState22Sentinel(prepared, initialized) {
  let migration = prepared.migration;
  if (prepared.originalBytes) {
    const directory = path.join(DATA_DIR, 'migrations');
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = String(prepared.migration?.migrated_at || now()).replace(/[:.]/g, '-'),
      fromVersion = prepared.migration?.from_version ?? 'legacy',
      stem = `state-schema${fromVersion}-to22-${stamp}-${prepared.sourceStateHash.slice(0, 12)}`,
      backupPath = path.join(directory, `${stem}.json`),
      manifestPath = path.join(directory, `${stem}.manifest.json`);
    await writeExclusiveAndSync(backupPath, prepared.originalBytes).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const manifest = {
      migration: `aiws-state-${fromVersion}-to-22-sqlite`,
      status: 'committed',
      from_schema: fromVersion,
      to_schema: 22,
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
    createState22Sentinel({
      revision: initialized.revision,
      stateHash: initialized.canonical_state_hash,
      migratedFrom: prepared.migration?.from_version || 21,
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
    let temporaryValue;
    try {
      temporaryValue = JSON.parse(temporaryBytes.toString('utf8'));
    } catch {
      throw stateRuntimeFailure('state_temp_recovery_invalid');
    }
    if (!temporaryValue || typeof temporaryValue !== 'object' || Array.isArray(temporaryValue))
      throw stateRuntimeFailure('state_temp_recovery_invalid');
    await replaceStateFile(temporary, STATE_FILE);
    return;
  }
  const currentBytes = await fsp.readFile(STATE_FILE);
  if (currentBytes.equals(temporaryBytes)) {
    await fsp.rm(temporary, { force: true });
    return;
  }
  let currentValue = null;
  try {
    currentValue = JSON.parse(currentBytes.toString('utf8'));
  } catch {}
  if (isState22Sentinel(currentValue) && fs.existsSync(STATE_DB_FILE)) {
    await fsp.rm(temporary, { force: true });
    return;
  }
  let temporaryValue = null,
    temporaryInvalid = false;
  try {
    temporaryValue = JSON.parse(temporaryBytes.toString('utf8'));
  } catch {
    temporaryInvalid = true;
  }
  if (Number(currentValue?.schema_version) === 21 && !Array.isArray(currentValue)) {
    if (temporaryInvalid || (Number(temporaryValue?.schema_version) === 21 && !Array.isArray(temporaryValue))) {
      await fsp.rm(temporary, { force: true });
      return;
    }
  }
  if (temporaryInvalid) throw stateRuntimeFailure('state_temp_recovery_invalid');
  throw stateRuntimeFailure('state_temp_recovery_ambiguous', {
    state_file: path.basename(STATE_FILE),
    temp_file: path.basename(temporary)
  });
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
