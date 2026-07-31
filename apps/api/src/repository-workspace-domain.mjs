import fs from 'node:fs';
import path from 'node:path';
import { hashString } from '../../../packages/shared/index.mjs';
import { git, isGitRepo } from './git-utils.mjs';
import { HttpError } from './http.mjs';
import { isWithin, managedProjectRoot, safeSegment } from './managed-workspace.mjs';

export function managedRepositoryWorkspaceRoot(projectId) {
  return path.join(managedProjectRoot(projectId), 'repository-workspaces');
}

export function managedRepositoryWorkspacePath(projectId, workspaceId) {
  return path.join(managedRepositoryWorkspaceRoot(projectId), safeSegment(workspaceId));
}

export function validateRepositoryRef(value) {
  const ref = String(value || '').trim();
  const invalid =
    !ref ||
    ref.length > 240 ||
    ref === 'HEAD' ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(ref) ||
    ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'));
  if (invalid) throw new HttpError(400, { error: 'repository_ref_invalid', ref });
  return ref;
}

export function verifiedWorkspacePath(workspace) {
  const expected = path.resolve(managedRepositoryWorkspacePath(workspace.project_id, workspace.id));
  if (
    path.resolve(workspace.managed_path || '') !== expected ||
    !isWithin(managedRepositoryWorkspaceRoot(workspace.project_id), expected) ||
    !isGitRepo(expected)
  )
    throw new HttpError(409, { error: 'repository_workspace_path_invalid' });
  const real = fs.realpathSync(expected);
  if (!isWithin(managedRepositoryWorkspaceRoot(workspace.project_id), real))
    throw new HttpError(409, { error: 'repository_workspace_symlink_escape' });
  return real;
}

export function canonicalRepositoryId(state, projectId, connection) {
  const binding = state.project_repository_bindings.find(
    (item) => item.project_id === projectId && item.status !== 'removed'
  );
  if (binding) return binding.canonical_repository_id;
  const canonical = state.canonical_repositories.find(
    (item) => String(item.repository_id) === String(connection?.repository_id)
  );
  return canonical?.id || null;
}

export function canonicalDefaultBranch(state, projectId) {
  const binding = state.project_repository_bindings.find(
    (item) => item.project_id === projectId && item.status !== 'removed'
  );
  return (
    state.canonical_repositories.find((item) => item.id === binding?.canonical_repository_id)?.default_branch || null
  );
}

export function currentBranch(repoPath) {
  return git(repoPath, ['branch', '--show-current'], 5_000).stdout.trim() || null;
}

export function normalizeScope(value) {
  const scope = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    type: String(scope.type || 'project'),
    id: scope.id == null ? null : String(scope.id),
    path_prefixes: [
      ...new Set(
        (Array.isArray(scope.path_prefixes) ? scope.path_prefixes : ['.']).map((item) =>
          String(item || '.').replaceAll('\\', '/')
        )
      )
    ]
  };
}

export function repositoryWorkspaceSnapshotHash(workspace) {
  return hashString(
    JSON.stringify({
      id: workspace.id,
      project_id: workspace.project_id,
      connection_id: workspace.connection_id,
      ref: workspace.ref,
      fixed_sha: workspace.fixed_sha,
      mode: workspace.mode,
      scope: workspace.scope
    })
  );
}
