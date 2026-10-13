// Owner: Frontend. Phase: post-P10 maintenance.
import type { ApiErrorBody } from './types';

let sessionRecovery: Promise<void> | null = null;

/** Recover the browser session once at a time, retaining the original retry semantics. */
export function recoverBrowserSession(): Promise<void> {
  if (sessionRecovery) return sessionRecovery;
  const idempotencyKey = globalThis.crypto?.randomUUID?.() || `session-${Date.now()}`;
  sessionRecovery = fetch('/api/v2/setup/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ idempotency_key: idempotencyKey })
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { ApiError } = await import('./api');
      throw new ApiError(response.status, body as ApiErrorBody);
    }
  }).finally(() => { sessionRecovery = null; });
  return sessionRecovery;
}
