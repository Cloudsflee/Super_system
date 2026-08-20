import { canonicalJson, sha256Hex } from './canonical.mjs';

export function redactedIdentityView(value, redact = (item) => item) {
  return redact(value);
}

export function identityRequestHash(value = {}) {
  const json = canonicalJson(value);
  return sha256Hex(json);
}

export function identityStatusTransition(current, next, transitions = {}) {
  const allowed = transitions[current];
  if (allowed && !new Set(allowed).has(next)) {
    const error = new Error('state_conflict');
    error.code = 'state_conflict';
    error.status = 409;
    error.details = { current, next };
    throw error;
  }
  return next;
}

export const IDENTITY_OWNER_TABLES = Object.freeze({
  Actor: Object.freeze(['actors']),
  Session: Object.freeze(['sessions']),
  TeamAccess: Object.freeze(['teams', 'team_memberships', 'project_memberships', 'project_invitations', 'project_acl_entries', 'exchange_grants']),
  CredentialProfile: Object.freeze(['credential_refs', 'provider_profiles'])
});
