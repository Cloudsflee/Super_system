import { PlatformError } from './platform-error.mjs';

/** Authenticated GitHub transport for Repository connections and Workspaces. */
export class GithubRepositoryAdapter {
  constructor({ githubTransport, authResolver, vault = null, maxBytes = 100 * 1024 * 1024 } = {}) {
    if (!githubTransport || typeof githubTransport.inspectRepository !== 'function' || typeof githubTransport.materializeRepository !== 'function') throw new TypeError('github_repository_transport_required');
    if (typeof authResolver !== 'function') throw new TypeError('github_repository_auth_resolver_required');
    this.github = githubTransport;
    this.authResolver = authResolver;
    this.vault = vault;
    this.maxBytes = Number(maxBytes);
  }

  bindSource(source = {}) { return source; }

  async probe(source = {}, principal) {
    const pin = sourcePin(source);
    const auth = await this.authResolver(pin.profileId, principal);
    try {
      return await this.github.inspectRepository(auth, pin);
    } finally { clearAuth(auth); }
  }

  async materialize(source = {}, destination, expected = {}, principal) {
    const pin = sourcePin(source, expected);
    const auth = await this.authResolver(pin.profileId, principal);
    try {
      return await this.github.materializeRepository(auth, { ...pin, destination, expectedHeadSha: pin.expectedHeadSha || expected.revision || null });
    } finally { clearAuth(auth); }
  }
}

export class RepositoryAdapterRouter {
  constructor({ local, github }) { this.local = local; this.github = github; }
  bindSource(source = {}) { return source.kind === 'git' ? this.github.bindSource?.(source) || source : this.local.bindSource?.(source) || source; }
  probe(source, principal) { return source.kind === 'git' ? this.github.probe(source, principal) : this.local.probe(source, principal); }
  materialize(source, destination, expected, principal) { return source.kind === 'git' ? this.github.materialize(source, destination, expected, principal) : this.local.materialize(source, destination, expected, principal); }
}

function sourcePin(source = {}, expected = {}) {
  const metadata = source.metadata && typeof source.metadata === 'object' ? source.metadata : {};
  const profileId = String(source.provider_profile_id || source.profile_id || metadata.provider_profile_id || metadata.github_profile_id || metadata.profile_id || '');
  if (!profileId) throw new PlatformError('github_profile_required', 'GitHub provider profile is required', {}, 409);
  const fullName = String(source.full_name || source.repository_full_name || metadata.repository_full_name || source.locator || '').replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  return {
    profileId,
    repositoryId: source.repository_id || source.github_repository_id || metadata.repository_id || null,
    fullName,
    branch: String(source.branch || metadata.branch || 'main'),
    expectedHeadSha: source.expected_head_sha || source.expectedHeadSha || metadata.api_head_sha || expected.revision || null
  };
}

function clearAuth(auth) {
  if (!auth || typeof auth !== 'object') return;
  if (Buffer.isBuffer(auth.privateKey)) auth.privateKey.fill(0);
  if (Buffer.isBuffer(auth.jwt)) auth.jwt.fill(0);
}
