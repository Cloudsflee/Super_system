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
import { commitRepositoryBindingInState } from '../repository-binding-state.mjs';
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
  const snapshot = await readState(),
    context = repositoryBindingContext(snapshot, params.id, body);
  if (context.priorResult) return send(res, 200, context.priorResult);
  await assertRepositoryBindingAccess(context);
  const checkout = await checkoutBoundRepository(snapshot, body, context),
    result = await mutate((state) =>
      commitRepositoryBindingInState(state, {
        projectId: params.id,
        body,
        checkout,
        account: context.account,
        operationKey: context.operationKey
      })
    );
  return send(res, 200, result);
}

function repositoryBindingContext(snapshot, projectId, body) {
  const sourceProject = assertProjectLifecycleIdle(snapshot.projects.find((item) => item.id === projectId)),
    actor = owner(snapshot),
    account = connectedGithubAccount(snapshot, actor.id),
    operationKey = String(body.operation_key || `${sourceProject.id}:${body.installation_id}:${body.repository_id}`)
      .trim()
      .slice(0, 150),
    prior = matchingBindOperation(snapshot, sourceProject.id, operationKey, actor.id),
    priorBinding = snapshot.repository_bindings.find(
      (item) => item.project_id === sourceProject.id && String(item.repository_id) === String(body.repository_id)
    );
  if (prior?.status === 'succeeded' && priorBinding)
    return {
      priorResult: { ...priorBinding, checkout: prior.checkout, operation: prior, idempotent: true }
    };
  const sourceInstallation = findInstallation(snapshot, body.installation_id),
    sourceRepository = selectedRepository(sourceInstallation, body.repository_id);
  return { sourceProject, actor, account, operationKey, sourceInstallation, sourceRepository, priorResult: null };
}

function matchingBindOperation(state, projectId, operationKey, actorId) {
  return state.import_jobs.find(
    (item) =>
      item.kind === 'github_repository_bind' &&
      item.project_id === projectId &&
      item.operation_key === operationKey &&
      (!item.owner_id || item.owner_id === actorId)
  );
}

function selectedRepository(installation, repositoryId) {
  const repository = (installation.repositories || []).find(
    (item) => String(item.id) === String(repositoryId) && item.selected !== false
  );
  if (!repository) throw new HttpError(404, { error: 'repository_not_available' });
  return repository;
}

async function assertRepositoryBindingAccess(context) {
  if (context.sourceRepository.permissions?.pull === true && context.sourceRepository.permissions?.push === true)
    return;
  await persistBindOperation({
    operationKey: context.operationKey,
    projectId: context.sourceProject.id,
    actorId: context.actor.id,
    status: 'access_required',
    errorCode: 'repository_pull_push_required'
  });
  throw new HttpError(403, {
    error: 'access_required',
    installation_url: '/github/installations/start',
    action: 'grant_pull_push_access'
  });
}

async function checkoutBoundRepository(snapshot, body, context) {
  await persistBindOperation({
    operationKey: context.operationKey,
    projectId: context.sourceProject.id,
    actorId: context.actor.id,
    status: 'running',
    errorCode: null,
    incrementAttempt: true
  });
  const adapted = testAdapter(body);
  try {
    return await ensureRepositoryCheckout(snapshot, {
      project: context.sourceProject,
      installation: context.sourceInstallation,
      repository: context.sourceRepository,
      adapted,
      adaptedFailure: adapted ? body.test_checkout_failure : null
    });
  } catch (error) {
    await persistBindOperation({
      operationKey: context.operationKey,
      projectId: context.sourceProject.id,
      actorId: context.actor.id,
      status: 'failed',
      errorCode: error?.payload?.error || 'repository_checkout_failed'
    });
    throw error;
  }
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
