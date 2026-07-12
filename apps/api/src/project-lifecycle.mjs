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
export { assertManagedProjectWritable, managedProjectRoot, managedRepoPath } from './managed-workspace.mjs';
export { ensureManagedBaseline, ensureManagedRepository, materializeCodeSource, materializeContextSources } from './project-import-service.mjs';

const nodeTypes = new Set(['goal_definition', 'research', 'analysis', 'execution', 'retrospective']);

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
    settings: { ...created.project.settings, workspace_root_whitelist: [root] }
  });
  const intake = {
    id: id('pin'), project_id: created.project.id, mode: normalizeMode(body.mode), status: body.mode ? 'collecting' : 'awaiting_mode',
    code_source: body.code_source || legacyCodeSource(body.repo_path || body.workspace_root), context_sources: normalizeContextSources(body.context_sources),
    answers: normalizeAnswers(body.answers), revision: 1, last_error: null, created_by_user_id: actor.id, created_at: now(), updated_at: now()
  };
  const brief = buildProjectBrief(created.project, intake, actor.id, 1);
  const session = {
    id: id('asst'), version: 3, project_id: created.project.id, workspace_id: created.workspace.id, node_id: null,
    scope_type: 'project', scope_id: created.project.id, parent_session_id: null, title: `${created.project.title} · 项目引导`,
    status: 'idle', lifecycle: 'active', pinned: true, archived_at: null, codex_thread_id: null,
    created_by_user_id: actor.id, created_at: now(), updated_at: now()
  };
  return { ...created, intake, brief, session, onboarding_route: `/projects/${created.project.id}/onboarding` };
}

export function buildProjectBrief(project, intake, actorId, version) {
  const answers = intake.answers || {};
  const goal = text(answers.goal || project.goal, 4000);
  const features = list(answers.features || answers.scope_in || (goal ? [goal] : []));
  const constraints = list(answers.constraints);
  const acceptance = list(answers.acceptance_criteria || (goal ? [`交付结果能够验证：${goal}`] : []));
  return {
    id: id('pbr'), project_id: project.id, version, status: 'draft',
    content: {
      goal, users: list(answers.users || answers.target_users), scope: { in: features, out: list(answers.scope_out) },
      features, constraints, milestones: list(answers.milestones || ['完成项目工作流并通过验收']),
      acceptance_criteria: acceptance, risks: list(answers.risks), open_questions: list(answers.open_questions)
    },
    source: intake.mode || 'unselected', created_by_user_id: actorId, created_at: now(), updated_at: now()
  };
}

export function suggestedWorkflow(brief) {
  const content = brief?.content || {};
  const goal = content.goal || '澄清目标并完成可验证交付';
  return [
    { type: 'goal_definition', title: '确认项目简报', goal, dependency_indexes: [], position: { x: 80, y: 120 } },
    { type: 'execution', title: '实现核心交付', goal: (content.features || []).join('；') || goal, dependency_indexes: [0], position: { x: 390, y: 120 } },
    { type: 'retrospective', title: '验证与交付审查', goal: (content.acceptance_criteria || []).join('；') || '验证交付结果', dependency_indexes: [1], position: { x: 700, y: 120 } }
  ];
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
  const inputs = Array.isArray(workflowInput) && workflowInput.length ? workflowInput : suggestedWorkflow(brief);
  const created = inputs.slice(0, 20).map((input, index) => ({
    id: id('wfn'), workflow_id: workflow.id, workspace_id: null, type: nodeTypes.has(input.type) ? input.type : 'execution',
    title: text(input.title || '新节点', 100), goal: text(input.goal || input.title || '', 2000), status: 'ready', order_index: index,
    dependencies: [], current_contract_id: null, position: validPosition(input.position, index), created_at: now(), updated_at: now()
  }));
  for (let index = 0; index < created.length; index++) {
    created[index].dependencies = listIndexes(inputs[index]?.dependency_indexes, index).map((dependencyIndex) => ({ node_id: created[dependencyIndex].id, type: 'finish_to_start' }));
    const workspace = createNodeWorkspace(project, created[index], actorId);
    const contract = defaultContractForNode(created[index], project, actorId, 'confirmed');
    created[index].workspace_id = workspace.id; created[index].current_contract_id = contract.id;
    state.workspaces.push(workspace); state.node_contracts.push(contract);
  }
  state.workflow_nodes.push(...created);
  workflow.graph_json = graphFor(created);
  Object.assign(brief, { status: 'confirmed', confirmed_by_user_id: actorId, confirmed_at: now(), updated_at: now() });
  Object.assign(project, { status: 'active', onboarding_state: 'confirmed', managed_workspace_state: 'ready', activated_at: now(), updated_at: now() });
  return { project, workflow, nodes: created, brief, idempotent: false };
}

export async function moveProjectToTrash(projectId) {
  const source = managedProjectRoot(projectId);
  const target = path.join(TRASH_DIR, `${safeSegment(projectId)}-${Date.now()}`);
  if (!fs.existsSync(source)) return null;
  assertWithin(WORKSPACE_DIR, source); assertWithin(TRASH_DIR, target);
  await fsp.mkdir(TRASH_DIR, { recursive: true }); await fsp.rename(source, target);
  return target;
}

export async function restoreProjectDirectory(projectId, trashedPath) {
  if (!trashedPath || !fs.existsSync(trashedPath)) return managedProjectRoot(projectId);
  const target = managedProjectRoot(projectId);
  assertWithin(TRASH_DIR, trashedPath); assertWithin(WORKSPACE_DIR, target);
  if (fs.existsSync(target)) throw new HttpError(409, { error: 'managed_workspace_restore_conflict' });
  await fsp.mkdir(WORKSPACE_DIR, { recursive: true }); await fsp.rename(trashedPath, target);
  return target;
}

export async function purgeProjectDirectory(projectId, trashedPath, retain) {
  const source = trashedPath && fs.existsSync(trashedPath) ? trashedPath : managedProjectRoot(projectId);
  if (!fs.existsSync(source)) return { retained: false, path: null };
  const allowed = isWithin(TRASH_DIR, source) || isWithin(WORKSPACE_DIR, source);
  if (!allowed) throw new HttpError(400, { error: 'purge_path_outside_managed_roots' });
  if (retain) {
    const target = path.join(EXPORT_DIR, `${safeSegment(projectId)}-${Date.now()}`);
    assertWithin(EXPORT_DIR, target); await fsp.mkdir(EXPORT_DIR, { recursive: true }); await fsp.rename(source, target);
    return { retained: true, path: target };
  }
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
  const url = new URL(String(value || ''));
  const host = url.hostname.toLowerCase();
  const privateHost = host === 'localhost' || host === '0.0.0.0' || host === '[::1]' || host === '::1' || host.endsWith('.local') || /^\[?(?:fc|fd|fe8|fe9|fea|feb)/i.test(host) || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || privateHost || [...url.searchParams.keys()].some((key) => /token|key|secret|password|auth/i.test(key))) throw new HttpError(400, { error: 'unsafe_context_url' });
  return url.toString();
}
