import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import {
  connectedGithubAccount,
  fetchInstallationRepositories,
  githubJson,
  resolveGithubAppConfig
} from '../github-service.mjs';
import { readSecret } from '../vault.mjs';
import { ensureRepositoryCheckout } from '../repository-checkout.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { id, now } from '../../../../packages/shared/index.mjs';
import { assertProjectLifecycleIdle, withProjectLifecycleLock } from '../project-lifecycle-operations.mjs';
import { actorForRequest, assertProjectMembership, githubIdentityForUser } from '../project-governance-v19.mjs';
import {
  bindCanonicalRepositoryInState,
  repositoryAdministrationPreflight,
  upsertCanonicalRepositoryInState
} from '../repository-lifecycle-v19.mjs';

export const githubRepositoriesV13Routes = [
  makeRoute('POST', '/github/repositories', createRepository),
  makeRoute('POST', '/projects/:id/github/repository', createRepository)
];

async function createRepository({ req, res, params, body, query }) {
  const projectId = params.id || body.project_id || null;
  if (!projectId) throw new HttpError(400, { error: 'repository_project_context_required' });
  return withProjectLifecycleLock(projectId, () => createRepositoryLocked({ req, res, params, body, query }));
}
async function createRepositoryLocked({ req, res, params, body, query }) {
  const snapshot = await readState(),
    actor = actorForRequest(snapshot, req, { strict: Boolean(req.auth?.clientId) }),
    projectId = params.id || body.project_id || null;
  const project = projectId
    ? assertProjectLifecycleIdle(snapshot.projects.find((item) => item.id === projectId))
    : null;
  const adapted = testAdapter(body, query);
  const operationKey = String(
    body.operation_key ||
      body.idempotency_key ||
      req.headers?.['x-idempotency-key'] ||
      req.headers?.['idempotency-key'] ||
      `${projectId || actor.id}:${body.name || ''}`
  )
    .trim()
    .slice(0, 150);
  if (!operationKey) throw new HttpError(400, { error: 'operation_key_required' });
  assertProjectMembership(snapshot, projectId, actor.id, 'github:write');
  const prior = snapshot.import_jobs.find(
    (item) =>
      item.kind === 'github_repository_create' &&
      item.operation_key === operationKey &&
      item.project_id === projectId &&
      (!item.owner_id || item.owner_id === actor.id)
  );
  const foreignPrior = snapshot.import_jobs.find(
    (item) =>
      item.kind === 'github_repository_create' &&
      item.operation_key === operationKey &&
      item.project_id === projectId &&
      item.owner_id &&
      item.owner_id !== actor.id
  );
  if (foreignPrior) throw new HttpError(409, { error: 'idempotency_key_actor_mismatch' });
  if (prior?.status === 'succeeded') {
    const canonicalRepository = snapshot.canonical_repositories.find(
      (item) => String(item.repository_id) === String(prior.repository_id || prior.repository?.id)
    );
    return send(res, 200, {
      operation: prior,
      repository: prior.repository,
      canonical_repository: canonicalRepository || null,
      binding: snapshot.repository_bindings.find((item) => item.project_id === projectId) || null,
      project_repository_binding:
        snapshot.project_repository_bindings.find(
          (item) => item.project_id === projectId && item.canonical_repository_id === canonicalRepository?.id
        ) || null,
      checkout: prior.checkout || null,
      idempotent: true
    });
  }
  const activeBinding = snapshot.project_repository_bindings.find(
    (item) => item.project_id === projectId && item.status !== 'removed'
  );
  if (activeBinding)
    throw new HttpError(409, {
      error: 'project_repository_already_bound',
      canonical_repository_id: activeBinding.canonical_repository_id
    });
  const recoverable = snapshot.import_jobs.find(
    (item) =>
      item.kind === 'github_repository_create' &&
      item.project_id === projectId &&
      item.operation_key !== operationKey &&
      item.repository &&
      ['running', 'failed', 'access_required'].includes(item.status)
  );
  if (recoverable)
    throw new HttpError(409, {
      error: 'repository_creation_recovery_required',
      operation_id: recoverable.id,
      operation_key: recoverable.operation_key
    });
  const preflight = repositoryAdministrationPreflight(snapshot, {
    project_id: projectId,
    installation_id: body.installation_id,
    actor_id: actor.id,
    requested_permission: adapted ? body.test_administration_permission : null
  });
  if (!preflight.ok) {
    const operation = await persistOperation({
      operationKey,
      projectId,
      actorId: actor.id,
      status: 'pending',
      errorCode: preflight.error
    });
    return send(res, 202, {
      status: 'pending',
      error: preflight.error,
      operation,
      installation_id: preflight.installation_id,
      action: 'complete_github_app_installation'
    });
  }
  // A visible installation is the prerequisite for creating a remote
  // repository. Only after that preflight succeeds do we require the user's
  // connected GitHub account/credential used by the live adapter.
  const account = connectedGithubAccount(snapshot, actor.id);
  if (!account) throw new HttpError(409, { error: 'github_account_required' });
  await persistOperation({
    operationKey,
    projectId,
    actorId: actor.id,
    repository: prior?.repository,
    status: 'running',
    errorCode: null,
    incrementAttempt: true
  });
  let repository = prior?.repository || null;
  try {
    repository ||= adapted ? testRepository(body, account) : await createLiveRepository(account, body);
  } catch (error) {
    await persistOperation({
      operationKey,
      projectId,
      actorId: actor.id,
      status: 'failed',
      errorCode: publicErrorCode(error)
    });
    throw error;
  }
  const installation = await findVisibleInstallation(snapshot, repository, adapted, body);
  if (!installation) {
    const operation = await persistOperation({
      operationKey,
      projectId,
      actorId: actor.id,
      repository,
      status: 'access_required',
      errorCode: 'access_required'
    });
    return send(res, 409, {
      error: 'access_required',
      installation_url: '/github/installations/start',
      action: 'install_or_expand_repository_access',
      operation,
      repository: publicRepository(repository)
    });
  }
  const visible = (installation.repositories || []).find((item) => String(item.id) === String(repository.id));
  if (visible?.permissions?.pull !== true || visible?.permissions?.push !== true) {
    const operation = await persistOperation({
      operationKey,
      projectId,
      actorId: actor.id,
      repository,
      status: 'access_required',
      errorCode: 'repository_pull_push_required'
    });
    return send(res, 403, {
      error: 'access_required',
      installation_url: '/github/installations/start',
      action: 'grant_pull_push_access',
      operation
    });
  }
  let checkout = null;
  if (project) {
    try {
      checkout = await ensureRepositoryCheckout(snapshot, {
        project,
        installation,
        repository: visible,
        adapted,
        adaptedFailure: adapted ? body.test_checkout_failure : null
      });
    } catch (error) {
      await persistOperation({
        operationKey,
        projectId,
        actorId: actor.id,
        repository,
        status: 'failed',
        errorCode: publicErrorCode(error)
      });
      throw error;
    }
  }
  const result = await mutate((state) => {
    const currentActor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
      currentProject = project
        ? assertProjectLifecycleIdle(state.projects.find((item) => item.id === project.id))
        : null;
    let operation = state.import_jobs.find(
      (item) =>
        item.kind === 'github_repository_create' &&
        item.operation_key === operationKey &&
        item.project_id === projectId &&
        item.owner_id === currentActor.id
    );
    if (!operation) {
      operation = {
        id: id('imp'),
        kind: 'github_repository_create',
        operation_key: operationKey,
        project_id: projectId,
        created_at: now()
      };
      state.import_jobs.push(operation);
    }
    Object.assign(operation, {
      owner_id: currentActor.id,
      status: 'succeeded',
      repository: publicRepository(repository),
      repository_id: String(repository.id),
      installation_id: installation.installation_id,
      checkout: checkout
        ? { cloned: checkout.cloned, remote_name: checkout.remote_name, head: checkout.head, ready: checkout.ready }
        : null,
      error_code: null,
      updated_at: now()
    });
    let binding = null;
    const canonicalRepository = upsertCanonicalRepositoryInState(
      state,
      {
        ...repository,
        repository_id: repository.id,
        default_branch: visible.default_branch || repository.default_branch || 'main'
      },
      {
        installation_id: installation.installation_id,
        creator_user_id: currentActor.id,
        creator_github_identity: githubIdentityForUser(state, currentActor.id),
        external_import: false,
        administration_permission: 'write'
      }
    );
    if (currentProject) {
      state.repository_bindings = state.repository_bindings.filter((item) => item.project_id !== currentProject.id);
      binding = {
        id: id('rbd'),
        project_id: currentProject.id,
        github_account_id: account.id,
        installation_id: installation.installation_id,
        repository_id: String(repository.id),
        full_name: repository.full_name,
        remote_name: checkout.remote_name,
        permissions: visible.permissions,
        status: checkout.ready ? 'ready' : 'pending',
        created_by_user_id: currentActor.id,
        created_at: now(),
        updated_at: now()
      };
      state.repository_bindings.push(binding);
      bindCanonicalRepositoryInState(state, {
        project_id: currentProject.id,
        canonical_repository_id: canonicalRepository.id,
        installation_id: installation.installation_id,
        checkout,
        permissions: visible.permissions,
        actor_id: currentActor.id,
        status: checkout.ready ? 'ready' : 'pending'
      });
      Object.assign(currentProject, {
        github_account_id: account.id,
        repo_path: checkout.repo_path,
        workspace_root: checkout.repo_path.replace(/[\\/]repo$/, ''),
        managed_workspace_state: 'ready',
        updated_at: now()
      });
    }
    addTrace(
      state,
      'github.repository.created',
      {
        project_id: projectId,
        target_type: 'repository_binding',
        target_id: binding?.id || operation.id,
        summary: `创建 GitHub Repository：${repository.full_name}`,
        data: { private: repository.private, binding_status: binding?.status || null }
      },
      currentActor.id
    );
    return {
      operation,
      repository: publicRepository(repository),
      canonical_repository: canonicalRepository,
      binding,
      project_repository_binding: state.project_repository_bindings.find(
        (item) => item.project_id === projectId && item.canonical_repository_id === canonicalRepository.id
      ),
      checkout: checkout
        ? { cloned: checkout.cloned, remote_name: checkout.remote_name, head: checkout.head, ready: checkout.ready }
        : null,
      idempotent: false
    };
  });
  return send(res, 201, result);
}

async function createLiveRepository(account, body) {
  const name = validateName(body.name),
    token = await readSecret(account.credential_ref);
  if (!token) throw new HttpError(409, { error: 'github_account_reauthorization_required' });
  return githubJson('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      description: String(body.description || '').slice(0, 350),
      private: body.private !== false,
      auto_init: body.auto_init !== false
    })
  });
}
async function findVisibleInstallation(state, repository, adapted, body) {
  if (adapted)
    return (
      state.github_installations.find(
        (item) =>
          String(item.installation_id) === String(body.installation_id || '9001') &&
          (item.repositories || []).some((repo) => String(repo.id) === String(repository.id))
      ) || null
    );
  const config = resolveGithubAppConfig(state);
  if (!config) return null;
  for (const installation of state.github_installations.filter((item) => item.status === 'active')) {
    const synced = await fetchInstallationRepositories(config, installation.installation_id).catch(() => null),
      visible = synced?.repositories?.find((item) => String(item.id) === String(repository.id));
    if (visible) {
      installation.repositories = synced.repositories;
      return installation;
    }
  }
  return null;
}
function persistOperation({
  operationKey,
  projectId,
  actorId,
  repository,
  status,
  errorCode,
  incrementAttempt = false
}) {
  return mutate((state) => {
    let item = state.import_jobs.find(
      (entry) =>
        entry.kind === 'github_repository_create' &&
        entry.operation_key === operationKey &&
        entry.project_id === projectId &&
        (!entry.owner_id || entry.owner_id === actorId)
    );
    if (!item) {
      item = {
        id: id('imp'),
        kind: 'github_repository_create',
        operation_key: operationKey,
        project_id: projectId,
        owner_id: actorId,
        attempt: 0,
        created_at: now()
      };
      state.import_jobs.push(item);
    }
    Object.assign(item, {
      status,
      error_code: errorCode,
      ...(repository ? { repository: publicRepository(repository) } : {}),
      attempt: Number(item.attempt || 0) + (incrementAttempt ? 1 : 0),
      updated_at: now()
    });
    return item;
  });
}
function testRepository(body, account) {
  const name = validateName(body.name);
  return {
    id: String(body.repository_id || 'v13-repository'),
    name,
    full_name: `${account.login || 'aiws-owner'}/${name}`,
    private: body.private !== false,
    html_url: `https://github.com/${account.login || 'aiws-owner'}/${name}`
  };
}
function validateName(value) {
  const name = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(name)) throw new HttpError(400, { error: 'invalid_repository_name' });
  return name;
}
function publicRepository(item) {
  return {
    id: String(item.id),
    name: item.name,
    full_name: item.full_name,
    private: Boolean(item.private),
    html_url: item.html_url
  };
}
function publicErrorCode(error) {
  return error?.payload?.error || (error?.status ? `github_http_${error.status}` : 'github_repository_create_failed');
}
