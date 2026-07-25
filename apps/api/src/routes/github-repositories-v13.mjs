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
  const context = await prepareRepositoryCreation({ req, params, body, query });
  const idempotent = repositoryCreationIdempotentResult(context);
  if (idempotent) return send(res, 200, idempotent);
  assertRepositoryCreationAvailable(context);
  const pending = await repositoryCreationPreflightResult(context);
  if (pending) return send(res, 202, pending);
  const { snapshot, actor } = context;
  const account = connectedGithubAccount(snapshot, actor.id);
  if (!account) throw new HttpError(409, { error: 'github_account_required' });
  const repository = await createRepositoryRemote(context, account);
  const access = await resolveRepositoryCreationAccess(context, repository);
  if (access.response) return send(res, access.response.status, access.response.body);
  const { installation, visible } = access;
  const checkout = await checkoutCreatedRepository(context, repository, installation, visible);
  const result = await mutate((state) =>
    finalizeRepositoryCreationInState(state, context, { account, repository, installation, visible, checkout })
  );
  return send(res, 201, result);
}

async function prepareRepositoryCreation({ req, params, body, query }) {
  const snapshot = await readState();
  const actor = actorForRequest(snapshot, req, { strict: Boolean(req.auth?.clientId) });
  const projectId = params.id || body.project_id || null;
  const project = projectId
    ? assertProjectLifecycleIdle(snapshot.projects.find((item) => item.id === projectId))
    : null;
  const adapted = testAdapter(body, query);
  const operationKey = repositoryCreationOperationKey(req, body, projectId, actor.id);
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
  return { req, body, snapshot, actor, projectId, project, adapted, operationKey, prior };
}

function repositoryCreationOperationKey(req, body, projectId, actorId) {
  return String(
    body.operation_key ||
      body.idempotency_key ||
      req.headers?.['x-idempotency-key'] ||
      req.headers?.['idempotency-key'] ||
      `${projectId || actorId}:${body.name || ''}`
  )
    .trim()
    .slice(0, 150);
}

function repositoryCreationIdempotentResult(context) {
  const { prior, snapshot, projectId } = context;
  if (prior?.status !== 'succeeded') return null;
  const canonicalRepository = snapshot.canonical_repositories.find(
    (item) => String(item.repository_id) === String(prior.repository_id || prior.repository?.id)
  );
  return {
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
  };
}

function assertRepositoryCreationAvailable(context) {
  const activeBinding = context.snapshot.project_repository_bindings.find(
    (item) => item.project_id === context.projectId && item.status !== 'removed'
  );
  if (activeBinding)
    throw new HttpError(409, {
      error: 'project_repository_already_bound',
      canonical_repository_id: activeBinding.canonical_repository_id
    });
  const recoverable = context.snapshot.import_jobs.find(
    (item) =>
      item.kind === 'github_repository_create' &&
      item.project_id === context.projectId &&
      item.operation_key !== context.operationKey &&
      item.repository &&
      ['running', 'failed', 'access_required'].includes(item.status)
  );
  if (recoverable)
    throw new HttpError(409, {
      error: 'repository_creation_recovery_required',
      operation_id: recoverable.id,
      operation_key: recoverable.operation_key
    });
}

async function repositoryCreationPreflightResult(context) {
  const preflight = repositoryAdministrationPreflight(context.snapshot, {
    project_id: context.projectId,
    installation_id: context.body.installation_id,
    actor_id: context.actor.id,
    requested_permission: context.adapted ? context.body.test_administration_permission : null
  });
  if (preflight.ok) return null;
  const operation = await persistOperation({
    operationKey: context.operationKey,
    projectId: context.projectId,
    actorId: context.actor.id,
    status: 'pending',
    errorCode: preflight.error
  });
  return {
    status: 'pending',
    error: preflight.error,
    operation,
    installation_id: preflight.installation_id,
    action: 'complete_github_app_installation'
  };
}

async function createRepositoryRemote(context, account) {
  await persistOperation({
    operationKey: context.operationKey,
    projectId: context.projectId,
    actorId: context.actor.id,
    repository: context.prior?.repository,
    status: 'running',
    errorCode: null,
    incrementAttempt: true
  });
  try {
    return (
      context.prior?.repository ||
      (context.adapted ? testRepository(context.body, account) : await createLiveRepository(account, context.body))
    );
  } catch (error) {
    await persistRepositoryCreationFailure(context, null, error);
    throw error;
  }
}

async function resolveRepositoryCreationAccess(context, repository) {
  const installation = await findVisibleInstallation(context.snapshot, repository, context.adapted, context.body);
  if (!installation) {
    const operation = await persistRepositoryAccessRequired(context, repository, 'access_required');
    return {
      response: {
        status: 409,
        body: {
          error: 'access_required',
          installation_url: '/github/installations/start',
          action: 'install_or_expand_repository_access',
          operation,
          repository: publicRepository(repository)
        }
      }
    };
  }
  const visible = (installation.repositories || []).find((item) => String(item.id) === String(repository.id));
  if (visible?.permissions?.pull === true && visible?.permissions?.push === true) return { installation, visible };
  const operation = await persistRepositoryAccessRequired(context, repository, 'repository_pull_push_required');
  return {
    response: {
      status: 403,
      body: {
        error: 'access_required',
        installation_url: '/github/installations/start',
        action: 'grant_pull_push_access',
        operation
      }
    }
  };
}

function persistRepositoryAccessRequired(context, repository, errorCode) {
  return persistOperation({
    operationKey: context.operationKey,
    projectId: context.projectId,
    actorId: context.actor.id,
    repository,
    status: 'access_required',
    errorCode
  });
}

async function checkoutCreatedRepository(context, repository, installation, visible) {
  if (!context.project) return null;
  try {
    return await ensureRepositoryCheckout(context.snapshot, {
      project: context.project,
      installation,
      repository: visible,
      adapted: context.adapted,
      adaptedFailure: context.adapted ? context.body.test_checkout_failure : null
    });
  } catch (error) {
    await persistRepositoryCreationFailure(context, repository, error);
    throw error;
  }
}

function persistRepositoryCreationFailure(context, repository, error) {
  return persistOperation({
    operationKey: context.operationKey,
    projectId: context.projectId,
    actorId: context.actor.id,
    repository,
    status: 'failed',
    errorCode: publicErrorCode(error)
  });
}

function finalizeRepositoryCreationInState(state, context, created) {
  const { req, project, projectId, operationKey } = context;
  const { account, repository, installation, visible, checkout } = created;
  const currentActor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  const currentProject = project
    ? assertProjectLifecycleIdle(state.projects.find((item) => item.id === project.id))
    : null;
  const operation = completeRepositoryCreationOperation(state, {
    currentActor,
    projectId,
    operationKey,
    repository,
    installation,
    checkout
  });
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
  const binding = currentProject
    ? bindCreatedRepository(state, {
        currentProject,
        currentActor,
        account,
        repository,
        installation,
        visible,
        checkout,
        canonicalRepository
      })
    : null;
  traceRepositoryCreation(state, projectId, repository, operation, binding, currentActor.id);
  return {
    operation,
    repository: publicRepository(repository),
    canonical_repository: canonicalRepository,
    binding,
    project_repository_binding: state.project_repository_bindings.find(
      (item) => item.project_id === projectId && item.canonical_repository_id === canonicalRepository.id
    ),
    checkout: publicCheckout(checkout),
    idempotent: false
  };
}

function completeRepositoryCreationOperation(state, input) {
  let operation = state.import_jobs.find(
    (item) =>
      item.kind === 'github_repository_create' &&
      item.operation_key === input.operationKey &&
      item.project_id === input.projectId &&
      item.owner_id === input.currentActor.id
  );
  if (!operation) {
    operation = {
      id: id('imp'),
      kind: 'github_repository_create',
      operation_key: input.operationKey,
      project_id: input.projectId,
      created_at: now()
    };
    state.import_jobs.push(operation);
  }
  Object.assign(operation, {
    owner_id: input.currentActor.id,
    status: 'succeeded',
    repository: publicRepository(input.repository),
    repository_id: String(input.repository.id),
    installation_id: input.installation.installation_id,
    checkout: publicCheckout(input.checkout),
    error_code: null,
    updated_at: now()
  });
  return operation;
}

function bindCreatedRepository(state, input) {
  const { currentProject, currentActor, account, repository, installation, visible, checkout, canonicalRepository } =
    input;
  state.repository_bindings = state.repository_bindings.filter((item) => item.project_id !== currentProject.id);
  const binding = {
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
  return binding;
}

function traceRepositoryCreation(state, projectId, repository, operation, binding, actorId) {
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
    actorId
  );
}

function publicCheckout(checkout) {
  return checkout
    ? { cloned: checkout.cloned, remote_name: checkout.remote_name, head: checkout.head, ready: checkout.ready }
    : null;
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
