import type { ApiErrorBody } from './types';

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

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith('/') ? path : `/api/v1/${path}`, {
    ...options,
    headers: { accept: 'application/json', ...options.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody);
  return body as T;
}

export type ApiV2Envelope<T> = {
  request_id: string;
  data: T;
  meta: { api_version: string; resource_type?: string; resource_revision?: number; etag?: string; redactions?: string[] };
};

/** Clean-break client. It unwraps the v2 envelope and never falls back to v1. */
export async function apiV2<T>(path: string, options: RequestInit = {}): Promise<ApiV2Envelope<T>> {
  const normalized = path.startsWith('/api/v2/') ? path : `/api/v2/${path.replace(/^\//, '')}`;
  const response = await fetch(normalized, {
    ...options,
    headers: { accept: 'application/json', ...options.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody);
  return body as ApiV2Envelope<T>;
}

export function mutateV2<T>(path: string, body: Record<string, unknown> = {}, method = 'POST', expectedRevision?: number): Promise<ApiV2Envelope<T>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'Idempotency-Key': crypto.randomUUID()
  };
  if (expectedRevision != null) headers['X-Expected-Revision'] = String(expectedRevision);
  return apiV2<T>(path, { method, headers, body: JSON.stringify(body) });
}

export function mutate<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return api<T>(path, {
    method,
    headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(body)
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortHash(value = ''): string {
  return value ? value.slice(0, 10) : 'uncommitted';
}

export function formatTime(value?: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
