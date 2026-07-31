import { id } from '../../../packages/shared/index.mjs';

export function applyProjectGovernanceDefaults(state, { timestamp, markLegacy }, githubIdentityForUser) {
  ensureGovernanceCollections(state);
  const ownerId = instanceOwnerCandidate(state);
  if (ownerId && !state.instance_owner_user_id) state.instance_owner_user_id = ownerId;
  for (const project of state.projects || [])
    applyProjectDefaults(state, project, ownerId, timestamp, markLegacy, githubIdentityForUser);
  return state;
}

function ensureGovernanceCollections(state) {
  if (!Array.isArray(state.project_memberships)) state.project_memberships = [];
  if (!Array.isArray(state.project_invitations)) state.project_invitations = [];
  if (!Array.isArray(state.legacy_project_allowlist_compat)) state.legacy_project_allowlist_compat = [];
}

function instanceOwnerCandidate(state) {
  return (
    state.instance_owner_user_id ||
    state.users?.find((item) => item.role === 'owner')?.id ||
    state.users?.[0]?.id ||
    null
  );
}

function applyProjectDefaults(state, project, ownerId, timestamp, markLegacy, githubIdentityForUser) {
  if (!project.owner_user_id) project.owner_user_id = project.created_by_user_id || ownerId;
  if (!project.created_by_user_id) project.created_by_user_id = project.owner_user_id;
  const hadProjectMembership = state.project_memberships.some((item) => item.project_id === project.id),
    existing = state.project_memberships.find(
      (item) => item.project_id === project.id && item.user_id === project.owner_user_id
    );
  recordLegacyAllowlist(state, project, hadProjectMembership, markLegacy);
  if (!existing && project.owner_user_id)
    state.project_memberships.push(ownerMembership(state, project, timestamp, githubIdentityForUser));
  else if (existing && existing.role !== 'owner')
    Object.assign(existing, { role: 'owner', status: 'active', updated_at: timestamp });
}

function recordLegacyAllowlist(state, project, hadProjectMembership, markLegacy) {
  if (
    markLegacy &&
    !hadProjectMembership &&
    project.owner_user_id &&
    !state.legacy_project_allowlist_compat.includes(project.id)
  )
    state.legacy_project_allowlist_compat.push(project.id);
}

function ownerMembership(state, project, timestamp, githubIdentityForUser) {
  return {
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
  };
}
