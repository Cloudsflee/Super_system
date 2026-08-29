import { canonicalJson, sha256Hex } from './canonical.mjs';
import { ProcessAppServerAdapter } from './app-server-adapter.mjs';
import { GitHubAppAdapter } from './p8/github-adapter.mjs';
import { PlatformError } from './platform-error.mjs';

export class FakeProviderAdapter {
  constructor({ provider = 'codex', available = true, failureCode = null } = {}) {
    this.provider = String(provider);
    this.available = Boolean(available);
    this.failureCode = failureCode == null ? null : String(failureCode);
    this.calls = [];
  }

  async probe(input = {}) {
    const request = { provider: this.provider, profile_id: input.profile?.id || null, revision: Number(input.profile?.revision || 0) };
    this.calls.push(request);
    if (this.failureCode) {
      const error = new Error('provider probe failed');
      error.code = this.failureCode;
      throw error;
    }
    return {
      available: this.available,
      provider: this.provider,
      adapter: 'fake-contract',
      request_sha256: `sha256:${sha256Hex(canonicalJson(request))}`
    };
  }
}

export function createFakeProviderAdapters(options = {}) {
  return Object.freeze(Object.fromEntries(['codex', 'github', 'mcp'].map((provider) => [provider, new FakeProviderAdapter({ provider, ...(options[provider] || {}) })])));
}

export function createRealProviderAdapters({ config = {}, fetchImpl = globalThis.fetch } = {}) {
  return Object.freeze({
    codex: new CodexProfileProbeAdapter({
      processAdapter: new ProcessAppServerAdapter({
        command: config.providerCommand || 'codex',
        timeoutMs: config.providerTimeoutMs || 30_000,
        homeRoot: config.providerHomeRoot
      })
    }),
    github: new GitHubProfileProbeAdapter({ fetchImpl }),
    mcp: new McpProfileProbeAdapter({ fetchImpl, timeoutMs: config.providerTimeoutMs || 30_000 })
  });
}

export class CodexProfileProbeAdapter {
  constructor({ processAdapter } = {}) {
    this.process = processAdapter || new ProcessAppServerAdapter();
    this.requiresCredentialLease = true;
  }
  async probe({ credential } = {}) {
    if (!Buffer.isBuffer(credential) || !credential.length) throw new PlatformError('rebind_required', 'Codex credential lease is required', {}, 409);
    const result = await this.process.probe({ credential });
    return { available: result.available === true, provider: 'codex', adapter: 'process-app-server', protocol_version: result.protocol_version, schema_sha256: result.schema_sha256 };
  }
}

export class GitHubProfileProbeAdapter {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.github = new GitHubAppAdapter({ fetchImpl });
    this.requiresCredentialLease = true;
  }
  async probe({ profile, credential } = {}) {
    if (!Buffer.isBuffer(credential) || !credential.length) throw new PlatformError('rebind_required', 'GitHub credential lease is required', {}, 409);
    let bundle;
    try { bundle = JSON.parse(credential.toString('utf8')); } catch { throw new PlatformError('github_app_identity_missing', 'GitHub App credential bundle is invalid', {}, 409); }
    const config = profile?.config && typeof profile.config === 'object' ? profile.config : {};
    const privateKey = Buffer.from(String(bundle.private_key || ''), 'utf8');
    try {
      const auth = { appId: config.app_id || bundle.app_id, installationId: config.installation_id || bundle.installation_id, privateKey };
      if (!auth.appId || !auth.installationId || !privateKey.length) throw new PlatformError('github_app_identity_missing', 'GitHub App and Installation identity are required', {}, 409);
      const result = await this.github.listRepositories(auth, { limit: 1 });
      return { available: true, provider: 'github', adapter: 'github-app', repository_visibility_verified: Array.isArray(result.repositories) };
    } finally { privateKey.fill(0); }
  }
}

export class McpProfileProbeAdapter {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = Number(timeoutMs);
    this.requiresCredentialLease = true;
  }
  async probe({ profile, credential } = {}) {
    if (typeof this.fetch !== 'function') throw new PlatformError('mcp_unavailable', 'MCP fetch adapter is unavailable', {}, 503);
    const endpoint = String(profile?.config?.endpoint || profile?.config?.url || '');
    let url;
    try { url = new URL(endpoint); } catch { throw new PlatformError('schema_invalid', 'MCP profile endpoint is invalid', {}, 422); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new PlatformError('schema_invalid', 'MCP profile endpoint is invalid', {}, 422);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(credential?.length ? { authorization: `Bearer ${credential.toString('utf8')}` } : {})
        },
        body: canonicalJson({ jsonrpc: '2.0', id: 'profile-probe', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aiws-v3-clean', version: '10' } } })
      });
      if (!response.ok) throw new PlatformError('mcp_unavailable', 'MCP profile probe failed', { status: response.status }, 503);
      return { available: true, provider: 'mcp', adapter: 'mcp-http', protocol_version: response.headers.get('mcp-protocol-version') || '2025-06-18' };
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('mcp_unavailable', 'MCP profile probe failed', { reason: String(error?.name || error?.code || 'network') }, 503);
    } finally { clearTimeout(timer); }
  }
}
