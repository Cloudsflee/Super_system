import { produceWithPatches } from 'immer';

import { collections } from './config-v22.mjs';
import { redactKnownSecrets, redactKnownSecretsSync } from './vault.mjs';
import { canonicalJsonHash, stateRecordIdentity, validateState22 } from './state-migration-v22-compat.mjs';

export async function buildStateChanges(before, after) {
  await redactKnownSecrets('');
  const replacements = new Map(),
    collectionChanges = collections
      .map((collection) => collectionChange(collection, before, after, replacements))
      .filter(Boolean),
    { meta, metaDeletes } = metaChanges(before, after, replacements),
    sanitizedState = applyReplacements(after, replacements);
  validateState22(sanitizedState);
  return { state: sanitizedState, changes: { collections: collectionChanges, meta, metaDeletes } };
}

function collectionChange(collection, before, after, replacements) {
  const beforeRecords = before[collection] || [],
    afterRecords = after[collection] || [];
  if (beforeRecords === afterRecords) return null;
  const beforeByIdentity = new Map(
      beforeRecords.map((record, ordinal) => [stateRecordIdentity(collection, record), { record, ordinal }])
    ),
    scanned = scanAfterRecords(collection, afterRecords, beforeByIdentity, replacements),
    deletes = [...beforeByIdentity.keys()].filter((identity) => !scanned.identities.has(identity)),
    upserts = scanned.reindex
      ? afterRecords.map((record, ordinal) => recordUpsert(collection, record, ordinal, replacements))
      : scanned.upserts;
  return deletes.length || upserts.length ? { collection, deletes, upserts, reindex: scanned.reindex } : null;
}

function scanAfterRecords(collection, records, beforeByIdentity, replacements) {
  const identities = new Set(),
    upserts = [];
  let reindex = false;
  records.forEach((record, ordinal) => {
    const identity = stateRecordIdentity(collection, record),
      previous = beforeByIdentity.get(identity);
    if (identities.has(identity)) throw stateChangeFailure('state_record_identity_duplicate', { collection, identity });
    identities.add(identity);
    if (previous && previous.ordinal !== ordinal) reindex = true;
    const changed =
      !previous || (previous.record !== record && canonicalJsonHash(previous.record) !== canonicalJsonHash(record));
    if (changed || previous?.ordinal !== ordinal) upserts.push(recordUpsert(collection, record, ordinal, replacements));
  });
  return { identities, upserts, reindex };
}

function recordUpsert(collection, record, ordinal, replacements) {
  const identity = stateRecordIdentity(collection, record),
    sanitized = sanitizeJsonValue(record);
  if (sanitized.changed) collectionReplacements(replacements, collection).set(ordinal, sanitized.value);
  return { identity, ordinal, value: sanitized.value };
}

function collectionReplacements(replacements, collection) {
  let records = replacements.get(collection);
  if (!records) replacements.set(collection, (records = new Map()));
  return records;
}

function metaChanges(before, after, replacements) {
  const meta = [],
    metaDeletes = [],
    rootKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of rootKeys) {
    if (collections.includes(key)) continue;
    if (!Object.hasOwn(after, key)) {
      metaDeletes.push(key);
      continue;
    }
    if (Object.hasOwn(before, key) && canonicalJsonHash(before[key]) === canonicalJsonHash(after[key])) continue;
    const sanitized = sanitizeJsonValue(after[key]);
    if (sanitized.changed) replacements.set(key, sanitized.value);
    meta.push({ key, value: sanitized.value });
  }
  return { meta, metaDeletes };
}

function applyReplacements(state, replacements) {
  if (!replacements.size) return state;
  return produceWithPatches(state, (draft) => {
    for (const [key, value] of replacements) {
      if (value instanceof Map) for (const [ordinal, record] of value) draft[key][ordinal] = record;
      else draft[key] = value;
    }
  })[0];
}

function sanitizeJsonValue(value) {
  const serialized = JSON.stringify(value),
    sanitized = redactKnownSecretsSync(serialized);
  return sanitized === serialized ? { value, changed: false } : { value: JSON.parse(sanitized), changed: true };
}

function stateChangeFailure(code, details) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
