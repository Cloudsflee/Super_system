import { IDENTITY_OWNER_TABLES } from './identity-helpers.mjs';

export class TeamAccessService {
  constructor({ core } = {}) {
    if (!core) throw new TypeError('identity_core_required');
    this.core = core;
    this.owner = 'TeamAccess';
    this.tables = IDENTITY_OWNER_TABLES.TeamAccess;
  }
  listTeams(principal) { return this.core.teams(principal); }
  getTeam(id, principal) { return this.core.team(id, principal); }
  createTeam(input, principal) { return this.core.createTeam(input, principal); }
  setTeamStatus(id, status, input, principal) { return this.core.setTeamStatus(id, status, input, principal); }
  memberships(id, principal) { return this.core.memberships(id, principal); }
  grantMembership(id, input, principal) { return this.core.grantMembership(id, input, principal); }
  setMembershipStatus(id, status, input, principal) { return this.core.setMembershipStatus(id, status, input, principal); }
  projectMembers(id, principal) { return this.core.projectMembers(id, principal); }
  projectInvitations(id, principal) { return this.core.projectInvitations(id, principal); }
  createInvitation(id, input, principal) { return this.core.createProjectInvitation(id, input, principal); }
  acceptInvitation(projectId, invitationId, input, principal) { return this.core.acceptProjectInvitation(projectId, invitationId, input, principal); }
  revokeInvitation(projectId, invitationId, input, principal) { return this.core.revokeProjectInvitation(projectId, invitationId, input, principal); }
  grantProjectMembership(id, input, principal) { return this.core.grantProjectMembership(id, input, principal); }
  setProjectMembershipStatus(projectId, membershipId, status, input, principal) { return this.core.setProjectMembershipStatus(projectId, membershipId, status, input, principal); }
  aclEntries(id, principal) { return this.core.aclEntries(id, principal); }
  setAclEntry(id, input, principal) { return this.core.setAclEntry(id, input, principal); }
}
