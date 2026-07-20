import assert from 'node:assert/strict';
import {
  acceptProjectInvitationInState, assertProjectMembership, createOwnerMembershipInState,
  createProjectInvitationInState, ensureProjectGovernanceDefaults, membershipFor,
  projectInvitationMatchesActor, requireInstanceOwner, revokeProjectInvitationInState, resolveProjectIdForContext
} from '../../apps/api/src/project-governance-v19.mjs';

const timestamp = new Date().toISOString();
const state = {
  instance_owner_user_id: 'owner',
  users: [user('owner', 'owner'), user('collab'), user('viewer'), user('outsider')],
  connected_accounts: [account('owner', '100', 'owner-gh'), account('collab', '101', 'collab-gh'), account('viewer', '102', 'viewer-gh')],
  projects: [{ id: 'p1', title: 'Governed', owner_user_id: 'owner', created_by_user_id: 'owner', created_at: timestamp }],
  project_memberships: [], project_invitations: []
};
ensureProjectGovernanceDefaults(state, { timestamp });
assert.equal(membershipFor(state, 'p1', 'owner').role, 'owner');
assert.equal(requireInstanceOwner(state, 'owner', { scopes: ['project:create'], requireProjectCreateScope: true }).id, 'owner');
assert.throws(() => requireInstanceOwner(state, 'collab', { scopes: ['project:create'], requireProjectCreateScope: true }), code('project_create_owner_required'));
assert.throws(() => requireInstanceOwner(state, 'owner', { scopes: ['project:write'], requireProjectCreateScope: true }), code('mcp_scope_required'));

const collaboratorInvite = createProjectInvitationInState(state, 'p1', { user_id: 'collab', role: 'collaborator', operation_key: 'invite-collab' }, 'owner');
assert.equal(createProjectInvitationInState(state, 'p1', { user_id: 'collab', role: 'collaborator', operation_key: 'invite-collab' }, 'owner').idempotent, true);
assert.throws(() => acceptProjectInvitationInState(state, collaboratorInvite.invitation.id, 'viewer'), code('project_invitation_identity_mismatch'));
assert.equal(acceptProjectInvitationInState(state, collaboratorInvite.invitation.id, 'collab').membership.role, 'collaborator');
assert.equal(assertProjectMembership(state, 'p1', 'collab', 'write').role, 'collaborator');
assert.throws(() => assertProjectMembership(state, 'p1', 'collab', 'share'), code('project_role_forbidden'));

const viewerInvite = createProjectInvitationInState(state, 'p1', { github_identity: { provider: 'github', provider_account_id: '102', login: 'viewer-gh' }, role: 'viewer' }, 'owner');
assert.equal(projectInvitationMatchesActor(state, viewerInvite.invitation, 'viewer'), true);
assert.equal(acceptProjectInvitationInState(state, viewerInvite.invitation.id, 'viewer').membership.role, 'viewer');
assert.equal(assertProjectMembership(state, 'p1', 'viewer', 'read').role, 'viewer');
assert.throws(() => assertProjectMembership(state, 'p1', 'viewer', 'write'), code('project_role_forbidden'));

const revoked = createProjectInvitationInState(state, 'p1', { user_id: 'outsider', role: 'viewer' }, 'owner').invitation;
revokeProjectInvitationInState(state, revoked.id, 'owner');
assert.throws(() => acceptProjectInvitationInState(state, revoked.id, 'outsider'), code('project_invitation_not_pending'));

const previousMembership = state.project_memberships.find((item) => item.project_id === 'p1' && item.user_id === 'collab');
previousMembership.status = 'revoked'; previousMembership.revoked_at = timestamp;
const membershipCount = state.project_memberships.length;
const reinvite = createProjectInvitationInState(state, 'p1', { user_id: 'collab', role: 'viewer' }, 'owner');
const reaccepted = acceptProjectInvitationInState(state, reinvite.invitation.id, 'collab');
assert.equal(reaccepted.membership.id, previousMembership.id);
assert.equal(reaccepted.membership.role, 'viewer');
assert.equal(state.project_memberships.length, membershipCount);

const migrated = { instance_owner_user_id: 'owner', users: state.users, connected_accounts: [], projects: [{ id: 'legacy', title: 'Legacy', created_by_user_id: 'owner', created_at: timestamp }], project_memberships: [], project_invitations: [] };
ensureProjectGovernanceDefaults(migrated, { timestamp });
assert.equal(migrated.projects[0].owner_user_id, 'owner');
assert.equal(migrated.project_memberships[0].role, 'owner');
assert.equal(await resolveProjectIdForContext({ pattern: '/runs/:id' }, { params: { id: 'private-run' }, query: { project_id: 'p1' } }, { node_runs: [{ id: 'private-run', project_id: 'private-project' }] }), 'private-project');

console.log('V1.9 Project owner, membership, invitation, and role matrix tests passed');

function user(id, role = 'member') { return { id, display_name: id, role, auth_mode: 'test', created_at: timestamp, updated_at: timestamp }; }
function account(userId, providerId, login) { return { id: `acct-${userId}`, user_id: userId, provider: 'github', provider_account_id: providerId, login, status: 'connected' }; }
function code(expected) { return (error) => error?.payload?.error === expected; }
