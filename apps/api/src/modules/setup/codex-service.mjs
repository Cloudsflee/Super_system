import { parseCodexDeviceAuthOutput } from '../../../../../packages/contracts/src/codex-device-auth.mjs';
import { hashJson } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';
import { CodexDiscoveryService } from './codex-discovery.mjs';

const DEVICE_TERMINAL = new Set(['completed', 'claimed', 'failed', 'cancelled', 'expired']);
const PROBE_PHASES = Object.freeze(['configuration', 'runtime', 'binding', 'transport', 'protocol', 'model', 'inference']);

export class CodexService {
  constructor({ config, broker, setup, operations, clock = () => Date.now(), discovery = null }) {
    this.config = config;
    this.broker = broker;
    this.setup = setup;
    this.operations = operations;
    this.clock = clock;
    this.discovery = discovery || new CodexDiscoveryService({ config, setup });
  }

  async startDeviceAuth(input = {}, ctx = {}) {
    const pending = await this.setup.createPendingCredential({
      kind: 'codex_oauth_bundle',
      label: String(input?.label || 'Codex device login').slice(0, 120),
      origin: 'device_auth',
      actor: ctx.actor
    });
    const operation = await this.operations.create({
      kind: 'codex.device_auth',
      resourceType: 'credential',
      resourceId: pending.id,
      actor: ctx.actor,
      executor: (operationContext) => this.runDeviceAuth(pending.id, input, ctx, operationContext)
    });
    return { ...operation, credential_id: pending.id };
  }

  async runDeviceAuth(credentialId, input, ctx, operationContext, externalId = null) {
    let brokerOperation = externalId;
    let claimed = false;
    try {
      if (!brokerOperation) {
        const started = await this.broker.startCodexDeviceAuth();
        brokerOperation = String(started.operation_id || '');
        assert(/^da_[A-Za-z0-9]{16,}$/.test(brokerOperation), 'device_auth_start_failed', 'device auth broker receipt is invalid', { status: 502, retryable: true });
        await operationContext.setExternalRef(brokerOperation);
      }
      let cursor = 0;
      const deadline = this.clock() + Math.min(15 * 60 * 1000, Math.max(30_000, Number(input?.timeout_ms || 10 * 60 * 1000)));
      while (this.clock() < deadline) {
        operationContext.ensureActive();
        const status = await this.broker.codexDeviceAuthStatus(brokerOperation);
        const events = await this.broker.codexDeviceAuthEvents(brokerOperation, cursor);
        for (const event of Array.isArray(events?.events) ? events.events : []) {
          cursor = Math.max(cursor, Number(event.cursor) || cursor);
          await operationContext.emit(event.type, sanitizeDeviceEvent(event.data));
        }
        if (DEVICE_TERMINAL.has(status.status)) {
          if (status.status !== 'completed') throw new AppError(`device_auth_${status.status}`, 'device auth did not complete', { status: 409 });
          const claimedBundle = await this.broker.claimCodexDeviceAuth(brokerOperation);
          const credential = await this.setup.activatePendingCredential(credentialId, String(claimedBundle.auth_bundle || ''), 1, ctx);
          claimed = true;
          return { credential_id: credential.id, status: credential.status, revision: credential.revision };
        }
        await delay(40, operationContext.signal);
      }
      throw new AppError('device_auth_timeout', 'device auth timed out', { status: 408, retryable: true });
    } finally {
      if (!claimed && brokerOperation) await this.broker.cancelCodexDeviceAuth(brokerOperation).catch(() => undefined);
      if (!claimed) {
        const current = await this.setup.repository.credential(credentialId).catch(() => null);
        if (current && ['pending', 'active'].includes(current.status)) {
          await this.setup.revokeCredential(credentialId, { expected_revision: current.revision }, ctx).catch(() => undefined);
        }
      }
    }
  }

  async resumeOperation(operation) {
    if (operation.kind !== 'codex.device_auth' || !operation.external_ref) return false;
    await this.broker.codexDeviceAuthStatus(operation.external_ref);
    return (operationContext) => this.runDeviceAuth(operation.resource_id, {}, { actor: operation.actor }, operationContext, operation.external_ref);
  }

  cancelExternal(kind, externalRef) {
    if (kind === 'codex.device_auth' && externalRef) return this.broker.cancelCodexDeviceAuth(externalRef);
    return Promise.resolve();
  }

  async discover(input = {}, ctx = {}) {
    return this.operations.create({
      kind: 'codex.discovery',
      resourceType: 'discovery',
      actor: ctx.actor,
      executor: (operationContext) => this.discovery.discover(operationContext)
    });
  }

  importDiscovery(input = {}, ctx = {}) {
    return this.discovery.import(input, ctx);
  }

  async probe(input = {}, ctx = {}) {
    const current = await this.setup.repository.activeCodexProfile();
    if (!current) throw new AppError('codex_profile_missing', 'an active Codex profile is required', { status: 409 });
    const profileId = String(input?.profile_id || current.id);
    const profile = profileId === current.id ? current : await this.setup.repository.codexProfile(profileId);
    if (!profile) throw new AppError('not_found', 'Codex profile not found');
    const expectedRevision = Number(input?.expected_revision);
    assert(Number.isInteger(expectedRevision) && expectedRevision > 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    return this.operations.create({
      kind: 'codex.probe', resourceType: 'codex_profile', resourceId: profile.id, actor: ctx.actor,
      executor: (operationContext) => this.runProbe(profile.id, expectedRevision, input, operationContext)
    });
  }

  async runProbe(profileId, expectedRevision, input, operationContext) {
    const profile = await this.setup.repository.codexProfile(profileId);
    if (!profile || profile.revision !== expectedRevision || !profile.is_active) throw new AppError('codex_profile_stale', 'Codex profile revision is stale', { status: 409 });
    const credential = await this.setup.credentialSecret(profile.credential_ref);
    const snapshot = {
      profile_id: profile.id,
      profile_revision: profile.revision,
      profile_hash: profileHash(profile, this.config.runnerDigest),
      config_hash: profile.config_hash,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      base_url: profile.base_url,
      wire_api: profile.wire_api,
      reasoning: profile.reasoning,
      timeout_ms: profile.timeout_ms,
      auth_kind: profile.auth_kind,
      credential_ref: profile.credential_ref,
      credential_revision: profile.current_credential_revision,
      runner_digest: this.config.runnerDigest
    };
    const result = await runSevenStageProbe({ broker: this.broker, snapshot, credential, signal: operationContext.signal });
    operationContext.ensureActive?.();
    await this.setup.recordCodexProbe(profile.id, expectedRevision, result);
    return { profile_id: profile.id, profile_revision: expectedRevision, ...result };
  }
}

export async function runSevenStageProbe({ broker, snapshot, credential, signal }) {
  const checks = PROBE_PHASES.map((phase) => ({ phase, status: 'pending', error_code: null }));
  const fail = (phase, code) => {
    const index = PROBE_PHASES.indexOf(phase);
    checks[index] = { phase, status: 'failed', error_code: code };
    for (let i = index + 1; i < checks.length; i += 1) checks[i] = { phase: PROBE_PHASES[i], status: 'skipped', error_code: code };
    return { status: 'unavailable', error_code: code, checks };
  };
  if (!snapshot?.profile_id || !Number.isInteger(snapshot.profile_revision) || !/^[a-f0-9]{64}$/.test(snapshot.profile_hash)) return fail('configuration', 'codex_configuration_invalid');
  checks[0] = { phase: 'configuration', status: 'passed', error_code: null };
  if (signal?.aborted) return fail('runtime', 'codex_probe_cancelled');
  const runtime = await broker.probe().catch(() => ({ ready: false, error: 'runner_unavailable' }));
  if (!runtime?.ready) return fail('runtime', stableProbeError(runtime?.error, 'codex_runtime_unavailable'));
  checks[1] = { phase: 'runtime', status: 'passed', error_code: null };
  checks[2] = { phase: 'binding', status: 'passed', error_code: null };
  const provider = typeof broker.codexProfileProbe === 'function'
    ? await broker.codexProfileProbe(snapshot, credential).catch((error) => ({ status: 'unavailable', error_code: error?.code || 'codex_transport_failed' }))
    : await broker.codexProbe().catch((error) => ({ status: 'unavailable', error_code: error?.code || 'codex_transport_failed' }));
  const providerChecks = new Map((Array.isArray(provider?.checks) ? provider.checks : []).map((item) => [String(item.phase), item]));
  for (const phase of PROBE_PHASES.slice(3)) {
    const item = providerChecks.get(phase);
    const passed = item ? item.status === 'passed' || item.passed === true : provider?.status === 'available';
    if (!passed) return fail(phase, stableProbeError(item?.error_code || provider?.error_code, `codex_${phase}_failed`));
    checks[PROBE_PHASES.indexOf(phase)] = { phase, status: 'passed', error_code: null };
  }
  return { status: 'available', error_code: null, checks };
}

function stableProbeError(value, fallback) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return /^codex_[a-z0-9_]{3,80}$/.test(normalized) ? normalized : fallback;
}

function sanitizeDeviceEvent(value) {
  const data = value && typeof value === 'object' ? value : {};
  return {
    verification_url: typeof data.verification_url === 'string' ? data.verification_url.slice(0, 500) : undefined,
    user_code: typeof data.user_code === 'string' ? data.user_code.slice(0, 40) : undefined,
    status: typeof data.status === 'string' ? data.status.slice(0, 40) : 'unknown',
    error_code: /^device_auth_[a-z_]+$/.test(String(data.error_code || '')) ? String(data.error_code) : undefined
  };
}

function profileHash(profile, runnerDigest = profile.runner_digest) {
  return hashJson({
    id: profile.id, revision: Number(profile.revision), config_hash: profile.config_hash,
    credential_ref: profile.credential_ref, credential_revision: Number(profile.current_credential_revision),
    runner_digest: runnerDigest
  });
}

export { parseCodexDeviceAuthOutput };

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) { clearTimeout(timer); reject(new AppError('operation_cancelled', 'operation was cancelled', { status: 409 })); return; }
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new AppError('operation_cancelled', 'operation was cancelled', { status: 409 })); }, { once: true });
  });
}
