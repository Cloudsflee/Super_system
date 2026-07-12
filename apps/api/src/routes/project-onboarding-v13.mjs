import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { activateDraftInState, buildProjectBrief, ensureManagedBaseline, ensureManagedRepository, materializeCodeSource, materializeContextSources, moveProjectToTrash, purgeProjectDirectory, restoreProjectDirectory, suggestedWorkflow, validateContextSource } from '../project-lifecycle.mjs';
import fs from 'node:fs/promises';
import { id, now } from '../../../../packages/shared/index.mjs';
import { managedProjectRoot } from '../managed-workspace.mjs';
import { isGitRepo } from '../git-utils.mjs';
import { stageMultipartSources } from '../project-upload-service.mjs';
import { normalizeCodeSource } from '../project-import-service.mjs';

export const projectOnboardingV13Routes = [
  makeRoute('GET', '/projects/:id/onboarding', getOnboarding),
  makeRoute('PUT', '/projects/:id/intake', updateIntake),
  makeRoute('POST', '/projects/:id/intake', updateIntake),
  makeRoute('POST', '/projects/:id/intake/retry', retryIntake),
  makeRoute('POST', '/projects/:id/imports', importSources),
  makeRoute('POST', '/projects/:id/onboarding/confirm', confirmOnboarding),
  makeRoute('POST', '/projects/:id/confirm', confirmOnboarding),
  makeRoute('POST', '/projects/:id/managed-workspace/migrate', migrateWorkspace),
  makeRoute('POST', '/projects/:id/trash', trashProject),
  makeRoute('DELETE', '/projects/:id', trashProject),
  makeRoute('POST', '/projects/:id/restore', restoreProject),
  makeRoute('POST', '/projects/:id/purge', purgeProject)
];

async function getOnboarding({ res, params }) {
  const state = await readState(), project = findProject(state, params.id, true);
  const intake = state.project_intakes.find((item) => item.project_id === project.id);
  const briefs = state.project_briefs.filter((item) => item.project_id === project.id).sort((a, b) => b.version - a.version);
  const imports = state.import_jobs.filter((item) => item.project_id === project.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const session = state.assist_sessions.find((item) => item.version === 3 && item.project_id === project.id && item.scope_type === 'project');
  const sourceReady = intake?.mode === 'brainstorm' || Boolean(intake?.code_source && project.managed_workspace_state === 'ready');
  return send(res, 200, { project, intake, brief: briefs[0] || null, briefs, workflow_draft: suggestedWorkflow(briefs[0]), imports, assist_session: session, can_confirm: Boolean(intake?.mode && briefs[0] && !intake.last_error && sourceReady), onboarding_route: `/projects/${project.id}/onboarding` });
}

async function updateIntake({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state), project = findProject(state, params.id);
    if (project.status !== 'draft') throw new HttpError(409, { error: 'project_not_draft' });
    const intake = state.project_intakes.find((item) => item.project_id === project.id);
    if (!intake) throw new HttpError(404, { error: 'project_intake_not_found' });
    if (body.mode !== undefined && !['brainstorm', 'existing'].includes(body.mode)) throw new HttpError(400, { error: 'invalid_intake_mode' });
    if (body.mode) intake.mode = body.mode;
    if (body.answers && typeof body.answers === 'object') intake.answers = { ...(intake.answers || {}), ...body.answers };
    if (body.code_source !== undefined) intake.code_source = body.code_source ? normalizeCodeSource(body.code_source) : null;
    if (body.context_sources !== undefined) {
      if (!Array.isArray(body.context_sources) || body.context_sources.length > 50) throw new HttpError(400, { error: 'invalid_context_sources' });
      intake.context_sources = body.context_sources.map(validateContextSource);
    }
    Object.assign(intake, { status: 'ready_for_review', revision: Number(intake.revision || 0) + 1, last_error: null, updated_at: now() });
    for (const prior of state.project_briefs.filter((item) => item.project_id === project.id && item.status === 'draft')) prior.status = 'superseded';
    const version = Math.max(0, ...state.project_briefs.filter((item) => item.project_id === project.id).map((item) => item.version || 0)) + 1;
    const brief = buildProjectBrief(project, intake, actor.id, version); state.project_briefs.push(brief);
    Object.assign(project, { goal: brief.content.goal || project.goal, onboarding_state: 'brief_review', updated_at: now() });
    addTrace(state, 'project.intake.updated', { project_id: project.id, target_id: intake.id, summary: `更新项目引导：${intake.mode}` }, actor.id);
    return { project, intake, brief, workflow_draft: suggestedWorkflow(brief) };
  });
  return send(res, 200, result);
}

async function retryIntake({ res, params, body }) { return updateIntake({ res, params, body: { ...body, answers: body.answers || {} } }); }

async function importSources({ res, params, body }) {
  const snapshot = await readState(), project = findProject(snapshot, params.id), intake = snapshot.project_intakes.find((item) => item.project_id === project.id);
  if (project.status !== 'draft') throw new HttpError(409, { error: 'project_not_draft' });
  const operationKey = String(body.operation_key || `import-${intake?.revision || 1}`).slice(0, 100);
  const existing = snapshot.import_jobs.find((item) => item.kind === 'code_source' && item.project_id === project.id && item.operation_key === operationKey && item.status === 'succeeded');
  if (existing) return send(res, 200, { job: existing, project, idempotent: true });
  const uploaded = await stageMultipartSources(project.id, body, operationKey);
  const source = uploaded?.code_source || body.code_source || intake?.code_source;
  if (intake?.mode === 'existing' && !source) throw new HttpError(409, { error: 'project_code_source_required' });
  let checkout, attachments;
  try { checkout = await materializeCodeSource(project, source, operationKey); attachments = await materializeContextSources(project, [...(body.context_sources || intake?.context_sources || []), ...(uploaded?.context_sources || [])].map(validateContextSource)); }
  catch (error) {
    if (project.managed_workspace_state !== 'ready') await fs.rm(managedProjectRoot(project.id), { recursive: true, force: true }).catch(() => undefined);
    await mutate((state) => { const current = state.project_intakes.find((item) => item.project_id === project.id); if (current) Object.assign(current, { status: 'import_failed', last_error: error.payload?.error || error.message, updated_at: now() }); let job = state.import_jobs.find((item) => item.kind === 'code_source' && item.project_id === project.id && item.operation_key === operationKey); if (!job) { job = { id: id('imp'), kind: 'code_source', project_id: project.id, operation_key: operationKey, created_at: now() }; state.import_jobs.push(job); } Object.assign(job, { status: 'failed', error_code: error.payload?.error || error.message, updated_at: now() }); });
    throw error;
  } finally { await uploaded?.cleanup(); }
  const result = await mutate((state) => {
    const actor = owner(state), current = findProject(state, project.id), currentIntake = state.project_intakes.find((item) => item.project_id === project.id);
    let job = state.import_jobs.find((item) => item.kind === 'code_source' && item.project_id === project.id && item.operation_key === operationKey);
    if (!job) { job = { id: id('imp'), project_id: project.id, operation_key: operationKey, kind: 'code_source', created_at: now() }; state.import_jobs.push(job); }
    Object.assign(job, { status: 'succeeded', error_code: null, source: checkout.source, source_hash: checkout.source_hash, managed_repo_path: checkout.repo_path, updated_at: now() });
    const assistSession = state.assist_sessions.find((item) => item.version === 3 && item.project_id === project.id && item.scope_type === 'project');
    for (const attachment of attachments) Object.assign(attachment, { session_id: assistSession?.id || null, title: attachment.title || attachment.label, relative_path: attachment.relative_path || null, file_ref_id: null, model_policy: attachment.kind === 'url' || attachment.model_injectable ? (/^image\//.test(attachment.content_type || '') ? 'image' : 'injectable') : 'artifact_only', created_by_user_id: actor.id });
    state.attachments.push(...attachments);
    Object.assign(current, { repo_path: checkout.repo_path, workspace_root: checkout.repo_path.replace(/[\\/]repo$/, ''), managed_workspace_state: 'ready', source_metadata: checkout.source, source_hash: checkout.source_hash, updated_at: now() });
    if (currentIntake) Object.assign(currentIntake, { code_source: checkout.source, context_sources: sanitizeImportedContexts(currentIntake.context_sources, attachments), status: 'ready_for_review', last_error: null, updated_at: now() });
    addTrace(state, 'project.source.imported', { project_id: project.id, target_id: job.id, summary: '代码源已导入受管 workspace。', data: { source: checkout.source, source_hash: checkout.source_hash } }, actor.id);
    return { job, project: current, attachments, idempotent: false };
  });
  return send(res, 201, result);
}

async function confirmOnboarding({ res, params, body }) {
  const snapshot = await readState(), project = findProject(snapshot, params.id);
  if (project.status === 'active' && project.onboarding_state === 'confirmed') {
    const workflow = snapshot.workflows.find((item) => item.project_id === project.id);
    return send(res, 200, { project, workflow, idempotent: true, route: `/projects/${project.id}/workflow` });
  }
  const intake = snapshot.project_intakes.find((item) => item.project_id === project.id);
  if (!intake?.mode) throw new HttpError(409, { error: 'project_intake_incomplete' });
  if (intake.mode === 'existing' && !intake.code_source) throw new HttpError(409, { error: 'project_code_source_required' });
  if (intake.mode === 'existing' && project.managed_workspace_state !== 'ready') throw new HttpError(409, { error: 'project_source_import_required', import_route: `/projects/${project.id}/imports` });
  await ensureManagedRepository(project.id);
  await ensureManagedBaseline(project.id);
  const result = await mutate((state) => {
    const actor = owner(state), current = findProject(state, project.id), brief = state.project_briefs.filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => b.version - a.version)[0];
    Object.assign(current, { repo_path: current.repo_path, managed_workspace_state: 'ready' });
    const activated = activateDraftInState(state, current, brief, body.workflow_nodes, actor.id);
    addTrace(state, 'project.activated', { project_id: current.id, workspace_id: current.current_workspace_id, target_id: activated.workflow.id, summary: `确认项目简报并激活：${current.title}` }, actor.id);
    return { ...activated, route: `/projects/${current.id}/workflow` };
  });
  return send(res, 200, result);
}

async function migrateWorkspace({ res, params, body }) {
  const snapshot = await readState(), project = findProject(snapshot, params.id);
  const source = body.source || (project.repo_path ? { type: isGitRepository(project.repo_path) ? 'local_git' : 'local_directory', path: project.repo_path } : null);
  const checkout = await materializeCodeSource(project, source, body.operation_key || 'workspace-migration');
  const result = await mutate((state) => { const actor = owner(state), current = findProject(state, project.id); Object.assign(current, { repo_path: checkout.repo_path, workspace_root: checkout.repo_path.replace(/[\\/]repo$/, ''), managed_workspace_state: 'ready', source_metadata: checkout.source, source_hash: checkout.source_hash, updated_at: now() }); addTrace(state, 'project.workspace.migrated', { project_id: current.id, summary: '项目已迁移到受管 workspace。', data: { source_hash: checkout.source_hash } }, actor.id); return current; });
  return send(res, 200, result);
}

async function trashProject({ res, params }) {
  const snapshot = await readState(), project = findProject(snapshot, params.id, true);
  if (project.deleted_at) return send(res, 200, { project, idempotent: true });
  const trashPath = await moveProjectToTrash(project.id);
  const result = await mutate((state) => { const actor = owner(state), current = findProject(state, project.id, true), trashedAt = now(), previousStatus = current.status; Object.assign(current, { status_before_trash: previousStatus, status: 'archived', deleted_at: trashedAt, trash_path: trashPath, trash_metadata: { path: trashPath, status_before_trash: previousStatus, trashed_at: trashedAt }, updated_at: trashedAt }); addTrace(state, 'project.trashed', { project_id: current.id, summary: `项目移入回收站：${current.title}` }, actor.id); return current; });
  return send(res, 200, { project: result, idempotent: false });
}

async function restoreProject({ res, params }) {
  const snapshot = await readState(), project = findProject(snapshot, params.id, true);
  if (!project.deleted_at) return send(res, 200, { project, idempotent: true });
  await restoreProjectDirectory(project.id, project.trash_metadata?.path || project.trash_path);
  const result = await mutate((state) => { const actor = owner(state), current = findProject(state, project.id, true); Object.assign(current, { status: current.trash_metadata?.status_before_trash || current.status_before_trash || 'active', deleted_at: null, trash_path: null, trash_metadata: null, updated_at: now() }); addTrace(state, 'project.restored', { project_id: current.id, summary: `恢复项目：${current.title}` }, actor.id); return current; });
  return send(res, 200, { project: result, idempotent: false });
}

async function purgeProject({ res, params, body }) {
  const snapshot = await readState(), project = findProject(snapshot, params.id, true);
  if (body.confirm_title !== project.title) throw new HttpError(409, { error: 'project_title_confirmation_mismatch' });
  const storage = await purgeProjectDirectory(project.id, project.trash_metadata?.path || project.trash_path, body.retain_managed_directory === true);
  await mutate((state) => {
    const projectId = project.id, workflowIds = state.workflows.filter((item) => item.project_id === projectId).map((item) => item.id), nodeIds = state.workflow_nodes.filter((item) => workflowIds.includes(item.workflow_id)).map((item) => item.id), workspaceIds = state.workspaces.filter((item) => item.project_id === projectId).map((item) => item.id);
    const direct = ['projects', 'workspaces', 'workflows', 'context_packs', 'context_sufficiency_checks', 'traces', 'assets', 'decisions', 'digests', 'node_runs', 'agent_sessions', 'code_changes', 'assist_sessions', 'change_proposals', 'submissions', 'repository_bindings', 'file_changes', 'node_workspace_data', 'test_tasks', 'project_intakes', 'project_briefs', 'assist_turns', 'attachments', 'worktrees', 'runtime_approvals', 'terminal_sessions', 'config_revisions', 'import_jobs'];
    for (const key of direct) state[key] = state[key].filter((item) => item.project_id !== projectId && !(key === 'projects' && item.id === projectId));
    state.workflow_nodes = state.workflow_nodes.filter((item) => !workflowIds.includes(item.workflow_id));
    state.node_contracts = state.node_contracts.filter((item) => !nodeIds.includes(item.node_id));
    const sessionIds = new Set(snapshot.assist_sessions.filter((item) => item.project_id === projectId).map((item) => item.id));
    state.assist_messages = state.assist_messages.filter((item) => !sessionIds.has(item.session_id)); state.assist_events = state.assist_events.filter((item) => !sessionIds.has(item.session_id)); state.ui_action_intents = state.ui_action_intents.filter((item) => !sessionIds.has(item.session_id));
    state.file_refs = state.file_refs.filter((item) => !workspaceIds.includes(item.workspace_id));
  });
  return send(res, 200, { purged: true, project_id: project.id, storage });
}

function findProject(state, idValue, includeDeleted = false) { const project = state.projects.find((item) => item.id === idValue && (includeDeleted || !item.deleted_at)); if (!project) throw new HttpError(404, { error: 'project_not_found' }); return project; }
function isGitRepository(value) { try { return Boolean(value && isGitRepo(value)); } catch { return false; } }
function sanitizeImportedContexts(sources = [], attachments = []) { return sources.map((source, index) => source.path ? { type: source.type, label: source.label || attachments[index]?.label || '本地材料', path_scope: source.path_scope || 'managed_import', sha256: attachments[index]?.sha256 || null } : source); }
