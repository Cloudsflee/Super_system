import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
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
  STAGING_DIR,
  STATE_FILE,
  TRASH_DIR,
  VAULT_DIR,
  WORKSPACE_DIR,
  WORKTREE_DIR,
  collections
} from './config.mjs';
import { redactKnownSecrets } from './vault.mjs';
import {
  codexAuthMatchesProfile,
  isThirdPartyProvider,
  isValidCodexTimeoutMs,
  normalizeProviderBaseUrl,
  resolveCodexTimeoutMs,
  writeProfileConfig
} from './codex-service.mjs';
import {
  migrateStateFileToV20,
  normalizeOfficialRunnerImagesV20,
  normalizeOutcomeEvidenceRelationsV20,
  normalizeState20Defaults,
  STATE_SCHEMA_VERSION,
  validateState20
} from './state-migration-v20.mjs';
import {
  assertContextImmutability,
  reconcileContextProjectionState
} from '../../../packages/system-context/src/index.mjs';
import { collectContextVersions, materializeContextDocumentsInState } from './context-projection.mjs';
import { normalizeState18Compatibility } from './state-compatibility.mjs';
import { currentActorId } from './actor-context.mjs';
import { ensureProjectGovernanceDefaults, expireProjectInvitationsInState } from './project-governance-v19.mjs';
import {
  ensureRepositoryLifecycleDefaults,
  expireRepositoryDeletionIntentsInState
} from './repository-lifecycle-v19.mjs';
import { ensureExchangeDefaults, expireExchangeRequestsInState } from './exchange-v19.mjs';
import { recoverInterruptedRepositoryDeletionsInState } from './repository-deletion-recovery.mjs';
import { recoverInvalidDeliveryPullRequestClaimsInState } from './delivery-recovery.mjs';
import { recoverPullRequestIntentsInState } from './pull-request-intent-domain.mjs';
import { promoteLegacyExecutionHistoryInState } from './legacy-execution-promotion.mjs';
let lastMigration = null;
const STATE_FILE_REPLACE_RETRIES = 100;
export async function ensureRuntime() {
  await ensureRuntimeDirectories();
  if (!fs.existsSync(STATE_FILE)) {
    const state = bootstrapState();
    normalizeState20Defaults(state, now());
    await materializeContextDocumentsInState(state);
    return writeState(state);
  }
  lastMigration = await migrateStateFileToV20(STATE_FILE);
  const state = await readState();
  if (state.schema_version !== STATE_SCHEMA_VERSION)
    throw new Error(`unsupported_state_schema_${state.schema_version}`);

  const changes = { value: false };
  normalizeRuntimeCollections(state, changes);
  if (normalizeOfficialRunnerImagesV20(state, { timestamp: now() }).changed) changes.value = true;
  if (normalizeOutcomeEvidenceRelationsV20(state).changed) changes.value = true;
  ensureRuntimeDefaults(state, changes);
  normalizeRuntimeGovernance(state, changes);
  normalizeRuntimeProjects(state, changes);
  normalizeRuntimeDraftsAndProposals(state, changes);
  recoverInterruptedRuntimeWork(state, changes);
  normalizeLegacyRuntimeRecords(state, changes);
  normalizeCodexProfileRecords(state, changes);
  await refreshValidatedCodexProfiles(state, changes);
  removeRetiredRuntimeRecords(state, changes);
  if ((await promoteLegacyExecutionHistoryInState(state)).changed) changes.value = true;
  const reconciled = reconcileContextProjectionState(state, { sourceCollections: collections, timestamp: now() });
  if (reconciled.dirty) changes.value = true;
  const projection = await materializeContextDocumentsInState(state);
  if (projection.materialized || projection.reused || projection.failed) changes.value = true;
  if (pruneExpiredContextVersions(state)) changes.value = true;

  const serialized = JSON.stringify(state, null, 2);
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

function normalizeRuntimeCollections(state, changes) {
  for (const key of collections)
    if (!Array.isArray(state[key])) {
      state[key] = [];
      changes.value = true;
    }
}

function ensureRuntimeDefaults(state, changes) {
  if (!state.users.length) {
    const { user, session } = createLocalOwner();
    state.users.push(user);
    state.sessions.push(session);
    changes.value = true;
  }
  if (!state.tools.length) {
    state.tools.push(...defaultTools(state.users[0].id));
    changes.value = true;
  }
  if (!state.codex_profiles.length) {
    state.codex_profiles.push(...defaultCodexProfiles(state.users[0]?.id));
    changes.value = true;
  }
}

function normalizeRuntimeGovernance(state, changes) {
  const governanceBefore = governanceFingerprint(state);
  ensureProjectGovernanceDefaults(state);
  if (expireProjectInvitationsInState(state)) changes.value = true;
  if (governanceBefore !== governanceFingerprint(state)) changes.value = true;
  const lifecycleBefore = lifecycleFingerprint(state);
  ensureRepositoryLifecycleDefaults(state);
  ensureExchangeDefaults(state);
  if (recoverInterruptedRepositoryDeletionsInState(state)) changes.value = true;
  if (expireRepositoryDeletionIntentsInState(state) || expireExchangeRequestsInState(state)) changes.value = true;
  if (lifecycleBefore !== lifecycleFingerprint(state)) changes.value = true;
  const deliveryRecovery = recoverInvalidDeliveryPullRequestClaimsInState(state);
  if (deliveryRecovery.changed) {
    changes.value = true;
    for (const deliveryId of deliveryRecovery.delivery_ids)
      addTrace(state, 'integration.synced', {
        target_type: 'delivery',
        target_id: deliveryId,
        summary: 'Removed an invalid webhook PR claim from a failed Delivery.'
      });
  }
  if (recoverPullRequestIntentsInState(state)) changes.value = true;
}

function normalizeRuntimeProjects(state, changes) {
  for (const project of state.projects) {
    if (!project.status) {
      project.status = 'active';
      changes.value = true;
    }
    project.settings ||= {};
    if (!Number.isFinite(Number(project.settings.token_budget))) {
      project.settings.token_budget = 12000;
      changes.value = true;
    }
    if (!['codex', 'codex_docker'].includes(project.settings.preferred_runner)) {
      project.settings.preferred_runner = 'codex_docker';
      changes.value = true;
    }
    if (!Array.isArray(project.settings.workspace_root_whitelist)) {
      project.settings.workspace_root_whitelist = [project.repo_path || project.workspace_root].filter(Boolean);
      changes.value = true;
    }
    if (!project.onboarding_state) {
      project.onboarding_state = project.status === 'draft' ? 'intake' : 'confirmed';
      changes.value = true;
    }
    if (project.source_metadata === undefined) {
      project.source_metadata = null;
      changes.value = true;
    }
    if (project.github_account_id === undefined) {
      project.github_account_id = null;
      changes.value = true;
    }
    if (!project.managed_workspace_state) {
      const managed = isWithin(WORKSPACE_DIR, project.repo_path || project.workspace_root || '');
      project.managed_workspace_state = managed
        ? 'ready'
        : project.repo_path || project.workspace_root
          ? 'workspace_migration_required'
          : 'empty';
      changes.value = true;
    }
    if (project.deleted_at === undefined) {
      project.deleted_at = null;
      changes.value = true;
    }
    if (project.lifecycle_operation === undefined) {
      project.lifecycle_operation = null;
      changes.value = true;
    }
    if (project.trash_metadata === undefined) {
      project.trash_metadata = project.trash_path
        ? {
            path: project.trash_path,
            status_before_trash: project.status_before_trash || 'active',
            trashed_at: project.deleted_at
          }
        : null;
      changes.value = true;
    }
  }
}

function normalizeRuntimeDraftsAndProposals(state, changes) {
  for (const draft of state.workflow_drafts) {
    if (!draft.status) {
      draft.status = draft.workflow_id || draft.activated_at ? 'activated' : 'draft';
      changes.value = true;
    }
    if (draft.user_modified_at === undefined) {
      draft.user_modified_at = Number(draft.revision || 1) > 1 ? draft.updated_at || now() : null;
      changes.value = true;
    }
  }
  for (const proposal of state.change_proposals) {
    if (!Number.isInteger(proposal.revision) || proposal.revision < 1) {
      proposal.revision = 1;
      changes.value = true;
    }
    if (!proposal.attention_state) {
      proposal.attention_state = proposal.status === 'pending' ? 'queued' : 'resolved';
      changes.value = true;
    }
    if (!proposal.target_hash) {
      proposal.target_hash = hashString(JSON.stringify(proposal.before_json ?? null));
      changes.value = true;
    }
  }
}

function recoverInterruptedRuntimeWork(state, changes) {
  for (const session of state.terminal_sessions.filter((item) =>
    ['starting', 'running', 'connected'].includes(item.status)
  )) {
    Object.assign(session, { status: 'interrupted', interrupted_reason: 'service_restarted', updated_at: now() });
    changes.value = true;
  }
  for (const run of state.node_runs.filter((item) => ['queued', 'running'].includes(item.status))) {
    Object.assign(run, {
      status: 'failed',
      error_code: 'service_restarted',
      summary: run.summary || 'NodeRun interrupted by service restart.',
      completed_at: now(),
      updated_at: now()
    });
    const node = state.workflow_nodes.find((item) => item.id === run.node_id);
    if (node) Object.assign(node, { status: 'blocked', updated_at: now() });
    changes.value = true;
  }
  for (const job of state.import_jobs.filter((item) =>
    ['queued', 'starting', 'running', 'processing', 'staging', 'stopping'].includes(item.status)
  )) {
    Object.assign(job, { status: 'failed', error_code: 'service_restarted', updated_at: now() });
    changes.value = true;
  }
  for (const generation of state.workflow_generations.filter((item) => ['queued', 'running'].includes(item.status))) {
    Object.assign(generation, {
      status: 'failed',
      phase: 'failed',
      error_code: 'service_restarted',
      retryable: true,
      completed_at: now(),
      updated_at: now()
    });
    changes.value = true;
    const draft = state.workflow_drafts.find(
      (item) => item.id === generation.draft_id && item.generation_id === generation.id
    );
    if (draft) {
      draft.generation_status = 'failed';
      draft.updated_at = now();
    }
  }
  for (const delivery of state.deliveries.filter((item) => ['queued', 'running'].includes(item.status))) {
    Object.assign(delivery, {
      status: 'failed',
      phase: 'failed',
      error_code: 'service_restarted',
      retryable: true,
      completed_at: now(),
      updated_at: now()
    });
    changes.value = true;
    const target = state.repository_targets.find((item) => item.id === delivery.repository_target_id);
    if (target) target.status = 'ready';
  }
  for (const session of state.assist_sessions.filter((item) => item.version !== 3 && item.status === 'running')) {
    Object.assign(session, { status: 'failed', error: 'service_restarted', updated_at: now() });
    changes.value = true;
  }
  for (const input of state.runtime_user_inputs.filter((item) => item.status === 'pending')) {
    Object.assign(input, {
      status: 'cancelled',
      cancelled_reason: 'service_restarted',
      cancelled_at: now(),
      updated_at: now()
    });
    changes.value = true;
    const turn = state.assist_turns.find((item) => item.id === input.turn_id);
    if (turn && ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(turn.status)) {
      Object.assign(turn, {
        status: 'interrupted',
        error_code: 'service_restarted',
        completed_at: now(),
        updated_at: now()
      });
    }
  }
}

function normalizeLegacyRuntimeRecords(state, changes) {
  const legacyWorkflowSuffix = ['V1', '闭环工作流'].join(' ');
  for (const workflow of state.workflows)
    if (workflow.generated_by === 'system' && workflow.title?.includes(legacyWorkflowSuffix)) {
      workflow.title = workflow.title.replace(legacyWorkflowSuffix, '工作流');
      changes.value = true;
    }
  const retiredProfileKind = ['m', 'o', 'c', 'k'].join('');
  const productionProfiles = state.codex_profiles.filter(
    (item) => item.kind !== retiredProfileKind && item.kind !== 'cc_switch'
  );
  if (productionProfiles.length !== state.codex_profiles.length) {
    state.codex_profiles = productionProfiles;
    changes.value = true;
  }
  if (!state.codex_profiles.length) {
    state.codex_profiles.push(...defaultCodexProfiles(state.users[0]?.id));
    changes.value = true;
  }
  const ccSwitch = state.integration_statuses.find((item) => item.key === 'cc_switch');
  if (
    ccSwitch &&
    (!ccSwitch.bridge?.ready ||
      ccSwitch.bridge?.conformance?.ok !== true ||
      Number(ccSwitch.bridge?.revision || 0) < 2 ||
      !ccSwitch.sources?.find((item) => item.name === 'cc-switch-cli')?.commit)
  ) {
    Object.assign(ccSwitch, {
      status: 'not_synced',
      bridge: {
        ...(ccSwitch.bridge || {}),
        ready: false,
        revision: Number(ccSwitch.bridge?.revision || 0),
        reason: 'bridge_resync_required'
      },
      updated_at: now()
    });
    changes.value = true;
  }
}

function normalizeCodexProfileRecords(state, changes) {
  for (const profile of state.codex_profiles) {
    const before = JSON.stringify(profile);
    if (!isValidCodexTimeoutMs(profile.timeout_ms) || profile.timeout_ms == null)
      profile.timeout_ms = resolveCodexTimeoutMs(profile.timeout_ms);
    const usedMcpNames = new Set();
    for (const server of Array.isArray(profile.mcp_servers) ? profile.mcp_servers : []) {
      let name = String(server.name || 'external');
      if (name === 'aiws-built-in') name = 'aiws-built-in-external';
      let candidate = name,
        suffix = 2;
      while (usedMcpNames.has(candidate)) candidate = `${name}-${suffix++}`;
      server.name = candidate;
      usedMcpNames.add(candidate);
    }
    if (!profile.base_url) profile.base_url = profile.api_url || profile.provider_url || null;
    if (profile.base_url) profile.base_url = normalizeProviderBaseUrl(profile.base_url) || profile.base_url;
    profile.wire_api ||= 'responses';
    if (typeof profile.requires_openai_auth !== 'boolean') profile.requires_openai_auth = false;
    profile.cc_switch_mode ||= 'native';
    if (profile.cc_switch_mode !== 'managed')
      Object.assign(profile, {
        cc_switch_required: false,
        cc_switch_status: 'not_required',
        cc_switch_provider_id: null,
        cc_switch_synced_at: null,
        cc_switch_bridge_revision: null,
        cc_switch_source_commit: null
      });
    if (
      isThirdPartyProvider(profile.provider) &&
      !normalizeProviderBaseUrl(profile.base_url) &&
      profile.status === 'validated'
    )
      profile.status = 'configuration_required';
    if (JSON.stringify(profile) !== before) {
      profile.updated_at = now();
      changes.value = true;
    }
  }
}

async function refreshValidatedCodexProfiles(state, changes) {
  const codexAuth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  const activeProfile =
    state.codex_profiles.find((item) => item.is_active) ||
    state.codex_profiles.find((item) => item.status === 'validated');
  const activeProfileInvalid =
    activeProfile &&
    (activeProfile.status !== 'validated' ||
      !codexAuthMatchesProfile(codexAuth, activeProfile) ||
      (isThirdPartyProvider(activeProfile.provider) && !normalizeProviderBaseUrl(activeProfile.base_url)));
  if (activeProfileInvalid)
    for (const setup of state.setup_states.filter((item) => item.completed_at)) {
      setup.completed_at = null;
      setup.updated_at = now();
      changes.value = true;
    }
  for (const profile of state.codex_profiles.filter(
    (item) =>
      item.status === 'validated' &&
      item.model &&
      (!isThirdPartyProvider(item.provider) || normalizeProviderBaseUrl(item.base_url))
  )) {
    const generated = await writeProfileConfig(profile, codexAuth?.home);
    if (profile.codex_home !== generated.codex_home || profile.config_file !== generated.config_file) {
      Object.assign(profile, generated);
      changes.value = true;
    }
  }
}

function removeRetiredRuntimeRecords(state, changes) {
  const retiredToolName = [['m', 'o', 'c', 'k'].join(''), 'runner'].join('_');
  const productionTools = state.tools.filter((item) => item.name !== retiredToolName);
  if (productionTools.length !== state.tools.length) {
    state.tools = productionTools;
    changes.value = true;
  }
  for (const contract of state.node_contracts) {
    if (!Array.isArray(contract.allowed_tools)) continue;
    const allowed = contract.allowed_tools.filter((item) => item !== retiredToolName);
    if (allowed.length !== contract.allowed_tools.length) {
      contract.allowed_tools = allowed;
      contract.updated_at = now();
      changes.value = true;
    }
  }
  const retiredRunner = ['m', 'o', 'c', 'k'].join('');
  for (const run of state.node_runs)
    if (run.runner === retiredRunner) {
      run.legacy_runner = retiredRunner;
      run.runner = 'legacy_retired_adapter';
      run.legacy_read_only = true;
      changes.value = true;
    }
}
export function emptyState() {
  return Object.fromEntries(collections.map((key) => [key, []]));
}
function bootstrapState() {
  const state = emptyState();
  state.schema_version = STATE_SCHEMA_VERSION;
  const { user, session } = createLocalOwner();
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
  return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
}
export async function writeState(state) {
  normalizeState18Compatibility(state, collections);
  ensureProjectGovernanceDefaults(state);
  ensureRepositoryLifecycleDefaults(state);
  ensureExchangeDefaults(state);
  normalizeState20Defaults(state);
  validateState20(state);
  const tmp = `${STATE_FILE}.tmp`;
  const serialized = await redactKnownSecrets(JSON.stringify(state, null, 2));
  const handle = await fsp.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceStateFile(tmp, STATE_FILE);
}
export function lastStateMigration() {
  return lastMigration ? { ...lastMigration, state: undefined } : null;
}
async function clearEphemeralDirectory(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map((entry) => fsp.rm(path.join(directory, entry.name), { recursive: true, force: true })));
}
let mutationQueue = Promise.resolve();
export function mutate(fn, { allowContextRecordDeletion = false } = {}) {
  const operation = mutationQueue.then(async () => {
    const state = await readState();
    const immutableBefore = {
      context_document_versions: structuredClone(state.context_document_versions || []),
      context_selections: structuredClone(state.context_selections || [])
    };
    const result = await fn(state);
    assertContextImmutability(immutableBefore, state, { allowDeletion: allowContextRecordDeletion });
    reconcileContextProjectionState(state, { sourceCollections: collections, timestamp: now() });
    pruneExpiredContextVersions(state);
    await writeState(state);
    return result;
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

function pruneExpiredContextVersions(state) {
  const retained = collectContextVersions(state),
    changed = retained.length !== (state.context_document_versions || []).length;
  if (changed) state.context_document_versions = retained;
  return changed;
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
  const actorId = currentActorId();
  const value = state.users.find((user) => user.id === actorId) || null;
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
  const full = path.join(dir, fileName);
  const serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
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

function isWithin(root, candidate) {
  if (!candidate) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function governanceFingerprint(state) {
  return JSON.stringify({
    instance_owner_user_id: state.instance_owner_user_id || null,
    memberships: (state.project_memberships || []).map((item) => [
      item.id,
      item.project_id,
      item.user_id,
      item.role,
      item.status
    ]),
    project_owners: (state.projects || []).map((item) => [item.id, item.owner_user_id || null])
  });
}

function lifecycleFingerprint(state) {
  return JSON.stringify({
    canonical: (state.canonical_repositories || []).map((item) => [item.id, item.repository_id, item.remote_state]),
    bindings: (state.project_repository_bindings || []).map((item) => [
      item.id,
      item.project_id,
      item.canonical_repository_id,
      item.status
    ]),
    intents: (state.repository_deletion_intents || []).map((item) => [item.id, item.status]),
    exchanges: (state.exchange_requests || []).map((item) => [item.id, item.status]),
    grants: (state.exchange_grants || []).map((item) => [item.id, item.status])
  });
}

async function replaceStateFile(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= STATE_FILE_REPLACE_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}
