export const DEFAULT_CODEX_TIMEOUT_MINUTES = 30;
export const MIN_CODEX_TIMEOUT_MINUTES = 1;
export const MAX_CODEX_TIMEOUT_MINUTES = 30;

export function validCodexTimeoutMinutes(value: number) {
  return Number.isInteger(value) && value >= MIN_CODEX_TIMEOUT_MINUTES && value <= MAX_CODEX_TIMEOUT_MINUTES;
}

export function codexTimeoutMinutesToMs(value: number) {
  return value * 60_000;
}

export function codexTimeoutMinutesFromMs(value?: number) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return DEFAULT_CODEX_TIMEOUT_MINUTES;
  return Math.max(MIN_CODEX_TIMEOUT_MINUTES, Math.min(MAX_CODEX_TIMEOUT_MINUTES, Math.ceil(milliseconds / 60_000)));
}

export function formatCodexTimeout(value?: number) {
  const milliseconds = Number(value ?? DEFAULT_CODEX_TIMEOUT_MINUTES * 60_000);
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1_000))} 秒超时`;
  const minutes = Math.round(milliseconds / 6_000) / 10;
  return `${minutes} 分钟超时`;
}
