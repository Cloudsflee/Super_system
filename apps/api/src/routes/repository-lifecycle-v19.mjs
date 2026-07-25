import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, readState } from '../state.mjs';
import { createInstallationToken, githubJson, resolveGithubAppConfig } from '../github-service.mjs';
import { testAdapter } from '../test-adapter.mjs';
import { actorForRequest, assertProjectRead, membershipFor } from '../project-governance-v19.mjs';
import {
  completeRepositoryDeletionInState,
  confirmRepositoryDeletionInState,
  consentRepositoryDeletionInState,
  createRepositoryDeletionIntentInState,
  prepareRepositoryDeletionExecutionInState,
  rejectDirectRepositoryDelete,
  expireRepositoryDeletionIntentInState
} from '../repository-lifecycle-v19.mjs';

export const repositoryLifecycleV19Routes = [
  makeRoute('GET', '/projects/:id/github/repositories', listProjectRepositories),
  makeRoute('GET', '/canonical-repositories/:id', getCanonicalRepository),
  makeRoute('GET', '/repository-deletion-intents/:id', getDeletionIntent),
  makeRoute('POST', '/canonical-repositories/:id/deletion-intents', createDeletionIntent),
  makeRoute('POST', '/github/repositories/:id/deletion-intents', createDeletionIntent),
  makeRoute('POST', '/github/repositories/:id/deletion-intent', createDeletionIntent),
  makeRoute('POST', '/repository-deletion-intents/:id/consent', consentDeletion),
  makeRoute('POST', '/repository-deletion-intents/:id/creator-consent', consentDeletion),
  makeRoute('POST', '/repository-deletion-intents/:id/confirm', confirmDeletion),
  makeRoute('POST', '/repository-deletion-intents/:id/project-confirmation', confirmDeletion),
  makeRoute('POST', '/repository-deletion-intents/:id/execute', executeDeletion),
  makeRoute('DELETE', '/projects/:id/github/repository', directDelete),
  makeRoute('DELETE', '/github/repositories/:id', directDelete),
  makeRoute('DELETE', '/canonical-repositories/:id', directDelete)
];

async function listProjectRepositories({ req, res, params }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, params.id, actor.id);
  const bindings = state.project_repository_bindings.filter(
    (item) => item.project_id === params.id && item.status !== 'removed'
  );
  return send(res, 200, {
    project_id: params.id,
    bindings,
    repositories: bindings
      .map((binding) => state.canonical_repositories.find((item) => item.id === binding.canonical_repository_id))
      .filter(Boolean)
  });
}

async function getCanonicalRepository({ req, res, params }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
    repository = state.canonical_repositories.find(
      (item) => item.id === params.id || String(item.repository_id) === String(params.id)
    );
  if (!repository) return send(res, 404, { error: 'canonical_repository_not_found' });
  const allBindings = state.project_repository_bindings.filter(
    (item) => item.canonical_repository_id === repository.id
  );
  const bindings = allBindings.filter((item) => item.status !== 'removed');
  const visible = bindings.filter(
    (item) => membershipFor(state, item.project_id, actor.id) || state.instance_owner_user_id === actor.id
  );
  const authorized =
    actor.id === state.instance_owner_user_id ||
    allBindings.some((item) => membershipFor(state, item.project_id, actor.id));
  if (!authorized) return send(res, 403, { error: 'project_access_denied' });
  return send(res, 200, {
    repository,
    bindings: visible,
    deletion_intents: state.repository_deletion_intents
      .filter((item) => item.canonical_repository_id === repository.id)
      .map((item) => publicDeletionIntent(state, item, actor.id))
  });
}

async function getDeletionIntent({ req, res, params }) {
  await mutate((state) => expireRepositoryDeletionIntentInState(state, params.id));
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
    intent = state.repository_deletion_intents.find((item) => item.id === params.id);
  if (!intent) return send(res, 404, { error: 'repository_deletion_intent_not_found' });
  const visible =
    state.project_repository_bindings.some(
      (item) =>
        item.canonical_repository_id === intent.canonical_repository_id &&
        item.status !== 'removed' &&
        membershipFor(state, item.project_id, actor.id)
    ) || (intent.snapshot?.bindings || []).some((item) => membershipFor(state, item.project_id, actor.id));
  if (!visible && state.instance_owner_user_id !== actor.id) return send(res, 403, { error: 'project_access_denied' });
  return send(res, 200, publicDeletionIntent(state, intent, actor.id));
}

async function createDeletionIntent({ req, res, params, body }) {
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
      created = createRepositoryDeletionIntentInState(state, params.id, body, actor.id);
    addTrace(
      state,
      'repository.deletion_intent.created',
      {
        project_id: created.intent.snapshot.bindings[0]?.project_id || null,
        target_type: 'repository_deletion_intent',
        target_id: created.intent.id,
        summary: '创建 Repository deletion intent',
        data: {
          canonical_repository_id: created.intent.canonical_repository_id,
          revision: created.intent.revision,
          snapshot_hash: created.intent.snapshot_hash
        }
      },
      actor.id
    );
    return { ...created, intent: publicDeletionIntent(state, created.intent, actor.id) };
  });
  return send(res, result.idempotent ? 200 : 201, result);
}

async function consentDeletion({ req, res, params, body }) {
  await mutate((state) => expireRepositoryDeletionIntentInState(state, params.id));
  const intent = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
      value = consentRepositoryDeletionInState(state, params.id, body, actor.id);
    addTrace(
      state,
      'repository.deletion_intent.consented',
      {
        project_id: value.snapshot.bindings[0]?.project_id || null,
        target_type: 'repository_deletion_intent',
        target_id: value.id,
        summary: 'Repository 创建者已 consent',
        data: { revision: value.revision }
      },
      actor.id
    );
    return publicDeletionIntent(state, value, actor.id);
  });
  return send(res, 200, intent);
}

async function confirmDeletion({ req, res, params, body }) {
  await mutate((state) => expireRepositoryDeletionIntentInState(state, params.id));
  const intent = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) }),
      value = confirmRepositoryDeletionInState(state, params.id, body, actor.id);
    addTrace(
      state,
      'repository.deletion_intent.confirmed',
      {
        project_id: body.project_id,
        target_type: 'repository_deletion_intent',
        target_id: value.id,
        summary: 'Project owner 已确认 Repository 删除',
        data: { revision: value.revision }
      },
      actor.id
    );
    return publicDeletionIntent(state, value, actor.id);
  });
  return send(res, 200, intent);
}

async function executeDeletion({ req, res, params, body, query }) {
  await mutate((state) => expireRepositoryDeletionIntentInState(state, params.id));
  const actorId = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    prepareRepositoryDeletionExecutionInState(state, params.id, body, actor.id);
    return actor.id;
  });
  const snapshot = await readState(),
    intent = snapshot.repository_deletion_intents.find((item) => item.id === params.id),
    repository = snapshot.canonical_repositories.find((item) => item.id === intent.canonical_repository_id);
  const remoteResult = await deleteRemoteRepository(snapshot, repository, body, query);
  const completed = await mutate((state) => {
    const result = completeRepositoryDeletionInState(state, params.id, remoteResult, actorId);
    addTrace(
      state,
      result.uncertain
        ? 'repository.deletion.reconciled'
        : result.failed
          ? 'repository.deletion.rejected'
          : 'repository.deleted',
      {
        project_id: intent.snapshot.bindings[0]?.project_id || null,
        target_type: 'canonical_repository',
        target_id: repository.id,
        summary: result.uncertain
          ? 'Repository 删除结果不确定，等待 reconciliation'
          : result.failed
            ? 'Repository 删除被远端拒绝'
            : 'Repository 远端删除完成',
        data: { deletion_intent_id: params.id, remote_status: remoteResult.status }
      },
      actorId
    );
    return { ...result, intent: publicDeletionIntent(state, result.intent, actorId) };
  });
  if (completed.uncertain)
    return send(res, 502, { error: completed.error, reconciliation_required: true, intent: completed.intent });
  if (completed.failed) return send(res, 409, { error: completed.error, intent: completed.intent });
  return send(res, 200, completed);
}

async function directDelete() {
  return rejectDirectRepositoryDelete();
}

async function deleteRemoteRepository(state, repository, body, query) {
  if (testAdapter(body, query)) {
    const status = Number(body.test_github_status || body.test_status || 204);
    return status === 204
      ? { ok: true, status, request_id: body.test_request_id || null }
      : { ok: false, status, error: `github_http_${status}`, uncertain: status === 404 || status >= 500 };
  }
  const account = state.connected_accounts.find(
    (item) => item.user_id === repository.creator_user_id && item.provider === 'github' && item.status === 'connected'
  );
  if (!account) return { ok: false, status: null, error: 'repository_creator_identity_unverifiable', uncertain: true };
  try {
    const config = resolveGithubAppConfig(state);
    if (!config || !repository.installation_id)
      return { ok: false, status: null, error: 'github_administration_write_required', uncertain: false };
    const access = await createInstallationToken(config, repository.installation_id);
    await githubJson(
      `https://api.github.com/repos/${encodeURIComponent(repository.full_name.split('/')[0])}/${encodeURIComponent(repository.full_name.split('/')[1])}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${access.token}` } }
    );
    return { ok: true, status: 204 };
  } catch (error) {
    return {
      ok: false,
      status: Number(error.status || 0) || null,
      error: error.payload?.error || error.payload?.message || error.message || 'github_repository_delete_failed',
      uncertain: !error.status || error.status === 404 || error.status >= 500
    };
  }
}

function publicDeletionIntent(state, intent, actorId) {
  const value = structuredClone(intent),
    repository = state.canonical_repositories.find((item) => item.id === intent.canonical_repository_id);
  const visibleProjects = visibleRepositoryProjectIds(state, intent.canonical_repository_id, actorId, intent);
  for (const key of ['snapshot', 'execution_snapshot']) {
    const snapshot = value[key];
    if (!snapshot) continue;
    snapshot.bindings = (snapshot.bindings || []).filter((item) => visibleProjects.has(item.project_id));
    snapshot.active_deliveries = (snapshot.active_deliveries || []).filter((item) =>
      visibleProjects.has(item.project_id)
    );
  }
  value.project_owner_confirmation_count = (value.project_owner_confirmations || []).length;
  value.project_owner_confirmations = (value.project_owner_confirmations || []).filter((item) =>
    visibleProjects.has(item.project_id)
  );
  if (actorId !== repository?.creator_user_id && actorId !== state.instance_owner_user_id) {
    delete value.consent_challenge;
    if (value.creator_consent)
      value.creator_consent = {
        intent_id: value.creator_consent.intent_id,
        revision: value.creator_consent.revision,
        snapshot_hash: value.creator_consent.snapshot_hash,
        consented_at: value.creator_consent.consented_at
      };
  }
  return value;
}

function visibleRepositoryProjectIds(state, canonicalRepositoryId, actorId, intent = null) {
  const projectIds = new Set(
    state.project_repository_bindings
      .filter((item) => item.canonical_repository_id === canonicalRepositoryId && item.status !== 'removed')
      .map((item) => item.project_id)
  );
  for (const binding of intent?.snapshot?.bindings || []) projectIds.add(binding.project_id);
  if (actorId === state.instance_owner_user_id) return projectIds;
  return new Set([...projectIds].filter((projectId) => membershipFor(state, projectId, actorId)));
}
