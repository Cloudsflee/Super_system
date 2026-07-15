import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLocalOwner, defaultCodexProfiles, defaultTools, hashString, id, makeTrace, now } from '../../../packages/shared/index.mjs';
import { ARTIFACT_DIR, ASSIST_DIR, ATTACHMENT_DIR, ATTACHMENT_TEMP_DIR, CODEX_HOME_DIR, DATA_DIR, EXPORT_DIR, PROBE_DIR, STAGING_DIR, STATE_FILE, TRASH_DIR, VAULT_DIR, WORKSPACE_DIR, WORKTREE_DIR, collections } from './config.mjs';
import { redactKnownSecrets } from './vault.mjs';
import { codexAuthMatchesProfile, isThirdPartyProvider, normalizeProviderBaseUrl, writeProfileConfig } from './codex-service.mjs';
import { migrateStateFileToV16, normalizeOfficialRunnerImages, STATE_SCHEMA_VERSION, validateState16 } from './state-migration-v16.mjs';
import { legacyBriefToV2 } from './brief-workflow-domain.mjs';

let lastMigration = null;

export async function ensureRuntime() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  await fsp.mkdir(VAULT_DIR, { recursive: true });
  await fsp.mkdir(CODEX_HOME_DIR, { recursive: true });
  await Promise.all([WORKSPACE_DIR, STAGING_DIR, TRASH_DIR, EXPORT_DIR, WORKTREE_DIR, PROBE_DIR, ASSIST_DIR, ATTACHMENT_DIR, ATTACHMENT_TEMP_DIR].map((dir) => fsp.mkdir(dir, { recursive: true, mode: 0o700 })));
  await Promise.all([STAGING_DIR, ATTACHMENT_TEMP_DIR].map(clearEphemeralDirectory));
  if (!fs.existsSync(STATE_FILE)) return writeState(bootstrapState());
  lastMigration = await migrateStateFileToV16(STATE_FILE);
  const state = await readState();
  let changed = false;
  if (state.schema_version !== STATE_SCHEMA_VERSION) throw new Error(`unsupported_state_schema_${state.schema_version}`);
  for (const key of collections) if (!Array.isArray(state[key])) { state[key] = []; changed = true; }
  if (normalizeOfficialRunnerImages(state, { timestamp: now() }).changed) changed = true;
  if (!state.users.length) { const { user, session } = createLocalOwner(); state.users.push(user); state.sessions.push(session); changed = true; }
  if (!state.tools.length) { state.tools.push(...defaultTools(state.users[0].id)); changed = true; }
  if (!state.codex_profiles.length) { state.codex_profiles.push(...defaultCodexProfiles(state.users[0]?.id)); changed = true; }
  for (const project of state.projects) {
    if (!project.status) { project.status = 'active'; changed = true; }
    project.settings ||= {};
    if (!Number.isFinite(Number(project.settings.token_budget))) { project.settings.token_budget = 12000; changed = true; }
    if (!['codex', 'codex_docker'].includes(project.settings.preferred_runner)) { project.settings.preferred_runner = 'codex_docker'; changed = true; }
    if (!Array.isArray(project.settings.workspace_root_whitelist)) { project.settings.workspace_root_whitelist = [project.repo_path || project.workspace_root].filter(Boolean); changed = true; }
    if (!project.onboarding_state) { project.onboarding_state = project.status === 'draft' ? 'intake' : 'confirmed'; changed = true; }
    if (project.source_metadata === undefined) { project.source_metadata = null; changed = true; }
    if (project.github_account_id === undefined) { project.github_account_id = null; changed = true; }
    if (!project.managed_workspace_state) {
      const managed = isWithin(WORKSPACE_DIR, project.repo_path || project.workspace_root || '');
      project.managed_workspace_state = managed ? 'ready' : (project.repo_path || project.workspace_root ? 'workspace_migration_required' : 'empty');
      changed = true;
    }
    if (project.deleted_at === undefined) { project.deleted_at = null; changed = true; }
    if (project.lifecycle_operation === undefined) { project.lifecycle_operation = null; changed = true; }
    if (project.trash_metadata === undefined) {
      project.trash_metadata = project.trash_path ? { path: project.trash_path, status_before_trash: project.status_before_trash || 'active', trashed_at: project.deleted_at } : null;
      changed = true;
    }
  }
  for (const draft of state.workflow_drafts) {
    if (!draft.status) { draft.status = draft.workflow_id || draft.activated_at ? 'activated' : 'draft'; changed = true; }
    if (draft.user_modified_at === undefined) { draft.user_modified_at = Number(draft.revision || 1) > 1 ? draft.updated_at || now() : null; changed = true; }
  }
  for (const proposal of state.change_proposals) {
    if (!Number.isInteger(proposal.revision) || proposal.revision < 1) { proposal.revision = 1; changed = true; }
    if (!proposal.attention_state) { proposal.attention_state = proposal.status === 'pending' ? 'queued' : 'resolved'; changed = true; }
    if (!proposal.target_hash) { proposal.target_hash = hashString(JSON.stringify(proposal.before_json ?? null)); changed = true; }
  }
  for (const session of state.terminal_sessions.filter((item) => ['starting', 'running', 'connected'].includes(item.status))) {
    Object.assign(session, { status: 'interrupted', interrupted_reason: 'service_restarted', updated_at: now() }); changed = true;
  }
  for (const run of state.node_runs.filter((item) => ['queued', 'running'].includes(item.status))) {
    Object.assign(run, { status: 'failed', error_code: 'service_restarted', summary: run.summary || 'NodeRun interrupted by service restart.', completed_at: now(), updated_at: now() }); changed = true;
  }
  for (const job of state.import_jobs.filter((item) => ['queued', 'starting', 'running', 'processing', 'staging', 'stopping'].includes(item.status))) {
    Object.assign(job, { status: 'failed', error_code: 'service_restarted', updated_at: now() }); changed = true;
  }
  for (const session of state.assist_sessions.filter((item) => item.version !== 3 && item.status === 'running')) {
    Object.assign(session, { status: 'failed', error: 'service_restarted', updated_at: now() }); changed = true;
  }
  for (const input of state.runtime_user_inputs.filter((item) => item.status === 'pending')) {
    Object.assign(input, { status: 'cancelled', cancelled_reason: 'service_restarted', cancelled_at: now(), updated_at: now() }); changed = true;
    const turn = state.assist_turns.find((item) => item.id === input.turn_id);
    if (turn && ['preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping'].includes(turn.status)) {
      Object.assign(turn, { status: 'interrupted', error_code: 'service_restarted', completed_at: now(), updated_at: now() });
    }
  }
  const legacyWorkflowSuffix = ['V1', '闭环工作流'].join(' ');
  for (const workflow of state.workflows) if (workflow.generated_by === 'system' && workflow.title?.includes(legacyWorkflowSuffix)) { workflow.title = workflow.title.replace(legacyWorkflowSuffix, '工作流'); changed = true; }
  const retiredProfileKind = ['m', 'o', 'c', 'k'].join('');
  const productionProfiles = state.codex_profiles.filter((item) => item.kind !== retiredProfileKind && item.kind !== 'cc_switch');
  if (productionProfiles.length !== state.codex_profiles.length) { state.codex_profiles = productionProfiles; changed = true; }
  if (!state.codex_profiles.length) { state.codex_profiles.push(...defaultCodexProfiles(state.users[0]?.id)); changed = true; }
  const ccSwitch = state.integration_statuses.find((item) => item.key === 'cc_switch');
  if (ccSwitch && (!ccSwitch.bridge?.ready || ccSwitch.bridge?.conformance?.ok !== true || Number(ccSwitch.bridge?.revision || 0) < 2 || !ccSwitch.sources?.find((item) => item.name === 'cc-switch-cli')?.commit)) {
    Object.assign(ccSwitch, { status: 'not_synced', bridge: { ...(ccSwitch.bridge || {}), ready: false, revision: Number(ccSwitch.bridge?.revision || 0), reason: 'bridge_resync_required' }, updated_at: now() });
    changed = true;
  }
  for (const profile of state.codex_profiles) {
    const before = JSON.stringify(profile);
    if (!profile.base_url) profile.base_url = profile.api_url || profile.provider_url || null;
    if (profile.base_url) profile.base_url = normalizeProviderBaseUrl(profile.base_url) || profile.base_url;
    profile.wire_api ||= 'responses';
    if (typeof profile.requires_openai_auth !== 'boolean') profile.requires_openai_auth = false;
    profile.cc_switch_mode ||= 'native';
    if (profile.cc_switch_mode !== 'managed') Object.assign(profile, { cc_switch_required: false, cc_switch_status: 'not_required', cc_switch_provider_id: null, cc_switch_synced_at: null, cc_switch_bridge_revision: null, cc_switch_source_commit: null });
    if (isThirdPartyProvider(profile.provider) && !normalizeProviderBaseUrl(profile.base_url) && profile.status === 'validated') profile.status = 'configuration_required';
    if (JSON.stringify(profile) !== before) { profile.updated_at = now(); changed = true; }
  }
  const codexAuth = state.integration_statuses.find((item) => item.key === 'codex_auth');
  const activeProfile = state.codex_profiles.find((item) => item.is_active) || state.codex_profiles.find((item) => item.status === 'validated');
  const activeProfileInvalid = activeProfile && (activeProfile.status !== 'validated' || !codexAuthMatchesProfile(codexAuth, activeProfile) || (isThirdPartyProvider(activeProfile.provider) && !normalizeProviderBaseUrl(activeProfile.base_url)));
  if (activeProfileInvalid) for (const setup of state.setup_states.filter((item) => item.completed_at)) { setup.completed_at = null; setup.updated_at = now(); changed = true; }
  for (const profile of state.codex_profiles.filter((item) => item.status === 'validated' && item.model && (!isThirdPartyProvider(item.provider) || normalizeProviderBaseUrl(item.base_url)))) {
    const generated = await writeProfileConfig(profile, codexAuth?.home);
    if (profile.codex_home !== generated.codex_home || profile.config_file !== generated.config_file) { Object.assign(profile, generated); changed = true; }
  }
  const retiredToolName = [['m', 'o', 'c', 'k'].join(''), 'runner'].join('_');
  const productionTools = state.tools.filter((item) => item.name !== retiredToolName);
  if (productionTools.length !== state.tools.length) { state.tools = productionTools; changed = true; }
  for (const contract of state.node_contracts) {
    if (!Array.isArray(contract.allowed_tools)) continue;
    const allowed = contract.allowed_tools.filter((item) => item !== retiredToolName);
    if (allowed.length !== contract.allowed_tools.length) { contract.allowed_tools = allowed; contract.updated_at = now(); changed = true; }
  }
  const retiredRunner = ['m', 'o', 'c', 'k'].join('');
  for (const run of state.node_runs) if (run.runner === retiredRunner) { run.legacy_runner = retiredRunner; run.runner = 'legacy_retired_adapter'; run.legacy_read_only = true; changed = true; }
  const serialized = JSON.stringify(state, null, 2);
  if (changed || await redactKnownSecrets(serialized) !== serialized) await writeState(state);
}

export function emptyState() { return Object.fromEntries(collections.map((key) => [key, []])); }

function bootstrapState() {
  const state = emptyState();
  state.schema_version = STATE_SCHEMA_VERSION;
  const { user, session } = createLocalOwner();
  state.users.push(user);
  state.sessions.push(session);
  state.tools.push(...defaultTools(user.id));
  state.codex_profiles.push(...defaultCodexProfiles(user.id));
  state.traces.push(makeTrace('human.reviewed', { summary: '首次启动：创建 Local Owner Account。' }, { type: 'system', id: user.id }));
  return state;
}

export async function readState() { return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')); }

export async function writeState(state) {
  normalizeState16Compatibility(state);
  validateState16(state);
  const tmp = `${STATE_FILE}.tmp`;
  const serialized = await redactKnownSecrets(JSON.stringify(state, null, 2));
  const handle = await fsp.open(tmp, 'w', 0o600);
  try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await replaceStateFile(tmp, STATE_FILE);
}

function normalizeState16Compatibility(state) {
  for (const project of state.projects || []) if (project.lifecycle_operation === undefined) project.lifecycle_operation = null;
  for (const draft of state.workflow_drafts || []) {
    if (!draft.status) draft.status = draft.workflow_id || draft.activated_at ? 'activated' : 'draft';
    if (draft.user_modified_at === undefined) draft.user_modified_at = Number(draft.revision || 1) > 1 ? draft.updated_at || now() : null;
  }
  for (const session of state.assist_sessions || []) if (session.version === 3 && !['ask', 'auto_recommend'].includes(session.clarification_policy)) session.clarification_policy = 'ask';
  for (const brief of state.project_briefs || []) {
    if (brief.content?.schema_version !== 2) {
      const project = state.projects?.find((item) => item.id === brief.project_id);
      brief.content = legacyBriefToV2(brief.content || {}, { briefId: brief.id, title: `${project?.title || '项目'}简报` });
    }
    if (!Number.isInteger(brief.revision) || brief.revision < 1) brief.revision = Math.max(1, Number(brief.version) || 1);
  }
}

export function lastStateMigration() { return lastMigration ? { ...lastMigration, state: undefined } : null; }

async function clearEphemeralDirectory(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map((entry) => fsp.rm(path.join(directory, entry.name), { recursive: true, force: true })));
}

let mutationQueue = Promise.resolve();

export function mutate(fn) {
  const operation = mutationQueue.then(async () => {
    const state = await readState();
    const result = await fn(state);
    await writeState(state);
    return result;
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

export function owner(state) { return state.users.find((u) => u.role === 'owner') || state.users[0]; }

export function addTrace(state, event, payload = {}, actorId = null) {
  const trace = makeTrace(event, payload, { type: actorId ? 'user' : 'system', id: actorId });
  state.traces.push(trace);
  return trace;
}

export async function saveArtifact(kind, name, content, meta = {}) {
  const dir = path.join(ARTIFACT_DIR, String(kind || 'artifact').replace(/[^\w-]/g, '_'));
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}_${String(name || 'artifact').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80)}`;
  const full = path.join(dir, fileName);
  const serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await fsp.writeFile(full, await redactKnownSecrets(serialized), 'utf8');
  const bytes = await fsp.readFile(full);
  return {
    id: id('fil'), kind, absolute_path: full, relative_path: path.relative(path.dirname(DATA_DIR), full),
    sha256: hashString(bytes), size_bytes: bytes.length,
    content_type: fileName.endsWith('.json') ? 'application/json' : fileName.endsWith('.md') ? 'text/markdown' : 'text/plain',
    meta, created_at: now()
  };
}

function isWithin(root, candidate) {
  if (!candidate) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function replaceStateFile(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { await fsp.rename(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
    }
  }
}
