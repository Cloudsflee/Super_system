import { DEFAULT_CODEX_TIMEOUT_MS, MAX_CODEX_TIMEOUT_MS, MIN_CODEX_TIMEOUT_MS } from '../../../packages/shared/index.mjs';

export { DEFAULT_CODEX_TIMEOUT_MS, MAX_CODEX_TIMEOUT_MS, MIN_CODEX_TIMEOUT_MS };

export function isValidCodexTimeoutMs(value) {
  if (value == null) return true;
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CODEX_TIMEOUT_MS && value <= MAX_CODEX_TIMEOUT_MS;
}

export function resolveCodexTimeoutMs(value) {
  const timeout = value == null ? DEFAULT_CODEX_TIMEOUT_MS : Number(value);
  if (!Number.isFinite(timeout)) return DEFAULT_CODEX_TIMEOUT_MS;
  return Math.max(MIN_CODEX_TIMEOUT_MS, Math.min(MAX_CODEX_TIMEOUT_MS, Math.trunc(timeout)));
}

export function codexTimeoutTtlSeconds(value, paddingSeconds = 300) {
  return Math.ceil(resolveCodexTimeoutMs(value) / 1_000) + paddingSeconds;
}
