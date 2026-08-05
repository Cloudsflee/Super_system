import type { ApiErrorBody } from './types';

export class ApiError extends Error {
  code: string;
  status: number;
  retryable: boolean;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error?.code || 'request_failed';
    this.retryable = Boolean(body.error?.retryable);
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
