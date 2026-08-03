import { createHash } from 'node:crypto';

import { collections } from './config.mjs';
import {
  assertV21AppendOnly,
  canonicalStateHash,
  migrateState20To21,
  normalizeState21Defaults,
  validateState21
} from './state-migration-v21.mjs';
import { removeRetiredRuntimeRecordsForMigration } from './state-migration-retired-runtime.mjs';

export const STATE_SCHEMA_VERSION = 22;
export const V22_RUNNER_IMAGE = 'aiws-codex-runner:2.2.0-codex-0.144.0';
export const V22_SENTINEL_FORMAT = 'aiws.sqlite-state.v1';
export const V22_SPECIALIZED_COLLECTIONS = Object.freeze([
  'context_nodes',
  'context_document_versions',
  'context_edges',
  'context_projection_jobs',
  'context_selections'
]);
export const V22_COLLECTIONS = Object.freeze(
  collections.filter(
    (collection) => !['quality_review_runs', 'quality_review_reports', 'quality_review_events'].includes(collection)
  )
);

export { assertV21AppendOnly, canonicalStateHash };

export function migrateState21To22(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw stateError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion > STATE_SCHEMA_VERSION)
    throw stateError('state_schema_newer_than_runtime', { schema_version: inputVersion });
  if (inputVersion === STATE_SCHEMA_VERSION) {
    validateState22(source);
    return {
      state: source,
      migrated: false,
      from_version: STATE_SCHEMA_VERSION,
      to_version: STATE_SCHEMA_VERSION,
      migrated_at: null
    };
  }

  const migrated21 =
    inputVersion === 21
      ? (validateState21(source), { state: source, from_version: 21 })
      : migrateState20To21(source, { timestamp });
  const state = migrated21.state;
  normalizeState22Defaults(state, timestamp, { migrating: true });
  state.schema_version = STATE_SCHEMA_VERSION;
  state.migrated_to_schema_22_at = timestamp;
  validateState22(state);
  return {
    state,
    migrated: true,
    from_version: inputVersion,
    to_version: STATE_SCHEMA_VERSION,
    migrated_at: timestamp
  };
}

export function normalizeState22Defaults(state, timestamp = new Date().toISOString(), { migrating = false } = {}) {
  normalizeState21Defaults(state, timestamp, { migrating: false });
  normalizeOfficialRunnerImagesV22(state, { timestamp });
  if (migrating) removeRetiredRuntimeRecordsForMigration(state, timestamp);
  if (migrating) state.migrated_to_schema_22_at ||= timestamp;
  state.schema_version = STATE_SCHEMA_VERSION;
  return state;
}

export function normalizeOfficialRunnerImagesV22(state, { timestamp = new Date().toISOString() } = {}) {
  let changed = false;
  const official = /^aiws-codex-runner:(?:1\.(?:[0-9]|10)\.0|2\.[0-2]\.0)-codex-0\.144\.0$/;
  for (const profile of state.codex_profiles || []) {
    if (official.test(String(profile.image || '')) && profile.image !== V22_RUNNER_IMAGE) {
      profile.image = V22_RUNNER_IMAGE;
      profile.updated_at = timestamp;
      changed = true;
    }
    if (official.test(String(profile.config?.image || '')) && profile.config.image !== V22_RUNNER_IMAGE) {
      profile.config.image = V22_RUNNER_IMAGE;
      profile.updated_at = timestamp;
      changed = true;
    }
  }
  for (const integration of state.integration_statuses || [])
    if (
      integration.key === 'codex_docker' &&
      official.test(String(integration.image || '')) &&
      integration.image !== V22_RUNNER_IMAGE
    ) {
      integration.image = V22_RUNNER_IMAGE;
      integration.updated_at = timestamp;
      changed = true;
    }
  return { changed };
}

export function validateState22(state) {
  if (Number(state?.schema_version) !== STATE_SCHEMA_VERSION)
    throw stateError('state_schema_invalid', { expected: STATE_SCHEMA_VERSION, actual: state?.schema_version });
  validateState21({ ...state, schema_version: 21 });
  for (const collection of V22_COLLECTIONS) validateCollectionIdentities(collection, state[collection]);
  return true;
}

export function validateCollectionIdentities(collection, records) {
  if (!Array.isArray(records)) throw stateError('state_collection_invalid', { collection });
  const identities = new Set();
  for (const record of records) {
    const identity = stateRecordIdentity(collection, record);
    if (identities.has(identity)) throw stateError('state_record_identity_duplicate', { collection, identity });
    identities.add(identity);
  }
}

export function stateRecordIdentity(collection, record) {
  if (collection === 'assist_events') {
    const sessionId = record?.session_id,
      sequence = record?.sequence;
    if (sessionId == null || sessionId === '' || sequence == null || sequence === '')
      throw stateError('state_record_identity_missing', { collection, identity_field: identityField(collection) });
    return JSON.stringify([String(sessionId), String(sequence)]);
  }
  if (collection === 'integration_statuses' && record?.id == null && record?.key != null) {
    const qualifier = [record.profile_id, record.request_id, record.source_id, record.provider_id]
      .filter((value) => value != null && String(value).trim())
      .map(String)
      .join(':');
    return qualifier ? `${record.key}:${qualifier}` : String(record.key);
  }
  const value = collection === 'webhook_deliveries' ? record?.delivery_id : (record?.id ?? record?.key),
    normalized = value == null ? '' : String(value);
  if (!normalized)
    throw stateError('state_record_identity_missing', { collection, identity_field: identityField(collection) });
  return normalized;
}

export function identityField(collection) {
  if (collection === 'webhook_deliveries') return 'delivery_id';
  if (collection === 'assist_events') return 'session_id_and_sequence';
  if (collection === 'integration_statuses') return 'id_or_qualified_key';
  return 'id_or_key';
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function canonicalJsonHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function createState22Sentinel({ revision, stateHash, migratedFrom = 21, migratedAt }) {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    storage: {
      format: V22_SENTINEL_FORMAT,
      authoritative: 'state-v22.sqlite',
      state_json_is_snapshot: false
    },
    revision: Number(revision || 0),
    migrated_from_schema: Number(migratedFrom || 21),
    migrated_at: migratedAt || new Date().toISOString(),
    canonical_state_sha256: stateHash
  };
}

export function isState22Sentinel(value) {
  return (
    Number(value?.schema_version) === STATE_SCHEMA_VERSION &&
    value?.storage?.format === V22_SENTINEL_FORMAT &&
    value?.storage?.authoritative === 'state-v22.sqlite'
  );
}

function stateError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
