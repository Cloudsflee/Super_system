import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { activateDraftInState, buildProjectBrief, ensureManagedBaseline, ensureManagedRepository, materializeCodeSource, materializeContextSources, validateContextSource } from '../project-lifecycle.mjs';
import fs from 'node:fs/promises';
import { id, now } from '../../../../packages/shared/index.mjs';
import { managedProjectRoot } from '../managed-workspace.mjs';
import { isGitRepo } from '../git-utils.mjs';
import { stageMultipartSources } from '../project-upload-service.mjs';
import { normalizeCodeSource } from '../project-import-service.mjs';
import { createWorkflowDraft, suggestedWorkflowNodes } from '../brief-workflow-domain.mjs';
import { applyBriefTemplateInState, createBriefTemplateInState, patchBriefInState } from '../project-brief-service.mjs';
import { patchWorkflowDraftInState } from '../workflow-draft-service.mjs';
import { assertProjectLifecycleIdle, purgeProjectLifecycle, restoreProjectLifecycle, trashProjectLifecycle, withProjectLifecycleLock } from '../project-lifecycle-operations.mjs';

export const projectOnboardingV13Routes = [
  makeRoute('GET', '/projects/:id/onboarding', getOnboarding),
  makeRoute('PUT', '/projects/:id/intake', lockedProjectOperation(updateIntake)),
  makeRoute('POST', '/projects/:id/intake', lockedProjectOperation(updateIntake)),
  makeRoute('POST', '/projects/:id/intake/retry', lockedProjectOperation(retryIntake)),
  makeRoute('POST', '/projects/:id/imports', lockedProjectOperation(importSources)),
  makeRoute('POST', '/projects/:id/onboarding/confirm', lockedProjectOperation(confirmOnboarding)),
  makeRoute('POST', '/projects/:id/confirm', lockedProjectOperation(confirmOnboarding)),
  makeRoute('PATCH', '/projects/:projectId/briefs/:briefId', lockedProjectOperation(patchBrief, 'projectId')),
  makeRoute('GET', '/brief-templates', listBriefTemplates),
  makeRoute('POST', '/brief-templates', createBriefTemplate),
  makeRoute('POST', '/brief-templates/:templateId/apply', applyBriefTemplate),
  makeRoute('POST', '/projects/:projectId/briefs/:briefId/apply-template', applyBriefTemplate),
  makeRoute('GET', '/projects/:id/workflow-draft', getWorkflowDraft),
  makeRoute('PATCH', '/projects/:id/workflow-draft', lockedProjectOperation(patchWorkflowDraft)),
  makeRoute('POST', '/projects/:id/managed-workspace/migrate', lockedProjectOperation(migrateWorkspace)),
  makeRoute('POST', '/projects/:id/trash', trashProject),
  makeRoute('DELETE', '/projects/:id', trashProject),
  makeRoute('POST', '/projects/:id/restore', restoreProject),
  makeRoute('POST', '/projects/:id/purge', purgeProject)
];

async function getOnboarding({ res, params }) {
  const state = await readState(), project = assertProjectLifecycleIdle(findProject(state, params.id));
  const intake = state.project_intakes.find((item) => item.project_id === project.id);
  const briefs = state.project_briefs.filter((item) => item.project_id === project.id).sort((a, b) => b.version - a.version);
  const imports = state.import_jobs.filter((item) => item.project_id === project.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const session = state.assist_sessions.find((item) => item.version === 3 && item.project_id === project.id && item.scope_type === 'project');
  const sourceReady = intake?.mode === 'brainstorm' || Boolean(intake?.code_source && project.managed_workspace_state === 'ready');
  const workflowDraft = state.workflow_drafts.find((item) => item.project_id === project.id) || null;
  return send(res, 200, { project, intake, brief: briefs[0] || null, briefs, workflow_draft: workflowDraft, imports, assist_session: session, can_confirm: Boolean(intake?.mode && briefs[0] && workflowDraft && !intake.last_error && sourceReady), onboarding_route: `/projects/${project.id}/onboarding` });
}

async function updateIntake({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state), project = assertProjectLifecycleIdle(findProject(state, params.id));
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
    let workflowDraft = state.workflow_drafts.find((item) => item.project_id === project.id);
    if (!workflowDraft) { workflowDraft = createWorkflowDraft({ project, brief }); state.workflow_drafts.push(workflowDraft); }
    else if (workflowDraft.user_modified_at === null || workflowDraft.user_modified_at === undefined && workflowDraft.revision === 1) Object.assign(workflowDraft, { nodes: rebaseSuggestedNodes(workflowDraft.nodes, suggestedWorkflowNodes(brief)), source_brief_id: brief.id, source_brief_revision: brief.revision, revision: workflowDraft.revision + 1, updated_at: now() });
    Object.assign(project, { goal: brief.content.goal || project.goal, onboarding_state: 'brief_review', updated_at: now() });
    addTrace(state, 'project.intake.updated', { project_id: project.id, target_id: intake.id, summary: `更新项目引导：${intake.mode}` }, actor.id);
    return { project, intake, brief, workflow_draft: workflowDraft };
  });
  return send(res, 200, result);
}

async function retryIntake({ res, params, body }) { return updateIntake({ res, params, body: { ...body, answers: body.answers || {} } }); }

async function importSources({ res, params, body }) {
  const snapshot = await readState(), project = assertProjectLifecycleIdle(findProject(snapshot, params.id)), intake = snapshot.project_intakes.find((item) => item.project_id === project.id);
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
    const actor = owner(state), current = assertProjectLifecycleIdle(findProject(state, project.id)), currentIntake = state.project_intakes.find((item) => item.project_id === project.id);
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
  const snapshot = await readState(), project = assertProjectLifecycleIdle(findProject(snapshot, params.id));
  if (project.status === 'active' && project.onboarding_state === 'confirmed') {
    const workflow = snapshot.workflows.find((item) => item.project_id === project.id);
    return send(res, 200, { project, workflow, idempotent: true, route: `/projects/${project.id}/workflow` });
  }
  const intake = snapshot.project_intakes.find((item) => item.project_id === project.id);
  if (!intake?.mode) throw new HttpError(409, { error: 'project_intake_incomplete' });
  if (intake.mode === 'existing' && !intake.code_source) throw new HttpError(409, { error: 'project_code_source_required' });
  if (intake.mode === 'existing' && project.managed_workspace_state !== 'ready') throw new HttpError(409, { error: 'project_source_import_required', import_route: `/projects/${project.id}/imports` });
  const snapshotBrief = snapshot.project_briefs.filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => b.version - a.version)[0];
  const snapshotDraft = snapshot.workflow_drafts.find((item) => item.project_id === project.id);
  const versionedRequest = pairedConfirmationRevisions(body);
  checkOptionalRevision(body.expected_brief_revision, snapshotBrief?.revision, 'project_brief_revision_conflict');
  checkOptionalRevision(body.expected_workflow_revision, snapshotDraft?.revision, 'workflow_draft_revision_conflict');
  await ensureManagedRepository(project.id);
  await ensureManagedBaseline(project.id);
  const result = await mutate((state) => {
    const actor = owner(state), current = assertProjectLifecycleIdle(findProject(state, project.id)), brief = state.project_briefs.filter((item) => item.project_id === project.id && item.status !== 'superseded').sort((a, b) => b.version - a.version)[0], workflowDraft = state.workflow_drafts.find((item) => item.project_id === project.id);
    checkOptionalRevision(body.expected_brief_revision, brief?.revision, 'project_brief_revision_conflict');
    checkOptionalRevision(body.expected_workflow_revision, workflowDraft?.revision, 'workflow_draft_revision_conflict');
    Object.assign(current, { repo_path: current.repo_path, managed_workspace_state: 'ready' });
    const activated = activateDraftInState(state, current, brief, versionedRequest ? workflowDraft : body.workflow_nodes || workflowDraft, actor.id);
    if (workflowDraft) Object.assign(workflowDraft, { status: 'activated', workflow_id: activated.workflow.id, activated_at: now(), updated_at: now() });
    addTrace(state, 'project.activated', { project_id: current.id, workspace_id: current.current_workspace_id, target_id: activated.workflow.id, summary: `确认项目简报并激活：${current.title}` }, actor.id);
    return { ...activated, route: `/projects/${current.id}/workflow` };
  });
  return send(res, 200, result);
}

async function patchBrief({ res, params, body }) {
  const result = await mutate((state) => { const actor = owner(state), brief = patchBriefInState(state, params.projectId, params.briefId, body, actor.id); addTrace(state, 'project.intake.updated', { project_id: params.projectId, target_id: brief.id, summary: '更新 Brief V2 区块。', data: { revision: brief.revision } }, actor.id); return brief; });
  return send(res, 200, result);
}

async function listBriefTemplates({ res, query }) {
  const state = await readState();
  const items = state.brief_templates.filter((item) => item.status !== 'deleted' && (!query.domain || item.domain === query.domain)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return send(res, 200, { items, templates: items });
}

async function createBriefTemplate({ res, body }) {
  const result = await mutate((state) => { const actor = owner(state), template = createBriefTemplateInState(state, body, actor.id); addTrace(state, 'assist.draft.applied', { target_id: template.id, summary: `保存个人简报模板：${template.title}`, data: { version: template.version, domain: template.domain } }, actor.id); return template; });
  return send(res, 201, result);
}

async function applyBriefTemplate({ res, params, body }) {
  const projectId = params.projectId || body.project_id, briefId = params.briefId || body.brief_id, templateId = params.templateId || body.template_id;
  if (!projectId || !briefId || !templateId) throw new HttpError(400, { error: 'brief_template_apply_target_required' });
  const result = await withProjectLifecycleLock(projectId, () => mutate((state) => { const actor = owner(state), brief = applyBriefTemplateInState(state, projectId, briefId, templateId, body, actor.id); addTrace(state, 'assist.draft.applied', { project_id: projectId, target_id: brief.id, summary: '应用简报模板并无损合并。', data: { template_id: templateId, revision: brief.revision } }, actor.id); return brief; }));
  return send(res, 200, result);
}

async function getWorkflowDraft({ res, params }) {
  const state = await readState(); assertProjectLifecycleIdle(findProject(state, params.id));
  const draft = state.workflow_drafts.find((item) => item.project_id === params.id);
  if (!draft) throw new HttpError(404, { error: 'workflow_draft_not_found' });
  return send(res, 200, draft);
}

async function patchWorkflowDraft({ res, params, body }) {
  const result = await mutate((state) => { const actor = owner(state), draft = patchWorkflowDraftInState(state, params.id, body, actor.id); addTrace(state, 'workflow.layout.saved', { project_id: params.id, target_id: draft.id, summary: '更新初始工作流草稿。', data: { revision: draft.revision } }, actor.id); return draft; });
  return send(res, 200, result);
}

async function migrateWorkspace({ res, params, body }) {
  const snapshot = await readState(), project = assertProjectLifecycleIdle(findProject(snapshot, params.id));
  const source = body.source || (project.repo_path ? { type: isGitRepository(project.repo_path) ? 'local_git' : 'local_directory', path: project.repo_path } : null);
  const checkout = await materializeCodeSource(project, source, body.operation_key || 'workspace-migration');
  const result = await mutate((state) => { const actor = owner(state), current = assertProjectLifecycleIdle(findProject(state, project.id)); Object.assign(current, { repo_path: checkout.repo_path, workspace_root: checkout.repo_path.replace(/[\\/]repo$/, ''), managed_workspace_state: 'ready', source_metadata: checkout.source, source_hash: checkout.source_hash, updated_at: now() }); addTrace(state, 'project.workspace.migrated', { project_id: current.id, summary: '项目已迁移到受管 workspace。', data: { source_hash: checkout.source_hash } }, actor.id); return current; });
  return send(res, 200, result);
}

async function trashProject({ res, params }) {
  return send(res, 200, await trashProjectLifecycle(params.id));
}

async function restoreProject({ res, params }) {
  return send(res, 200, await restoreProjectLifecycle(params.id));
}

async function purgeProject({ res, params, body }) {
  return send(res, 200, await purgeProjectLifecycle(params.id, { confirmTitle: body.confirm_title, retainManagedDirectory: body.retain_managed_directory === true }));
}

function findProject(state, idValue) { const project = state.projects.find((item) => item.id === idValue && !item.deleted_at); if (!project) throw new HttpError(404, { error: 'project_not_found' }); return project; }
function checkOptionalRevision(expected, current, error) { if (expected === undefined || expected === null) return; if (!Number.isInteger(expected)) throw new HttpError(400, { error: 'expected_revision_invalid' }); if (expected !== current) throw new HttpError(409, { error, expected_revision: expected, current_revision: current ?? null }); }
function pairedConfirmationRevisions(body) { const brief = body.expected_brief_revision != null, workflow = body.expected_workflow_revision != null; if (brief !== workflow) throw new HttpError(400, { error: 'project_confirmation_revisions_required' }); return brief && workflow; }
function rebaseSuggestedNodes(current = [], suggested = []) { const ids = suggested.map((node, index) => current[index]?.id || node.id); return suggested.map((node, index) => ({ ...node, id: ids[index], dependency_ids: (node.dependency_ids || []).map((dependencyId) => { const dependencyIndex = suggested.findIndex((candidate) => candidate.id === dependencyId); return dependencyIndex >= 0 ? ids[dependencyIndex] : dependencyId; }) })); }
function isGitRepository(value) { try { return Boolean(value && isGitRepo(value)); } catch { return false; } }
function sanitizeImportedContexts(sources = [], attachments = []) { return sources.map((source, index) => source.path ? { type: source.type, label: source.label || attachments[index]?.label || '本地材料', path_scope: source.path_scope || 'managed_import', sha256: attachments[index]?.sha256 || null } : source); }
function lockedProjectOperation(handler, parameter = 'id') { return (context) => withProjectLifecycleLock(context.params[parameter], () => handler(context)); }
