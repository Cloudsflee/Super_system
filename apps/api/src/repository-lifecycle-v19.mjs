import path from 'node:path';
import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { managedProjectRoot, managedRepoPath } from './managed-workspace.mjs';
import { assertProjectMembership } from './project-governance-v19.mjs';
import { assertRepositoryDeletionInactive } from './repository-lifecycle-deletion-support.mjs';
import { isolatedCheckoutIdentity, normalizeRepositoryPath } from './repository-lifecycle-normalization.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';

export * from './repository-lifecycle-deletion.mjs';
export {
  ensureRepositoryLifecycleDefaults,
  upsertCanonicalRepositoryInState
} from './repository-lifecycle-normalization.mjs';
export { revokeRepositoryInstallationBindingsInState } from './repository-access-v19.mjs';

export function repositoryAdministrationPreflight(
  state,
  { project_id: projectId, installation_id: installationId, actor_id: actorId, requested_permission = null } = {}
) {
  const access = assertProjectMembership(state, projectId, actorId, 'github:write');
  if (access.role === 'viewer') throw new HttpError(403, { error: 'repository_create_forbidden', role: access.role });
  const installation = findGithubInstallation(state, installationId);
  if (!installation || installation.status !== 'active') return pendingInstallation(installationId);
  assertAdministrationWritePermission(installation, requested_permission);
  return { ok: true, status: 'ready', installation, role: access.role || access.membership?.role };
}

export function bindCanonicalRepositoryInState(
  state,
  {
    project_id: projectId,
    canonical_repository_id: canonicalId,
    installation_id: installationId,
    checkout,
    permissions = {},
    actor_id: actorId,
    status = 'ready'
  }
) {
  const { project, repository } = requireRepositoryBindingContext(state, projectId, canonicalId, actorId);
  const checkoutPath = requireIsolatedCheckoutPath(state, project, checkout);
  const timestamp = now();
  retirePreviousProjectBindings(state, projectId, canonicalId, timestamp);
  const binding = upsertProjectRepositoryBinding(state, {
    project,
    repository,
    installationId,
    checkoutPath,
    permissions,
    actorId,
    status,
    timestamp
  });
  upsertLegacyRepositoryBinding(state, { projectId, repository, binding, checkoutPath, permissions, actorId, status });
  repository.binding_count = activeBindingCount(state, repository.id);
  return binding;
}

function findGithubInstallation(state, installationId) {
  return state.github_installations.find(
    (item) => item.id === installationId || String(item.installation_id) === String(installationId)
  );
}

function pendingInstallation(installationId) {
  return {
    ok: false,
    status: 'pending',
    error: 'github_installation_pending',
    installation_id: installationId || null
  };
}

function assertAdministrationWritePermission(installation, requestedPermission) {
  if (requestedPermission === 'read' || requestedPermission === false) throwAdministrationWriteRequired();
  const permissions = installation.permissions || installation.app_permissions || {};
  const repositoryPermissions = (installation.repositories || []).map((item) => item.permissions || {});
  const hasWrite =
    requestedPermission === 'write' ||
    permissions.administration === 'write' ||
    permissions.admin === true ||
    repositoryPermissions.some((item) => item.administration === 'write' || item.admin === true);
  if (!hasWrite) throwAdministrationWriteRequired();
}

function throwAdministrationWriteRequired() {
  throw new HttpError(403, {
    error: 'github_administration_write_required',
    required_permission: 'Administration: write'
  });
}

function requireRepositoryBindingContext(state, projectId, canonicalId, actorId) {
  assertProjectMembership(state, projectId, actorId, 'github:write');
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  const repository = state.canonical_repositories.find((item) => item.id === canonicalId);
  if (!project || !repository)
    throw new HttpError(404, { error: !project ? 'project_not_found' : 'canonical_repository_not_found' });
  assertRepositoryDeletionInactive(state, { canonicalRepositoryId: canonicalId, projectId });
  assertNoProtectedRepositoryReplacement(state, projectId, canonicalId);
  return { project, repository };
}

function assertNoProtectedRepositoryReplacement(state, projectId, canonicalId) {
  const protectedBinding = state.project_repository_bindings.find(
    (item) =>
      item.project_id === projectId &&
      item.canonical_repository_id !== canonicalId &&
      item.status !== 'removed' &&
      hasActiveAiwsRepository(state, item.canonical_repository_id)
  );
  if (!protectedBinding) return;
  throw new HttpError(409, {
    error: 'project_aiws_repository_replacement_forbidden',
    canonical_repository_id: protectedBinding.canonical_repository_id,
    action: 'complete_repository_deletion_intent'
  });
}

function hasActiveAiwsRepository(state, canonicalId) {
  return state.canonical_repositories.some(
    (item) => item.id === canonicalId && item.origin === 'aiws_created' && item.remote_state !== 'deleted'
  );
}

function requireIsolatedCheckoutPath(state, project, checkout) {
  const expectedPath = path.resolve(managedRepoPath(project.id));
  const checkoutPath = path.resolve(checkout?.repo_path || expectedPath);
  if (normalizeRepositoryPath(checkoutPath) !== normalizeRepositoryPath(expectedPath))
    throw new HttpError(409, { error: 'repository_checkout_not_project_isolated', expected_path: expectedPath });
  const checkoutIdentity = isolatedCheckoutIdentity(checkoutPath);
  const collision = state.project_repository_bindings.find((item) =>
    repositoryCheckoutCollides(item, project.id, checkoutIdentity)
  );
  if (collision)
    throw new HttpError(409, {
      error: 'repository_checkout_path_shared',
      conflicting_project_id: collision.project_id
    });
  return checkoutPath;
}

function repositoryCheckoutCollides(binding, projectId, checkoutIdentity) {
  if (binding.project_id === projectId || binding.status === 'removed' || !binding.local_checkout_path) return false;
  const existingIdentity = isolatedCheckoutIdentity(path.resolve(binding.local_checkout_path));
  return normalizeRepositoryPath(existingIdentity) === normalizeRepositoryPath(checkoutIdentity);
}

function retirePreviousProjectBindings(state, projectId, canonicalId, timestamp) {
  for (const previous of state.project_repository_bindings.filter(
    (item) => item.project_id === projectId && item.canonical_repository_id !== canonicalId && item.status !== 'removed'
  ))
    Object.assign(previous, { status: 'removed', removed_at: timestamp, updated_at: timestamp });
}

function upsertProjectRepositoryBinding(state, options) {
  const { project, repository, installationId, checkoutPath, permissions, actorId, status, timestamp } = options;
  let binding = state.project_repository_bindings.find(
    (item) => item.project_id === project.id && item.canonical_repository_id === repository.id
  );
  if (!binding) {
    binding = newProjectRepositoryBinding(project.id, repository.id, actorId, timestamp);
    state.project_repository_bindings.push(binding);
  }
  Object.assign(binding, {
    installation_id: String(installationId || repository.installation_id || ''),
    local_checkout_path: checkoutPath,
    managed_worktree_root: path.join(managedProjectRoot(project.id), 'worktrees'),
    permissions: structuredClone(permissions || {}),
    status,
    updated_at: timestamp
  });
  return binding;
}

function newProjectRepositoryBinding(projectId, repositoryId, actorId, timestamp) {
  return {
    id: id('prb'),
    project_id: projectId,
    canonical_repository_id: repositoryId,
    created_by_user_id: actorId,
    created_at: timestamp
  };
}

function upsertLegacyRepositoryBinding(state, options) {
  const { projectId, repository, binding, checkoutPath, permissions, actorId, status } = options;
  let legacy = state.repository_bindings.find(
    (item) =>
      item.project_id === projectId &&
      (item.canonical_repository_id === repository.id ||
        String(item.repository_id) === String(repository.repository_id))
  );
  if (!legacy) {
    legacy = {
      id: id('rbd'),
      project_id: projectId,
      created_by_user_id: actorId,
      created_at: binding.created_at
    };
    state.repository_bindings.push(legacy);
  }
  Object.assign(legacy, {
    canonical_repository_id: repository.id,
    installation_id: binding.installation_id,
    repository_id: repository.repository_id,
    full_name: repository.full_name,
    local_checkout_path: checkoutPath,
    repo_path: checkoutPath,
    permissions: structuredClone(permissions || {}),
    status,
    updated_at: binding.updated_at
  });
}

function activeBindingCount(state, canonicalId) {
  return state.project_repository_bindings.filter(
    (item) => item.canonical_repository_id === canonicalId && item.status !== 'removed'
  ).length;
}
