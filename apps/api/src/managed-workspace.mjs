import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.mjs';
import { WORKSPACE_DIR } from './config.mjs';

export function managedProjectRoot(projectId) {
  return path.join(WORKSPACE_DIR, safeSegment(projectId));
}
export function managedRepoPath(projectId) {
  return path.join(managedProjectRoot(projectId), 'repo');
}
export function assertManagedProjectWritable(project) {
  if (!project || project.deleted_at) throw new HttpError(404, { error: 'project_not_found' });
  if (project.lifecycle_operation)
    throw new HttpError(423, {
      error: 'project_lifecycle_operation_in_progress',
      operation: project.lifecycle_operation.type || null
    });
  if (project.status !== 'active' || project.onboarding_state !== 'confirmed')
    throw new HttpError(409, {
      error: 'project_onboarding_required',
      onboarding_route: `/projects/${project.id}/onboarding`
    });
  const repo = project.repo_path || '',
    expected = managedRepoPath(project.id);
  const valid =
    project.managed_workspace_state === 'ready' &&
    path.resolve(repo) === path.resolve(expected) &&
    isWithin(WORKSPACE_DIR, repo) &&
    realPathWithin(WORKSPACE_DIR, repo);
  if (!valid)
    throw new HttpError(409, {
      error: 'workspace_migration_required',
      migration_route: `/projects/${project.id}/managed-workspace/migrate`
    });
  return project;
}
export function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
export function assertWithin(root, candidate) {
  if (!isWithin(root, candidate)) throw new HttpError(400, { error: 'managed_path_escape' });
}
export function safeSegment(value) {
  return String(value || 'item').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function realPathWithin(root, candidate) {
  try {
    const realRoot = fs.realpathSync(root),
      realCandidate = fs.realpathSync(candidate);
    return isWithin(realRoot, realCandidate);
  } catch {
    return false;
  }
}
