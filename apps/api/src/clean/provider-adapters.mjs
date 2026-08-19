import { canonicalJson, sha256Hex } from './canonical.mjs';

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
