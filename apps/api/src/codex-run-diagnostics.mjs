import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { redactKnownSecretsSync } from './vault.mjs';

export function createCodexRunError(run, { failureCode, timeoutCode }) {
  const timedOut = run?.timed_out === true;
  const error = new Error(timedOut ? timeoutCode : failureCode);
  error.code = error.message;
  error.details = {
    detail: sanitize(run?.stderr || run?.error || '', { tail: true }),
    timed_out: timedOut,
    timeout_ms: finiteNumber(run?.timeout_ms),
    exit_code: finiteNumber(run?.code)
  };
  return error;
}

export function safeErrorDetail(error) {
  const source = error?.details || error?.payload || {};
  const detail =
    source && typeof source === 'object' && !Array.isArray(source) ? structuredClone(source) : { detail: source };
  if (error?.message && detail.message === undefined) detail.message = error.message;
  if (error?.code && detail.code === undefined) detail.code = error.code;
  return JSON.parse(
    JSON.stringify(detail, (key, value) => {
      if (typeof value !== 'string') return value;
      return sanitize(value, { tail: key === 'detail' || key === 'stderr' });
    })
  );
}

function sanitize(value, { tail = false } = {}) {
  const redacted = redactKnownSecretsSync(String(value || ''));
  return tail ? redacted.slice(-2000) : redacted.slice(0, 2000);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}
