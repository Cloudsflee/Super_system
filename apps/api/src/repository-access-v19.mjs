import { now } from '../../../packages/shared/index.mjs';

/** Revoke only the installation-scoped bindings affected by a GitHub event. */
export function revokeRepositoryInstallationBindingsInState(state, installationId = null, repositoryIds = null, { reason = 'github_installation_access_revoked', timestamp = now() } = {}) {
  ensureArrays(state);
  const installation = installationId == null ? null : String(installationId);
  const ids = repositoryIds == null ? null : new Set((typeof repositoryIds === 'string' ? [repositoryIds] : [...repositoryIds]).map((value) => String(value)));
  const scopeMatches = (item) => {
    const itemInstallation = item.installation_id ?? item.installationId;
    const installationMatches = installation == null || !itemInstallation || String(itemInstallation) === installation;
    const repositoryId = item.repository_id ?? item.repositoryId;
    return installationMatches && (!ids || ids.has(String(repositoryId || '')));
  };
  const canonicalIds = new Set(state.canonical_repositories.filter(scopeMatches).map((item) => item.id));
  for (const binding of state.repository_bindings) {
    if (!scopeMatches(binding)) continue;
    const canonical = state.canonical_repositories.find((item) => item.id === binding.canonical_repository_id || String(item.repository_id) === String(binding.repository_id));
    if (canonical) canonicalIds.add(canonical.id);
    Object.assign(binding, { status: 'removed', removed_at: binding.removed_at || timestamp, removal_reason: reason, updated_at: timestamp });
  }
  const bindingIds = [];
  for (const binding of state.project_repository_bindings) {
    const canonical = state.canonical_repositories.find((item) => item.id === binding.canonical_repository_id);
    const inScope = scopeMatches({ installation_id: binding.installation_id || canonical?.installation_id, repository_id: canonical?.repository_id || binding.repository_id });
    if (!canonicalIds.has(binding.canonical_repository_id) || !inScope) continue;
    bindingIds.push(binding.id);
    Object.assign(binding, { status: 'removed', removed_at: binding.removed_at || timestamp, removal_reason: reason, updated_at: timestamp });
  }
  for (const repository of state.canonical_repositories.filter((item) => canonicalIds.has(item.id))) {
    const stillBound = state.project_repository_bindings.some((item) => item.canonical_repository_id === repository.id && item.status !== 'removed');
    if (stillBound) continue;
    Object.assign(repository, { remote_state: repository.remote_state === 'deleted' ? 'deleted' : 'access_revoked', access_revoked_at: repository.access_revoked_at || timestamp, access_revocation_reason: reason, updated_at: timestamp });
    for (const mirror of state.github_repositories.filter((item) => item.canonical_repository_id === repository.id || String(item.repository_id) === String(repository.repository_id))) Object.assign(mirror, { status: repository.remote_state, access_revoked_at: repository.access_revoked_at, updated_at: timestamp });
  }
  for (const connection of state.repository_connections.filter(scopeMatches)) Object.assign(connection, { sync_status: 'disconnected', disconnected_at: connection.disconnected_at || timestamp, disconnect_reason: reason, updated_at: timestamp });
  return { canonical_repository_ids: [...canonicalIds], project_repository_binding_ids: bindingIds };
}

function ensureArrays(state) {
  for (const key of ['canonical_repositories', 'project_repository_bindings', 'repository_bindings', 'github_repositories', 'repository_connections']) if (!Array.isArray(state[key])) state[key] = [];
}
