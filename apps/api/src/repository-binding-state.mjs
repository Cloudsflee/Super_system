import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { addTrace, owner } from './state.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';
import { bindCanonicalRepositoryInState, upsertCanonicalRepositoryInState } from './repository-lifecycle-v19.mjs';

export function commitRepositoryBindingInState(state, { projectId, body, checkout, account, operationKey }) {
  const currentActor = owner(state),
    project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === projectId)),
    installation = requireInstallation(state, body.installation_id),
    repository = requireSelectedRepository(installation, body.repository_id),
    binding = upsertLegacyBinding(state, project, repository, installation, checkout, account, currentActor);
  updateProjectWorkspace(project, checkout, account);
  const canonicalRepository = upsertCanonicalRepository(state, repository, installation),
    projectRepositoryBinding = bindProjectRepository(
      state,
      project,
      canonicalRepository,
      installation,
      repository,
      checkout,
      currentActor
    ),
    operation = completeBindOperation(state, project, binding, checkout, operationKey, currentActor);
  traceRepositoryBinding(state, project, repository, checkout, currentActor);
  return {
    ...binding,
    canonical_repository: canonicalRepository,
    project_repository_binding: projectRepositoryBinding,
    checkout,
    operation,
    idempotent: false
  };
}

function requireInstallation(state, value) {
  const installation = state.github_installations.find(
    (item) => item.id === value || String(item.installation_id) === String(value)
  );
  if (!installation) throw new HttpError(404, { error: 'installation_not_found' });
  return installation;
}

function requireSelectedRepository(installation, repositoryId) {
  const repository = (installation.repositories || []).find(
    (item) => String(item.id) === String(repositoryId) && item.selected !== false
  );
  if (!repository) throw new HttpError(404, { error: 'repository_not_available' });
  return repository;
}

function upsertLegacyBinding(state, project, repository, installation, checkout, account, actor) {
  let binding = state.repository_bindings.find(
    (item) => item.project_id === project.id && String(item.repository_id) === String(repository.id)
  );
  state.repository_bindings = state.repository_bindings.filter(
    (item) => item.project_id !== project.id || item === binding
  );
  if (!binding) {
    binding = { id: id('rbd'), project_id: project.id, created_by_user_id: actor.id, created_at: now() };
    state.repository_bindings.push(binding);
  }
  Object.assign(binding, {
    github_account_id: account?.id || null,
    installation_id: installation.installation_id,
    repository_id: String(repository.id),
    full_name: repository.full_name,
    remote_name: checkout.remote_name,
    permissions: repository.permissions,
    status: 'ready',
    updated_at: now()
  });
  return binding;
}

function updateProjectWorkspace(project, checkout, account) {
  project.repo_path = checkout.repo_path;
  project.workspace_root = checkout.repo_path.replace(/[\\/]repo$/, '');
  project.managed_workspace_state = 'ready';
  project.github_account_id = account?.id || project.github_account_id || null;
  project.settings ||= {};
  project.settings.workspace_root_whitelist = [
    ...new Set([...(project.settings.workspace_root_whitelist || []), checkout.repo_path])
  ];
  project.updated_at = now();
}

function upsertCanonicalRepository(state, repository, installation) {
  return upsertCanonicalRepositoryInState(
    state,
    { ...repository, repository_id: repository.id, default_branch: repository.default_branch || 'main' },
    {
      installation_id: installation.installation_id,
      creator_user_id: null,
      creator_github_identity: null,
      external_import: true,
      administration_permission: repository.permissions?.admin ? 'write' : 'unknown'
    }
  );
}

function bindProjectRepository(state, project, canonicalRepository, installation, repository, checkout, actor) {
  return bindCanonicalRepositoryInState(state, {
    project_id: project.id,
    canonical_repository_id: canonicalRepository.id,
    installation_id: installation.installation_id,
    checkout,
    permissions: repository.permissions,
    actor_id: actor.id,
    status: 'ready'
  });
}

function completeBindOperation(state, project, binding, checkout, operationKey, actor) {
  let operation = state.import_jobs.find(
    (item) =>
      item.kind === 'github_repository_bind' &&
      item.project_id === project.id &&
      item.operation_key === operationKey &&
      (!item.owner_id || item.owner_id === actor.id)
  );
  if (!operation) {
    operation = {
      id: id('imp'),
      kind: 'github_repository_bind',
      project_id: project.id,
      operation_key: operationKey,
      owner_id: actor.id,
      attempt: 1,
      created_at: now()
    };
    state.import_jobs.push(operation);
  }
  Object.assign(operation, {
    status: 'succeeded',
    error_code: null,
    binding_id: binding.id,
    checkout: {
      cloned: checkout.cloned,
      remote_name: checkout.remote_name,
      head: checkout.head,
      ready: checkout.ready
    },
    updated_at: now()
  });
  return operation;
}

function traceRepositoryBinding(state, project, repository, checkout, actor) {
  addTrace(
    state,
    'human.reviewed',
    {
      project_id: project.id,
      summary: `绑定 repository ${repository.full_name}`,
      data: { repo_path: checkout.repo_path, cloned: checkout.cloned }
    },
    actor.id
  );
}
