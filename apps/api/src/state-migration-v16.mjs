import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalStateHash, migrateState14To15, sha256, validateState15, V15_COLLECTIONS } from './state-migration-v15.mjs';
import { createWorkflowDraft, legacyBriefToV2 } from './brief-workflow-domain.mjs';
import { AIWS_RUNNER_IMAGE } from '../../../packages/shared/src/version.mjs';

export const STATE_SCHEMA_VERSION = 16;
export const V16_COLLECTIONS = Object.freeze([...V15_COLLECTIONS, 'brief_templates', 'workflow_drafts']);
export { canonicalStateHash, sha256 };
export const V16_LEGACY_OFFICIAL_RUNNER_PATTERN = /^aiws-codex-runner:1\.[0-6]\.0-codex-\d+\.\d+\.\d+$/;

export function migrateState15To16(source, { timestamp = new Date().toISOString() } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrationError('state_root_invalid');
  const inputVersion = source.schema_version == null ? 13 : Number(source.schema_version);
  if (inputVersion === STATE_SCHEMA_VERSION) {
    const state = structuredClone(source);
    normalizeV16RecordDefaults(state, timestamp);
    validateState16(state);
    return { state, migrated: false, from_version: 16, to_version: 16, migrated_briefs: 0, created_workflow_drafts: 0 };
  }
  if (![12, 13, 14, 15].includes(inputVersion)) throw migrationError('unsupported_state_schema', { schema_version: source.schema_version ?? null });
  const state = inputVersion === 15 ? structuredClone(source) : migrateState14To15(source, { timestamp }).state;
  for (const collection of V16_COLLECTIONS) if (!Array.isArray(state[collection])) state[collection] = [];
  normalizeV16RecordDefaults(state, timestamp);

  for (const session of state.assist_sessions || []) {
    if (session.version !== 3) continue;
    if (!['ask', 'auto_recommend'].includes(session.clarification_policy)) session.clarification_policy = 'ask';
  }
  for (const turn of state.assist_turns || []) if (turn.operation_reference_id === undefined) turn.operation_reference_id = null;
  for (const operation of state.assist_operations || []) {
    const semantic = semanticOperation(operation);
    if (operation.capability_id === undefined) operation.capability_id = semantic.capability_id;
    if (operation.action === undefined) operation.action = semantic.action;
    if (operation.target_label === undefined) operation.target_label = operation.target_id || null;
    if (operation.summary === undefined) operation.summary = semantic.summary;
    if (operation.input_schema === undefined) operation.input_schema = null;
    if (operation.locator === undefined) operation.locator = { route: operation.route || null, surface_id: operation.surface_id || null, surface_revision: operation.surface_revision || null, target_id: operation.target_id || null };
  }
  for (const input of state.runtime_user_inputs || []) for (const question of input.questions || []) {
    if (question.allow_note === undefined) question.allow_note = true;
    for (const option of question.options || []) if (option.recommended === undefined) option.recommended = false;
  }
  const runnerNormalization = normalizeOfficialRunnerImages(state, { timestamp });

  let migratedBriefs = 0;
  for (const brief of state.project_briefs || []) {
    if (brief.content?.schema_version !== 2) {
      const project = state.projects?.find((item) => item.id === brief.project_id);
      const intake = state.project_intakes?.find((item) => item.project_id === brief.project_id);
      brief.content = legacyBriefToV2(brief.content || {}, {
        briefId: brief.id,
        title: `${project?.title || '项目'}简报`,
        materialReferences: (intake?.context_sources || []).map((item) => ({ ...item, url: item.url || null }))
      });
      migratedBriefs += 1;
    }
    if (!Number.isInteger(brief.revision) || brief.revision < 1) brief.revision = Math.max(1, Number(brief.version) || 1);
  }

  const draftsByProject = new Set(state.workflow_drafts.map((draft) => draft.project_id));
  let createdWorkflowDrafts = 0;
  for (const project of state.projects || []) {
    if (project.status !== 'draft' || draftsByProject.has(project.id)) continue;
    const brief = state.project_briefs.filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
    state.workflow_drafts.push(createWorkflowDraft({ project, brief, timestamp, deterministic: true }));
    draftsByProject.add(project.id); createdWorkflowDrafts += 1;
  }

  state.schema_version = STATE_SCHEMA_VERSION;
  validateState16(state);
  return { state, migrated: true, from_version: inputVersion, to_version: 16, migrated_briefs: migratedBriefs, created_workflow_drafts: createdWorkflowDrafts, normalized_runner_profiles: runnerNormalization.profile_ids, staled_runner_probes: runnerNormalization.staled_probe_count };
}

export function normalizeOfficialRunnerImages(state, { targetImage = AIWS_RUNNER_IMAGE, timestamp = new Date().toISOString() } = {}) {
  const changedProfiles = new Set(), changedFields = [];
  for (const profile of Array.isArray(state?.codex_profiles) ? state.codex_profiles : []) for (const [container, field] of [[profile, 'image'], [profile?.config, 'image']]) {
    if (!container || !V16_LEGACY_OFFICIAL_RUNNER_PATTERN.test(String(container[field] || ''))) continue;
    changedFields.push({ profile_id: profile.id || null, field: container === profile ? 'image' : 'config.image', from: container[field], to: targetImage }); container[field] = targetImage; if (profile.id) changedProfiles.add(profile.id);
  }
  for (const integration of Array.isArray(state?.integration_statuses) ? state.integration_statuses : []) if (integration?.key === 'codex_docker' && V16_LEGACY_OFFICIAL_RUNNER_PATTERN.test(String(integration.image || ''))) { changedFields.push({ profile_id: null, field: 'integration_statuses.codex_docker.image', from: integration.image, to: targetImage }); integration.image = targetImage; }
  let staledProbeCount = 0;
  for (const probe of Array.isArray(state?.integration_statuses) ? state.integration_statuses : []) if (probe?.key === 'codex_probe' && changedProfiles.has(probe.profile_id)) { probe.status = 'stale'; probe.updated_at = timestamp; staledProbeCount += 1; }
  return { changed: changedFields.length > 0, profile_ids: [...changedProfiles].sort(), changed_fields: changedFields, staled_probe_count: staledProbeCount };
}

export function validateState16(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw migrationError('state_root_invalid');
  if (Number(state.schema_version) !== STATE_SCHEMA_VERSION) throw migrationError('state_schema_not_16', { schema_version: state.schema_version ?? null });
  for (const collection of V16_COLLECTIONS) if (!Array.isArray(state[collection])) throw migrationError('state_collection_invalid', { collection });
  const legacyView = { ...state, schema_version: 15 };
  validateState15(legacyView);
  ensureUniqueIds(state.brief_templates, 'brief_templates');
  ensureUniqueIds(state.workflow_drafts, 'workflow_drafts');
  ensureUniqueIds(state.project_briefs || [], 'project_briefs');
  for (const project of state.projects || []) {
    if (!Object.hasOwn(project, 'lifecycle_operation')) throw migrationError('project_lifecycle_operation_missing', { id: project.id });
    const operation = project.lifecycle_operation;
    if (operation !== null && (!operation || typeof operation !== 'object' || !operation.id || !['trash', 'restore', 'purge'].includes(operation.type))) throw migrationError('project_lifecycle_operation_invalid', { id: project.id });
  }
  const draftProjects = new Set();
  for (const draft of state.workflow_drafts) {
    if (!draft.project_id || draftProjects.has(draft.project_id)) throw migrationError('workflow_draft_project_duplicate', { project_id: draft.project_id || null });
    draftProjects.add(draft.project_id);
    if (!Number.isInteger(draft.revision) || draft.revision < 1 || !Array.isArray(draft.nodes)) throw migrationError('workflow_draft_invalid', { id: draft.id });
    if (!['draft', 'activated'].includes(draft.status)) throw migrationError('workflow_draft_status_invalid', { id: draft.id, status: draft.status || null });
    if (!Object.hasOwn(draft, 'user_modified_at') || draft.user_modified_at !== null && !validTimestamp(draft.user_modified_at)) throw migrationError('workflow_draft_user_modified_at_invalid', { id: draft.id });
    ensureUniqueIds(draft.nodes, `workflow_drafts.${draft.id}.nodes`);
    const nodeIds = new Set(draft.nodes.map((node) => node.id));
    for (const node of draft.nodes) for (const dependencyId of node.dependency_ids || []) if (!nodeIds.has(dependencyId) || dependencyId === node.id) throw migrationError('workflow_draft_dependency_invalid', { id: draft.id, node_id: node.id, dependency_id: dependencyId });
  }
  for (const brief of state.project_briefs || []) {
    if (brief.content?.schema_version !== 2 || !Array.isArray(brief.content.sections)) throw migrationError('project_brief_v2_required', { id: brief.id });
    ensureUniqueIds(brief.content.sections, `project_briefs.${brief.id}.sections`);
  }
  for (const session of (state.assist_sessions || []).filter((item) => item.version === 3)) if (!['ask', 'auto_recommend'].includes(session.clarification_policy)) throw migrationError('assist_clarification_policy_invalid', { id: session.id });
  return state;
}

export async function migrateStateFileToV16(stateFile, {
  backupDirectory = path.join(path.dirname(stateFile), 'migrations'), clock = () => new Date(), beforeReplace, afterReplace
} = {}) {
  const original = await fsp.readFile(stateFile);
  const parsed = JSON.parse(original.toString('utf8'));
  const result = migrateState15To16(parsed, { timestamp: clock().toISOString() });
  if (!result.migrated) return { ...result, state_hash: canonicalStateHash(result.state), backup_path: null, manifest_path: null };
  await fsp.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const stamp = clock().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.json`);
  const manifestPath = path.join(backupDirectory, `state-schema${result.from_version}-${stamp}.manifest.json`);
  await writeExclusiveAndSync(backupPath, original);
  const backupDigest = sha256(original);
  const migratedBytes = Buffer.from(`${JSON.stringify(result.state, null, 2)}\n`, 'utf8');
  const tempPath = `${stateFile}.v16-${process.pid}-${Date.now()}.tmp`;
  const manifest = {
    migration: `aiws-state-${result.from_version}-to-16`, status: 'prepared', from_schema: result.from_version, to_schema: 16,
    created_at: clock().toISOString(), original_sha256: backupDigest, original_state_hash: canonicalStateHash(parsed),
    migrated_sha256: sha256(migratedBytes), migrated_state_hash: canonicalStateHash(result.state),
    migrated_briefs: result.migrated_briefs, created_workflow_drafts: result.created_workflow_drafts, normalized_runner_profiles: result.normalized_runner_profiles, staled_runner_probes: result.staled_runner_probes,
    backup_file: path.basename(backupPath), state_file: path.basename(stateFile)
  };
  await writeExclusiveAndSync(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  let replaced = false;
  try {
    await writeExclusiveAndSync(tempPath, migratedBytes);
    const reread = await fsp.readFile(tempPath);
    if (sha256(reread) !== manifest.migrated_sha256) throw migrationError('migrated_state_checksum_mismatch');
    validateState16(JSON.parse(reread.toString('utf8')));
    await beforeReplace?.({ stateFile, tempPath, backupPath, manifest });
    await replaceFile(tempPath, stateFile); replaced = true;
    await syncDirectory(path.dirname(stateFile));
    const installed = await fsp.readFile(stateFile);
    if (sha256(installed) !== manifest.migrated_sha256) throw migrationError('installed_state_checksum_mismatch');
    validateState16(JSON.parse(installed.toString('utf8')));
    await afterReplace?.({ stateFile, backupPath, manifest });
    manifest.status = 'committed'; manifest.committed_at = clock().toISOString();
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return { ...result, state_hash: manifest.migrated_state_hash, backup_path: backupPath, manifest_path: manifestPath, manifest };
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    if (replaced) {
      const backup = await fsp.readFile(backupPath);
      if (sha256(backup) !== backupDigest) throw migrationError('migration_failed_and_backup_corrupt', { cause: String(error?.message || error) });
      const restoreTemp = `${stateFile}.restore-${process.pid}-${Date.now()}.tmp`;
      await writeExclusiveAndSync(restoreTemp, backup); await replaceFile(restoreTemp, stateFile); await syncDirectory(path.dirname(stateFile));
    }
    manifest.status = 'rolled_back'; manifest.failed_at = clock().toISOString(); manifest.error = safeErrorCode(error);
    await atomicRewrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)).catch(() => undefined);
    throw error;
  }
}

function semanticOperation(operation) {
  if (operation.tool === 'set_filter') return { capability_id: 'surface.filter.set', action: 'set', summary: `已更新筛选 · ${operation.target_id || '页面'}` };
  if (operation.tool === 'select_tab') return { capability_id: 'surface.tab.select', action: 'select', summary: `已切换视图 · ${operation.target_id || '页面'}` };
  return { capability_id: 'surface.field.set', action: 'set', summary: `已更新 · ${operation.target_id || '页面字段'}` };
}
function normalizeV16RecordDefaults(state, timestamp) {
  for (const project of state.projects || []) if (project.lifecycle_operation === undefined) project.lifecycle_operation = null;
  for (const draft of state.workflow_drafts || []) {
    if (!draft.status) draft.status = draft.workflow_id || draft.activated_at ? 'activated' : 'draft';
    if (draft.user_modified_at === undefined) draft.user_modified_at = Number(draft.revision || 1) > 1 ? draft.updated_at || timestamp : null;
  }
}
function validTimestamp(value) { const parsed = new Date(value); return typeof value === 'string' && Number.isFinite(parsed.getTime()); }
function ensureUniqueIds(items, collection) { const seen = new Set(); for (const item of items) { if (!item || typeof item !== 'object' || !String(item.id || '')) throw migrationError('state_record_id_missing', { collection }); if (seen.has(item.id)) throw migrationError('state_record_id_duplicate', { collection, id: item.id }); seen.add(item.id); } }
function migrationError(code, details = {}) { const error = new Error(code); error.code = code; error.details = details; return error; }
function safeErrorCode(error) { return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || '')) ? String(error.code) : 'state_migration_failed'; }
async function writeExclusiveAndSync(file, bytes) { const handle = await fsp.open(file, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
async function atomicRewrite(file, bytes) { const temp = `${file}.${process.pid}.${Date.now()}.tmp`; await writeExclusiveAndSync(temp, bytes); await replaceFile(temp, file); await syncDirectory(path.dirname(file)); }
async function replaceFile(source, target) { for (let attempt = 0; ; attempt++) { try { await fsp.rename(source, target); return; } catch (error) { if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error; await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1)))); } } }
async function syncDirectory(directory) { if (process.platform === 'win32') return; const handle = await fsp.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
