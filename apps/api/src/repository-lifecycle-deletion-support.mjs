import { HttpError } from './http.mjs';
import { githubIdentityForUser, hashSnapshot } from './project-governance-v19.mjs';
import { repositoryRemoteSnapshot } from './repository-lifecycle-normalization.mjs';

const ACTIVE_DELIVERY_STATUSES = new Set([
  'pending',
  'queued',
  'starting',
  'running',
  'preparing',
  'preflight',
  'cloning',
  'testing',
  'committing',
  'pushing',
  'publishing',
  'pr_creating',
  'creating_pr',
  'in_progress',
  'awaiting_approval',
  'awaiting_review',
  'dispatching',
  'syncing'
]);

export function repositoryDeletionSnapshot(state, canonicalRepositoryId) {
  const repository = requireCanonicalRepository(state, canonicalRepositoryId);
  const bindings = activeRepositoryBindings(state, repository.id);
  const projectIds = new Set(bindings.map((item) => item.project_id));
  const deliveries = activeRepositoryDeliveries(state, projectIds);
  const pullRequests = activeRepositoryPullRequests(state, projectIds);
  return {
    repository: deletionRepositoryIdentity(repository),
    bindings: bindings.map(bindingSnapshot).sort(byId),
    active_deliveries: [...deliveries, ...pullRequests].sort(byId)
  };
}

export function expireRepositoryDeletionIntentInState(state, intentId, { at = Date.now() } = {}) {
  const intent = state.repository_deletion_intents?.find((item) => item.id === intentId);
  if (!intent || !['pending', 'ready'].includes(intent.status)) return false;
  if (new Date(intent.expires_at).getTime() > Number(at)) return false;
  const timestamp = new Date(Number(at)).toISOString();
  Object.assign(intent, {
    status: 'expired',
    expired_at: intent.expired_at || timestamp,
    updated_at: timestamp
  });
  return true;
}

export function requireMutableDeletionIntent(state, intentId, expectedRevision) {
  const intent = state.repository_deletion_intents.find((item) => item.id === intentId);
  if (!intent) throw new HttpError(404, { error: 'repository_deletion_intent_not_found' });
  const repository = requireCanonicalRepository(state, intent.canonical_repository_id);
  if (expireRepositoryDeletionIntentInState(state, intentId))
    throw new HttpError(410, { error: 'repository_deletion_intent_expired' });
  if (!['pending', 'ready'].includes(intent.status))
    throw new HttpError(409, { error: 'repository_deletion_intent_not_pending', status: intent.status });
  if (expectedRevision != null && Number(expectedRevision) !== intent.revision)
    throw new HttpError(409, {
      error: 'repository_deletion_revision_conflict',
      expected_revision: Number(expectedRevision),
      current_revision: intent.revision
    });
  return { intent, repository };
}

export function updateDeletionIntentReadiness(state, intent) {
  const bindingProjects = activeRepositoryBindings(state, intent.canonical_repository_id).map(
    (item) => item.project_id
  );
  const allConfirmed = bindingProjects.every((projectId) =>
    intent.project_owner_confirmations.some((item) => item.project_id === projectId)
  );
  if (intent.creator_consent && allConfirmed) intent.status = 'ready';
}

export function assertRepositoryCreatorIdentity(state, repository, userId) {
  const account = state.connected_accounts?.find(
    (item) => item.user_id === userId && item.provider === 'github' && item.status === 'connected'
  );
  const actual = githubIdentityForUser(state, userId);
  const expected = repository.creator_github_identity;
  if (!creatorIdentityMatches(state, userId, account, actual, expected))
    throw new HttpError(409, { error: 'repository_creator_identity_unverifiable' });
  return actual;
}

export function requireCanonicalRepository(state, idValue) {
  const repository = state.canonical_repositories.find(
    (item) => item.id === idValue || String(item.repository_id) === String(idValue)
  );
  if (!repository) throw new HttpError(404, { error: 'canonical_repository_not_found' });
  return repository;
}

export function normalizeDeletionExpiry(value, ttlMs) {
  if (value == null) return new Date(Date.now() + ttlMs).toISOString();
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed) || parsed <= Date.now() || parsed > Date.now() + ttlMs)
    throw new HttpError(400, { error: 'repository_deletion_expiry_invalid', max_ttl_hours: ttlMs / 3_600_000 });
  return new Date(parsed).toISOString();
}

export function sanitizeRemoteDeletionResult(result) {
  return result
    ? {
        ok: result.ok === true,
        status: Number(result.status || 0) || null,
        request_id: result.request_id || null,
        error: result.error || null
      }
    : { ok: false, status: null, request_id: null, error: 'missing_result' };
}

export function recordRemoteDeletionFailure(intent, repository, result, timestamp) {
  const uncertain = remoteDeletionIsUncertain(result);
  Object.assign(intent, {
    status: uncertain ? 'reconciliation_required' : 'failed',
    remote_result: sanitizeRemoteDeletionResult(result),
    reconciliation: failureReconciliation(result, uncertain, timestamp),
    updated_at: timestamp
  });
  repository.remote_state = uncertain ? 'uncertain' : 'active';
  repository.updated_at = timestamp;
  return {
    intent,
    repository,
    uncertain,
    failed: !uncertain,
    error: uncertain ? 'repository_deletion_remote_uncertain' : 'repository_deletion_remote_rejected'
  };
}

export function markRepositoryDeleted(state, repository, timestamp, actorId = null) {
  Object.assign(repository, {
    remote_state: 'deleted',
    deleted_at: repository.deleted_at || timestamp,
    ...(actorId ? { deleted_by_user_id: actorId } : {}),
    updated_at: timestamp
  });
  updateRepositoryMirrors(state, repository, 'deleted', timestamp);
  disconnectRepositoryConnections(state, repository, timestamp);
  removeProjectRepositoryBindings(state, repository, timestamp);
  removeLegacyRepositoryBindings(state, repository, timestamp);
}

export function markRepositoryActive(state, repository, timestamp) {
  repository.remote_state = 'active';
  repository.updated_at = timestamp;
  updateRepositoryMirrors(state, repository, 'active', timestamp);
}

export function assertRepositoryDeletionInactive(
  state,
  { canonicalRepositoryId = null, projectId = null, repositoryId = null } = {}
) {
  const canonicalIds = boundCanonicalRepositoryIds(state, projectId);
  if (canonicalRepositoryId) canonicalIds.add(canonicalRepositoryId);
  addMatchingCanonicalRepositoryIds(state, canonicalIds, repositoryId);
  const intent = (state.repository_deletion_intents || []).find(
    (item) =>
      canonicalIds.has(item.canonical_repository_id) && ['executing', 'reconciliation_required'].includes(item.status)
  );
  if (intent)
    throw new HttpError(423, {
      error: 'repository_deletion_in_progress',
      deletion_intent_id: intent.id,
      status: intent.status
    });
  return true;
}

function activeRepositoryBindings(state, repositoryId) {
  return state.project_repository_bindings.filter(
    (item) => item.canonical_repository_id === repositoryId && item.status !== 'removed'
  );
}

function activeRepositoryDeliveries(state, projectIds) {
  return state.deliveries
    .filter(
      (item) =>
        projectIds.has(item.project_id) && (ACTIVE_DELIVERY_STATUSES.has(item.status) || hasActivePullRequest(item))
    )
    .map((item) => ({
      id: item.id,
      project_id: item.project_id,
      status: item.status,
      pr_number: item.pr_number || null,
      pr_state: item.pr_state || null
    }));
}

function activeRepositoryPullRequests(state, projectIds) {
  return (state.code_changes || [])
    .filter((item) => projectIds.has(item.project_id) && hasActivePullRequest(item))
    .map((item) => ({
      id: item.id,
      project_id: item.project_id,
      status: 'pull_request',
      pr_number: item.pr_number || null,
      pr_state: item.pr_state || 'open'
    }));
}

function deletionRepositoryIdentity(repository) {
  return {
    id: repository.id,
    repository_id: repository.repository_id,
    full_name: repository.full_name,
    default_branch: repository.default_branch,
    remote_state: repository.remote_state,
    remote_snapshot_hash: repository.remote_snapshot_hash,
    stored_remote_snapshot_hash: hashSnapshot(repository.remote_snapshot || null),
    current_remote_snapshot_hash: hashSnapshot(repositoryRemoteSnapshot(repository))
  };
}

function bindingSnapshot(item) {
  return { id: item.id, project_id: item.project_id, status: item.status };
}

function creatorIdentityMatches(state, userId, account, actual, expected) {
  if (!state.users?.some((item) => item.id === userId) || !account || !actual || !expected) return false;
  if (expected.provider_account_id && String(expected.provider_account_id) !== String(actual.provider_account_id))
    return false;
  return !expected.login || String(expected.login).toLowerCase() === String(actual.login).toLowerCase();
}

function remoteDeletionIsUncertain(result) {
  return !result || result.uncertain === true || result.status === 404 || Number(result.status) >= 500;
}

function failureReconciliation(result, uncertain, timestamp) {
  return {
    status: uncertain ? 'pending' : 'rejected',
    reason: result?.error || `github_http_${result?.status || 'unknown'}`,
    ...(uncertain ? { requested_at: timestamp } : { rejected_at: timestamp })
  };
}

function updateRepositoryMirrors(state, repository, status, timestamp) {
  for (const mirror of state.github_repositories?.filter(
    (item) =>
      item.canonical_repository_id === repository.id ||
      (item.provider === repository.provider && String(item.repository_id) === String(repository.repository_id))
  ) || [])
    Object.assign(mirror, {
      status,
      ...(status === 'deleted' ? { deleted_at: repository.deleted_at || timestamp } : {}),
      updated_at: timestamp
    });
}

function disconnectRepositoryConnections(state, repository, timestamp) {
  const connectionIds = disconnectMatchingConnections(state, repository, timestamp);
  for (const target of state.repository_targets?.filter((item) => connectionIds.has(item.connection_id)) || [])
    Object.assign(target, { status: 'unavailable', updated_at: timestamp });
  revokeDeliveryPolicies(state, connectionIds, timestamp);
}

function disconnectMatchingConnections(state, repository, timestamp) {
  const connectionIds = new Set();
  for (const connection of state.repository_connections?.filter(
    (item) => item.provider === repository.provider && String(item.repository_id) === String(repository.repository_id)
  ) || []) {
    Object.assign(connection, { sync_status: 'disconnected', disconnected_at: timestamp, updated_at: timestamp });
    connectionIds.add(connection.id);
  }
  return connectionIds;
}

function revokeDeliveryPolicies(state, connectionIds, timestamp) {
  for (const policy of state.delivery_policies?.filter(
    (item) => connectionIds.has(item.connection_id) && item.status === 'approved'
  ) || [])
    Object.assign(policy, {
      status: 'revoked',
      revoked_reason: 'repository_deleted',
      revoked_at: timestamp,
      updated_at: timestamp
    });
}

function removeProjectRepositoryBindings(state, repository, timestamp) {
  for (const binding of state.project_repository_bindings.filter(
    (item) => item.canonical_repository_id === repository.id
  ))
    Object.assign(binding, { status: 'removed', removed_at: timestamp, updated_at: timestamp });
}

function removeLegacyRepositoryBindings(state, repository, timestamp) {
  for (const binding of state.repository_bindings?.filter(
    (item) =>
      item.canonical_repository_id === repository.id || String(item.repository_id) === String(repository.repository_id)
  ) || [])
    Object.assign(binding, { status: 'removed', removed_at: timestamp, updated_at: timestamp });
}

function boundCanonicalRepositoryIds(state, projectId) {
  return new Set(
    (state.project_repository_bindings || [])
      .filter((item) => item.status !== 'removed' && (!projectId || item.project_id === projectId))
      .map((item) => item.canonical_repository_id)
  );
}

function addMatchingCanonicalRepositoryIds(state, canonicalIds, repositoryId) {
  if (!repositoryId) return;
  for (const repository of state.canonical_repositories || [])
    if (String(repository.repository_id) === String(repositoryId)) canonicalIds.add(repository.id);
}

function hasActivePullRequest(item) {
  const state = String(item.pr_state || '').toLowerCase();
  return (
    ['open', 'draft'].includes(state) ||
    Boolean(item.pr_url && !item.pr_closed_at && !['closed', 'merged'].includes(state))
  );
}

function byId(a, b) {
  return String(a.id).localeCompare(String(b.id));
}
