import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { testAdapter } from '../test-adapter.mjs';
import {
  connectedGithubAccount,
  fetchInstallationRepositories,
  fetchUserInstallations,
  resolveGithubAppConfig
} from '../github-service.mjs';
import { id, now } from '../../../../packages/shared/index.mjs';
import { authorizeRepositoryAction } from '../authorization.mjs';
import { ensureRepositoryCheckout } from '../repository-checkout.mjs';
import { assertProjectLifecycleIdle, withProjectLifecycleLock } from '../project-lifecycle-operations.mjs';
import { bindCanonicalRepositoryInState, upsertCanonicalRepositoryInState } from '../repository-lifecycle-v19.mjs';
import {
  accessibleProjectIds,
  actorForRequest,
  assertProjectRead,
  instanceOwnerId,
  projectRole,
  requireInstanceOwner
} from '../project-governance-v19.mjs';

export const githubInstallationsV12Routes = [
  makeRoute('POST', '/github/installations/start', installationStart),
  makeRoute('POST', '/github/installations/discover', discoverInstallations),
  makeRoute('POST', '/github/installations/setup', installationSetup),
  makeRoute('GET', '/github/installations', listInstallations),
  makeRoute('GET', '/github/installations/:id/repositories', listRepositories),
  makeRoute('POST', '/github/installations/:id/repositories/sync', syncRepositories),
  makeRoute('PUT', '/github/installations/:id/repositories', selectRepositories),
  makeRoute('POST', '/github/repositories/sync', syncAll),
  makeRoute('PUT', '/projects/:id/repository-binding', bindRepository),
  makeRoute('POST', '/github/permissions/check', checkPermissions)
];

async function installationStart({ req, res, body, query }) {
  const state = await readState();
  requireInstanceOwner(state, actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) })?.id);
  const config = resolveGithubAppConfig(state);
  const slug = config?.slug;
  if (testAdapter(body, query)) {
    const installation = await createOrSyncTestInstallation(body);
    return send(res, 200, { installed: true, selection_required: true, installation });
  }
  if (!slug) throw new HttpError(400, { error: 'github_app_slug_required' });
  return send(res, 200, { ready: false, installation_url: `https://github.com/apps/${slug}/installations/new` });
}

async function installationSetup({ req, res, body, query }) {
  const state = await readState();
  requireInstanceOwner(state, actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) })?.id);
  if (!body.installation_id) throw new HttpError(400, { error: 'installation_id_required' });
  const result = testAdapter(body, query)
    ? await createOrSyncTestInstallation(body)
    : await syncInstallation(String(body.installation_id), body.account || {});
  return send(res, 200, result);
}

async function discoverInstallations({ req, res, body, query }) {
  const stateForAuth = await readState();
  requireInstanceOwner(stateForAuth, actorForRequest(stateForAuth, req, { strict: Boolean(req.auth?.clientId) })?.id);
  if (testAdapter(body, query)) {
    const installation = await createOrSyncTestInstallation(body);
    return send(res, 200, { installed: true, installations: [installation] });
  }
  const state = await readState();
  const config = resolveGithubAppConfig(state);
  const account = connectedGithubAccount(state, owner(state).id);
  if (!config) throw new HttpError(400, { error: 'github_app_config_required' });
  if (!account)
    throw new HttpError(409, {
      error: 'github_account_reauthorization_required',
      message: '请重新完成 GitHub Owner 授权。'
    });
  const response = await fetchUserInstallations(account);
  const available = (response.installations || []).filter(
    (item) => !item.app_id || String(item.app_id) === String(config.app_id)
  );
  const installations = [];
  for (const item of available) installations.push(await syncInstallation(String(item.id), item.account || {}));
  return send(res, 200, { installed: installations.length > 0, installations });
}

async function listInstallations({ req, res }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  return send(res, 200, visibleInstallations(state, actor.id, req.auth?.extra?.project_allowlist));
}

async function listRepositories({ req, res, params }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
    installation = visibleInstallations(state, actor.id, req.auth?.extra?.project_allowlist).find(
      (item) => item.id === params.id || String(item.installation_id) === String(params.id)
    );
  if (!installation) throw new HttpError(404, { error: 'installation_not_found' });
  return send(res, 200, installation.repositories || []);
}

async function syncRepositories({ req, res, params, body, query }) {
  const state = await readState();
  requireInstanceOwner(state, actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) })?.id);
  const result = testAdapter(body, query)
    ? await createOrSyncTestInstallation({ ...body, installation_id: params.id })
    : await syncInstallation(params.id);
  return send(res, 200, result);
}

async function selectRepositories({ req, res, params, body }) {
  const authState = await readState();
  requireInstanceOwner(authState, actorForRequest(authState, req, { strict: Boolean(req.auth?.clientId) })?.id);
  const selected = new Set((body.repository_ids || []).map(String));
  const result = await mutate((state) => {
    const actor = owner(state),
      installation = findInstallation(state, params.id);
    installation.repositories = (installation.repositories || []).map((repo) => ({
      ...repo,
      selected: selected.has(String(repo.id))
    }));
    installation.updated_at = now();
    addTrace(
      state,
      'github.installation.synced',
      { summary: `选择 ${selected.size} 个 GitHub repositories。` },
      actor.id
    );
    return installation;
  });
  return send(res, 200, result);
}

async function syncAll({ req, res, body, query }) {
  const state = await readState();
  requireInstanceOwner(state, actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) })?.id);
  const results = [];
  for (const item of state.github_installations.filter((entry) => entry.status === 'active')) {
    results.push(
      testAdapter(body, query)
        ? await createOrSyncTestInstallation({ ...body, installation_id: item.installation_id })
        : await syncInstallation(item.installation_id)
    );
  }
  return send(res, 200, { installations: results });
}

async function bindRepository({ res, params, body }) {
  return withProjectLifecycleLock(params.id, () => bindRepositoryLocked({ res, params, body }));
}
async function bindRepositoryLocked({ res, params, body }) {
  const snapshot = await readState();
  const sourceProject = assertProjectLifecycleIdle(snapshot.projects.find((item) => item.id === params.id));
  const actor = owner(snapshot),
    account = connectedGithubAccount(snapshot, actor.id);
  const operationKey = String(body.operation_key || `${sourceProject.id}:${body.installation_id}:${body.repository_id}`)
    .trim()
    .slice(0, 150);
  const prior = snapshot.import_jobs.find(
    (item) =>
      item.kind === 'github_repository_bind' &&
      item.project_id === sourceProject.id &&
      item.operation_key === operationKey &&
      (!item.owner_id || item.owner_id === actor.id)
  );
  const priorBinding = snapshot.repository_bindings.find(
    (item) => item.project_id === sourceProject.id && String(item.repository_id) === String(body.repository_id)
  );
  if (prior?.status === 'succeeded' && priorBinding)
    return send(res, 200, { ...priorBinding, checkout: prior.checkout, operation: prior, idempotent: true });
  const sourceInstallation = findInstallation(snapshot, body.installation_id);
  const sourceRepository = (sourceInstallation.repositories || []).find(
    (item) => String(item.id) === String(body.repository_id) && item.selected !== false
  );
  if (!sourceRepository) throw new HttpError(404, { error: 'repository_not_available' });
  if (sourceRepository.permissions?.pull !== true || sourceRepository.permissions?.push !== true) {
    await persistBindOperation({
      operationKey,
      projectId: sourceProject.id,
      actorId: actor.id,
      status: 'access_required',
      errorCode: 'repository_pull_push_required'
    });
    throw new HttpError(403, {
      error: 'access_required',
      installation_url: '/github/installations/start',
      action: 'grant_pull_push_access'
    });
  }
  await persistBindOperation({
    operationKey,
    projectId: sourceProject.id,
    actorId: actor.id,
    status: 'running',
    errorCode: null,
    incrementAttempt: true
  });
  let checkout;
  const adapted = testAdapter(body);
  try {
    checkout = await ensureRepositoryCheckout(snapshot, {
      project: sourceProject,
      installation: sourceInstallation,
      repository: sourceRepository,
      adapted,
      adaptedFailure: adapted ? body.test_checkout_failure : null
    });
  } catch (error) {
    await persistBindOperation({
      operationKey,
      projectId: sourceProject.id,
      actorId: actor.id,
      status: 'failed',
      errorCode: error?.payload?.error || 'repository_checkout_failed'
    });
    throw error;
  }
  const result = await mutate((state) => {
    const currentActor = owner(state),
      project = assertProjectLifecycleIdle(state.projects.find((item) => item.id === params.id));
    const installation = findInstallation(state, body.installation_id);
    const repository = (installation.repositories || []).find(
      (item) => String(item.id) === String(body.repository_id) && item.selected !== false
    );
    if (!repository) throw new HttpError(404, { error: 'repository_not_available' });
    let binding = state.repository_bindings.find(
      (item) => item.project_id === project.id && String(item.repository_id) === String(repository.id)
    );
    state.repository_bindings = state.repository_bindings.filter(
      (item) => item.project_id !== project.id || item === binding
    );
    if (!binding) {
      binding = { id: id('rbd'), project_id: project.id, created_by_user_id: currentActor.id, created_at: now() };
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
    project.repo_path = checkout.repo_path;
    project.workspace_root = checkout.repo_path.replace(/[\\/]repo$/, '');
    project.managed_workspace_state = 'ready';
    project.github_account_id = account?.id || project.github_account_id || null;
    project.settings ||= {};
    project.settings.workspace_root_whitelist = [
      ...new Set([...(project.settings.workspace_root_whitelist || []), checkout.repo_path])
    ];
    project.updated_at = now();
    const canonicalRepository = upsertCanonicalRepositoryInState(
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
    const projectRepositoryBinding = bindCanonicalRepositoryInState(state, {
      project_id: project.id,
      canonical_repository_id: canonicalRepository.id,
      installation_id: installation.installation_id,
      checkout,
      permissions: repository.permissions,
      actor_id: currentActor.id,
      status: 'ready'
    });
    let operation = state.import_jobs.find(
      (item) =>
        item.kind === 'github_repository_bind' &&
        item.project_id === project.id &&
        item.operation_key === operationKey &&
        (!item.owner_id || item.owner_id === currentActor.id)
    );
    if (!operation) {
      operation = {
        id: id('imp'),
        kind: 'github_repository_bind',
        project_id: project.id,
        operation_key: operationKey,
        owner_id: currentActor.id,
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
    addTrace(
      state,
      'human.reviewed',
      {
        project_id: project.id,
        summary: `绑定 repository ${repository.full_name}`,
        data: { repo_path: checkout.repo_path, cloned: checkout.cloned }
      },
      currentActor.id
    );
    return {
      ...binding,
      canonical_repository: canonicalRepository,
      project_repository_binding: projectRepositoryBinding,
      checkout,
      operation,
      idempotent: false
    };
  });
  return send(res, 200, result);
}

async function checkPermissions({ req, res, body }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, body.project_id, actor.id);
  const binding = state.repository_bindings.find((item) => item.project_id === body.project_id);
  const permission = binding?.permissions || {};
  const result = authorizeRepositoryAction({
    role: projectRole(state, body.project_id, actor.id) || actor.role,
    permissions: permission,
    operation: body.operation || 'read'
  });
  return send(res, result.allowed ? 200 : 403, result);
}

async function createOrSyncTestInstallation(body = {}) {
  const installationId = String(body.installation_id || '9001');
  const repositories = body.repositories || [
    {
      id: 7001,
      name: 'workspace',
      full_name: 'aiws/workspace',
      private: true,
      permissions: { pull: true, push: true, admin: true }
    }
  ];
  return mutate((state) =>
    persistInstallation(
      state,
      installationId,
      { login: body.login || 'aiws-owner', type: 'User' },
      repositories,
      resolveGithubAppConfig(state)?.app_id
    )
  );
}

async function syncInstallation(installationId, account = {}) {
  const state = await readState(),
    config = resolveGithubAppConfig(state);
  if (!config) throw new HttpError(400, { error: 'github_app_config_required' });
  const result = await fetchInstallationRepositories(config, installationId);
  return mutate((data) => persistInstallation(data, installationId, account, result.repositories || [], config.app_id));
}

function persistInstallation(state, installationId, account, repositories, appId) {
  const actor = owner(state);
  let item = state.github_installations.find((entry) => String(entry.installation_id) === String(installationId));
  if (!item) {
    item = { id: id('ghi'), installation_id: String(installationId), created_at: now() };
    state.github_installations.push(item);
  }
  const previous = new Map((item.repositories || []).map((repo) => [String(repo.id), repo]));
  Object.assign(item, {
    app_id: String(appId || ''),
    account,
    status: 'active',
    repositories: repositories.map((repo) => ({
      id: String(repo.id),
      name: repo.name,
      full_name: repo.full_name,
      private: Boolean(repo.private),
      permissions: repo.permissions || { pull: true, push: false, admin: false },
      selected: previous.get(String(repo.id))?.selected ?? false
    })),
    updated_at: now()
  });
  addTrace(
    state,
    'github.installation.synced',
    { summary: `GitHub installation ${installationId}: ${item.repositories.length} repositories` },
    actor.id
  );
  return item;
}

function findInstallation(state, value) {
  const item = state.github_installations.find(
    (entry) => entry.id === value || String(entry.installation_id) === String(value)
  );
  if (!item) throw new HttpError(404, { error: 'installation_not_found' });
  return item;
}
function visibleInstallations(state, actorId, projectAllowlist = []) {
  if (actorId === instanceOwnerId(state) && !projectAllowlist?.length) return state.github_installations;
  const allowed = accessibleProjectIds(state, actorId),
    tokenProjects = new Set(projectAllowlist || []),
    remoteIds = new Set();
  if (tokenProjects.size)
    for (const projectId of [...allowed]) if (!tokenProjects.has(projectId)) allowed.delete(projectId);
  for (const binding of state.project_repository_bindings.filter(
    (item) => allowed.has(item.project_id) && item.status !== 'removed'
  )) {
    const repository = state.canonical_repositories.find((item) => item.id === binding.canonical_repository_id);
    if (repository) remoteIds.add(String(repository.repository_id));
  }
  for (const binding of state.repository_bindings.filter(
    (item) => allowed.has(item.project_id) && item.status !== 'removed'
  ))
    remoteIds.add(String(binding.repository_id));
  return state.github_installations
    .map((item) => ({
      ...item,
      repositories: (item.repositories || []).filter((repository) => remoteIds.has(String(repository.id)))
    }))
    .filter((item) => item.repositories.length);
}
function persistBindOperation({ operationKey, projectId, actorId, status, errorCode, incrementAttempt = false }) {
  return mutate((state) => {
    let item = state.import_jobs.find(
      (entry) =>
        entry.kind === 'github_repository_bind' &&
        entry.project_id === projectId &&
        entry.operation_key === operationKey &&
        (!entry.owner_id || entry.owner_id === actorId)
    );
    if (!item) {
      item = {
        id: id('imp'),
        kind: 'github_repository_bind',
        project_id: projectId,
        operation_key: operationKey,
        owner_id: actorId,
        attempt: 0,
        created_at: now()
      };
      state.import_jobs.push(item);
    }
    Object.assign(item, {
      status,
      error_code: errorCode,
      attempt: Number(item.attempt || 0) + (incrementAttempt ? 1 : 0),
      updated_at: now()
    });
    return item;
  });
}
