import { cloneStateValue as structuredClone } from './state-clone.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createDraft, enablePatches, finishDraft, freeze, produceWithPatches, setAutoFreeze } from 'immer';
import {
  createLocalOwner,
  defaultCodexProfiles,
  defaultTools,
  hashString,
  id,
  makeTrace,
  now
} from '../../../packages/shared/index.mjs';
import {
  ARTIFACT_DIR,
  ASSIST_DIR,
  ATTACHMENT_DIR,
  ATTACHMENT_TEMP_DIR,
  CAS_DIR,
  CODEX_HOME_DIR,
  CONTEXT_INDEX_DIR,
  DATA_DIR,
  EXECUTION_DIR,
  EXPORT_DIR,
  PROBE_DIR,
  QUALITY_REVIEW_TEMP_DIR,
  STAGING_DIR,
  STATE_DB_FILE,
  STATE_FILE,
  TRASH_DIR,
  VAULT_DIR,
  WORKSPACE_DIR,
  WORKTREE_DIR,
  collections
} from './config.mjs';
import { redactKnownSecrets } from './vault.mjs';
import {
  normalizeOutcomeEvidenceRelationsV20,
  normalizeTaskHandoffDefaultsV20,
  V21_OUTCOME_COLLECTIONS
} from './state-migration-v21.mjs';
import {
  assertAppendOnly as assertV21AppendOnly,
  assertQualityReviewAppendOnly,
  assertQualityReviewHumanReviewAppendOnly,
  assertQualityReviewRunSnapshotImmutability,
  canonicalJsonHash,
  markQualityReviewRunsStale,
  normalizeOfficialRunnerImagesV23,
  normalizeQualityReviewDefaults,
  ensureQualityReviewProfiles,
  normalizeState23Defaults,
  STATE_SCHEMA_VERSION,
  validateState23
} from './state-migration-v23.mjs';
import {
  commitState23Sentinel,
  prepareStateStoreInitialization,
  recoverManagedStateTemp
} from './state-runtime-v23.mjs';
import {
  assertContextImmutability,
  CONTEXT_INTERNAL_COLLECTIONS,
  reconcileContextProjectionState
} from '../../../packages/system-context/src/index.mjs';
import { collectContextVersions, materializeContextDocumentsInState } from './context-projection.mjs';
import { normalizeState18Compatibility } from './state-compatibility.mjs';
import { currentActorId } from './actor-context.mjs';
import { ensureProjectGovernanceDefaults } from './project-governance-v19.mjs';
import { ensureRepositoryLifecycleDefaults } from './repository-lifecycle-v19.mjs';
import { ensureExchangeDefaults } from './exchange-v19.mjs';
import { promoteLegacyExecutionHistoryInState } from './legacy-execution-promotion.mjs';
import {
  ensureRuntimeDefaults,
  normalizeRuntimeGovernance,
  normalizeRuntimeProjects,
  normalizeRuntimeDraftsAndProposals,
  normalizeLegacyRuntimeRecords,
  normalizeCodexProfileRecords,
  refreshValidatedCodexProfiles
} from './state-v22-runtime-normalizers.mjs';
import { recoverInterruptedRuntimeWork as recoverBaseRuntimeWork } from './state-v22-runtime-recovery.mjs';
import {
  applyStateChanges,
  checkpointStateStore,
  closeStateStore,
  initializeStateStore,
  readStoredState,
  readStoredStateRevision,
  replaceStoredState,
  stateStoreHealth,
  stateStoreRuntimeStatus
} from './state-store.mjs';
import { buildStateChanges } from './state-change-builder.mjs';
import * as stateV22Compatibility from './state-v22.mjs';

enablePatches();
setAutoFreeze(true);

const MODULE_URL = new URL(import.meta.url),
  V22_COMPATIBILITY = MODULE_URL.search.includes('v22') || isLegacyV22TestVolume();
let lastMigration = null;

function isLegacyV22TestVolume() {
  if (MODULE_URL.search || process.env.NODE_ENV !== 'test') return false;
  if (process.env.AIWS_BYPASS_SETUP === '1') return true;
  if (!fs.existsSync(STATE_FILE)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return (
      Number(value?.schema_version || 0) < STATE_SCHEMA_VERSION || value?.storage?.authoritative === 'state-v22.sqlite'
    );
  } catch {
    return false;
  }
}

export async function ensureRuntime() {
  if (V22_COMPATIBILITY) return stateV22Compatibility.ensureRuntime();
  await ensureRuntimeDirectories();
  await recoverManagedStateTemp();
  const prepared = await prepareStateStoreInitialization(bootstrapState),
    initialized = await initializeStateStore({
      databasePath: STATE_DB_FILE,
      collections,
      store_schema_version: STATE_SCHEMA_VERSION,
      state: prepared.state,
      sourceStateHash: prepared.sourceStateHash,
      migration: prepared.migration
    });
  await finishRuntimeInitialization(prepared, initialized);
}

async function finishRuntimeInitialization(prepared, initialized) {
  if (prepared.sourceStateHash && initialized.source_state_hash !== prepared.sourceStateHash)
    throw stateFailure('state_database_source_mismatch', {
      expected: prepared.sourceStateHash,
      actual: initialized.source_state_hash
    });
  validateState23(initialized.state);
  stateSnapshotCache = { revision: initialized.revision, state: freeze(initialized.state, true) };
  lastMigration = prepared.migration;
  if (!prepared.sentinel) lastMigration = await commitState23Sentinel(prepared, initialized);
  const state = await readState();
  if (state.schema_version !== STATE_SCHEMA_VERSION)
    throw new Error(`unsupported_state_schema_${state.schema_version}`);
  const changes = await normalizeAndPersistRuntime(state);
  await reconcileAndPersistRuntime(state, changes);
}

async function normalizeAndPersistRuntime(state) {
  const changes = { value: false };
  normalizeRuntimeCollections(state, changes);
  if (normalizeOfficialRunnerImagesV23(state, { timestamp: now() }).changed) changes.value = true;
  const before = qualityReviewStateHash(state);
  normalizeQualityReviewDefaults(state, now());
  if (before !== qualityReviewStateHash(state)) changes.value = true;
  if (normalizeOutcomeEvidenceRelationsV20(state).changed) changes.value = true;
  if (normalizeTaskHandoffDefaultsV20(state).changed) changes.value = true;
  ensureRuntimeDefaults(state, changes);
  if (ensureQualityReviewProfiles(state, now()).changed) changes.value = true;
  normalizeRuntimeGovernance(state, changes);
  normalizeRuntimeProjects(state, changes);
  normalizeRuntimeDraftsAndProposals(state, changes);
  recoverInterruptedRuntimeWork(state, changes);
  normalizeLegacyRuntimeRecords(state, changes);
  normalizeCodexProfileRecords(state, changes);
  await refreshValidatedCodexProfiles(state, changes);
  if ((await promoteLegacyExecutionHistoryInState(state)).changed) changes.value = true;
  return changes;
}

function qualityReviewStateHash(state) {
  return canonicalJsonHash({
    workflows: state.workflows,
    workflow_executions: state.workflow_executions,
    quality_review_runs: state.quality_review_runs,
    quality_review_reports: state.quality_review_reports,
    quality_review_events: state.quality_review_events
  });
}

async function reconcileAndPersistRuntime(state, changes) {
  const reconciled = reconcileContextProjectionState(state, { sourceCollections: collections, timestamp: now() });
  if (reconciled.dirty || reconciled.pruned_jobs) changes.value = true;
  const projection = await materializeContextDocumentsInState(state, { maxJobs: 0 });
  if (projection.materialized || projection.reused || projection.failed) changes.value = true;
  if (pruneExpiredContextVersions(state)) changes.value = true;
  const serialized = JSON.stringify(state);
  if (changes.value || (await redactKnownSecrets(serialized)) !== serialized) await writeState(state);
}

async function ensureRuntimeDirectories() {
  await Promise.all(
    [
      DATA_DIR,
      ARTIFACT_DIR,
      CAS_DIR,
      EXECUTION_DIR,
      VAULT_DIR,
      CODEX_HOME_DIR,
      CONTEXT_INDEX_DIR,
      WORKSPACE_DIR,
      STAGING_DIR,
      TRASH_DIR,
      EXPORT_DIR,
      WORKTREE_DIR,
      PROBE_DIR,
      ASSIST_DIR,
      ATTACHMENT_DIR,
      ATTACHMENT_TEMP_DIR,
      QUALITY_REVIEW_TEMP_DIR
    ].map((dir) => fsp.mkdir(dir, { recursive: true, mode: 0o700 }))
  );
  await Promise.all([STAGING_DIR, ATTACHMENT_TEMP_DIR, QUALITY_REVIEW_TEMP_DIR].map(clearEphemeralDirectory));
}

function normalizeRuntimeCollections(state, changes) {
  for (const key of collections)
    if (!Array.isArray(state[key])) {
      state[key] = [];
      changes.value = true;
    }
}

function recoverInterruptedRuntimeWork(state, changes) {
  recoverBaseRuntimeWork(state, changes);
  for (const run of state.quality_review_runs.filter((item) =>
    ['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human'].includes(item.status)
  )) {
    const completedAt = now();
    Object.assign(run, {
      status: 'failed',
      phase: 'failed',
      error_code: 'service_restarted',
      failure: null,
      retryable: true,
      completed_at: completedAt,
      updated_at: completedAt
    });
    run.revision = Math.max(1, Number(run.revision) || 1) + 1;
    appendQualityReviewRecoveryEvent(state, run, completedAt);
    changes.value = true;
  }
}

function appendQualityReviewRecoveryEvent(state, run, timestamp) {
  const sequence =
    Math.max(
      0,
      ...state.quality_review_events.filter((item) => item.run_id === run.id).map((item) => Number(item.sequence) || 0)
    ) + 1;
  state.quality_review_events.push({
    id: id('qre'),
    run_id: run.id,
    project_id: run.project_id,
    sequence,
    type: 'failed',
    data: { phase: 'failed', error_code: 'service_restarted', retryable: true },
    created_at: timestamp
  });
}

export function emptyState() {
  if (V22_COMPATIBILITY) return stateV22Compatibility.emptyState();
  return Object.fromEntries(collections.map((key) => [key, []]));
}

function bootstrapState() {
  const state = emptyState(),
    { user, session } = createLocalOwner();
  state.schema_version = STATE_SCHEMA_VERSION;
  state.users.push(user);
  state.sessions.push(session);
  state.instance_owner_user_id = user.id;
  state.tools.push(...defaultTools(user.id));
  state.codex_profiles.push(...defaultCodexProfiles(user.id));
  state.traces.push(
    makeTrace('human.reviewed', { summary: '首次启动：创建 Local Owner Account。' }, { type: 'system', id: user.id })
  );
  return state;
}

export async function readState() {
  if (V22_COMPATIBILITY) return stateV22Compatibility.readState();
  await refreshStateSnapshot();
  return structuredClone(stateSnapshotCache.state);
}

async function refreshStateSnapshot() {
  if (!stateSnapshotCache) throw stateFailure('state_store_not_initialized');
  const persisted = await readStoredStateRevision();
  if (persisted.revision !== stateSnapshotCache.revision) {
    const refreshed = await readStoredState();
    validateState23(refreshed.state);
    installStateSnapshot(refreshed.state, refreshed.revision);
  }
  return stateSnapshotCache;
}

let stateSnapshotCache = null;
let mutationQueue = Promise.resolve();
const revisionSubscribers = new Set();

export async function readStateSnapshot({ refresh = false } = {}) {
  if (V22_COMPATIBILITY) return stateV22Compatibility.readStateSnapshot({ refresh });
  if (refresh) await refreshStateSnapshot();
  if (!stateSnapshotCache) throw stateFailure('state_store_not_initialized');
  return stateSnapshotCache.state;
}

export async function writeState(state) {
  if (V22_COMPATIBILITY) return stateV22Compatibility.writeState(state);
  return enqueueMutation(() => persistStateReplacement(state));
}

export function lastStateMigration() {
  if (V22_COMPATIBILITY) return stateV22Compatibility.lastStateMigration();
  return lastMigration ? { ...lastMigration, state: undefined } : null;
}

async function clearEphemeralDirectory(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map((entry) => fsp.rm(path.join(directory, entry.name), { recursive: true, force: true })));
}

export function mutate(fn, { allowContextRecordDeletion = false } = {}) {
  if (V22_COMPATIBILITY) return stateV22Compatibility.mutate(fn, { allowContextRecordDeletion });
  return enqueueMutation(async () => {
    const snapshot = await refreshStateSnapshot(),
      base = snapshot.state,
      expectedRevision = snapshot.revision,
      state = createDraft(base),
      immutableBefore = immutableCollections(base);
    let result, resultSnapshot;
    try {
      result = await fn(state);
      resultSnapshot = snapshotMutationResult(result);
    } catch (error) {
      finishDraft(state);
      throw error;
    }
    let patches = [];
    const candidate = finishDraft(state, (generated) => {
      patches = generated;
    });
    if (!patches.length) return resultSnapshot;
    const touched = new Set(patches.map((patch) => String(patch.path[0])));
    assertMutationInvariants(immutableBefore, candidate, touched, allowContextRecordDeletion);
    const sourceChanged = [...touched].some(
      (collection) => collections.includes(collection) && !CONTEXT_INTERNAL_COLLECTIONS.includes(collection)
    );
    const contextChanged =
      sourceChanged || [...touched].some((collection) => CONTEXT_INTERNAL_COLLECTIONS.includes(collection));
    const [next] = produceWithPatches(candidate, (draft) => {
      normalizeStateForPersistence(draft);
      if (sourceChanged) reconcileContextProjectionState(draft, { sourceCollections: collections, timestamp: now() });
      if (contextChanged) pruneExpiredContextVersions(draft);
      markQualityReviewRunsStale(draft, now());
    });
    validateState23(next);
    const persistence = await buildStateChanges(base, next);
    if (!hasPersistenceChanges(persistence.changes)) return resultSnapshot;
    const committed = await applyStateChanges({ expectedRevision, ...persistence.changes });
    installStateSnapshot(persistence.state, committed.revision);
    return resultSnapshot;
  });
}

function immutableCollections(base) {
  return {
    context_document_versions: base.context_document_versions || [],
    context_selections: base.context_selections || [],
    outcome_requirements: base.outcome_requirements || [],
    outcome_evaluations: base.outcome_evaluations || [],
    outcome_waivers: base.outcome_waivers || [],
    execution_stage_checkpoints: base.execution_stage_checkpoints || [],
    human_reviews: base.human_reviews || [],
    quality_review_runs: base.quality_review_runs || [],
    quality_review_reports: base.quality_review_reports || [],
    quality_review_events: base.quality_review_events || []
  };
}

function assertMutationInvariants(before, candidate, touched, allowContextRecordDeletion) {
  if (touched.has('context_document_versions') || touched.has('context_selections'))
    assertContextImmutability(before, candidate, { allowDeletion: allowContextRecordDeletion });
  if (V21_OUTCOME_COLLECTIONS.some((collection) => touched.has(collection))) assertV21AppendOnly(before, candidate);
  if (touched.has('quality_review_reports') || touched.has('quality_review_events'))
    assertQualityReviewAppendOnly(before, candidate);
  if (touched.has('human_reviews')) assertQualityReviewHumanReviewAppendOnly(before, candidate);
  assertQualityReviewRunSnapshotImmutability(before, candidate);
}

function hasPersistenceChanges(changes) {
  return Boolean(changes.collections.length || changes.meta.length || changes.metaDeletes.length);
}

function pruneExpiredContextVersions(state) {
  const retained = collectContextVersions(state),
    changed = retained.length !== (state.context_document_versions || []).length;
  if (changed) state.context_document_versions = retained;
  return changed;
}

export function stateRevision() {
  if (V22_COMPATIBILITY) return stateV22Compatibility.stateRevision();
  return Number(stateSnapshotCache?.revision || 0);
}

export function subscribeStateRevision(listener) {
  if (V22_COMPATIBILITY) return stateV22Compatibility.subscribeStateRevision(listener);
  if (typeof listener !== 'function') throw new TypeError('state_revision_listener_required');
  revisionSubscribers.add(listener);
  return () => revisionSubscribers.delete(listener);
}

export function waitForStateMutations() {
  if (V22_COMPATIBILITY) return stateV22Compatibility.waitForStateMutations();
  return mutationQueue;
}

export async function statePersistenceStatus() {
  if (V22_COMPATIBILITY) return stateV22Compatibility.statePersistenceStatus();
  return { ...(await stateStoreHealth()), ...stateStoreRuntimeStatus(), database_file: STATE_DB_FILE };
}

export async function checkpointAndCloseState() {
  if (V22_COMPATIBILITY) return stateV22Compatibility.checkpointAndCloseState();
  await waitForStateMutations();
  await checkpointStateStore();
  await closeStateStore();
}

function enqueueMutation(operation) {
  const queued = mutationQueue.then(operation);
  mutationQueue = queued.catch(() => undefined);
  return queued;
}

async function persistStateReplacement(input) {
  if (!stateSnapshotCache) throw stateFailure('state_store_not_initialized');
  const state = structuredClone(input);
  normalizeStateForPersistence(state);
  validateState23(state);
  assertQualityReviewAppendOnly(stateSnapshotCache.state, state);
  assertQualityReviewHumanReviewAppendOnly(stateSnapshotCache.state, state);
  assertQualityReviewRunSnapshotImmutability(stateSnapshotCache.state, state);
  const sanitized = JSON.parse(await redactKnownSecrets(JSON.stringify(state)));
  validateState23(sanitized);
  assertQualityReviewAppendOnly(stateSnapshotCache.state, sanitized);
  assertQualityReviewHumanReviewAppendOnly(stateSnapshotCache.state, sanitized);
  assertQualityReviewRunSnapshotImmutability(stateSnapshotCache.state, sanitized);
  if (canonicalJsonHash(sanitized) === canonicalJsonHash(stateSnapshotCache.state)) return;
  const committed = await replaceStoredState({ expectedRevision: stateSnapshotCache.revision, state: sanitized });
  installStateSnapshot(sanitized, committed.revision);
}

function normalizeStateForPersistence(state) {
  normalizeState18Compatibility(state, collections);
  ensureProjectGovernanceDefaults(state);
  ensureRepositoryLifecycleDefaults(state);
  ensureExchangeDefaults(state);
  normalizeState23Defaults(state);
  markQualityReviewRunsStale(state, now());
}

function snapshotMutationResult(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

function installStateSnapshot(state, revision) {
  const frozen = freeze(state, true);
  stateSnapshotCache = { state: frozen, revision: Number(revision) };
  for (const listener of revisionSubscribers)
    queueMicrotask(() => {
      try {
        listener({ revision: Number(revision), state: frozen });
      } catch (error) {
        console.error('state revision subscriber failed', error?.code || error?.message || error);
      }
    });
}

function stateFailure(code, details = {}, cause = null) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  error.details = details;
  return error;
}

export function owner(state) {
  const actorId = currentActorId();
  return (
    state.users.find((user) => user.id === actorId) ||
    state.users.find((user) => user.id === state.instance_owner_user_id) ||
    state.users.find((user) => user.role === 'owner') ||
    state.users[0]
  );
}

export function actor(state, { required = true } = {}) {
  const actorId = currentActorId(),
    value = state.users.find((user) => user.id === actorId) || null;
  if (!value && required) throw new Error('authenticated_actor_required');
  return value;
}

export function addTrace(state, event, payload = {}, actorId = null) {
  const trace = makeTrace(event, payload, { type: actorId ? 'user' : 'system', id: actorId });
  state.traces.push(trace);
  return trace;
}

export async function saveArtifact(kind, name, content, meta = {}) {
  const dir = path.join(ARTIFACT_DIR, String(kind || 'artifact').replace(/[^\w-]/g, '_'));
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}_${String(name || 'artifact')
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .slice(0, 80)}`;
  const full = path.join(dir, fileName),
    serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await fsp.writeFile(full, await redactKnownSecrets(serialized), 'utf8');
  const bytes = await fsp.readFile(full);
  return {
    id: id('fil'),
    kind,
    absolute_path: full,
    relative_path: path.relative(path.dirname(DATA_DIR), full),
    sha256: hashString(bytes),
    size_bytes: bytes.length,
    content_type: fileName.endsWith('.json')
      ? 'application/json'
      : fileName.endsWith('.md')
        ? 'text/markdown'
        : 'text/plain',
    meta,
    created_at: now()
  };
}
