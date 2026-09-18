import { PlatformError } from './platform-error.mjs';

/**
 * Repository-specific GitHub adapter.
 *
 * GitHub HTTP and Git process details stay in the shared GitHubAppAdapter;
 * this layer owns profile scope and Vault lease boundaries. No credential
 * material is returned to a domain row.
 */
export class GithubRepositoryAdapter {
  constructor({ githubTransport, authResolver, vault = null, maxFiles = 10_000, maxBytes = 100 * 1024 * 1024 } = {}) {
    if (!githubTransport || typeof githubTransport.inspectRepository !== 'function' || typeof githubTransport.materializeRepository !== 'function') {
      throw new TypeError('github_repository_transport_required');
    }
    if (typeof authResolver !== 'function') throw new TypeError('github_repository_auth_resolver_required');
    this.github = githubTransport;
    this.authResolver = authResolver;
    this.vault = vault;
    this.maxFiles = positiveLimit(maxFiles, 10_000);
    this.maxBytes = positiveLimit(maxBytes, 100 * 1024 * 1024);
  }

  bindSource(source = {}) {
    if (!isGithubSource(source)) return source;
    const pin = sourcePin(source);
    return {
      ...source,
      kind: 'git',
      locator: `https://github.com/${pin.fullName}.git`,
      full_name: pin.fullName,
      branch: pin.branch,
      ...(pin.repositoryId ? { repository_id: Number(pin.repositoryId) } : {}),
      ...(pin.expectedHeadSha ? { expected_head_sha: pin.expectedHeadSha } : {})
    };
  }

  async probe(source = {}, principal) {
    const pin = sourcePin(source);
    const auth = await this.#resolveAuth(pin.profileId, principal);
    try {
      return await this.github.inspectRepository(auth, {
        repositoryId: pin.repositoryId,
        fullName: pin.fullName,
        branch: pin.branch,
        expectedHeadSha: pin.expectedHeadSha
      });
    } finally {
      clearAuth(auth);
    }
  }

  async materialize(source = {}, destination, expected = {}, principal) {
    const pin = sourcePin(source, expected);
    const auth = await this.#resolveAuth(pin.profileId, principal);
    try {
      return await this.github.materializeRepository(auth, {
        repositoryId: pin.repositoryId,
        fullName: pin.fullName,
        branch: pin.branch,
        expectedHeadSha: pin.expectedHeadSha || expectedHead(expected),
        destination
      });
    } finally {
      clearAuth(auth);
    }
  }

  async #resolveAuth(profileId, principal) {
    let resolved;
    try {
      resolved = await this.authResolver(profileId, principal);
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('github_auth_unavailable', 'GitHub profile authentication is unavailable', {}, 503);
    }
    // A resolver may return { profile, auth } for test/integration adapters,
    // or the normalized auth object used by the runtime resolver.
    const profile = resolved?.profile && typeof resolved.profile === 'object'
      ? resolved.profile
      : (resolved?.auth && resolved?.provider ? resolved : null);
    const auth = resolved?.auth && typeof resolved.auth === 'object' ? resolved.auth : resolved;
    try {
      if (profile) assertProfile(profile, principal);
      if (resolved?.credential && typeof resolved.credential === 'object') assertCredential(resolved.credential);
      if (!auth || typeof auth !== 'object') throw new PlatformError('github_auth_unavailable', 'GitHub profile authentication is unavailable', {}, 503);
      if (auth.profile && typeof auth.profile === 'object') assertProfile(auth.profile, principal);
      return auth;
    } catch (error) {
      clearAuth(auth);
      throw error;
    }
  }
}

/** Route local Git/fixture sources without creating a second GitHub owner. */
export class RepositoryAdapterRouter {
  constructor({ local, github } = {}) {
    if (!local || !github) throw new TypeError('repository_adapter_router_dependencies_required');
    this.local = local;
    this.github = github;
  }

  bindSource(source = {}) { return this.#adapter(source).bindSource?.(source) || source; }
  probe(source = {}, principal) { return this.#adapter(source).probe(source, principal); }
  materialize(source = {}, destination, expected, principal) { return this.#adapter(source).materialize(source, destination, expected, principal); }
  #adapter(source) { return isGithubSource(source) ? this.github : this.local; }
}

function isGithubSource(source = {}) {
  const provider = String(source.provider || source.transport || source.adapter || source.metadata?.provider || '').toLowerCase();
  if (provider === 'fixture' || provider === 'local' || provider === 'https') return false;
  if (provider === 'github' || provider === 'git') return true;
  if (source.kind !== 'git') return false;
  return Boolean(source.provider_profile_id || source.github_profile_id || source.profile_id
    || source.metadata?.provider_profile_id || source.metadata?.github_profile_id || source.metadata?.profile_id
    || source.repository_id || source.full_name || source.repository_full_name
    || /^https:\/\/github\.com\//i.test(String(source.locator || '')));
}

function sourcePin(source = {}, expected = {}) {
  const metadata = source.metadata && typeof source.metadata === 'object' ? source.metadata : {};
  const profileId = String(source.provider_profile_id || source.github_profile_id || source.profile_id
    || metadata.provider_profile_id || metadata.github_profile_id || metadata.profile_id || '').trim();
  if (!profileId) throw new PlatformError('github_profile_required', 'GitHub provider profile is required', {}, 409);
  const fullName = normalizeFullName(source.full_name || source.repository_full_name || metadata.repository_full_name || source.locator);
  const repositoryId = source.repository_id ?? source.github_repository_id ?? metadata.repository_id ?? null;
  if (repositoryId != null && !safeRepositoryId(repositoryId)) {
    throw new PlatformError('github_repository_id_invalid', 'GitHub repository id is invalid', {}, 422);
  }
  const branch = normalizeBranch(source.branch || metadata.branch || expected.branch || 'main');
  const expectedHeadSha = source.expected_head_sha || source.expectedHeadSha || metadata.api_head_sha
    || expected.expected_head_sha || expected.expectedHeadSha || expected.revision || null;
  if (expectedHeadSha && !/^[a-f0-9]{40}$/i.test(String(expectedHeadSha))) {
    throw new PlatformError('github_branch_head_invalid', 'expected GitHub branch HEAD is invalid', {}, 422);
  }
  return {
    profileId,
    repositoryId: repositoryId == null || repositoryId === '' ? null : String(repositoryId),
    fullName,
    branch,
    expectedHeadSha: expectedHeadSha ? String(expectedHeadSha).toLowerCase() : null
  };
}

function normalizeFullName(value) {
  let raw = String(value || '').trim();
  if (!raw) throw new PlatformError('github_repository_invalid', 'GitHub repository is required', {}, 422);
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new PlatformError('github_repository_invalid', 'GitHub repository URL is invalid', {}, 422); }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/.test(parsed.pathname) || /%2e/i.test(parsed.pathname)) {
      throw new PlatformError('github_repository_invalid', 'GitHub repository URL is invalid', {}, 422);
    }
    raw = parsed.pathname;
  }
  raw = raw.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const segments = raw.split('/');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) || segments.some((segment) => segment === '.' || segment === '..')) throw new PlatformError('github_repository_invalid', 'GitHub repository name is invalid', {}, 422);
  return raw;
}

function normalizeBranch(value) {
  const branch = String(value || '').trim();
  if (!branch || branch.length > 256 || branch === '@' || branch.startsWith('-') || branch.startsWith('/') || branch.startsWith('refs/') || branch.endsWith('/') || branch.endsWith('.lock') || branch.includes('//') || branch.includes('\\') || branch.includes('..') || branch.includes('@{') || branch.includes('~') || branch.includes('^') || branch.includes(':') || branch.includes('?') || branch.includes('*') || branch.includes('[') || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.')) || /[\u0000-\u0020\u007f]/.test(branch)) {
    throw new PlatformError('github_branch_invalid', 'GitHub branch is invalid', {}, 422);
  }
  return branch;
}

function expectedHead(value = {}) { return value.revision || value.expected_head_sha || value.expectedHeadSha || null; }

function safeRepositoryId(value) {
  const text = String(value ?? '');
  const number = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(number);
}

function assertProfile(profile, principal) {
  const actorId = String(principal?.actorId || principal?.actor_id || '');
  const owner = profile.owner_actor_id ?? profile.ownerActorId ?? profile.actor_id ?? profile.actorId;
  if (owner != null && String(owner) !== actorId) throw new PlatformError('permission_denied', 'GitHub profile belongs to another actor', {}, 403);
  if (String(profile.provider || '').toLowerCase() !== 'github') throw new PlatformError('github_profile_unavailable', 'GitHub provider profile is unavailable', {}, 409);
  if ((profile.status != null && profile.status !== 'available') || profile.available === false || profile.unavailable === true) throw new PlatformError('github_profile_unavailable', 'GitHub provider profile is unavailable', {}, 409);
  if (profile.lifecycle_status === 'disabled' || profile.disabled === true) throw new PlatformError('github_profile_unavailable', 'GitHub provider profile is disabled', {}, 409);
  const credential = profile.credential || profile.credential_ref || null;
  if (credential) assertCredential(credential);
}

function assertCredential(credential) {
  if ((credential.status != null && credential.status !== 'active') || credential.active === false || !String(credential.external_ref || '').startsWith('vault:')) {
    throw new PlatformError('credential_rebind_required', 'GitHub credential must be rebound', {}, 409);
  }
}

function clearAuth(auth) {
  if (!auth || typeof auth !== 'object') return;
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) { value.fill(0); return; }
    for (const [name, child] of Object.entries(value)) {
      if (/token|authorization|credential|secret|private|jwt|proof|header/i.test(name)) {
        if (Buffer.isBuffer(child) || child instanceof Uint8Array) child.fill(0);
        else if (child && typeof child === 'object') visit(child);
        else if (typeof child === 'string') value[name] = '';
      } else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(auth);
}

function positiveLimit(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new PlatformError('repository_quota_invalid', 'repository quota is invalid', {}, 422);
  return number;
}

export { normalizeFullName as normalizeGithubRepositoryName, sourcePin as githubRepositoryPin };
