import fs from 'node:fs/promises';
import path from 'node:path';

import { AIWS_RUNNER_IMAGE, now } from '../../../packages/shared/index.mjs';
import { protocolHash } from '../../../packages/execution-protocol/src/index.mjs';
import { QUALITY_REVIEW_TEMP_DIR } from './config.mjs';
import { codexAuthMatchesProfile, extractMessage, runCodexJson } from './codex-service.mjs';
import { inspectCodexRuntimeCached } from './codex-runtime-status.mjs';
import {
  qualityReviewerProfile,
  reviewerProfileSnapshot,
  selectReviewerProfile
} from './quality-review-service-state.mjs';
import { readSecret } from './vault.mjs';

const CACHE_MAX_AGE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const VISION_PROBE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS8AAAAASUVORK5CYII=',
  'base64'
);
const readinessCache = new Map();

export async function reviewerReadinessPreflight(state, workflow, options = {}) {
  const profile = options.profile || qualityReviewerProfile(state, workflow),
    key = readinessCacheKey(state, profile),
    cached = readinessCache.get(key),
    maxAgeMs = options.maxAgeMs ?? CACHE_MAX_AGE_MS;
  if (!options.force && cached?.value && Date.now() - cached.checkedAt < maxAgeMs) return structuredClone(cached.value);
  if (!options.force && cached?.promise) return structuredClone(await cached.promise);
  const promise = computeReviewerReadiness(state, profile, options)
    .then((value) => {
      readinessCache.set(key, { value, checkedAt: Date.now(), promise: null });
      return value;
    })
    .catch((error) => {
      const value = unavailableReadiness(profile, 'reviewer_preflight_failed', errorCode(error));
      readinessCache.set(key, { value, checkedAt: Date.now(), promise: null });
      return value;
    });
  readinessCache.set(key, { value: cached?.value || null, checkedAt: cached?.checkedAt || 0, promise });
  return structuredClone(await promise);
}

export async function reviewerReadinessForRun(state, run, options = {}) {
  const profile = selectReviewerProfile(state, run);
  return reviewerReadinessPreflight(state, null, { ...options, profile });
}

export function invalidateReviewerReadinessCache() {
  readinessCache.clear();
}

async function computeReviewerReadiness(state, profile, options) {
  const checkedAt = now(),
    checks = emptyChecks(checkedAt),
    snapshot = profile ? reviewerProfileSnapshot(profile) : null;
  checks.profile = profileCheck(snapshot, checkedAt);
  if (!profile) return finalize(snapshot, checks, checkedAt);

  checks.image = await inspectReviewerImage(profile, options, checkedAt);
  const credential = await checkCredential(state, profile, options.credentialReader || readSecret);
  checks.credential = check(credential.ready, credential.code, checkedAt, credential.details);
  if (checks.image.ready && checks.credential.ready)
    await populateCapabilityChecks(checks, state, profile, options, checkedAt);
  return finalize(snapshot, checks, checkedAt);
}

function profileCheck(snapshot, checkedAt) {
  return check(Boolean(snapshot), snapshot ? null : 'reviewer_profile_unavailable', checkedAt, {
    profile_id: snapshot?.id || null,
    provider: snapshot?.provider || null,
    model: snapshot?.model || null,
    kind: snapshot?.kind || null
  });
}

async function inspectReviewerImage(profile, options, checkedAt) {
  const runtimeInspector = options.runtimeInspector || inspectCodexRuntimeCached,
    runtime = await guarded(() =>
      runtimeInspector({ image: AIWS_RUNNER_IMAGE, maxAgeMs: CACHE_MAX_AGE_MS, force: options.force === true })
    ),
    ready = runtime.ok && profile.image === AIWS_RUNNER_IMAGE && runtime.value?.image?.ready === true;
  return check(ready, reviewerImageFailureCode(runtime), checkedAt, {
    image: AIWS_RUNNER_IMAGE,
    image_id: runtime.value?.image?.id || null
  });
}

function reviewerImageFailureCode(runtime) {
  if (!runtime.ok) return errorCode(runtime.error);
  return runtime.value?.image?.error_code || 'reviewer_runner_image_unavailable';
}

async function populateCapabilityChecks(checks, state, profile, options, checkedAt) {
  const probeRunner = options.probeRunner || runIsolatedProbe,
    timeoutMs = normalizedTimeout(options.timeoutMs);
  checks.probe = await capabilityCheck(
    probeRunner,
    { state, profile, kind: 'probe', marker: 'AIWS_REVIEWER_PROBE_OK', timeoutMs },
    checkedAt
  );
  if (!checks.probe.ready) return;
  checks.vision = await capabilityCheck(
    probeRunner,
    { state, profile, kind: 'vision', marker: 'AIWS_REVIEWER_VISION_OK', timeoutMs },
    checkedAt
  );
}

async function capabilityCheck(probeRunner, input, checkedAt) {
  const result = await guarded(() => probeRunner(input)),
    ready = result.ok && result.value?.ready === true,
    code = result.ok ? result.value?.code : errorCode(result.error);
  return check(ready, code, checkedAt);
}

async function checkCredential(state, profile, credentialReader) {
  const auth = (state.integration_statuses || []).find((item) => item.key === 'codex_auth');
  if (!codexAuthMatchesProfile(auth, profile))
    return { ready: false, code: 'reviewer_credential_profile_mismatch', details: { source: null } };
  const deviceCredential = await checkDeviceCredential(auth);
  if (deviceCredential) return deviceCredential;
  return checkReferencedCredential(auth, credentialReader);
}

async function checkDeviceCredential(auth) {
  if (!auth?.home) return null;
  const accessible = await guarded(() => fs.access(auth.home));
  return accessible.ok ? { ready: true, code: null, details: { source: 'device_auth' } } : null;
}

async function checkReferencedCredential(auth, credentialReader) {
  const ref = auth?.refs?.credential;
  if (!ref) return { ready: false, code: 'reviewer_credential_reference_missing', details: { source: null } };
  const secret = await guarded(() => credentialReader(ref)),
    ready = secret.ok && typeof secret.value === 'string' && secret.value.length > 0;
  return {
    ready,
    code: ready ? null : secret.ok ? 'reviewer_credential_empty' : 'reviewer_credential_unavailable',
    details: { source: credentialSource(ref) }
  };
}

function credentialSource(reference) {
  if (String(reference).startsWith('vault:')) return 'vault';
  if (String(reference).startsWith('env:')) return 'env';
  return 'other';
}

async function runIsolatedProbe({ state, profile, kind, marker, timeoutMs }) {
  await fs.mkdir(QUALITY_REVIEW_TEMP_DIR, { recursive: true, mode: 0o700 });
  const tempDir = await fs.mkdtemp(path.join(QUALITY_REVIEW_TEMP_DIR, 'preflight-')),
    imagePath = path.join(tempDir, 'vision-probe.png'),
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs),
    messages = [];
  try {
    const images = kind === 'vision' ? [imagePath] : [];
    if (images.length) await fs.writeFile(imagePath, VISION_PROBE_PNG, { mode: 0o400 });
    const prompt =
      kind === 'vision'
        ? `Process the attached visual input, then reply with exactly ${marker}.`
        : `Reply with exactly ${marker}. Do not read or write files.`;
    const result = await runCodexJson({
      state,
      profile,
      prompt,
      cwd: tempDir,
      sandbox: 'read-only',
      runtimeKind: `quality-review-${kind}-preflight`,
      reviewer: true,
      ephemeral: true,
      disableMcp: true,
      disableRules: true,
      images,
      signal: controller.signal,
      onEvent: (event) => {
        const message = extractMessage(event);
        if (message) messages.push(message);
      }
    });
    const found = messages.some((item) => item.trim() === marker);
    return {
      ready: result.ok === true && found,
      code: result.timed_out
        ? 'reviewer_probe_timeout'
        : result.ok && !found
          ? `reviewer_${kind}_marker_missing`
          : result.ok
            ? null
            : `reviewer_${kind}_failed`
    };
  } finally {
    clearTimeout(timer);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function finalize(profile, checks, checkedAt) {
  const ready = Object.values(checks).every((item) => item.ready === true);
  return {
    status: ready ? 'ready' : 'unavailable',
    ready,
    advice_available: ready,
    checked_at: checkedAt,
    profile,
    checks
  };
}

function unavailableReadiness(profile, code, detailCode) {
  const checkedAt = now(),
    checks = emptyChecks(checkedAt);
  checks.profile = check(Boolean(profile), profile ? null : 'reviewer_profile_unavailable', checkedAt);
  checks.probe = check(false, detailCode || code, checkedAt);
  return finalize(profile ? reviewerProfileSnapshot(profile) : null, checks, checkedAt);
}

function emptyChecks(checkedAt) {
  return Object.fromEntries(
    ['profile', 'image', 'credential', 'probe', 'vision'].map((name) => [
      name,
      { status: 'not_checked', ready: false, code: 'reviewer_check_not_run', checked_at: checkedAt, details: {} }
    ])
  );
}

function check(ready, code, checkedAt, details = {}) {
  return {
    status: ready ? 'passed' : 'failed',
    ready: Boolean(ready),
    code: ready ? null : safeCode(code || 'reviewer_check_failed'),
    checked_at: checkedAt,
    details: sanitize(details)
  };
}

function readinessCacheKey(state, profile) {
  const auth = (state.integration_statuses || []).find((item) => item.key === 'codex_auth');
  return protocolHash({
    profile: profile ? reviewerProfileSnapshot(profile) : null,
    auth: auth
      ? {
          status: auth.status || null,
          provider: auth.provider || null,
          base_url: auth.base_url || null,
          home: Boolean(auth.home),
          credential_source: String(auth.refs?.credential || '').split(':', 1)[0] || null,
          updated_at: auth.updated_at || null
        }
      : null
  });
}

function normalizedTimeout(value) {
  const timeout = Number(value ?? process.env.AIWS_QUALITY_REVIEW_PREFLIGHT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(timeout) ? Math.min(60_000, Math.max(1_000, Math.round(timeout))) : DEFAULT_TIMEOUT_MS;
}

async function guarded(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorCode(error) {
  const code = String(error?.code || '');
  if (/abort|timeout/i.test(`${code} ${error?.name || ''}`)) return 'reviewer_probe_timeout';
  if (/^(?:reviewer|quality_review|codex_probe)_[a-z0-9_.-]+$/i.test(code)) return safeCode(code);
  return 'reviewer_preflight_failed';
}

function safeCode(value) {
  const candidate = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .slice(0, 160);
  return candidate || 'reviewer_check_failed';
}

function sanitize(value) {
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      /credential|secret|token|password|authorization|cookie|proxy|base_url|home/i.test(key) && typeof item === 'string'
        ? '[REDACTED]'
        : item
    )
  );
}
