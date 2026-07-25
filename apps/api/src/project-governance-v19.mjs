import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from './http.mjs';
import { currentActorId } from './actor-context.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { isProjectRoute, resolveProjectIdForContext } from './project-route-resolution-v19.mjs';
export { isProjectRoute, resolveProjectIdForContext } from './project-route-resolution-v19.mjs';

export const PROJECT_ROLES = Object.freeze(['owner', 'collaborator', 'viewer']);
export const PROJECT_ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(['read', 'write', 'run', 'propose', 'approve', 'share', 'github:write', 'delete:approve']),
  collaborator: Object.freeze(['read', 'write', 'run', 'propose', 'github:write']),
  viewer: Object.freeze(['read'])
});
export const PROJECT_SCOPES = Object.freeze(['project:create', 'project:read', 'project:write', 'project:share']);

/** Return the authenticated subject carried by a REST or MCP request. */
export function requestSubjectUserId(req = {}, { allowBody = false, body = null } = {}) {
  const extra = req.auth?.extra || {};
  const candidates = [
    extra.subject_user_id,
    req.auth?.subject_user_id,
    header(req, 'x-aiws-subject-user-id'),
    header(req, 'x-aiws-user-id')
  ];
  if (allowBody) candidates.push(body?.subject_user_id);
  const value = candidates.find((item) => item !== undefined && item !== null && String(item).trim());
  return value == null ? null : String(value).trim();
}

export function actorForRequest(state, req = {}, options = {}) {
  const requested = requestSubjectUserId(req, options);
  if (requested) {
    const user = state.users?.find((item) => item.id === requested);
    if (!user) throw new HttpError(401, { error: 'authenticated_subject_not_found', subject_user_id: requested });
    return user;
  }
  if (options.strict) throw new HttpError(401, { error: 'authentication_required' });
  // Preserve the bootstrap-only local session for legacy single-user clients.
  // Once another user exists, every request must carry a real subject.
  const local = state.users?.find((item) => item.auth_mode === 'local_auto' && item.role === 'owner');
  if (local && state.users.length === 1) return local;
  throw new HttpError(401, { error: 'authentication_required' });
}

export function instanceOwnerId(state) {
  return state?.instance_owner_user_id || state?.users?.find((item) => item.role === 'owner')?.id || null;
}

export function requireInstanceOwner(state, actorId, { scopes = [], requireProjectCreateScope = false } = {}) {
  const subject = state.users?.find((item) => item.id === actorId);
  if (!subject || subject.id !== instanceOwnerId(state) || !['owner', 'admin'].includes(String(subject.role || ''))) {
    throw new HttpError(403, { error: 'project_create_owner_required', required: 'instance_owner' });
  }
  if (requireProjectCreateScope && !new Set(scopes || []).has('project:create')) {
    throw new HttpError(403, { error: 'mcp_scope_required', required_scopes: ['project:create'] });
  }
  return subject;
}

export function membershipFor(state, projectId, userId, { includeRevoked = false, includeDeleted = false } = {}) {
  const project = state.projects?.find((item) => item.id === projectId && (includeDeleted || !item.deleted_at));
  if (!project || !userId) return null;
  const ownerId = project.owner_user_id || project.created_by_user_id;
  if (ownerId === userId) {
    const explicit = state.project_memberships?.find(
      (item) => item.project_id === projectId && item.user_id === userId
    );
    if (explicit && (includeRevoked || explicit.status === 'active'))
      return { ...explicit, role: 'owner', status: explicit.status || 'active' };
    return {
      id: `implicit-owner:${projectId}:${userId}`,
      project_id: projectId,
      user_id: userId,
      role: 'owner',
      status: 'active',
      implicit: true
    };
  }
  const membership = state.project_memberships?.find(
    (item) => item.project_id === projectId && item.user_id === userId
  );
  if (!membership || (!includeRevoked && membership.status !== 'active')) return null;
  return membership;
}

export function projectRole(state, projectId, userId) {
  return membershipFor(state, projectId, userId)?.role || null;
}

export function accessibleProjectIds(state, userId = currentActorId()) {
  const actorId = userId || instanceOwnerId(state);
  if (!actorId) return new Set();
  if (actorId === instanceOwnerId(state))
    return new Set((state.projects || []).filter((item) => !item.deleted_at).map((item) => item.id));
  const activeProjects = new Set((state.projects || []).filter((item) => !item.deleted_at).map((item) => item.id));
  return new Set(
    (state.project_memberships || [])
      .filter((item) => item.user_id === actorId && item.status === 'active' && activeProjects.has(item.project_id))
      .map((item) => item.project_id)
  );
}

export function assertProjectMembership(
  state,
  projectId,
  userId,
  action = 'read',
  { allowInstanceOwner = true, allowDeleted = false } = {}
) {
  const project = state.projects?.find((item) => item.id === projectId && (allowDeleted || !item.deleted_at));
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  const membership = membershipFor(state, projectId, userId, { includeDeleted: allowDeleted });
  if (!membership && allowInstanceOwner && userId === instanceOwnerId(state)) {
    return {
      project,
      membership: { project_id: projectId, user_id: userId, role: 'owner', status: 'active', implicit: true }
    };
  }
  if (!membership) throw new HttpError(403, { error: 'project_access_denied', project_id: projectId, action });
  const role = normalizeRole(membership.role);
  const permissions = PROJECT_ROLE_PERMISSIONS[role] || [];
  if (!permissions.includes(action) && !(action === 'github:write' && permissions.includes('write'))) {
    throw new HttpError(403, { error: 'project_role_forbidden', project_id: projectId, role, action });
  }
  return { project, membership: { ...membership, role }, role };
}

export function assertProjectRead(state, projectId, userId) {
  return assertProjectMembership(state, projectId, userId, 'read');
}
export function assertProjectWrite(state, projectId, userId) {
  return assertProjectMembership(state, projectId, userId, 'write');
}
export function assertProjectShare(state, projectId, userId) {
  return assertProjectMembership(state, projectId, userId, 'share', { allowInstanceOwner: false });
}
export function assertProjectRun(state, projectId, userId) {
  return assertProjectMembership(state, projectId, userId, 'run');
}
export function ensureProjectGovernanceDefaults(state, { timestamp = now(), markLegacy = true } = {}) {
  if (!Array.isArray(state.project_memberships)) state.project_memberships = [];
  if (!Array.isArray(state.project_invitations)) state.project_invitations = [];
  if (!Array.isArray(state.legacy_project_allowlist_compat)) state.legacy_project_allowlist_compat = [];
  const ownerId =
    state.instance_owner_user_id ||
    state.users?.find((item) => item.role === 'owner')?.id ||
    state.users?.[0]?.id ||
    null;
  if (ownerId && !state.instance_owner_user_id) state.instance_owner_user_id = ownerId;
  for (const project of state.projects || []) {
    if (!project.owner_user_id) project.owner_user_id = project.created_by_user_id || ownerId;
    if (!project.created_by_user_id) project.created_by_user_id = project.owner_user_id;
    const hadProjectMembership = state.project_memberships.some((item) => item.project_id === project.id);
    const existing = state.project_memberships.find(
      (item) => item.project_id === project.id && item.user_id === project.owner_user_id
    );
    if (
      markLegacy &&
      !hadProjectMembership &&
      project.owner_user_id &&
      !state.legacy_project_allowlist_compat.includes(project.id)
    )
      state.legacy_project_allowlist_compat.push(project.id);
    if (!existing && project.owner_user_id)
      state.project_memberships.push({
        id: id('pmb'),
        project_id: project.id,
        user_id: project.owner_user_id,
        role: 'owner',
        status: 'active',
        source: 'migration',
        invited_by_user_id: null,
        github_identity: githubIdentityForUser(state, project.owner_user_id),
        accepted_at: project.created_at || timestamp,
        revoked_at: null,
        created_at: project.created_at || timestamp,
        updated_at: timestamp
      });
    else if (existing && existing.role !== 'owner')
      Object.assign(existing, { role: 'owner', status: 'active', updated_at: timestamp });
  }
  return state;
}
export function expireProjectInvitationsInState(state, { at = Date.now() } = {}) {
  let changed = false;
  const timestamp = new Date(Number(at)).toISOString();
  for (const invitation of state.project_invitations || [])
    if (invitation.status === 'pending' && new Date(invitation.expires_at).getTime() <= Number(at)) {
      Object.assign(invitation, {
        status: 'expired',
        expired_at: invitation.expired_at || timestamp,
        updated_at: timestamp
      });
      changed = true;
    }
  return changed;
}
export function createOwnerMembershipInState(state, project, userId, { source = 'created' } = {}) {
  ensureProjectGovernanceDefaults(state, { markLegacy: false });
  const prior = state.project_memberships.find((item) => item.project_id === project.id && item.user_id === userId);
  if (prior) {
    Object.assign(prior, {
      role: 'owner',
      status: 'active',
      source: source === 'created' ? 'created' : prior.source,
      updated_at: now()
    });
    return prior;
  }
  const membership = {
    id: id('pmb'),
    project_id: project.id,
    user_id: userId,
    role: 'owner',
    status: 'active',
    source,
    invited_by_user_id: null,
    github_identity: githubIdentityForUser(state, userId),
    accepted_at: now(),
    revoked_at: null,
    created_at: now(),
    updated_at: now()
  };
  state.project_memberships.push(membership);
  return membership;
}
export function listProjectMembers(state, projectId, actorId) {
  assertProjectRead(state, projectId, actorId);
  return state.project_memberships
    .filter((item) => item.project_id === projectId && item.status === 'active')
    .map((item) => ({ ...item, user: publicUser(state.users?.find((user) => user.id === item.user_id)) }));
}
export function createProjectInvitationInState(state, projectId, input, inviterId) {
  assertProjectShare(state, projectId, inviterId);
  const role = normalizeInviteRole(input.role);
  const target = resolveInviteTarget(state, input);
  if (!target.user_id && !target.github_identity)
    throw new HttpError(400, { error: 'project_invitee_identity_required' });
  if (target.user_id && target.user_id === inviterId)
    throw new HttpError(409, { error: 'project_invitee_self_forbidden' });
  const existingMembership = target.user_id && membershipFor(state, projectId, target.user_id);
  if (existingMembership) throw new HttpError(409, { error: 'project_member_already_exists' });
  const operationKey =
    String(input.operation_key || '')
      .trim()
      .slice(0, 128) || null;
  if (operationKey) {
    const prior = state.project_invitations.find(
      (item) =>
        item.project_id === projectId && item.operation_key === operationKey && item.invited_by_user_id === inviterId
    );
    if (prior) return { invitation: prior, idempotent: true };
  }
  const expiresAt = invitationExpiry(input.expires_at, input.ttl_seconds);
  const invitation = {
    id: id('pinv'),
    project_id: projectId,
    invited_by_user_id: inviterId,
    invitee_user_id: target.user_id || null,
    github_identity: target.github_identity || null,
    role,
    status: 'pending',
    revision: 1,
    operation_key: operationKey,
    expires_at: expiresAt,
    accepted_at: null,
    revoked_at: null,
    created_at: now(),
    updated_at: now()
  };
  state.project_invitations.push(invitation);
  return { invitation, idempotent: false };
}
export function acceptProjectInvitationInState(state, invitationId, actorId) {
  const invitation = state.project_invitations.find((item) => item.id === invitationId);
  if (!invitation) throw new HttpError(404, { error: 'project_invitation_not_found' });
  if (invitation.status !== 'pending')
    throw new HttpError(409, {
      error: invitation.status === 'expired' ? 'project_invitation_expired' : 'project_invitation_not_pending'
    });
  if (new Date(invitation.expires_at).getTime() <= Date.now()) {
    Object.assign(invitation, { status: 'expired', updated_at: now() });
    throw new HttpError(410, { error: 'project_invitation_expired' });
  }
  if (!projectInvitationMatchesActor(state, invitation, actorId))
    throw new HttpError(403, { error: 'project_invitation_identity_mismatch' });
  const prior = membershipFor(state, invitation.project_id, actorId);
  if (prior) {
    Object.assign(invitation, { status: 'accepted', accepted_at: now(), updated_at: now() });
    return { invitation, membership: prior, idempotent: true };
  }
  const acceptedAt = now();
  let membership = state.project_memberships.find(
    (item) => item.project_id === invitation.project_id && item.user_id === actorId
  );
  if (membership) {
    Object.assign(membership, {
      role: invitation.role,
      status: 'active',
      source: 'invitation',
      invited_by_user_id: invitation.invited_by_user_id,
      invitation_id: invitation.id,
      github_identity: githubIdentityForUser(state, actorId) || invitation.github_identity,
      accepted_at: acceptedAt,
      revoked_at: null,
      updated_at: acceptedAt
    });
  } else {
    membership = {
      id: id('pmb'),
      project_id: invitation.project_id,
      user_id: actorId,
      role: invitation.role,
      status: 'active',
      source: 'invitation',
      invited_by_user_id: invitation.invited_by_user_id,
      invitation_id: invitation.id,
      github_identity: githubIdentityForUser(state, actorId) || invitation.github_identity,
      accepted_at: acceptedAt,
      revoked_at: null,
      created_at: acceptedAt,
      updated_at: acceptedAt
    };
    state.project_memberships.push(membership);
  }
  Object.assign(invitation, {
    status: 'accepted',
    accepted_at: membership.accepted_at,
    updated_at: now(),
    revision: Number(invitation.revision || 1) + 1
  });
  return { invitation, membership, idempotent: false };
}
export function revokeProjectInvitationInState(state, invitationId, actorId) {
  const invitation = state.project_invitations.find((item) => item.id === invitationId);
  if (!invitation) throw new HttpError(404, { error: 'project_invitation_not_found' });
  assertProjectShare(state, invitation.project_id, actorId);
  if (invitation.status === 'accepted') throw new HttpError(409, { error: 'project_invitation_already_accepted' });
  if (invitation.status !== 'revoked')
    Object.assign(invitation, {
      status: 'revoked',
      revoked_at: now(),
      revision: Number(invitation.revision || 1) + 1,
      updated_at: now()
    });
  return invitation;
}
export function revokeProjectMembershipInState(state, projectId, userId, actorId) {
  assertProjectShare(state, projectId, actorId);
  const membership = state.project_memberships.find(
    (item) => item.project_id === projectId && item.user_id === userId && item.status === 'active'
  );
  if (!membership) throw new HttpError(404, { error: 'project_member_not_found' });
  if (membership.role === 'owner') throw new HttpError(409, { error: 'project_owner_revoke_forbidden' });
  Object.assign(membership, { status: 'revoked', revoked_at: now(), updated_at: now() });
  return membership;
}

/** Route-level ACL used by both HTTP dispatch and MCP registry invocation. */
export async function authorizeApiRoute(route, ctx, { state = null, strict = false } = {}) {
  const projectId = await resolveProjectIdForContext(route, ctx, state);
  if (route.pattern === '/project-invitations/:id/accept')
    return { project_id: projectId, actor_id: requestSubjectUserId(ctx.req || {}) };
  if (!projectId || !isProjectRoute(route.pattern))
    return { project_id: projectId, actor_id: requestSubjectUserId(ctx.req || {}) };
  const snapshot = state || (await (await import('./state.mjs')).readState());
  const actor = actorForRequest(snapshot, ctx.req || {}, { strict });
  if (!actor) throw new HttpError(401, { error: 'authentication_required' });
  const approval =
    /^\/(?:approvals\/|change-proposals\/[^/]+\/(?:approve|reject|apply)|(?:tasks|workstreams)\/[^/]+\/review|task-executions\/[^/]+\/human-approve|asset-versions\/[^/]+\/attestations|pull-request-intents\/[^/]+\/(?:approve|execute))/.test(
      route.pattern
    ) ||
    (route.method === 'POST' && /\/delivery-policies$/.test(route.pattern));
  const ownerLifecycle =
    (route.method === 'DELETE' && route.pattern === '/projects/:id') ||
    (route.method === 'POST' && /^\/projects\/:id\/(?:trash|restore|purge)$/.test(route.pattern));
  const action =
    route.method === 'GET'
      ? 'read'
      : ownerLifecycle
        ? 'delete:approve'
        : route.pattern.includes('/members') || route.pattern.includes('/invit')
          ? 'share'
          : route.pattern.includes('/run')
            ? 'run'
            : approval
              ? 'approve'
              : 'write';
  const client = snapshot.mcp_clients?.find((item) => item.id === ctx.req?.auth?.clientId);
  if (
    client &&
    process.env.AIWS_MCP_REMOTE_MODE === 'gateway' &&
    client.kind === 'external' &&
    client.subject_user_id === actor.id &&
    client.project_allowlist?.includes(projectId) &&
    snapshot.legacy_project_allowlist_compat?.includes(projectId)
  ) {
    return { project_id: projectId, actor_id: actor.id, role: 'collaborator', legacy_allowlist_compat: true };
  }
  const allowDeleted = /^\/projects\/:id\/(?:restore|purge)$/.test(route.pattern);
  assertProjectMembership(snapshot, projectId, actor.id, action, { allowDeleted });
  return { project_id: projectId, actor_id: actor.id, role: projectRole(snapshot, projectId, actor.id) };
}
export function publicUser(user) {
  return user
    ? {
        id: user.id,
        display_name: user.display_name,
        email: user.email || '',
        avatar_url: user.avatar_url || '',
        role: user.role || 'member',
        auth_mode: user.auth_mode || null
      }
    : null;
}
export function normalizeRole(value) {
  const role = String(value || '')
    .trim()
    .toLowerCase();
  if (!PROJECT_ROLES.includes(role)) throw new HttpError(400, { error: 'project_role_invalid', role });
  return role;
}
export function githubIdentityForUser(state, userId) {
  const account = state.connected_accounts?.find(
    (item) => item.user_id === userId && item.provider === 'github' && item.status === 'connected'
  );
  const user = state.users?.find((item) => item.id === userId);
  return account
    ? {
        provider: 'github',
        provider_account_id: String(account.provider_account_id || ''),
        login: account.login || null
      }
    : user?.github_identity || null;
}
function resolveInviteTarget(state, input) {
  if (input.user_id || input.invitee_user_id) {
    const userId = String(input.user_id || input.invitee_user_id);
    if (!state.users?.some((item) => item.id === userId))
      throw new HttpError(404, { error: 'project_invitee_user_not_found' });
    return { user_id: userId, github_identity: githubIdentityForUser(state, userId) };
  }
  const identity =
    input.github_identity ||
    (input.github_user_id || input.github_login
      ? {
          provider: 'github',
          provider_account_id: input.github_user_id ? String(input.github_user_id) : null,
          login: input.github_login || null
        }
      : null);
  if (!identity) return { user_id: null, github_identity: null };
  if (!String(identity.provider_account_id || '').trim() && !String(identity.login || '').trim())
    throw new HttpError(400, { error: 'project_invitee_identity_required' });
  const account = state.connected_accounts?.find(
    (item) =>
      item.provider === 'github' &&
      item.status === 'connected' &&
      ((identity.provider_account_id && String(item.provider_account_id) === String(identity.provider_account_id)) ||
        (identity.login && String(item.login).toLowerCase() === String(identity.login).toLowerCase()))
  );
  return {
    user_id: account?.user_id || null,
    github_identity: {
      provider: 'github',
      provider_account_id: identity.provider_account_id || account?.provider_account_id || null,
      login: identity.login || account?.login || null
    }
  };
}
export function projectInvitationMatchesActor(state, invitation, actorId) {
  if (invitation.invitee_user_id) return invitation.invitee_user_id === actorId;
  const expected = invitation.github_identity,
    actual = githubIdentityForUser(state, actorId);
  return Boolean(
    expected &&
    actual &&
    (!expected.provider_account_id || String(expected.provider_account_id) === String(actual.provider_account_id)) &&
    (!expected.login || String(expected.login).toLowerCase() === String(actual.login).toLowerCase())
  );
}
function normalizeInviteRole(value) {
  const role = String(value || 'collaborator').toLowerCase();
  if (!['collaborator', 'viewer'].includes(role))
    throw new HttpError(400, { error: 'project_invitation_role_invalid' });
  return role;
}
function invitationExpiry(value, ttl) {
  const max = 30 * 24 * 60 * 60 * 1000,
    candidate =
      ttl == null
        ? value == null
          ? 7 * 24 * 60 * 60 * 1000
          : new Date(value).getTime() - Date.now()
        : Number(ttl) * 1000;
  if (!Number.isFinite(candidate) || candidate < 60_000 || candidate > max)
    throw new HttpError(400, { error: 'project_invitation_expiry_invalid' });
  return new Date(Date.now() + candidate).toISOString();
}
function header(req, name) {
  const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value ? String(value) : null;
}

export function hashSnapshot(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value ?? null))
    .digest('hex');
}
export function revisionNonce() {
  return randomUUID().replaceAll('-', '');
}

export const assertProjectAccess = assertProjectMembership;
export const getProjectMembership = membershipFor;
export const checkProjectPermission = (state, projectId, userId, action = 'read') => {
  try {
    assertProjectMembership(state, projectId, userId, action);
    return true;
  } catch {
    return false;
  }
};
export const inviteProjectMemberInState = createProjectInvitationInState;
export const acceptInvitationInState = acceptProjectInvitationInState;
