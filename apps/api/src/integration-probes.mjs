import { now } from './crypto.mjs';

export const CODEX_ERROR_CODES = new Set([
  'runner_unavailable',
  'runner_digest_mismatch',
  'runner_cli_version_mismatch',
  'credential_missing',
  'model_mismatch',
  'egress_unavailable',
  'probe_timeout',
  'provider_failed',
  'deterministic_adapter'
]);

const BROKER_CACHE_MS = 5_000;
const PROVIDER_CACHE_MS = 15 * 60 * 1000;

function normalizeCodexError(value) {
  const code = String(value || 'provider_failed').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (['runner_image_unavailable', 'runner_probe_failed', 'broker_unavailable'].includes(code)) return 'runner_unavailable';
  if (['model_name_invalid', 'model_not_found'].includes(code)) return 'model_mismatch';
  return CODEX_ERROR_CODES.has(code) ? code : 'provider_failed';
}

export class IntegrationProbeService {
  constructor({ config, broker, github = null, clock = () => Date.now() }) {
    this.config = config;
    this.broker = broker;
    this.github = github;
    this.clock = clock;
    this.brokerCache = null;
    this.codexCache = null;
    this.githubCache = null;
  }

  fresh(cache, ttl) {
    return cache && this.clock() - cache.checked < ttl;
  }

  async brokerProbe({ force = false } = {}) {
    if (!force && this.fresh(this.brokerCache, BROKER_CACHE_MS)) return this.brokerCache.value;
    const value = await this.broker.probe().catch(() => ({ ready: false, error: 'runner_unavailable' }));
    this.brokerCache = { checked: this.clock(), value };
    return value;
  }

  async capabilities() {
    const broker = await this.brokerProbe();
    const codex = this.fresh(this.codexCache, PROVIDER_CACHE_MS)
      ? this.codexCache.value
      : { provider: 'codex', model: String(this.config.codexModel || 'gpt-5.5'), status: 'unknown', checked_at: null, error_code: 'not_probed' };
    const github = this.fresh(this.githubCache, PROVIDER_CACHE_MS)
      ? this.githubCache.value
      : { provider: 'github', status: 'unknown', checked_at: null, error_code: 'not_probed' };
    return {
      version: this.config.version,
      api: this.config.apiPrefix,
      codex: { provider: 'codex', status: codex.status, model: codex.model, checked_at: codex.checked_at, error_code: codex.error_code },
      github,
      broker: { status: broker.ready ? 'available' : 'unavailable', runner_digest: broker.runner_digest || this.config.runnerDigest }
    };
  }

  async probeCodex({ force = false } = {}) {
    if (!force && this.fresh(this.codexCache, PROVIDER_CACHE_MS)) return this.codexCache.value;
    const broker = await this.brokerProbe({ force });
    const realRunner = Boolean(broker.ready && broker.executor === 'docker');
    let available = false;
    let errorCode = !broker.ready
      ? normalizeCodexError(broker.error || 'runner_unavailable')
      : !realRunner
        ? 'deterministic_adapter'
        : !this.config.codexCredential
          ? 'credential_missing'
          : null;
    if (!errorCode && typeof this.broker.codexProbe === 'function') {
      const providerProbe = await this.broker.codexProbe().catch((error) => ({ status: 'unavailable', error_code: normalizeCodexError(error?.code || 'provider_failed') }));
      available = providerProbe?.status === 'available';
      errorCode = available ? null : normalizeCodexError(providerProbe?.error_code || 'provider_failed');
    } else if (!errorCode) {
      available = true;
    }
    const result = {
      provider: 'codex',
      model: String(this.config.codexModel || 'gpt-5.5'),
      status: available ? 'available' : 'unavailable',
      checked_at: now(),
      error_code: available ? null : errorCode
    };
    this.codexCache = { checked: this.clock(), value: result };
    return result;
  }

  async probeGithub({ force = false } = {}) {
    if (!force && this.fresh(this.githubCache, PROVIDER_CACHE_MS)) return this.githubCache.value;
    const result = this.github
      ? await this.github.probe(this.config.githubFixtureSha || '')
      : { provider: 'github', status: 'unavailable', checked_at: now(), error_code: 'not_configured' };
    const normalized = {
      provider: 'github',
      status: result?.status === 'available' ? 'available' : 'unavailable',
      checked_at: result?.checked_at || now(),
      error_code: result?.status === 'available' ? null : String(result?.error_code || 'github_probe_failed').slice(0, 120)
    };
    this.githubCache = { checked: this.clock(), value: normalized };
    return normalized;
  }
}
