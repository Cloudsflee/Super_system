export class ApiError extends Error {
  status: number;
  payload: Record<string, unknown>;
  constructor(status: number, payload: Record<string, unknown>) {
    super(String(payload.message || payload.error || `HTTP ${status}`));
    this.status = status;
    this.payload = payload;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = init.body instanceof FormData ? init.headers : { 'content-type': 'application/json', ...init.headers };
  const response = await fetch(apiUrl(path), {
    ...init,
    headers
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('json') ? await response.json() : { message: await response.text() };
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}

export function multipart(method: string, form: FormData): RequestInit { return { method, body: form }; }

export function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

export function streamUrl(sessionId: string, after = 0) {
  const query = after ? `?after=${after}` : '';
  return apiUrl(`/assist/v2/sessions/${encodeURIComponent(sessionId)}/events${query}`);
}

export function assistV3StreamUrl(sessionId: string, after = 0) {
  const query = after ? `?after=${after}` : '';
  return apiUrl(`/assist/v3/sessions/${encodeURIComponent(sessionId)}/events${query}`);
}

export function websocketUrl(path: string) {
  const target = new URL(apiUrl(path), window.location.href);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return target.toString();
}

function apiUrl(path: string) { return path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`; }
