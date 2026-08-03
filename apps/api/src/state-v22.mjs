import { cloneStateValue as structuredClone } from './state-clone.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createDraft, enablePatches, finishDraft, freeze, produceWithPatches, setAutoFreeze } from 'immer';
import {
  createLocalOwner,
  defaultCodexProfiles,
  defaultTools,
  id,
  makeTrace,
  now
} from '../../../packages/shared/index.mjs';
import {
  ASSIST_DIR,
  ARTIFACT_DIR,
  ATTACHMENT_DIR,
  ATTACHMENT_TEMP_DIR,
  CAS_DIR,
  CODEX_HOME_DIR,
  CONTEXT_INDEX_DIR,
  DATA_DIR,
  EXECUTION_DIR,
  EXPORT_DIR,
  PROBE_DIR,
  STAGING_DIR,
  STATE_DB_FILE,
  TRASH_DIR,
  VAULT_DIR,
  WORKTREE_DIR,
  WORKSPACE_DIR,
  collections
} from './config-v22.mjs';
import { redactKnownSecrets } from './vault.mjs';
import { ensureExchangeDefaults, expireExchangeRequestsInState } from './exchange-v19.mjs';
import {
  ensureRepositoryLifecycleDefaults,
  expireRepositoryDeletionIntentsInState
} from './repository-lifecycle-v19.mjs';
import { normalizeState18Compatibility } from './state-compatibility.mjs';
import { promoteLegacyExecutionHistoryInState } from './legacy-execution-promotion.mjs';
import {
  normalizeOutcomeEvidenceRelationsV20,
  normalizeTaskHandoffDefaultsV20,
  V21_OUTCOME_COLLECTIONS
} from './state-migration-v21-compat.mjs';
import {
  assertV21AppendOnly,
  canonicalJsonHash,
  normalizeOfficialRunnerImagesV22,
  normalizeState22Defaults,
  STATE_SCHEMA_VERSION,
  validateState22
} from './state-migration-v22-compat.mjs';
import {
  commitState22Sentinel,
  prepareStateStoreInitialization,
  recoverManagedStateTemp
} from './state-runtime-v22.mjs';
import {
  assertContextImmutability,
  CONTEXT_INTERNAL_COLLECTIONS,
  reconcileContextProjectionState
} from '../../../packages/system-context/src/index.mjs';
import { collectContextVersions, materializeContextDocumentsInState } from './context-projection.mjs';
import { ensureProjectGovernanceDefaults } from './project-governance-v19.mjs';
import {
  normalizeRuntimeCollections,
  ensureRuntimeDefaults,
  normalizeRuntimeGovernance,
  normalizeRuntimeProjects,
  normalizeRuntimeDraftsAndProposals,
  recoverInterruptedRuntimeWork,
  normalizeLegacyRuntimeRecords,
  normalizeCodexProfileRecords,
  refreshValidatedCodexProfiles
} from './state-v22-runtime-normalizers.mjs';
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
import { buildStateChanges } from './state-change-builder-v22.mjs';
import { saveArtifact } from './state-v22-artifacts.mjs';
import { actor, addTrace, owner } from './state-v22-actors.mjs';

enablePatches();
setAutoFreeze(true);

let lastMigration = null;

export async function ensureRuntime() {
  await ensureRuntimeDirectories();
  await recoverManagedStateTemp();
  const prepared = await prepareStateStoreInitialization(bootstrapState);
  const initialized = await initializeStateStore({
    databasePath: STATE_DB_FILE,
    collections,
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
  validateState22(initialized.state);
  stateSnapshotCache = { revision: initialized.revision, state: freeze(initialized.state, true) };
  lastMigration = prepared.migration;
  if (!prepared.sentinel) lastMigration = await commitState22Sentinel(prepared, initialized);
  const state = await readState();
  if (state.schema_version !== STATE_SCHEMA_VERSION)
    throw new Error(`unsupported_state_schema_${state.schema_version}`);
  const changes = await normalizeAndPersistRuntime(state);
  await reconcileAndPersistRuntime(state, changes);
}

async function normalizeAndPersistRuntime(state) {
  const changes = { value: false };
  normalizeRuntimeCollections(state, changes);
  if (normalizeOfficialRunnerImagesV22(state, { timestamp: now() }).changed) changes.value = true;
  if (normalizeOutcomeEvidenceRelationsV20(state).changed) changes.value = true;
  if (normalizeTaskHandoffDefaultsV20(state).changed) changes.value = true;
  ensureRuntimeDefaults(state, changes);
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
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  await fsp.mkdir(CAS_DIR, { recursive: true });
  await fsp.mkdir(EXECUTION_DIR, { recursive: true });
  await fsp.mkdir(VAULT_DIR, { recursive: true });
  await fsp.mkdir(CODEX_HOME_DIR, { recursive: true });
  await fsp.mkdir(CONTEXT_INDEX_DIR, { recursive: true, mode: 0o700 });
  await Promise.all(
    [
      WORKSPACE_DIR,
      STAGING_DIR,
      TRASH_DIR,
      EXPORT_DIR,
      WORKTREE_DIR,
      PROBE_DIR,
      ASSIST_DIR,
      ATTACHMENT_DIR,
      ATTACHMENT_TEMP_DIR
    ].map((dir) => fsp.mkdir(dir, { recursive: true, mode: 0o700 }))
  );
  await Promise.all([STAGING_DIR, ATTACHMENT_TEMP_DIR].map(clearEphemeralDirectory));
}

export function emptyState() {
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
  await refreshStateSnapshot();
  return structuredClone(stateSnapshotCache.state);
}

async function refreshStateSnapshot() {
  if (!stateSnapshotCache) throw stateFailure('state_store_not_initialized');
  const persisted = await readStoredStateRevision();
  if (persisted.revision !== stateSnapshotCache.revision) {
    const refreshed = await readStoredState();
    validateState22(refreshed.state);
    installStateSnapshot(refreshed.state, refreshed.revision);
  }
  return stateSnapshotCache;
}

let stateSnapshotCache = null;
let mutationQueue = Promise.resolve();
const revisionSubscribers = new Set();

export async function readStateSnapshot({ refresh = false } = {}) {
  if (refresh) await refreshStateSnapshot();
  if (!stateSnapshotCache) throw stateFailure('state_store_not_initialized');
  return stateSnapshotCache.state;
}

export async function writeState(state) {
  return enqueueMutation(() => persistStateReplacement(state));
}

export function lastStateMigration() {
  return lastMigration ? { ...lastMigration, state: undefined } : null;
}

async function clearEphemeralDirectory(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map((entry) => fsp.rm(path.join(directory, entry.name), { recursive: true, force: true })));
}

export function mutate(fn, { allowContextRecordDeletion = false } = {}) {
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
    });
    validateState22(next);
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
    execution_stage_checkpoints: base.execution_stage_checkpoints || []
  };
}

function assertMutationInvariants(before, candidate, touched, allowContextRecordDeletion) {
  if (touched.has('context_document_versions') || touched.has('context_selections'))
    assertContextImmutability(before, candidate, { allowDeletion: allowContextRecordDeletion });
  if (V21_OUTCOME_COLLECTIONS.some((collection) => touched.has(collection))) assertV21AppendOnly(before, candidate);
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
  return Number(stateSnapshotCache?.revision || 0);
}

export function subscribeStateRevision(listener) {
  if (typeof listener !== 'function') throw new TypeError('state_revision_listener_required');
  revisionSubscribers.add(listener);
  return () => revisionSubscribers.delete(listener);
}

export function waitForStateMutations() {
  return mutationQueue;
}

export async function statePersistenceStatus() {
  return { ...(await stateStoreHealth()), ...stateStoreRuntimeStatus(), database_file: STATE_DB_FILE };
}

export async function checkpointAndCloseState() {
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
  validateState22(state);
  const sanitized = JSON.parse(await redactKnownSecrets(JSON.stringify(state)));
  validateState22(sanitized);
  if (canonicalJsonHash(sanitized) === canonicalJsonHash(stateSnapshotCache.state)) return;
  const committed = await replaceStoredState({ expectedRevision: stateSnapshotCache.revision, state: sanitized });
  installStateSnapshot(sanitized, committed.revision);
}

function normalizeStateForPersistence(state) {
  normalizeState18Compatibility(state, collections);
  ensureProjectGovernanceDefaults(state);
  ensureRepositoryLifecycleDefaults(state);
  ensureExchangeDefaults(state);
  normalizeState22Defaults(state);
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

export { actor, addTrace, owner, saveArtifact };
