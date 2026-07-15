import fsp from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ARTIFACT_DIR, ASSIST_DIR, ATTACHMENT_DIR, EXPORT_DIR, STAGING_DIR, TRASH_DIR, WORKTREE_DIR } from './config.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, owner } from './state.mjs';
import { moveProjectToTrash, purgeProjectDirectory, restoreProjectDirectory } from './project-lifecycle.mjs';
import { isWithin, safeSegment } from './managed-workspace.mjs';
import { projectManagedPathsInState, purgeProjectInState } from './state-purge.mjs';
import { id, now } from '../../../packages/shared/index.mjs';

const locks = new Map();
const lockContext = new AsyncLocalStorage();
const ACTIVE_TURNS = new Set(['queued', 'preparing', 'running', 'waiting_user_input', 'waiting_approval', 'stopping']);
const ACTIVE_TERMINALS = new Set(['starting', 'running', 'connected', 'stopping']);
const ACTIVE_JOBS = new Set(['queued', 'starting', 'running', 'processing', 'staging', 'stopping']);
const ACTIVE_LEGACY_ASSIST = new Set(['running']);

export function withProjectLifecycleLock(projectId, operation) {
  const key = String(projectId), held = lockContext.getStore();
  if (held?.has(key)) return Promise.resolve().then(operation);
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(() => lockContext.run(new Set([...(held || []), key]), operation));
  locks.set(key, current);
  return current.finally(() => { if (locks.get(key) === current) locks.delete(key); });
}

export function assertProjectLifecycleIdle(project) {
  if (!project || project.deleted_at) throw new HttpError(404, { error: 'project_not_found' });
  if (project?.lifecycle_operation) throw lifecycleBusy(project);
  return project;
}

export function trashProjectLifecycle(projectId) {
  return withProjectLifecycleLock(projectId, async () => {
    const prepared = await mutate((state) => {
      const project = findProject(state, projectId);
      if (project.lifecycle_operation && project.lifecycle_operation.type !== 'trash') throw lifecycleBusy(project);
      if (project.deleted_at && !project.lifecycle_operation) return { idempotent: true, project };
      assertProjectIdle(state, projectId);
      const operation = project.lifecycle_operation || lifecycleOperation('trash', projectId, { status_before_trash: project.status });
      project.lifecycle_operation = operation; project.updated_at = now();
      return { idempotent: false, operation };
    });
    if (prepared.idempotent) return prepared;
    const project = await mutate(async (state) => {
      const current = requireOperation(state, projectId, prepared.operation.id, 'trash');
      const trashPath = await moveProjectToTrash(projectId, prepared.operation.trash_path);
      const trashedAt = now(), previousStatus = prepared.operation.status_before_trash || current.status;
      Object.assign(current, { status_before_trash: previousStatus, status: 'archived', deleted_at: trashedAt, trash_path: trashPath, trash_metadata: { path: trashPath, status_before_trash: previousStatus, trashed_at: trashedAt }, lifecycle_operation: null, updated_at: trashedAt });
      addTrace(state, 'project.trashed', { project_id: current.id, summary: `项目移入回收站：${current.title}` }, owner(state).id);
      return current;
    });
    return { project, idempotent: false };
  });
}

export function restoreProjectLifecycle(projectId) {
  return withProjectLifecycleLock(projectId, async () => {
    const prepared = await mutate((state) => {
      const project = findProject(state, projectId);
      if (project.lifecycle_operation && project.lifecycle_operation.type !== 'restore') throw lifecycleBusy(project);
      if (!project.deleted_at && !project.lifecycle_operation) return { idempotent: true, project };
      const operation = project.lifecycle_operation || lifecycleOperation('restore', projectId, { trash_path: project.trash_metadata?.path || project.trash_path || null });
      project.lifecycle_operation = operation; project.updated_at = now();
      return { idempotent: false, operation };
    });
    if (prepared.idempotent) return prepared;
    const project = await mutate(async (state) => {
      const current = requireOperation(state, projectId, prepared.operation.id, 'restore');
      const target = await restoreProjectDirectory(projectId, prepared.operation.trash_path);
      if (prepared.operation.trash_path && !(await exists(target))) throw new HttpError(409, { error: 'managed_workspace_restore_missing' });
      Object.assign(current, { status: current.trash_metadata?.status_before_trash || current.status_before_trash || 'active', deleted_at: null, trash_path: null, trash_metadata: null, lifecycle_operation: null, updated_at: now() });
      addTrace(state, 'project.restored', { project_id: current.id, summary: `恢复项目：${current.title}` }, owner(state).id);
      return current;
    });
    return { project, idempotent: false };
  });
}

export function purgeProjectLifecycle(projectId, { confirmTitle, retainManagedDirectory = false } = {}) {
  return withProjectLifecycleLock(projectId, async () => {
    const operation = await mutate((state) => {
      const project = findProject(state, projectId);
      if (project.lifecycle_operation && project.lifecycle_operation.type !== 'purge') throw lifecycleBusy(project);
      if (!project.deleted_at) throw new HttpError(409, { error: 'project_not_trashed' });
      if (confirmTitle !== project.title) throw new HttpError(409, { error: 'project_title_confirmation_mismatch' });
      assertProjectIdle(state, projectId);
      if (project.lifecycle_operation) {
        if (project.lifecycle_operation.retain_managed_directory !== retainManagedDirectory) throw new HttpError(409, { error: 'project_purge_options_changed' });
        return project.lifecycle_operation;
      }
      const prepared = lifecycleOperation('purge', projectId, {
        trash_path: project.trash_metadata?.path || project.trash_path || null,
        retain_managed_directory: retainManagedDirectory
      });
      project.lifecycle_operation = prepared; project.updated_at = now(); return prepared;
    });
    return mutate(async (state) => {
      const project = requireOperation(state, projectId, operation.id, 'purge');
      if (!project.deleted_at) throw new HttpError(409, { error: 'project_not_trashed' });
      if (confirmTitle !== project.title) throw new HttpError(409, { error: 'project_title_confirmation_mismatch' });
      assertProjectIdle(state, projectId);
      const storage = await purgeProjectDirectory(projectId, operation.trash_path, operation.retain_managed_directory, operation.export_path);
      const cleanup = await removeProjectManagedPaths(projectId, projectManagedPathsInState(state, projectId));
      purgeProjectInState(state, projectId);
      return { purged: true, project_id: projectId, storage, cleanup };
    });
  });
}

function lifecycleOperation(type, projectId, extra = {}) {
  const operationId = id('plop');
  return {
    id: operationId, type, started_at: now(), ...extra,
    ...(type === 'trash' ? { trash_path: path.join(TRASH_DIR, `${safeSegment(projectId)}-${operationId}`) } : {}),
    ...(type === 'purge' && extra.retain_managed_directory ? { export_path: path.join(EXPORT_DIR, `${safeSegment(projectId)}-${operationId}`) } : {})
  };
}

function assertProjectIdle(state, projectId) {
  const sessions = new Set((state.assist_sessions || []).filter((item) => item.project_id === projectId).map((item) => item.id));
  const active = (state.assist_sessions || []).find((item) => item.version !== 3 && item.project_id === projectId && ACTIVE_LEGACY_ASSIST.has(item.status))
    || (state.assist_turns || []).find((item) => (item.project_id === projectId || sessions.has(item.session_id)) && ACTIVE_TURNS.has(item.status))
    || (state.terminal_sessions || []).find((item) => (item.project_id === projectId || sessions.has(item.assist_session_id)) && ACTIVE_TERMINALS.has(item.status))
    || (state.node_runs || []).find((item) => item.project_id === projectId && ACTIVE_JOBS.has(item.status))
    || (state.test_tasks || []).find((item) => item.project_id === projectId && ACTIVE_JOBS.has(item.status))
    || (state.import_jobs || []).find((item) => item.project_id === projectId && ACTIVE_JOBS.has(item.status));
  if (active) throw new HttpError(423, { error: 'project_in_use', resource_id: active.id, status: active.status });
}

async function removeProjectManagedPaths(projectId, managed) {
  let attachments = 0, artifacts = 0, directories = 0;
  for (const file of managed.attachment_paths) if (await removeFileWithin(ATTACHMENT_DIR, file)) attachments++;
  for (const file of managed.artifact_paths) if (await removeFileWithin(ARTIFACT_DIR, file)) artifacts++;
  if (safeSegment(projectId) === projectId) for (const root of [ATTACHMENT_DIR, ASSIST_DIR, WORKTREE_DIR, STAGING_DIR]) if (await removeTreeWithin(root, path.join(root, projectId))) directories++;
  return { attachments, artifacts, directories };
}

async function removeFileWithin(root, candidate) {
  const full = path.resolve(candidate || '');
  if (!candidate || full === path.resolve(root) || !isWithin(root, full)) return false;
  const stat = await fsp.lstat(full).catch(() => null);
  if (!stat || (!stat.isFile() && !stat.isSymbolicLink())) return false;
  await fsp.rm(full, { force: true }); return true;
}
async function removeTreeWithin(root, target) {
  if (path.resolve(target) === path.resolve(root) || !isWithin(root, target)) return false;
  if (!(await exists(target))) return false;
  await fsp.rm(target, { recursive: true, force: true }); return true;
}
function requireOperation(state, projectId, operationId, type) { const project = findProject(state, projectId); if (project.lifecycle_operation?.id !== operationId || project.lifecycle_operation?.type !== type) throw new HttpError(409, { error: 'project_lifecycle_operation_changed' }); return project; }
function findProject(state, projectId) { const project = state.projects.find((item) => item.id === projectId); if (!project) throw new HttpError(404, { error: 'project_not_found' }); return project; }
function lifecycleBusy(project) { return new HttpError(423, { error: 'project_lifecycle_operation_in_progress', operation: project.lifecycle_operation?.type || null }); }
function exists(target) { return fsp.stat(target).then(() => true, () => false); }
