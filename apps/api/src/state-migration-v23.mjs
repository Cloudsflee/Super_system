import { collections } from './config.mjs';
import { reconcileContextProjectionState } from '../../../packages/system-context/src/index.mjs';
import {
  assertV21AppendOnly,
  canonicalJson,
  canonicalJsonHash as canonicalJsonHashV22,
  migrateState21To22,
  normalizeOfficialRunnerImagesV22,
  normalizeState22Defaults,
  validateState22
} from './state-migration-v22.mjs';
import { V21_SOURCE_COLLECTIONS } from './state-migration-v21.mjs';
import {
  assertQualityReviewAppendOnly,
  assertQualityReviewHumanReviewAppendOnly,
  assertQualityReviewRunSnapshotImmutability,
  ensureQualityReviewProfiles,
  markQualityReviewRunsStale,
  normalizeQualityReviewDefaults,
  qualityReviewRunInputIsCurrent,
  stateRecordIdentity as qualityStateRecordIdentity,
  validateQualityReviewRecords,
  validateQualityReviewReferences
} from './state-migration-v23-quality.mjs';
import { removeRetiredRuntimeRecordsForMigration } from './state-migration-retired-runtime.mjs';

export const STATE_SCHEMA_VERSION = 23;
export const V23_RUNNER_IMAGE = 'aiws-codex-runner:2.3.0-codex-0.144.0';
export const V23_SENTINEL_FORMAT = 'aiws.sqlite-state.v1';
export const V23_SPECIALIZED_COLLECTIONS = Object.freeze([
  'context_nodes',
  'context_document_versions',
  'context_edges',
  'context_projection_jobs',
  'context_selections'
]);
export const QUALITY_REVIEW_COLLECTIONS = Object.freeze([
  'quality_review_runs',
  'quality_review_reports',
  'quality_review_events'
]);
export const QUALITY_REVIEW_APPEND_ONLY_COLLECTIONS = Object.freeze([
  'quality_review_reports',
  'quality_review_events'
]);

export const canonicalJsonHash = canonicalJsonHashV22;
export { canonicalJson };
export const assertAppendOnly = assertV21AppendOnly;
export {
  assertQualityReviewAppendOnly,
  assertQualityReviewHumanReviewAppendOnly,
  assertQualityReviewRunSnapshotImmutability,
  ensureQualityReviewProfiles,
  markQualityReviewRunsStale,
  normalizeQualityReviewDefaults,
  qualityReviewRunInputIsCurrent,
  validateQualityReviewRecords,
  validateQualityReviewReferences
};

export function migrateState22To23(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw stateError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion > STATE_SCHEMA_VERSION)
    throw stateError('state_schema_newer_than_runtime', { schema_version: inputVersion });
  if (inputVersion === STATE_SCHEMA_VERSION) return migrateCurrentState(source, timestamp);
  const state =
    inputVersion < 22
      ? migrateState21To22(source, { timestamp }).state
      : normalizeState22Defaults(source, timestamp, { migrating: false });
  normalizeState23Defaults(state, timestamp, { migrating: true });
  ensureQualityReviewProfiles(state, timestamp);
  reconcileContextProjectionState(state, { sourceCollections: V21_SOURCE_COLLECTIONS, timestamp });
  state.schema_version = STATE_SCHEMA_VERSION;
  state.migrated_to_schema_23_at = timestamp;
  validateState23(state);
  return {
    state,
    migrated: true,
    from_version: inputVersion,
    to_version: STATE_SCHEMA_VERSION,
    migrated_at: timestamp,
    quality_review_runs: state.quality_review_runs.length
  };
}

function migrateCurrentState(source, timestamp) {
  const state = normalizeState23Defaults(source, timestamp, { migrating: false });
  validateState23(state);
  return { state, migrated: false, from_version: 23, to_version: 23, migrated_at: null };
}

export function normalizeState23Defaults(state, timestamp = new Date().toISOString(), { migrating = false } = {}) {
  for (const collection of collections) if (!Array.isArray(state[collection])) state[collection] = [];
  normalizeState22Defaults(state, timestamp, { migrating: false });
  normalizeOfficialRunnerImagesV23(state, { timestamp });
  if (migrating) removeRetiredRuntimeRecordsForMigration(state, timestamp);
  normalizeQualityReviewDefaults(state, timestamp, { migrating });
  if (migrating) state.migrated_to_schema_23_at ||= timestamp;
  state.schema_version = STATE_SCHEMA_VERSION;
  return state;
}

export function normalizeOfficialRunnerImagesV23(state, { timestamp = new Date().toISOString() } = {}) {
  const result = normalizeOfficialRunnerImagesV22(state, { timestamp }),
    official = /^aiws-codex-runner:(?:1\.(?:[0-9]|10)\.0|2\.[0-3]\.0)-codex-0\.144\.0$/;
  for (const profile of state.codex_profiles || []) {
    result.changed = updateRunnerImage(profile, official, timestamp) || result.changed;
    result.changed = updateConfigImage(profile, official, timestamp) || result.changed;
  }
  for (const integration of state.integration_statuses || [])
    if (integration.key === 'codex_docker' && updateIntegrationImage(integration, official, timestamp))
      result.changed = true;
  return { ...result, image: V23_RUNNER_IMAGE };
}

function updateRunnerImage(profile, official, timestamp) {
  if (!official.test(String(profile.image || '')) || profile.image === V23_RUNNER_IMAGE) return false;
  profile.image = V23_RUNNER_IMAGE;
  profile.updated_at = timestamp;
  return true;
}

function updateConfigImage(profile, official, timestamp) {
  if (!official.test(String(profile.config?.image || '')) || profile.config.image === V23_RUNNER_IMAGE) return false;
  profile.config.image = V23_RUNNER_IMAGE;
  profile.updated_at = timestamp;
  return true;
}

function updateIntegrationImage(integration, official, timestamp) {
  if (!official.test(String(integration.image || '')) || integration.image === V23_RUNNER_IMAGE) return false;
  integration.image = V23_RUNNER_IMAGE;
  integration.updated_at = timestamp;
  return true;
}

export function validateState23(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw stateError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION)
    throw stateError('state_schema_invalid', { expected: STATE_SCHEMA_VERSION, actual: state.schema_version });
  validateState22({ ...state, schema_version: 22 });
  for (const collection of QUALITY_REVIEW_COLLECTIONS) {
    if (!Array.isArray(state[collection])) throw stateError('state_collection_invalid', { collection });
    validateCollectionIdentities(collection, state[collection]);
  }
  validateQualityReviewRecords(state);
  validateQualityReviewReferences(state);
  return true;
}

export function validateCollectionIdentities(collection, records) {
  if (!Array.isArray(records)) throw stateError('state_collection_invalid', { collection });
  const identities = new Set();
  for (const record of records) {
    const identity = qualityStateRecordIdentity(collection, record);
    if (identities.has(identity)) throw stateError('state_record_identity_duplicate', { collection, identity });
    identities.add(identity);
  }
}

export const stateRecordIdentity = qualityStateRecordIdentity;

export function createState23Sentinel({ revision, stateHash, migratedFrom = 22, migratedAt }) {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    storage: {
      format: V23_SENTINEL_FORMAT,
      authoritative: 'state-v23.sqlite',
      state_json_is_snapshot: false
    },
    revision: Number(revision || 0),
    migrated_from_schema: Number(migratedFrom || 22),
    migrated_at: migratedAt || new Date().toISOString(),
    canonical_state_sha256: stateHash
  };
}

export function isState23Sentinel(value) {
  return (
    Number(value?.schema_version) === STATE_SCHEMA_VERSION &&
    value?.storage?.format === V23_SENTINEL_FORMAT &&
    value?.storage?.authoritative === 'state-v23.sqlite'
  );
}

function stateError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
