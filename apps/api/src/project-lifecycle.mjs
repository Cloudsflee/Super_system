import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { AIWS_HOME, EXPORT_DIR, TRASH_DIR, WORKSPACE_DIR } from './config.mjs';
import { createEmptyWorkflow, createNodeWorkspace, createProject, defaultContractForNode, id, now } from '../../../packages/shared/index.mjs';
import { assertWithin, isWithin, managedProjectRoot, managedRepoPath, safeSegment } from './managed-workspace.mjs';
import { isGitRepo } from './git-utils.mjs';
import { isContainerized } from './container-runtime-config.mjs';
import { validateHostImportRelative } from './host-import-root.mjs';
import { safeHttpsReferenceUrl } from './safe-reference-url.mjs';
import { assertWorkflowAcyclic, createBriefContentV2, createWorkflowDraft, MAX_WORKFLOW_DRAFT_NODES, normalizeBriefContentV2, normalizeWorkflowNodes, suggestedWorkflowNodes, WORKFLOW_NODE_TYPES } from './brief-workflow-domain.mjs';
export { assertManagedProjectWritable, managedProjectRoot, managedRepoPath } from './managed-workspace.mjs';
export { ensureManagedBaseline, ensureManagedRepository, materializeCodeSource, materializeContextSources } from './project-import-service.mjs';

const nodeTypes = new Set(WORKFLOW_NODE_TYPES);

export function createDraftProjectRecords(body, actor) {
  const created = createProject({
    title: body.title,
    goal: body.goal,
    role: body.role,
    background: body.background,
    created_by_user_id: actor.id,
    status: 'draft'
  });
  const root = managedProjectRoot(created.project.id);
  Object.assign(created.project, {
    workspace_root: root,
    repo_path: managedRepoPath(created.project.id),
    onboarding_state: 'intake',
    managed_workspace_state: 'empty',
    github_account_id: body.github_account_id || null,
    source_metadata: null,
    deleted_at: null,
    trash_metadata: null,
    lifecycle_operation: null,
    settings: { ...created.project.settings, workspace_root_whitelist: [root] }
  });
  const intake = {
    id: id('pin'), project_id: created.project.id, mode: normalizeMode(body.mode), status: body.mode ? 'collecting' : 'awaiting_mode',
    code_source: body.code_source || legacyCodeSource(body.repo_path || body.workspace_root), context_sources: normalizeContextSources(body.context_sources),
    answers: normalizeAnswers(body.answers), revision: 1, last_error: null, created_by_user_id: actor.id, created_at: now(), updated_at: now()
  };
  const brief = buildProjectBrief(created.project, intake, actor.id, 1);
  const workflowDraft = createWorkflowDraft({ project: created.project, brief });
  const session = {
    id: id('asst'), version: 3, project_id: created.project.id, workspace_id: created.workspace.id, node_id: null,
    scope_type: 'project', scope_id: created.project.id, parent_session_id: null, title: `${created.project.title} · 项目引导`,
    status: 'idle', lifecycle: 'active', pinned: true, archived_at: null, codex_thread_id: null, clarification_policy: 'ask',
    created_by_user_id: actor.id, created_at: now(), updated_at: now()
  };
  return { ...created, intake, brief, workflowDraft, session, onboarding_route: `/projects/${created.project.id}/onboarding` };
}

export function buildProjectBrief(project, intake, actorId, version) {
  const briefId = id('pbr');
  return {
    id: briefId, project_id: project.id, version, revision: 1, status: 'draft',
    content: createBriefContentV2({ briefId, title: `${project.title}简报`, answers: intake.answers || {}, projectGoal: project.goal, materialReferences: intake.context_sources || [] }),
    source: intake.mode || 'unselected', created_by_user_id: actorId, created_at: now(), updated_at: now()
  };
}

export function suggestedWorkflow(brief) {
  return suggestedWorkflowNodes(brief);
}

export function activateDraftInState(state, project, brief, workflowInput, actorId) {
  if (project.status === 'active' && project.onboarding_state === 'confirmed') {
    const workflow = state.workflows.find((item) => item.project_id === project.id);
    return { project, workflow, idempotent: true };
  }
  if (project.status !== 'draft') throw new HttpError(409, { error: 'project_not_draft' });
  if (!brief || brief.status === 'superseded') throw new HttpError(409, { error: 'project_brief_required' });
  const workflow = createEmptyWorkflow(project, actorId);
  Object.assign(workflow, { status: 'active', generated_by: 'onboarding', confirmed_by: 'human', brief_version: brief.version });
  state.workflows.push(workflow);
  const supplied = Array.isArray(workflowInput) ? workflowInput : Array.isArray(workflowInput?.nodes) ? workflowInput.nodes : null;
  if (supplied && !supplied.length) throw new HttpError(409, { error: 'workflow_draft_requires_node' });
  if (supplied?.length > MAX_WORKFLOW_DRAFT_NODES) throw new HttpError(409, { error: 'workflow_draft_node_limit', max_nodes: MAX_WORKFLOW_DRAFT_NODES });
  const rawInputs = supplied || suggestedWorkflow(brief), sourceIds = rawInputs.map((input) => text(input?.id, 120) || id('wfdn'));
  if (new Set(sourceIds).size !== sourceIds.length) throw new HttpError(409, { error: 'workflow_draft_node_id_duplicate' });
  const prepared = rawInputs.map((input, index) => ({ ...input, id: sourceIds[index], dependency_ids: Array.isArray(input?.dependency_ids) ? input.dependency_ids : listIndexes(input?.dependency_indexes, index).map((dependencyIndex) => sourceIds[dependencyIndex]) }));
  const preparedIds = new Set(sourceIds);
  for (const input of prepared) for (const value of input.dependency_ids) { const dependencyId = text(value, 120); if (dependencyId && !preparedIds.has(dependencyId)) throw new HttpError(409, { error: 'workflow_draft_dependency_not_found', node_id: input.id, dependency_id: dependencyId }); if (dependencyId === input.id) throw new HttpError(409, { error: 'workflow_draft_self_dependency', node_id: input.id }); }
  const inputs = normalizeWorkflowNodes(prepared), inputIds = new Set(inputs.map((input) => input.id));
  for (const input of inputs) for (const dependencyId of input.dependency_ids) if (!inputIds.has(dependencyId)) throw new HttpError(409, { error: 'workflow_draft_dependency_not_found', node_id: input.id, dependency_id: dependencyId });
  try { assertWorkflowAcyclic(inputs); } catch (error) { if (error?.code === 'workflow_draft_cycle') throw new HttpError(409, { error: 'workflow_draft_cycle' }); throw error; }
  const created = inputs.map((input, index) => ({
    id: input.id || id('wfn'), workflow_id: workflow.id, workspace_id: null, type: nodeTypes.has(input.type) ? input.type : 'execution',
    title: text(input.title || '新节点', 100), goal: text(input.goal || input.title || '', 2000), status: 'ready', order_index: index,
    dependencies: [], current_contract_id: null, position: validPosition(input.position, index), created_at: now(), updated_at: now()
  }));
  const createdIds = new Set(created.map((node) => node.id));
  for (let index = 0; index < created.length; index++) {
    const dependencyIds = inputs[index].dependency_ids.filter((dependencyId) => createdIds.has(dependencyId) && dependencyId !== created[index].id);
    created[index].dependencies = dependencyIds.map((nodeId) => ({ node_id: nodeId, type: 'finish_to_start' }));
    const workspace = createNodeWorkspace(project, created[index], actorId);
    const contract = defaultContractForNode(created[index], project, actorId, 'confirmed');
    created[index].workspace_id = workspace.id; created[index].current_contract_id = contract.id;
    state.workspaces.push(workspace); state.node_contracts.push(contract);
  }
  state.workflow_nodes.push(...created);
  workflow.graph_json = graphFor(created);
  brief.content = normalizeBriefContentV2(brief.content, { briefId: brief.id, title: `${project.title}简报` });
  Object.assign(brief, { status: 'confirmed', confirmed_by_user_id: actorId, confirmed_at: now(), updated_at: now() });
  Object.assign(project, { status: 'active', onboarding_state: 'confirmed', managed_workspace_state: 'ready', activated_at: now(), updated_at: now() });
  return { project, workflow, nodes: created, brief, idempotent: false };
}

export async function moveProjectToTrash(projectId, targetPath = null) {
  const source = managedProjectRoot(projectId);
  const target = targetPath || path.join(TRASH_DIR, `${safeSegment(projectId)}-${Date.now()}`);
  assertWithin(WORKSPACE_DIR, source); assertWithin(TRASH_DIR, target);
  if (fs.existsSync(target)) {
    if (fs.existsSync(source)) throw new HttpError(409, { error: 'managed_workspace_trash_conflict' });
    return target;
  }
  if (!fs.existsSync(source)) return null;
  await fsp.mkdir(TRASH_DIR, { recursive: true }); await fsp.rename(source, target);
  return target;
}

export async function restoreProjectDirectory(projectId, trashedPath) {
  const target = managedProjectRoot(projectId);
  assertWithin(WORKSPACE_DIR, target);
  if (!trashedPath) return target;
  assertWithin(TRASH_DIR, trashedPath);
  if (!fs.existsSync(trashedPath)) return target;
  if (fs.existsSync(target)) throw new HttpError(409, { error: 'managed_workspace_restore_conflict' });
  await fsp.mkdir(WORKSPACE_DIR, { recursive: true }); await fsp.rename(trashedPath, target);
  return target;
}

export async function purgeProjectDirectory(projectId, trashedPath, retain, retainedPath = null) {
  if (trashedPath) assertWithin(TRASH_DIR, trashedPath);
  const source = trashedPath && fs.existsSync(trashedPath) ? trashedPath : managedProjectRoot(projectId);
  const allowed = isWithin(TRASH_DIR, source) || isWithin(WORKSPACE_DIR, source);
  if (!allowed) throw new HttpError(400, { error: 'purge_path_outside_managed_roots' });
  if (retain) {
    const target = retainedPath || path.join(EXPORT_DIR, `${safeSegment(projectId)}-${Date.now()}`);
    assertWithin(EXPORT_DIR, target);
    if (fs.existsSync(target)) {
      if (fs.existsSync(source)) throw new HttpError(409, { error: 'managed_workspace_export_conflict' });
      return { retained: true, path: target };
    }
    if (!fs.existsSync(source)) return { retained: false, path: null };
    await fsp.mkdir(EXPORT_DIR, { recursive: true }); await fsp.rename(source, target);
    return { retained: true, path: target };
  }
  if (!fs.existsSync(source)) return { retained: false, path: null };
  await fsp.rm(source, { recursive: true, force: true });
  return { retained: false, path: null };
}

export function validateContextSource(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, { error: 'invalid_context_source' });
  if (input.type === 'url') return { type: 'url', url: validateHttpsUrl(input.url), label: text(input.label || input.url, 200) };
  if (input.type === 'text') return { type: 'text', text: text(input.text, 100000), label: text(input.label || '文本材料', 200) };
  if (input.path) {
    if (input.path_scope === 'host_import_root') return { type: input.type || 'file', path: validateHostImportRelative(input.path), path_scope: 'host_import_root', label: text(input.label || path.posix.basename(input.path), 200) };
    const resolved = path.resolve(input.path);
    if (isContainerized() && !isWithin(AIWS_HOME, resolved)) throw new HttpError(400, { error: 'host_import_scope_required' });
    return { type: input.type || 'file', path: resolved, label: text(input.label || path.basename(input.path), 200) };
  }
  throw new HttpError(400, { error: 'invalid_context_source' });
}

function legacyCodeSource(value) { if (!value) return null; return { type: isGitRepo(value) ? 'local_git' : 'local_directory', path: value }; }
function normalizeMode(value) { return ['brainstorm', 'existing'].includes(value) ? value : null; }
function normalizeAnswers(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function normalizeContextSources(value) { return Array.isArray(value) ? value.slice(0, 50) : []; }
function text(value, max) { return String(value || '').trim().slice(0, max); }
function list(value) { return (Array.isArray(value) ? value : value ? [value] : []).map((item) => text(item, 1000)).filter(Boolean).slice(0, 100); }
function listIndexes(value, max) { return (Array.isArray(value) ? value : []).filter((item) => Number.isInteger(item) && item >= 0 && item < max); }
function validPosition(value, index) { return { x: Math.max(-10000, Math.min(10000, Number(value?.x) || 80 + index * 310)), y: Math.max(-10000, Math.min(10000, Number(value?.y) || 120)) }; }
function graphFor(nodes) { return { nodes: nodes.map((node) => ({ id: node.id, type: node.type, label: node.title, position: node.position })), edges: nodes.flatMap((node) => node.dependencies.map((dependency, index) => ({ id: `${dependency.node_id}-${node.id}-${index}`, source: dependency.node_id, target: node.id }))) }; }
function validateHttpsUrl(value) {
  return safeHttpsReferenceUrl(value, 'unsafe_context_url');
}
