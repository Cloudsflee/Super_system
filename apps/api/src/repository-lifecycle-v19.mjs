import path from 'node:path';
import fs from 'node:fs';
import { HttpError } from './http.mjs';
import { managedProjectRoot, managedRepoPath } from './managed-workspace.mjs';
import { assertProjectMembership, githubIdentityForUser, hashSnapshot, membershipFor, revisionNonce } from './project-governance-v19.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
export { revokeRepositoryInstallationBindingsInState } from './repository-access-v19.mjs';
import { revokeRepositoryInstallationBindingsInState } from './repository-access-v19.mjs';
export const REPOSITORY_DELETION_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_DELIVERY_STATUSES = new Set(['pending', 'queued', 'starting', 'running', 'preparing', 'preflight', 'cloning', 'testing', 'committing', 'pushing', 'publishing', 'pr_creating', 'creating_pr', 'in_progress', 'awaiting_approval', 'awaiting_review', 'dispatching', 'syncing']);
export function ensureRepositoryLifecycleDefaults(state, { timestamp = now() } = {}) {
  for (const collection of ['github_repositories', 'canonical_repositories', 'project_repository_bindings', 'repository_deletion_intents']) if (!Array.isArray(state[collection])) state[collection] = [];
  for (const legacy of state.repository_bindings || []) {
    if (!legacy.repository_id || !legacy.full_name) { legacy.lifecycle_unresolved = true; continue; }
    const canonical = upsertCanonicalRepositoryInState(state, {
      id: legacy.repository_id, repository_id: legacy.repository_id, full_name: legacy.full_name,
      default_branch: legacy.default_branch || 'main', private: legacy.private !== false
    }, { installation_id: legacy.installation_id, creator_user_id: legacy.created_by_user_id || state.projects.find((item) => item.id === legacy.project_id)?.owner_user_id || null, external_import: true, timestamp });
    if (!state.project_repository_bindings.some((item) => item.project_id === legacy.project_id && item.canonical_repository_id === canonical.id)) {
      const project = state.projects.find((item) => item.id === legacy.project_id);
      if (project) state.project_repository_bindings.push({ id: id('prb'), project_id: project.id, canonical_repository_id: canonical.id, installation_id: legacy.installation_id || null, local_checkout_path: project.repo_path || managedRepoPath(project.id), managed_worktree_root: path.join(managedProjectRoot(project.id), 'worktrees'), status: legacy.status || 'ready', permissions: structuredClone(legacy.permissions || {}), created_by_user_id: legacy.created_by_user_id || project.owner_user_id, created_at: legacy.created_at || timestamp, updated_at: legacy.updated_at || timestamp });
    }
  }
  return state;
}
export function repositoryAdministrationPreflight(state, { project_id: projectId, installation_id: installationId, actor_id: actorId, requested_permission = null } = {}) {
  const access = assertProjectMembership(state, projectId, actorId, 'github:write');
  if (access.role === 'viewer') throw new HttpError(403, { error: 'repository_create_forbidden', role: access.role });
  const installation = state.github_installations.find((item) => item.id === installationId || String(item.installation_id) === String(installationId));
  if (!installation || installation.status !== 'active') return { ok: false, status: 'pending', error: 'github_installation_pending', installation_id: installationId || null };
  const permissions = installation.permissions || installation.app_permissions || {};
  const repositoryPermissions = (installation.repositories || []).map((item) => item.permissions || {});
  if (requested_permission === 'read' || requested_permission === false) throw new HttpError(403, { error: 'github_administration_write_required', required_permission: 'Administration: write' });
  const administrationWrite = requested_permission === 'write' || permissions.administration === 'write' || permissions.admin === true || repositoryPermissions.some((item) => item.administration === 'write' || item.admin === true);
  if (!administrationWrite) throw new HttpError(403, { error: 'github_administration_write_required', required_permission: 'Administration: write' });
  return { ok: true, status: 'ready', installation, role: access.role || access.membership?.role };
}
export function upsertCanonicalRepositoryInState(state, repository, metadata = {}) {
  ensureRepositoryLifecycleDefaultsShallow(state);
  const provider = metadata.provider || 'github', repositoryId = String(repository.repository_id || repository.id || '');
  if (!repositoryId || !String(repository.full_name || '').includes('/')) throw new HttpError(400, { error: 'canonical_repository_identity_invalid' });
  let record = state.canonical_repositories.find((item) => item.provider === provider && String(item.repository_id) === repositoryId);
  const timestamp = metadata.timestamp || now();
  const remoteSnapshot = repositoryRemoteSnapshot(repository);
  if (!record) {
    record = {
      id: id('crep'), provider, repository_id: repositoryId, full_name: String(repository.full_name), name: repository.name || String(repository.full_name).split('/').at(-1),
      installation_id: metadata.installation_id ? String(metadata.installation_id) : null, default_branch: repository.default_branch || 'main',
      private: repository.private !== false, visibility: repository.visibility || (repository.private === false ? 'public' : 'private'),
      creator_user_id: metadata.creator_user_id || null, creator_github_identity: metadata.creator_github_identity || null,
      origin: metadata.external_import ? 'external_import' : 'aiws_created', external_import: metadata.external_import === true,
      administration_permission: metadata.administration_permission || 'write', remote_state: metadata.remote_state || 'active',
      remote_snapshot: remoteSnapshot, remote_snapshot_hash: hashSnapshot(remoteSnapshot), deleted_at: null,
      created_at: timestamp, updated_at: timestamp
    };
    state.canonical_repositories.push(record);
  } else {
    Object.assign(record, { full_name: String(repository.full_name || record.full_name), name: repository.name || record.name, installation_id: metadata.installation_id ? String(metadata.installation_id) : record.installation_id, default_branch: repository.default_branch || record.default_branch, private: repository.private !== undefined ? repository.private !== false : record.private, visibility: repository.visibility || record.visibility, remote_state: metadata.remote_state || record.remote_state, remote_snapshot: remoteSnapshot, remote_snapshot_hash: hashSnapshot(remoteSnapshot), updated_at: timestamp });
    if (!record.creator_user_id && metadata.creator_user_id) record.creator_user_id = metadata.creator_user_id;
    if (!record.creator_github_identity && metadata.creator_github_identity) record.creator_github_identity = metadata.creator_github_identity;
    // Repository provenance is immutable. An imported remote must never become
    // deletable merely because a later sync presents it through a create path.
    if (!record.origin) Object.assign(record, { origin: metadata.external_import ? 'external_import' : 'aiws_created', external_import: metadata.external_import === true });
  }
  const legacy = state.github_repositories.find((item) => item.canonical_repository_id === record.id || item.provider === provider && String(item.repository_id) === repositoryId);
  const mirror = legacy || { id: id('ghr'), created_at: timestamp };
  Object.assign(mirror, { canonical_repository_id: record.id, provider, repository_id: record.repository_id, full_name: record.full_name, name: record.name, installation_id: record.installation_id, default_branch: record.default_branch, private: record.private, status: record.remote_state, updated_at: timestamp });
  if (!legacy) state.github_repositories.push(mirror);
  return record;
}
export function bindCanonicalRepositoryInState(state, { project_id: projectId, canonical_repository_id: canonicalId, installation_id: installationId, checkout, permissions = {}, actor_id: actorId, status = 'ready' }) {
  assertProjectMembership(state, projectId, actorId, 'github:write');
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at), repository = state.canonical_repositories.find((item) => item.id === canonicalId);
  if (!project || !repository) throw new HttpError(404, { error: !project ? 'project_not_found' : 'canonical_repository_not_found' });
  assertRepositoryDeletionInactive(state, { canonicalRepositoryId: canonicalId, projectId });
  const protectedBinding = state.project_repository_bindings.find((item) => item.project_id === projectId && item.canonical_repository_id !== canonicalId && item.status !== 'removed' && state.canonical_repositories.some((candidate) => candidate.id === item.canonical_repository_id && candidate.origin === 'aiws_created' && candidate.remote_state !== 'deleted'));
  if (protectedBinding) throw new HttpError(409, { error: 'project_aiws_repository_replacement_forbidden', canonical_repository_id: protectedBinding.canonical_repository_id, action: 'complete_repository_deletion_intent' });
  const expectedPath = path.resolve(managedRepoPath(project.id)), checkoutPath = path.resolve(checkout?.repo_path || expectedPath);
  if (normalizePath(checkoutPath) !== normalizePath(expectedPath)) throw new HttpError(409, { error: 'repository_checkout_not_project_isolated', expected_path: expectedPath });
  const checkoutIdentity = isolatedCheckoutIdentity(checkoutPath);
  const collision = state.project_repository_bindings.find((item) => item.project_id !== projectId && item.status !== 'removed' && item.local_checkout_path && normalizePath(isolatedCheckoutIdentity(path.resolve(item.local_checkout_path))) === normalizePath(checkoutIdentity));
  if (collision) throw new HttpError(409, { error: 'repository_checkout_path_shared', conflicting_project_id: collision.project_id });
  // A Project has one active primary checkout. Rebinding it to another
  // canonical repository retires the previous binding while preserving its
  // audit record; other Projects may still bind the same remote.
  for (const previous of state.project_repository_bindings.filter((item) => item.project_id === projectId && item.canonical_repository_id !== canonicalId && item.status !== 'removed')) Object.assign(previous, { status: 'removed', removed_at: now(), updated_at: now() });
  let binding = state.project_repository_bindings.find((item) => item.project_id === projectId && item.canonical_repository_id === canonicalId);
  if (!binding) { binding = { id: id('prb'), project_id: projectId, canonical_repository_id: canonicalId, created_by_user_id: actorId, created_at: now() }; state.project_repository_bindings.push(binding); }
  Object.assign(binding, { installation_id: String(installationId || repository.installation_id || ''), local_checkout_path: checkoutPath, managed_worktree_root: path.join(managedProjectRoot(project.id), 'worktrees'), permissions: structuredClone(permissions || {}), status, updated_at: now() });
  let legacy = state.repository_bindings.find((item) => item.project_id === projectId && (item.canonical_repository_id === canonicalId || String(item.repository_id) === String(repository.repository_id)));
  if (!legacy) { legacy = { id: id('rbd'), project_id: projectId, created_by_user_id: actorId, created_at: binding.created_at }; state.repository_bindings.push(legacy); }
  Object.assign(legacy, { canonical_repository_id: canonicalId, installation_id: binding.installation_id, repository_id: repository.repository_id, full_name: repository.full_name, local_checkout_path: checkoutPath, repo_path: checkoutPath, permissions: structuredClone(permissions || {}), status, updated_at: now() });
  repository.binding_count = state.project_repository_bindings.filter((item) => item.canonical_repository_id === repository.id && item.status !== 'removed').length;
  return binding;
}
export function repositoryDeletionSnapshot(state, canonicalRepositoryId) {
  const repository = requireCanonicalRepository(state, canonicalRepositoryId);
  const bindings = state.project_repository_bindings.filter((item) => item.canonical_repository_id === repository.id && item.status !== 'removed').map((item) => ({ id: item.id, project_id: item.project_id, status: item.status }));
  const projectIds = new Set(bindings.map((item) => item.project_id));
  const deliveries = state.deliveries.filter((item) => projectIds.has(item.project_id) && (ACTIVE_DELIVERY_STATUSES.has(item.status) || hasActivePullRequest(item))).map((item) => ({ id: item.id, project_id: item.project_id, status: item.status, pr_number: item.pr_number || null, pr_state: item.pr_state || null }));
  const pullRequests = (state.code_changes || []).filter((item) => projectIds.has(item.project_id) && hasActivePullRequest(item)).map((item) => ({ id: item.id, project_id: item.project_id, status: 'pull_request', pr_number: item.pr_number || null, pr_state: item.pr_state || 'open' }));
  return { repository: { id: repository.id, repository_id: repository.repository_id, full_name: repository.full_name, default_branch: repository.default_branch, remote_state: repository.remote_state, remote_snapshot_hash: repository.remote_snapshot_hash, stored_remote_snapshot_hash: hashSnapshot(repository.remote_snapshot || null), current_remote_snapshot_hash: hashSnapshot(repositoryRemoteSnapshot(repository)) }, bindings: bindings.sort(byId), active_deliveries: [...deliveries, ...pullRequests].sort(byId) };
}
export function createRepositoryDeletionIntentInState(state, canonicalRepositoryId, input, actorId) {
  const repository = requireCanonicalRepository(state, canonicalRepositoryId);
  if (repository.external_import || repository.origin !== 'aiws_created') throw new HttpError(409, { error: 'repository_external_import_deletion_forbidden' });
  const bindings = state.project_repository_bindings.filter((item) => item.canonical_repository_id === repository.id && item.status !== 'removed');
  if (!bindings.length) throw new HttpError(409, { error: 'repository_project_binding_required' });
  if (!bindings.some((item) => membershipFor(state, item.project_id, actorId)?.role === 'owner')) throw new HttpError(403, { error: 'repository_deletion_project_owner_required' });
  const operationKey = String(input.operation_key || '').trim().slice(0, 128) || null;
  if (operationKey) {
    const foreign = state.repository_deletion_intents.find((item) => item.canonical_repository_id === repository.id && item.operation_key === operationKey && item.requested_by_user_id !== actorId);
    if (foreign) throw new HttpError(409, { error: 'idempotency_key_actor_mismatch' });
    const prior = state.repository_deletion_intents.find((item) => item.canonical_repository_id === repository.id && item.operation_key === operationKey && item.requested_by_user_id === actorId);
    if (prior) return { intent: prior, idempotent: true };
  }
  if (state.repository_deletion_intents.some((item) => item.canonical_repository_id === repository.id && ['pending', 'ready', 'executing', 'reconciliation_required'].includes(item.status) && new Date(item.expires_at).getTime() > Date.now())) throw new HttpError(409, { error: 'repository_deletion_intent_active' });
  const snapshot = repositoryDeletionSnapshot(state, repository.id), timestamp = now();
  const intent = {
    id: id('rdi'), canonical_repository_id: repository.id, requested_by_user_id: actorId, operation_key: operationKey,
    status: 'pending', revision: 1, consent_challenge: revisionNonce(), snapshot, snapshot_hash: hashSnapshot(snapshot),
    creator_consent: null, project_owner_confirmations: [], expires_at: normalizeDeletionExpiry(input.expires_at),
    execution_started_at: null, executed_at: null, remote_result: null, reconciliation: null,
    created_at: timestamp, updated_at: timestamp
  };
  state.repository_deletion_intents.push(intent);
  return { intent, idempotent: false };
}
export function consentRepositoryDeletionInState(state, intentId, input, actorId) {
  const { intent, repository } = requireMutableIntent(state, intentId, input.expected_revision);
  if (repository.creator_user_id !== actorId) throw new HttpError(403, { error: 'repository_creator_consent_required' });
  const creatorBindings = state.project_repository_bindings.filter((item) => item.canonical_repository_id === repository.id && item.status !== 'removed');
  if (!creatorBindings.some((item) => membershipFor(state, item.project_id, actorId))) throw new HttpError(403, { error: 'project_access_denied' });
  assertCreatorIdentity(state, repository, actorId);
  if (intent.creator_consent) throw new HttpError(409, { error: 'repository_deletion_consent_replayed' });
  if (String(input.consent_challenge || '') !== String(intent.consent_challenge)) throw new HttpError(409, { error: 'repository_deletion_consent_challenge_invalid' });
  intent.creator_consent = { consented_by_user_id: actorId, github_identity: githubIdentityForUser(state, actorId), intent_id: intent.id, revision: intent.revision, snapshot_hash: intent.snapshot_hash, consented_at: now() };
  intent.updated_at = now(); updateIntentReadiness(state, intent);
  return intent;
}
export function confirmRepositoryDeletionInState(state, intentId, input, actorId) {
  const { intent } = requireMutableIntent(state, intentId, input.expected_revision);
  const projectId = String(input.project_id || '');
  const binding = state.project_repository_bindings.find((item) => item.canonical_repository_id === intent.canonical_repository_id && item.project_id === projectId && item.status !== 'removed');
  if (!binding) throw new HttpError(404, { error: 'repository_project_binding_not_found' });
  if (membershipFor(state, projectId, actorId)?.role !== 'owner') throw new HttpError(403, { error: 'repository_deletion_project_owner_required', project_id: projectId });
  if (intent.project_owner_confirmations.some((item) => item.project_id === projectId)) throw new HttpError(409, { error: 'repository_deletion_confirmation_replayed', project_id: projectId });
  intent.project_owner_confirmations.push({ project_id: projectId, confirmed_by_user_id: actorId, intent_id: intent.id, revision: intent.revision, snapshot_hash: intent.snapshot_hash, confirmed_at: now() });
  intent.updated_at = now(); updateIntentReadiness(state, intent);
  return intent;
}
export function prepareRepositoryDeletionExecutionInState(state, intentId, input, actorId) {
  const { intent, repository } = requireMutableIntent(state, intentId, input.expected_revision);
  if (!intent.creator_consent || intent.creator_consent.revision !== intent.revision || intent.creator_consent.snapshot_hash !== intent.snapshot_hash) throw new HttpError(409, { error: 'repository_creator_consent_required' });
  assertCreatorIdentity(state, repository, repository.creator_user_id);
  const bindings = state.project_repository_bindings.filter((item) => item.canonical_repository_id === repository.id && item.status !== 'removed');
  if (bindings.length > 1) throw new HttpError(409, { error: 'repository_other_project_bindings_active', project_ids: bindings.map((item) => item.project_id) });
  if (bindings.length !== 1) throw new HttpError(409, { error: 'repository_project_binding_required' });
  const executionMembership = membershipFor(state, bindings[0].project_id, actorId);
  if (!executionMembership || executionMembership.role !== 'owner' && actorId !== repository.creator_user_id) throw new HttpError(403, { error: 'repository_deletion_execute_forbidden' });
  for (const binding of bindings) if (!intent.project_owner_confirmations.some((item) => item.project_id === binding.project_id && item.revision === intent.revision && item.snapshot_hash === intent.snapshot_hash)) throw new HttpError(409, { error: 'repository_deletion_project_confirmation_required', project_id: binding.project_id });
  const currentSnapshot = repositoryDeletionSnapshot(state, repository.id), currentHash = hashSnapshot(currentSnapshot);
  if (currentSnapshot.active_deliveries.length) throw new HttpError(409, { error: 'repository_active_delivery_or_pr', delivery_ids: currentSnapshot.active_deliveries.map((item) => item.id) });
  if (currentHash !== intent.snapshot_hash) throw new HttpError(409, { error: 'repository_deletion_snapshot_changed', expected_snapshot_hash: intent.snapshot_hash, current_snapshot_hash: currentHash });
  Object.assign(intent, { status: 'executing', execution_started_at: now(), execution_snapshot: currentSnapshot, updated_at: now() });
  return { intent, repository, binding: bindings[0] };
}
export function completeRepositoryDeletionInState(state, intentId, result, actorId) {
  const intent = state.repository_deletion_intents.find((item) => item.id === intentId), repository = state.canonical_repositories.find((item) => item.id === intent?.canonical_repository_id);
  if (!intent || !repository || intent.status !== 'executing') throw new HttpError(409, { error: 'repository_deletion_not_executing' });
  if (!result || result.ok !== true) {
    const uncertain = !result || result.uncertain === true || result.status === 404 || Number(result.status) >= 500;
    Object.assign(intent, { status: uncertain ? 'reconciliation_required' : 'failed', remote_result: sanitizeRemoteResult(result), reconciliation: { status: uncertain ? 'pending' : 'rejected', reason: result?.error || `github_http_${result?.status || 'unknown'}`, ...(uncertain ? { requested_at: now() } : { rejected_at: now() }) }, updated_at: now() });
    repository.remote_state = uncertain ? 'uncertain' : 'active'; repository.updated_at = now();
    return { intent, repository, uncertain, failed: !uncertain, error: uncertain ? 'repository_deletion_remote_uncertain' : 'repository_deletion_remote_rejected' };
  }
  const timestamp = now();
  Object.assign(repository, { remote_state: 'deleted', deleted_at: timestamp, deleted_by_user_id: actorId, updated_at: timestamp });
  updateRepositoryMirrors(state, repository, 'deleted', timestamp);
  disconnectRepositoryConnections(state, repository, timestamp);
  for (const binding of state.project_repository_bindings.filter((item) => item.canonical_repository_id === repository.id)) Object.assign(binding, { status: 'removed', removed_at: timestamp, updated_at: timestamp });
  removeLegacyRepositoryBindings(state, repository, timestamp);
  Object.assign(intent, { status: 'executed', executed_at: timestamp, remote_result: sanitizeRemoteResult(result), reconciliation: { status: 'confirmed', reconciled_at: timestamp }, updated_at: timestamp });
  return { intent, repository };
}
/** Persist expiry transitions separately from a failed consent/confirmation
 * mutation. This keeps the audit-visible state at `expired` even though the
 * attempted operation returns HTTP 410. */
export function expireRepositoryDeletionIntentInState(state, intentId, { at = Date.now() } = {}) {
  const intent = state.repository_deletion_intents?.find((item) => item.id === intentId);
  if (!intent || !['pending', 'ready'].includes(intent.status)) return false;
  if (new Date(intent.expires_at).getTime() > Number(at)) return false;
  Object.assign(intent, { status: 'expired', expired_at: intent.expired_at || new Date(Number(at)).toISOString(), updated_at: new Date(Number(at)).toISOString() });
  return true;
}

export function expireRepositoryDeletionIntentsInState(state, options = {}) {
  let changed = false;
  for (const intent of state.repository_deletion_intents || []) changed = expireRepositoryDeletionIntentInState(state, intent.id, options) || changed;
  return changed;
}
export function reconcileRepositoryDeletionInState(state, repositoryIdentity, { deleted, delivery_id: deliveryId = null } = {}) {
  const repository = state.canonical_repositories.find((item) => String(item.repository_id) === String(repositoryIdentity.repository_id || repositoryIdentity.id) || item.full_name === repositoryIdentity.full_name);
  if (!repository) return null;
  const intents = state.repository_deletion_intents.filter((item) => item.canonical_repository_id === repository.id && ['executing', 'reconciliation_required'].includes(item.status));
  const timestamp = now();
  if (deleted) {
    Object.assign(repository, { remote_state: 'deleted', deleted_at: repository.deleted_at || timestamp, updated_at: timestamp });
    updateRepositoryMirrors(state, repository, 'deleted', timestamp);
    disconnectRepositoryConnections(state, repository, timestamp);
    for (const binding of state.project_repository_bindings.filter((item) => item.canonical_repository_id === repository.id)) Object.assign(binding, { status: 'removed', removed_at: timestamp, updated_at: timestamp });
    removeLegacyRepositoryBindings(state, repository, timestamp);
    for (const intent of intents) Object.assign(intent, { status: 'executed', executed_at: intent.executed_at || timestamp, reconciliation: { status: 'confirmed', webhook_delivery_id: deliveryId, reconciled_at: timestamp }, updated_at: timestamp });
  } else {
    repository.remote_state = 'active'; repository.updated_at = timestamp;
    updateRepositoryMirrors(state, repository, 'active', timestamp);
    for (const intent of intents) Object.assign(intent, { status: 'failed', reconciliation: { status: 'repository_still_exists', webhook_delivery_id: deliveryId, reconciled_at: timestamp }, updated_at: timestamp });
  }
  return { repository, intents };
}

export function rejectDirectRepositoryDelete() { throw new HttpError(405, { error: 'repository_direct_delete_forbidden', action: 'create_deletion_intent' }); }
export function assertRepositoryDeletionInactive(state, { canonicalRepositoryId = null, projectId = null, repositoryId = null } = {}) {
  const canonicalIds = new Set((state.project_repository_bindings || []).filter((item) => item.status !== 'removed' && (!projectId || item.project_id === projectId)).map((item) => item.canonical_repository_id)); if (canonicalRepositoryId) canonicalIds.add(canonicalRepositoryId);
  for (const repository of state.canonical_repositories || []) if (repositoryId && String(repository.repository_id) === String(repositoryId)) canonicalIds.add(repository.id);
  const intent = (state.repository_deletion_intents || []).find((item) => canonicalIds.has(item.canonical_repository_id) && ['executing', 'reconciliation_required'].includes(item.status)); if (intent) throw new HttpError(423, { error: 'repository_deletion_in_progress', deletion_intent_id: intent.id, status: intent.status }); return true;
}
function requireMutableIntent(state, intentId, expectedRevision) { const intent = state.repository_deletion_intents.find((item) => item.id === intentId); if (!intent) throw new HttpError(404, { error: 'repository_deletion_intent_not_found' }); const repository = requireCanonicalRepository(state, intent.canonical_repository_id); if (expireRepositoryDeletionIntentInState(state, intentId)) throw new HttpError(410, { error: 'repository_deletion_intent_expired' }); if (!['pending', 'ready'].includes(intent.status)) throw new HttpError(409, { error: 'repository_deletion_intent_not_pending', status: intent.status }); if (expectedRevision != null && Number(expectedRevision) !== intent.revision) throw new HttpError(409, { error: 'repository_deletion_revision_conflict', expected_revision: Number(expectedRevision), current_revision: intent.revision }); return { intent, repository }; }
function updateIntentReadiness(state, intent) { const bindingProjects = state.project_repository_bindings.filter((item) => item.canonical_repository_id === intent.canonical_repository_id && item.status !== 'removed').map((item) => item.project_id); if (intent.creator_consent && bindingProjects.every((projectId) => intent.project_owner_confirmations.some((item) => item.project_id === projectId))) intent.status = 'ready'; }
function assertCreatorIdentity(state, repository, userId) {
  const account = state.connected_accounts?.find((item) => item.user_id === userId && item.provider === 'github' && item.status === 'connected');
  const actual = githubIdentityForUser(state, userId), expected = repository.creator_github_identity;
  if (!state.users?.some((item) => item.id === userId) || !account || !actual || !expected
    || expected.provider_account_id && String(expected.provider_account_id) !== String(actual.provider_account_id)
    || expected.login && String(expected.login).toLowerCase() !== String(actual.login).toLowerCase()) {
    throw new HttpError(409, { error: 'repository_creator_identity_unverifiable' });
  }
  return actual;
}
function requireCanonicalRepository(state, idValue) { const repository = state.canonical_repositories.find((item) => item.id === idValue || String(item.repository_id) === String(idValue)); if (!repository) throw new HttpError(404, { error: 'canonical_repository_not_found' }); return repository; }
function normalizeDeletionExpiry(value) { if (value == null) return new Date(Date.now() + REPOSITORY_DELETION_TTL_MS).toISOString(); const parsed = new Date(value).getTime(); if (!Number.isFinite(parsed) || parsed <= Date.now() || parsed > Date.now() + REPOSITORY_DELETION_TTL_MS) throw new HttpError(400, { error: 'repository_deletion_expiry_invalid', max_ttl_hours: 24 }); return new Date(parsed).toISOString(); }
function repositoryRemoteSnapshot(repository) { return { repository_id: String(repository.repository_id || repository.id), full_name: String(repository.full_name), default_branch: repository.default_branch || 'main', private: repository.private !== false, visibility: repository.visibility || (repository.private === false ? 'public' : 'private'), pushed_at: repository.pushed_at || null, archived: Boolean(repository.archived), disabled: Boolean(repository.disabled) }; }
function ensureRepositoryLifecycleDefaultsShallow(state) { if (!Array.isArray(state.github_repositories)) state.github_repositories = []; if (!Array.isArray(state.repository_bindings)) state.repository_bindings = []; if (!Array.isArray(state.repository_connections)) state.repository_connections = []; if (!Array.isArray(state.canonical_repositories)) state.canonical_repositories = []; if (!Array.isArray(state.project_repository_bindings)) state.project_repository_bindings = []; if (!Array.isArray(state.repository_deletion_intents)) state.repository_deletion_intents = []; }
function sanitizeRemoteResult(result) { return result ? { ok: result.ok === true, status: Number(result.status || 0) || null, request_id: result.request_id || null, error: result.error || null } : { ok: false, status: null, request_id: null, error: 'missing_result' }; }
function updateRepositoryMirrors(state, repository, status, timestamp) { for (const mirror of state.github_repositories?.filter((item) => item.canonical_repository_id === repository.id || item.provider === repository.provider && String(item.repository_id) === String(repository.repository_id)) || []) Object.assign(mirror, { status, ...(status === 'deleted' ? { deleted_at: repository.deleted_at || timestamp } : {}), updated_at: timestamp }); }
function disconnectRepositoryConnections(state, repository, timestamp) { const ids = new Set(); for (const connection of state.repository_connections?.filter((item) => item.provider === repository.provider && String(item.repository_id) === String(repository.repository_id)) || []) { Object.assign(connection, { sync_status: 'disconnected', disconnected_at: timestamp, updated_at: timestamp }); ids.add(connection.id); } for (const target of state.repository_targets?.filter((item) => ids.has(item.connection_id)) || []) Object.assign(target, { status: 'unavailable', updated_at: timestamp }); for (const policy of state.delivery_policies?.filter((item) => ids.has(item.connection_id) && item.status === 'approved') || []) Object.assign(policy, { status: 'revoked', revoked_reason: 'repository_deleted', revoked_at: timestamp, updated_at: timestamp }); }
function removeLegacyRepositoryBindings(state, repository, timestamp) { for (const binding of state.repository_bindings?.filter((item) => item.canonical_repository_id === repository.id || String(item.repository_id) === String(repository.repository_id)) || []) Object.assign(binding, { status: 'removed', removed_at: timestamp, updated_at: timestamp }); }
function isolatedCheckoutIdentity(value) { if (!fs.existsSync(value)) return value; const real = fs.realpathSync(value), root = fs.realpathSync(path.dirname(path.dirname(value))); const relative = path.relative(root, real); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(409, { error: 'repository_checkout_symlink_escape' }); return real; }
function normalizePath(value) { const resolved = String(value || ''); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function hasActivePullRequest(item) { const state = String(item.pr_state || '').toLowerCase(); return ['open', 'draft'].includes(state) || Boolean(item.pr_url && !item.pr_closed_at && !['closed', 'merged'].includes(state)); }
function byId(a, b) { return String(a.id).localeCompare(String(b.id)); }

export const createDeletionIntentInState = createRepositoryDeletionIntentInState;
export const consentDeletionIntentInState = consentRepositoryDeletionInState;
export const confirmDeletionIntentInState = confirmRepositoryDeletionInState;
export const executeDeletionIntentInState = prepareRepositoryDeletionExecutionInState;
export const reconcileDeletionIntentInState = reconcileRepositoryDeletionInState;
export const expireDeletionIntentInState = expireRepositoryDeletionIntentInState;
export const expireDeletionIntentsInState = expireRepositoryDeletionIntentsInState;
