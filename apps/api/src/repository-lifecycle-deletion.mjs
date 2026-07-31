import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { githubIdentityForUser, hashSnapshot, membershipFor, revisionNonce } from './project-governance-v19.mjs';
import {
  assertRepositoryCreatorIdentity,
  assertRepositoryDeletionInactive,
  expireRepositoryDeletionIntentInState,
  markRepositoryActive,
  markRepositoryDeleted,
  normalizeDeletionExpiry,
  recordRemoteDeletionFailure,
  repositoryDeletionSnapshot,
  requireCanonicalRepository,
  requireMutableDeletionIntent,
  sanitizeRemoteDeletionResult,
  updateDeletionIntentReadiness
} from './repository-lifecycle-deletion-support.mjs';

export { assertRepositoryDeletionInactive, repositoryDeletionSnapshot };

export const REPOSITORY_DELETION_TTL_MS = 24 * 60 * 60 * 1000;

export function createRepositoryDeletionIntentInState(state, canonicalRepositoryId, input, actorId) {
  const repository = requireCanonicalRepository(state, canonicalRepositoryId);
  assertRepositoryCanBeDeleted(state, repository, actorId);
  const operationKey = normalizeOperationKey(input.operation_key);
  const prior = reusableDeletionIntent(state, repository.id, operationKey, actorId);
  if (prior) return { intent: prior, idempotent: true };
  assertNoActiveDeletionIntent(state, repository.id);
  const snapshot = repositoryDeletionSnapshot(state, repository.id);
  const timestamp = now();
  const intent = newDeletionIntent(repository.id, actorId, operationKey, snapshot, input.expires_at, timestamp);
  state.repository_deletion_intents.push(intent);
  return { intent, idempotent: false };
}

export function consentRepositoryDeletionInState(state, intentId, input, actorId) {
  const { intent, repository } = requireMutableDeletionIntent(state, intentId, input.expected_revision);
  if (repository.creator_user_id !== actorId)
    throw new HttpError(403, { error: 'repository_creator_consent_required' });
  assertCreatorHasRepositoryAccess(state, repository, actorId);
  assertRepositoryCreatorIdentity(state, repository, actorId);
  if (intent.creator_consent) throw new HttpError(409, { error: 'repository_deletion_consent_replayed' });
  if (String(input.consent_challenge || '') !== String(intent.consent_challenge))
    throw new HttpError(409, { error: 'repository_deletion_consent_challenge_invalid' });
  intent.creator_consent = deletionCreatorConsent(state, intent, actorId);
  intent.updated_at = now();
  updateDeletionIntentReadiness(state, intent);
  return intent;
}

export function confirmRepositoryDeletionInState(state, intentId, input, actorId) {
  const { intent } = requireMutableDeletionIntent(state, intentId, input.expected_revision);
  const projectId = String(input.project_id || '');
  requireActiveProjectBinding(state, intent.canonical_repository_id, projectId);
  if (membershipFor(state, projectId, actorId)?.role !== 'owner')
    throw new HttpError(403, { error: 'repository_deletion_project_owner_required', project_id: projectId });
  if (intent.project_owner_confirmations.some((item) => item.project_id === projectId))
    throw new HttpError(409, { error: 'repository_deletion_confirmation_replayed', project_id: projectId });
  intent.project_owner_confirmations.push(deletionProjectConfirmation(intent, projectId, actorId));
  intent.updated_at = now();
  updateDeletionIntentReadiness(state, intent);
  return intent;
}

export function prepareRepositoryDeletionExecutionInState(state, intentId, input, actorId) {
  const { intent, repository } = requireMutableDeletionIntent(state, intentId, input.expected_revision);
  assertCurrentCreatorConsent(intent);
  assertRepositoryCreatorIdentity(state, repository, repository.creator_user_id);
  const bindings = activeRepositoryBindings(state, repository.id);
  assertExecutableBinding(state, repository, bindings, actorId);
  assertCurrentProjectConfirmations(intent, bindings);
  const currentSnapshot = repositoryDeletionSnapshot(state, repository.id);
  assertDeletionSnapshotUnchanged(intent, currentSnapshot);
  Object.assign(intent, {
    status: 'executing',
    execution_started_at: now(),
    execution_snapshot: currentSnapshot,
    updated_at: now()
  });
  return { intent, repository, binding: bindings[0] };
}

export function completeRepositoryDeletionInState(state, intentId, result, actorId) {
  const intent = state.repository_deletion_intents.find((item) => item.id === intentId);
  const repository = state.canonical_repositories.find((item) => item.id === intent?.canonical_repository_id);
  if (!intent || !repository || intent.status !== 'executing')
    throw new HttpError(409, { error: 'repository_deletion_not_executing' });
  const timestamp = now();
  if (!result || result.ok !== true) return recordRemoteDeletionFailure(intent, repository, result, timestamp);
  markRepositoryDeleted(state, repository, timestamp, actorId);
  Object.assign(intent, {
    status: 'executed',
    executed_at: timestamp,
    remote_result: sanitizeRemoteDeletionResult(result),
    reconciliation: { status: 'confirmed', reconciled_at: timestamp },
    updated_at: timestamp
  });
  return { intent, repository };
}

/** Persist expiry transitions separately from a failed consent/confirmation
 * mutation so the audit-visible state remains `expired` after HTTP 410. */
export { expireRepositoryDeletionIntentInState };

export function expireRepositoryDeletionIntentsInState(state, options = {}) {
  let changed = false;
  for (const intent of state.repository_deletion_intents || [])
    changed = expireRepositoryDeletionIntentInState(state, intent.id, options) || changed;
  return changed;
}

export function reconcileRepositoryDeletionInState(
  state,
  repositoryIdentity,
  { deleted, delivery_id: deliveryId = null } = {}
) {
  const repository = findCanonicalRepository(state, repositoryIdentity);
  if (!repository) return null;
  const intents = reconcilingDeletionIntents(state, repository.id);
  const timestamp = now();
  if (deleted) confirmReconciledDeletion(state, repository, intents, deliveryId, timestamp);
  else rejectReconciledDeletion(state, repository, intents, deliveryId, timestamp);
  return { repository, intents };
}

export function rejectDirectRepositoryDelete() {
  throw new HttpError(405, { error: 'repository_direct_delete_forbidden', action: 'create_deletion_intent' });
}

function assertRepositoryCanBeDeleted(state, repository, actorId) {
  if (repository.external_import || repository.origin !== 'aiws_created')
    throw new HttpError(409, { error: 'repository_external_import_deletion_forbidden' });
  const bindings = activeRepositoryBindings(state, repository.id);
  if (!bindings.length) throw new HttpError(409, { error: 'repository_project_binding_required' });
  if (!bindings.some((item) => membershipFor(state, item.project_id, actorId)?.role === 'owner'))
    throw new HttpError(403, { error: 'repository_deletion_project_owner_required' });
}

function normalizeOperationKey(value) {
  return (
    String(value || '')
      .trim()
      .slice(0, 128) || null
  );
}

function reusableDeletionIntent(state, repositoryId, operationKey, actorId) {
  if (!operationKey) return null;
  const matching = state.repository_deletion_intents.filter(
    (item) => item.canonical_repository_id === repositoryId && item.operation_key === operationKey
  );
  if (matching.some((item) => item.requested_by_user_id !== actorId))
    throw new HttpError(409, { error: 'idempotency_key_actor_mismatch' });
  return matching.find((item) => item.requested_by_user_id === actorId) || null;
}

function assertNoActiveDeletionIntent(state, repositoryId) {
  const active = state.repository_deletion_intents.some(
    (item) =>
      item.canonical_repository_id === repositoryId &&
      ['pending', 'ready', 'executing', 'reconciliation_required'].includes(item.status) &&
      new Date(item.expires_at).getTime() > Date.now()
  );
  if (active) throw new HttpError(409, { error: 'repository_deletion_intent_active' });
}

function newDeletionIntent(repositoryId, actorId, operationKey, snapshot, expiresAt, timestamp) {
  return {
    id: id('rdi'),
    canonical_repository_id: repositoryId,
    requested_by_user_id: actorId,
    operation_key: operationKey,
    status: 'pending',
    revision: 1,
    consent_challenge: revisionNonce(),
    snapshot,
    snapshot_hash: hashSnapshot(snapshot),
    creator_consent: null,
    project_owner_confirmations: [],
    expires_at: normalizeDeletionExpiry(expiresAt, REPOSITORY_DELETION_TTL_MS),
    execution_started_at: null,
    executed_at: null,
    remote_result: null,
    reconciliation: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function assertCreatorHasRepositoryAccess(state, repository, actorId) {
  const hasAccess = activeRepositoryBindings(state, repository.id).some((item) =>
    membershipFor(state, item.project_id, actorId)
  );
  if (!hasAccess) throw new HttpError(403, { error: 'project_access_denied' });
}

function deletionCreatorConsent(state, intent, actorId) {
  return {
    consented_by_user_id: actorId,
    github_identity: githubIdentityForUser(state, actorId),
    intent_id: intent.id,
    revision: intent.revision,
    snapshot_hash: intent.snapshot_hash,
    consented_at: now()
  };
}

function requireActiveProjectBinding(state, repositoryId, projectId) {
  const binding = state.project_repository_bindings.find(
    (item) =>
      item.canonical_repository_id === repositoryId && item.project_id === projectId && item.status !== 'removed'
  );
  if (!binding) throw new HttpError(404, { error: 'repository_project_binding_not_found' });
  return binding;
}

function deletionProjectConfirmation(intent, projectId, actorId) {
  return {
    project_id: projectId,
    confirmed_by_user_id: actorId,
    intent_id: intent.id,
    revision: intent.revision,
    snapshot_hash: intent.snapshot_hash,
    confirmed_at: now()
  };
}

function assertCurrentCreatorConsent(intent) {
  const consent = intent.creator_consent;
  if (!consent || consent.revision !== intent.revision || consent.snapshot_hash !== intent.snapshot_hash)
    throw new HttpError(409, { error: 'repository_creator_consent_required' });
}

function activeRepositoryBindings(state, repositoryId) {
  return state.project_repository_bindings.filter(
    (item) => item.canonical_repository_id === repositoryId && item.status !== 'removed'
  );
}

function assertExecutableBinding(state, repository, bindings, actorId) {
  if (bindings.length > 1)
    throw new HttpError(409, {
      error: 'repository_other_project_bindings_active',
      project_ids: bindings.map((item) => item.project_id)
    });
  if (bindings.length !== 1) throw new HttpError(409, { error: 'repository_project_binding_required' });
  const membership = membershipFor(state, bindings[0].project_id, actorId);
  if (!membership || (membership.role !== 'owner' && actorId !== repository.creator_user_id))
    throw new HttpError(403, { error: 'repository_deletion_execute_forbidden' });
}

function assertCurrentProjectConfirmations(intent, bindings) {
  for (const binding of bindings) {
    const confirmed = intent.project_owner_confirmations.some(
      (item) =>
        item.project_id === binding.project_id &&
        item.revision === intent.revision &&
        item.snapshot_hash === intent.snapshot_hash
    );
    if (!confirmed)
      throw new HttpError(409, {
        error: 'repository_deletion_project_confirmation_required',
        project_id: binding.project_id
      });
  }
}

function assertDeletionSnapshotUnchanged(intent, currentSnapshot) {
  if (currentSnapshot.active_deliveries.length)
    throw new HttpError(409, {
      error: 'repository_active_delivery_or_pr',
      delivery_ids: currentSnapshot.active_deliveries.map((item) => item.id)
    });
  const currentHash = hashSnapshot(currentSnapshot);
  if (currentHash !== intent.snapshot_hash)
    throw new HttpError(409, {
      error: 'repository_deletion_snapshot_changed',
      expected_snapshot_hash: intent.snapshot_hash,
      current_snapshot_hash: currentHash
    });
}

function findCanonicalRepository(state, identity) {
  return state.canonical_repositories.find(
    (item) =>
      String(item.repository_id) === String(identity.repository_id || identity.id) ||
      item.full_name === identity.full_name
  );
}

function reconcilingDeletionIntents(state, repositoryId) {
  return state.repository_deletion_intents.filter(
    (item) =>
      item.canonical_repository_id === repositoryId && ['executing', 'reconciliation_required'].includes(item.status)
  );
}

function confirmReconciledDeletion(state, repository, intents, deliveryId, timestamp) {
  markRepositoryDeleted(state, repository, timestamp);
  for (const intent of intents)
    Object.assign(intent, {
      status: 'executed',
      executed_at: intent.executed_at || timestamp,
      reconciliation: { status: 'confirmed', webhook_delivery_id: deliveryId, reconciled_at: timestamp },
      updated_at: timestamp
    });
}

function rejectReconciledDeletion(state, repository, intents, deliveryId, timestamp) {
  markRepositoryActive(state, repository, timestamp);
  for (const intent of intents)
    Object.assign(intent, {
      status: 'failed',
      reconciliation: {
        status: 'repository_still_exists',
        webhook_delivery_id: deliveryId,
        reconciled_at: timestamp
      },
      updated_at: timestamp
    });
}

export const createDeletionIntentInState = createRepositoryDeletionIntentInState;
export const consentDeletionIntentInState = consentRepositoryDeletionInState;
export const confirmDeletionIntentInState = confirmRepositoryDeletionInState;
export const executeDeletionIntentInState = prepareRepositoryDeletionExecutionInState;
export const reconcileDeletionIntentInState = reconcileRepositoryDeletionInState;
export const expireDeletionIntentInState = expireRepositoryDeletionIntentInState;
export const expireDeletionIntentsInState = expireRepositoryDeletionIntentsInState;
