import type { ApiErrorBody } from './types';
import { OfflineOutbox, isOfflineCommandAllowed, shouldQueueOffline, type OfflineCommand } from './offline/outbox';

export class ApiError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  details: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error?.code || 'request_failed';
    this.retryable = Boolean(body.error?.retryable);
    this.details = body.error?.details || {};
  }
}

export type ApiV2Envelope<T> = {
  request_id: string;
  data: T;
  meta: { api_version: string; resource_type?: string; resource_revision?: number; etag?: string; redactions?: string[] };
};

export type ApiV2Options = RequestInit & {
  idempotencyKey?: string;
  expectedRevision?: number;
  offline?: {
    command: OfflineCommand;
    scope: { actorId: string; teamId: string; projectId: string };
    aggregateKey: string;
  };
};

const RECOVERABLE_SESSION_CODES = new Set(['authentication_required', 'session_invalid', 'session_expired', 'session_revoked']);
let sessionRecovery: Promise<void> | null = null;

/** Strict clean-break client. Paths outside /api/v2 are rejected. */
export async function apiV2<T>(path: string, options: ApiV2Options = {}): Promise<ApiV2Envelope<T>> {
  const normalized = normalizeV2Path(path);
  const { idempotencyKey, expectedRevision, offline: _offline, ...request } = options;
  const headers: Record<string, string> = { accept: 'application/json', ...(request.headers as Record<string, string> || {}) };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (expectedRevision != null) headers['X-Expected-Revision'] = String(expectedRevision);
  let response: Response;
  try {
    response = await fetch(normalized, { ...request, credentials: request.credentials || 'same-origin', headers });
  } catch (error) {
    throw new ApiError(0, { error: { code: 'network_error', message: error instanceof Error ? error.message : 'network error', retryable: true, request_id: '', details: {} } });
  }
  let body = await response.json().catch(() => ({}));
  if (!response.ok && response.status === 401 && normalized !== '/api/v2/setup/session' && RECOVERABLE_SESSION_CODES.has(String((body as ApiErrorBody)?.error?.code || ''))) {
    await recoverBrowserSession();
    response = await fetch(normalized, { ...request, credentials: request.credentials || 'same-origin', headers });
    body = await response.json().catch(() => ({}));
  }
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody);
  return body as ApiV2Envelope<T>;
}

export async function fetchV2Binary(path: string, options: RequestInit = {}): Promise<Response> {
  const normalized = normalizeV2Path(path);
  const request: RequestInit = { ...options, credentials: options.credentials || 'same-origin' };
  let response = await fetch(normalized, request);
  const initialBody = response.status === 401 ? await response.clone().json().catch(() => ({})) : {};
  if (!response.ok && response.status === 401 && RECOVERABLE_SESSION_CODES.has(String((initialBody as ApiErrorBody)?.error?.code || ''))) {
    try {
      await recoverBrowserSession();
      response = await fetch(normalized, request);
    } catch { /* preserve the original response for the caller */ }
  }
  if (!response.ok) {
    const body = await response.clone().json().catch(() => ({}));
    throw new ApiError(response.status, body as ApiErrorBody);
  }
  return response;
}

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
    if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody);
  }).finally(() => { sessionRecovery = null; });
  return sessionRecovery;
}

export function mutateV2<T>(path: string, body: Record<string, unknown> = {}, method = 'POST', expectedRevisionOrOptions?: number | { expectedRevision?: number; idempotencyKey?: string }, explicitIdempotencyKey?: string): Promise<ApiV2Envelope<T>> {
  const mutation = typeof expectedRevisionOrOptions === 'object'
    ? expectedRevisionOrOptions
    : { expectedRevision: expectedRevisionOrOptions, idempotencyKey: explicitIdempotencyKey };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'Idempotency-Key': mutation.idempotencyKey || crypto.randomUUID()
  };
  if (mutation.expectedRevision != null) headers['X-Expected-Revision'] = String(mutation.expectedRevision);
  return apiV2<T>(path, { method, headers, body: JSON.stringify(body), credentials: 'same-origin' });
}

export async function mutateOfflineV2<T>(
  path: string,
  body: Record<string, unknown>,
  method: string,
  options: { command: OfflineCommand; scope: { actorId: string; teamId: string; projectId: string }; aggregateKey: string; expectedRevision?: number | null; idempotencyKey?: string }
): Promise<ApiV2Envelope<T> | { queued: true; record: Awaited<ReturnType<OfflineOutbox['enqueue']>> }> {
  if (!isOfflineCommandAllowed(options.command)) throw new Error('offline_command_forbidden');
  const key = options.idempotencyKey || randomId();
  const enqueue = () => new OfflineOutbox(options.scope).enqueue({ command: options.command, method, path: normalizeV2Path(path), body, expectedRevision: options.expectedRevision, aggregateKey: options.aggregateKey, idempotencyKey: key });
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { queued: true, record: await enqueue() };
  try {
    return await mutateV2<T>(path, body, method, { expectedRevision: options.expectedRevision ?? undefined, idempotencyKey: key });
  } catch (error) {
    if (!shouldQueueOffline(error)) throw error;
    const record = await enqueue();
    return { queued: true, record };
  }
}

export function normalizeV2Path(path: string): string {
  const value = String(path || '');
  if (value.includes('/api/v1') || value.includes('/api/v0')) throw new Error('retired_api_route');
  if (value.startsWith('/api/v2/')) return value;
  if (value === '/api/v2') return value;
  if (value.startsWith('/')) return `/api/v2${value}`;
  return `/api/v2/${value}`;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortHash(value = ''): string {
  return value ? value.slice(0, 10) : '未提交';
}

export function formatTime(value?: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
