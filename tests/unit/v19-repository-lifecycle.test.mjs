import assert from 'node:assert/strict';
import { managedRepoPath } from '../../apps/api/src/managed-workspace.mjs';
import { recoverInterruptedRepositoryDeletionsInState } from '../../apps/api/src/repository-deletion-recovery.mjs';
import {
  bindCanonicalRepositoryInState,
  completeRepositoryDeletionInState,
  confirmRepositoryDeletionInState,
  consentRepositoryDeletionInState,
  createRepositoryDeletionIntentInState,
  prepareRepositoryDeletionExecutionInState,
  assertRepositoryDeletionInactive,
  repositoryAdministrationPreflight,
  rejectDirectRepositoryDelete,
  upsertCanonicalRepositoryInState
} from '../../apps/api/src/repository-lifecycle-v19.mjs';

const timestamp = new Date().toISOString();
const state = baseState();
assert.equal(
  repositoryAdministrationPreflight(state, { project_id: 'p1', installation_id: 'inst-1', actor_id: 'creator' }).ok,
  true
);
assert.throws(
  () => repositoryAdministrationPreflight(state, { project_id: 'p1', installation_id: 'inst-1', actor_id: 'viewer' }),
  code('project_role_forbidden')
);
assert.equal(
  repositoryAdministrationPreflight(state, { project_id: 'p1', installation_id: 'missing', actor_id: 'creator' })
    .status,
  'pending'
);

const repository = upsertCanonicalRepositoryInState(
  state,
  { id: '900', full_name: 'acme/app', name: 'app', default_branch: 'main', private: true },
  {
    installation_id: 'inst-1',
    creator_user_id: 'creator',
    creator_github_identity: { provider: 'github', provider_account_id: '42', login: 'creator-gh' },
    external_import: false
  }
);
const binding = bindCanonicalRepositoryInState(state, {
  project_id: 'p1',
  canonical_repository_id: repository.id,
  installation_id: 'inst-1',
  checkout: { repo_path: managedRepoPath('p1') },
  permissions: { push: true, admin: true },
  actor_id: 'creator'
});
assert.equal(binding.local_checkout_path, managedRepoPath('p1'));
assert.throws(() => rejectDirectRepositoryDelete(), code('repository_direct_delete_forbidden'));
const prematureReplacement = upsertCanonicalRepositoryInState(
  state,
  { id: '899', full_name: 'acme/replacement' },
  { installation_id: 'inst-1', creator_user_id: 'creator', external_import: true }
);
assert.throws(
  () =>
    bindCanonicalRepositoryInState(state, {
      project_id: 'p1',
      canonical_repository_id: prematureReplacement.id,
      checkout: { repo_path: managedRepoPath('p1') },
      actor_id: 'creator'
    }),
  code('project_aiws_repository_replacement_forbidden')
);

const created = createRepositoryDeletionIntentInState(state, repository.id, { operation_key: 'delete-1' }, 'creator');
assert.equal(
  createRepositoryDeletionIntentInState(state, repository.id, { operation_key: 'delete-1' }, 'creator').idempotent,
  true
);
assert.throws(
  () => consentRepositoryDeletionInState(state, created.intent.id, { expected_revision: 1 }, 'viewer'),
  code('repository_creator_consent_required')
);
consentRepositoryDeletionInState(
  state,
  created.intent.id,
  { expected_revision: 1, consent_challenge: created.intent.consent_challenge },
  'creator'
);
assert.throws(
  () => consentRepositoryDeletionInState(state, created.intent.id, { expected_revision: 1 }, 'creator'),
  code('repository_deletion_consent_replayed')
);
confirmRepositoryDeletionInState(state, created.intent.id, { expected_revision: 1, project_id: 'p1' }, 'creator');
state.repository_connections.push({
  id: 'connection-deleting',
  project_id: 'p1',
  provider: 'github',
  repository_id: '900',
  sync_status: 'ready'
});
state.repository_targets.push({
  id: 'target-deleting',
  project_id: 'p1',
  connection_id: 'connection-deleting',
  status: 'ready'
});
state.delivery_policies.push({
  id: 'policy-deleting',
  project_id: 'p1',
  connection_id: 'connection-deleting',
  status: 'approved'
});
const prepared = prepareRepositoryDeletionExecutionInState(
  state,
  created.intent.id,
  { expected_revision: 1 },
  'creator'
);
assert.equal(prepared.intent.status, 'executing');
assert.throws(
  () => assertRepositoryDeletionInactive(state, { projectId: 'p1' }),
  code('repository_deletion_in_progress')
);
assert.throws(
  () =>
    bindCanonicalRepositoryInState(state, {
      project_id: 'p1',
      canonical_repository_id: repository.id,
      checkout: { repo_path: managedRepoPath('p1') },
      actor_id: 'creator'
    }),
  code('repository_deletion_in_progress')
);
const completed = completeRepositoryDeletionInState(state, created.intent.id, { ok: true, status: 204 }, 'creator');
assert.equal(completed.repository.remote_state, 'deleted');
assert.equal(state.project_repository_bindings[0].status, 'removed');
assert.equal(state.repository_connections[0].sync_status, 'disconnected');
assert.equal(state.repository_targets[0].status, 'unavailable');
assert.equal(state.delivery_policies[0].status, 'revoked');

const external = upsertCanonicalRepositoryInState(
  state,
  { id: '901', full_name: 'acme/imported' },
  {
    installation_id: 'inst-1',
    creator_user_id: 'creator',
    creator_github_identity: { provider: 'github', provider_account_id: '42', login: 'creator-gh' },
    external_import: true
  }
);
bindCanonicalRepositoryInState(state, {
  project_id: 'p1',
  canonical_repository_id: external.id,
  installation_id: 'inst-1',
  checkout: { repo_path: managedRepoPath('p1') },
  permissions: { admin: true },
  actor_id: 'creator'
});
assert.throws(
  () => createRepositoryDeletionIntentInState(state, external.id, {}, 'creator'),
  code('repository_external_import_deletion_forbidden')
);
upsertCanonicalRepositoryInState(
  state,
  { id: '901', full_name: 'acme/imported' },
  {
    installation_id: 'inst-1',
    creator_user_id: 'creator',
    creator_github_identity: { provider: 'github', provider_account_id: '42', login: 'creator-gh' },
    external_import: false
  }
);
assert.equal(external.external_import, true, 'external repository provenance is immutable');

const changed = upsertCanonicalRepositoryInState(
  state,
  { id: '902', full_name: 'acme/changed', default_branch: 'main' },
  {
    installation_id: 'inst-1',
    creator_user_id: 'creator',
    creator_github_identity: { provider: 'github', provider_account_id: '42', login: 'creator-gh' },
    external_import: false
  }
);
bindCanonicalRepositoryInState(state, {
  project_id: 'p1',
  canonical_repository_id: changed.id,
  installation_id: 'inst-1',
  checkout: { repo_path: managedRepoPath('p1') },
  permissions: { admin: true },
  actor_id: 'creator'
});
const changedIntent = createRepositoryDeletionIntentInState(state, changed.id, {}, 'creator').intent;
consentRepositoryDeletionInState(
  state,
  changedIntent.id,
  { consent_challenge: changedIntent.consent_challenge },
  'creator'
);
confirmRepositoryDeletionInState(state, changedIntent.id, { project_id: 'p1' }, 'creator');
changed.default_branch = 'develop';
assert.throws(
  () => prepareRepositoryDeletionExecutionInState(state, changedIntent.id, {}, 'creator'),
  code('repository_deletion_snapshot_changed')
);

const restartState = baseState(),
  interruptedRepository = upsertCanonicalRepositoryInState(
    restartState,
    { id: '903', full_name: 'acme/interrupted' },
    { creator_user_id: 'creator', external_import: false }
  );
restartState.repository_deletion_intents.push({
  id: 'intent-interrupted',
  canonical_repository_id: interruptedRepository.id,
  status: 'executing'
});
assert.equal(recoverInterruptedRepositoryDeletionsInState(restartState, '2026-07-19T12:00:00.000Z'), 1);
assert.equal(restartState.repository_deletion_intents[0].status, 'reconciliation_required');
assert.equal(restartState.canonical_repositories[0].remote_state, 'uncertain');

console.log('V1.9 canonical Repository, isolated binding, and deletion intent tests passed');

function baseState() {
  return {
    instance_owner_user_id: 'creator',
    users: [user('creator', 'owner'), user('viewer')],
    connected_accounts: [
      {
        id: 'acct',
        user_id: 'creator',
        provider: 'github',
        provider_account_id: '42',
        login: 'creator-gh',
        status: 'connected'
      }
    ],
    projects: [
      { id: 'p1', title: 'One', owner_user_id: 'creator', created_by_user_id: 'creator', created_at: timestamp }
    ],
    project_memberships: [membership('p1', 'creator', 'owner'), membership('p1', 'viewer', 'viewer')],
    github_installations: [
      {
        id: 'inst-record',
        installation_id: 'inst-1',
        status: 'active',
        permissions: { administration: 'write' },
        repositories: []
      }
    ],
    canonical_repositories: [],
    project_repository_bindings: [],
    repository_deletion_intents: [],
    repository_connections: [],
    repository_targets: [],
    delivery_policies: [],
    deliveries: []
  };
}
function user(id, role = 'member') {
  return { id, display_name: id, role, auth_mode: 'test', created_at: timestamp, updated_at: timestamp };
}
function membership(projectId, userId, role) {
  return {
    id: `m-${projectId}-${userId}`,
    project_id: projectId,
    user_id: userId,
    role,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp
  };
}
function code(expected) {
  return (error) => error?.payload?.error === expected;
}
