import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, readState } from '../state.mjs';
import {
  actorForRequest,
  acceptProjectInvitationInState,
  assertProjectRead,
  createProjectInvitationInState,
  listProjectMembers,
  membershipFor,
  PROJECT_ROLE_PERMISSIONS,
  projectRole,
  projectInvitationMatchesActor,
  revokeProjectInvitationInState,
  revokeProjectMembershipInState,
  expireProjectInvitationsInState
} from '../project-governance-v19.mjs';

export const projectGovernanceV19Routes = [
  makeRoute('GET', '/projects/:id/members', listMembers),
  makeRoute('GET', '/projects/:id/memberships', listMembers),
  makeRoute('GET', '/projects/:id/permissions', permissions),
  makeRoute('GET', '/projects/:id/invitations', listInvitations),
  makeRoute('POST', '/projects/:id/invitations', createInvitation),
  makeRoute('POST', '/projects/:id/share', createInvitation),
  makeRoute('POST', '/project-invitations/:id/accept', acceptInvitation),
  makeRoute('POST', '/project-invitations/:id/revoke', revokeInvitation),
  makeRoute('DELETE', '/projects/:id/members/:userId', removeMember)
];

async function listMembers({ req, res, params }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  return send(res, 200, { project_id: params.id, members: listProjectMembers(state, params.id, actor?.id) });
}

async function permissions({ req, res, params }) {
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  assertProjectRead(state, params.id, actor?.id);
  const role = projectRole(state, params.id, actor.id) || (state.instance_owner_user_id === actor.id ? 'owner' : null);
  return send(res, 200, {
    project_id: params.id,
    user_id: actor.id,
    role,
    permissions: [...(PROJECT_ROLE_PERMISSIONS[role] || [])]
  });
}

async function listInvitations({ req, res, params, query }) {
  await mutate((state) => expireProjectInvitationsInState(state));
  const state = await readState(),
    actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
  const membership = membershipFor(state, params.id, actor?.id);
  assertProjectRead(state, params.id, actor?.id);
  let items = state.project_invitations.filter((item) => item.project_id === params.id);
  if (membership?.role !== 'owner')
    items = items.filter((item) => projectInvitationMatchesActor(state, item, actor.id));
  if (query.status) items = items.filter((item) => item.status === query.status);
  return send(res, 200, { project_id: params.id, invitations: items });
}

async function createInvitation({ req, res, params, body }) {
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const created = createProjectInvitationInState(state, params.id, body, actor.id);
    addTrace(
      state,
      'project.invitation.created',
      {
        project_id: params.id,
        target_type: 'project_invitation',
        target_id: created.invitation.id,
        summary: `邀请 Project 成员：${created.invitation.role}`,
        data: {
          invitee_user_id: created.invitation.invitee_user_id,
          github_identity: created.invitation.github_identity
        }
      },
      actor.id
    );
    return created;
  });
  return send(res, result.idempotent ? 200 : 201, result);
}

async function acceptInvitation({ req, res, params }) {
  await mutate((state) => expireProjectInvitationsInState(state));
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const accepted = acceptProjectInvitationInState(state, params.id, actor.id);
    addTrace(
      state,
      'project.invitation.accepted',
      {
        project_id: accepted.invitation.project_id,
        target_type: 'project_membership',
        target_id: accepted.membership.id,
        summary: `接受 Project 邀请：${accepted.membership.role}`
      },
      actor.id
    );
    return accepted;
  });
  return send(res, 200, result);
}

async function revokeInvitation({ req, res, params }) {
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const invitation = revokeProjectInvitationInState(state, params.id, actor.id);
    addTrace(
      state,
      'project.invitation.revoked',
      {
        project_id: invitation.project_id,
        target_type: 'project_invitation',
        target_id: invitation.id,
        summary: '撤销 Project 邀请'
      },
      actor.id
    );
    return invitation;
  });
  return send(res, 200, result);
}

async function removeMember({ req, res, params }) {
  const result = await mutate((state) => {
    const actor = actorForRequest(state, req, { strict: Boolean(req.auth?.clientId) });
    const membership = revokeProjectMembershipInState(state, params.id, params.userId, actor.id);
    addTrace(
      state,
      'project.membership.revoked',
      {
        project_id: params.id,
        target_type: 'project_membership',
        target_id: membership.id,
        summary: '撤销 Project 成员访问',
        data: { user_id: membership.user_id }
      },
      actor.id
    );
    return membership;
  });
  return send(res, 200, result);
}
