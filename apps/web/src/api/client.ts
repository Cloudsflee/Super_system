import {
  beginOperation,
  cancelOperation,
  clearBackgroundFailure,
  completeOperation,
  failOperation,
  recordRequestFailure,
  registerOperationRetry,
  type OperationDescriptor
} from '../operations/operation-store';

export type ApiRequestInit = RequestInit & { operation?: OperationDescriptor; timeoutMs?: number };

export class ApiError extends Error {
  status: number;
  payload: Record<string, unknown>;
  code: string;
  requestId: string | null;
  method: string;
  path: string;
  phase: string;
  action: string;
  retryable: boolean;
  timeout: boolean;
  operationRecorded = false;
  constructor(
    status: number,
    payload: Record<string, unknown>,
    context: { requestId?: string | null; method?: string; path?: string; timeout?: boolean } = {}
  ) {
    const code = String(payload.error || (context.timeout ? 'request_timeout' : 'request_failed'));
    super(friendlyMessage(code, payload.message, status));
    this.status = status;
    this.payload = payload;
    this.code = code;
    this.requestId = String(payload.request_id || context.requestId || '') || null;
    this.method = context.method || 'GET';
    this.path = safePath(context.path || '');
    this.phase = String(payload.phase || 'request');
    this.action = String(payload.action || defaultAction(code, this.method));
    this.retryable = payload.retryable === true || (status >= 500 && this.method === 'GET');
    this.timeout = context.timeout === true || code === 'request_timeout';
  }
}

export async function api<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { operation, timeoutMs: explicitTimeout, ...requestInit } = init;
  const method = String(requestInit.method || 'GET').toUpperCase();
  const requestId = localRequestId();
  assertWriteOperationDescribed(operation, method, path, requestId);
  const headers = new Headers(requestInit.headers);
  if (!(requestInit.body instanceof FormData) && requestInit.body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  headers.set('x-aiws-request-id', requestId);
  if (operation?.idempotencyKey) headers.set('x-idempotency-key', operation.idempotencyKey);
  const timeoutMs = Number(explicitTimeout || operation?.timeoutMs || (method === 'GET' ? 30_000 : 120_000));
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(requestInit.signal?.reason);
  if (requestInit.signal?.aborted) abortFromCaller();
  else requestInit.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);
  const operationId = operation ? beginOperation({ descriptor: operation, method, path, requestId }) : null;
  const retrySafe = method === 'GET' || operation?.safeRetry === true || Boolean(operation?.idempotencyKey);
  if (operationId && retrySafe) registerOperationRetry(operationId, () => api(path, { ...init, signal: undefined }));
  try {
    const response = await fetch(apiUrl(path), { ...requestInit, headers, signal: controller.signal });
    const responseRequestId = response.headers.get('x-aiws-request-id') || requestId;
    const payload = await apiResponsePayload(response);
    if (!response.ok) throw new ApiError(response.status, payload, { requestId: responseRequestId, method, path });
    if (operationId) completeOperation(operationId, { requestId: responseRequestId });
    else if (method === 'GET') clearBackgroundFailure(`读取 ${safePath(path)}`);
    return payload as T;
  } catch (value) {
    return handleApiFailure(value, {
      path,
      init,
      signal: requestInit.signal,
      timedOut,
      method,
      requestId,
      operationId,
      retrySafe
    });
  } finally {
    window.clearTimeout(timer);
    requestInit.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function assertWriteOperationDescribed(
  operation: OperationDescriptor | undefined,
  method: string,
  path: string,
  requestId: string
) {
  if (method === 'GET' || operation) return;
  const error = new ApiError(
    0,
    {
      error: 'write_operation_description_required',
      message: '写操作缺少操作描述',
      action: '为该请求声明用户可读名称、反馈级别和超时策略。',
      phase: 'client',
      retryable: false
    },
    { requestId, method, path }
  );
  recordRequestFailure({
    name: '未描述的写操作',
    method,
    path,
    requestId,
    code: error.code,
    phase: error.phase,
    message: error.message,
    action: error.action,
    feedback: 'foreground'
  });
  error.operationRecorded = true;
  throw error;
}

async function apiResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('json')) return { message: await response.text() };
  const parsed: unknown = await response.json();
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { message: String(parsed ?? '') };
}

function handleApiFailure(
  value: unknown,
  context: {
    path: string;
    init: ApiRequestInit;
    signal: AbortSignal | null | undefined;
    timedOut: boolean;
    method: string;
    requestId: string;
    operationId: string | null;
    retrySafe: boolean;
  }
): never {
  if (isCallerAbort(value, context.signal, context.timedOut)) {
    if (context.operationId) cancelOperation(context.operationId);
    throw value;
  }
  const error = normalizeApiError(value, context);
  if (context.operationId) recordOperationFailure(context.operationId, error, context.retrySafe);
  else recordUnscopedRequestFailure(error, context);
  error.operationRecorded = true;
  throw error;
}

function normalizeApiError(
  value: unknown,
  context: { timedOut: boolean; method: string; requestId: string; path: string; retrySafe: boolean }
) {
  if (value instanceof ApiError) return value;
  return new ApiError(
    0,
    {
      error: context.timedOut ? 'request_timeout' : 'network_request_failed',
      message: context.timedOut ? '请求超时' : '无法连接到本地服务',
      action:
        context.timedOut && context.method !== 'GET'
          ? '服务端可能仍在处理，请先检查操作状态，不要立即重复提交。'
          : '检查本地服务和网络连接后重试。',
      phase: 'network',
      retryable: context.method === 'GET' || context.retrySafe
    },
    { requestId: context.requestId, method: context.method, path: context.path, timeout: context.timedOut }
  );
}

function recordOperationFailure(operationId: string, error: ApiError, retrySafe: boolean) {
  failOperation(operationId, {
    code: error.code,
    status: error.status,
    requestId: error.requestId,
    retryable: retrySafe && error.retryable,
    timeout: error.timeout,
    phase: error.phase,
    message: error.message,
    action: error.action
  });
}

function recordUnscopedRequestFailure(
  error: ApiError,
  context: { method: string; path: string; init: ApiRequestInit }
) {
  const recordedId = recordRequestFailure({
    method: context.method,
    path: context.path,
    requestId: error.requestId,
    code: error.code,
    status: error.status,
    retryable: context.method === 'GET' && error.retryable,
    timeout: error.timeout,
    phase: error.phase,
    message: error.message,
    action: error.action,
    feedback: context.method === 'GET' ? 'background' : 'silent'
  });
  if (context.method === 'GET' && error.retryable)
    registerOperationRetry(recordedId, () => api(context.path, { ...context.init, signal: undefined }));
}

export function multipart(method: string, form: FormData, operation: OperationDescriptor | string): ApiRequestInit {
  const descriptor = operationDescriptor(operation);
  return { method, body: form, operation: descriptor, timeoutMs: descriptor.timeoutMs };
}

export function json(method: string, body: unknown, operation: OperationDescriptor | string): ApiRequestInit {
  const descriptor = operationDescriptor(operation);
  return {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    operation: descriptor,
    timeoutMs: descriptor.timeoutMs
  };
}

export function describeOperation(
  name: string,
  options: Partial<Omit<OperationDescriptor, 'name'>> = {}
): OperationDescriptor {
  return { name, feedback: options.feedback || 'foreground', ...options };
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

export function apiUrl(path: string) {
  return path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`;
}

function localRequestId() {
  return `web_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}
function safePath(value: string) {
  return String(value || '').split(/[?#]/, 1)[0];
}
function isCallerAbort(_value: unknown, signal: AbortSignal | null | undefined, timedOut: boolean) {
  return !timedOut && Boolean(signal?.aborted);
}
function friendlyMessage(code: string, candidate: unknown, status: number) {
  const catalog: Record<string, string> = {
    request_timeout: '请求超时',
    network_request_failed: '无法连接到本地服务',
    internal_error: '服务端处理请求时发生内部错误',
    setup_required: '需要先完成工作区配置',
    not_found: '请求的资源不存在',
    codex_build_not_found: '未找到该 Codex 构建任务',
    discovery_source_stale: '本地配置已变化，请刷新后重新选择'
  };
  const value = String(candidate || '');
  return (
    catalog[code] || (value && value !== code ? value : code || (status ? `请求失败（HTTP ${status}）` : '请求失败'))
  );
}
function defaultAction(code: string, method: string) {
  if (code === 'request_timeout' && method !== 'GET') return '服务端可能仍在处理，请先检查操作状态，不要立即重复提交。';
  if (code === 'network_request_failed') return '检查本地服务和网络连接后重试。';
  return '检查操作详情和服务状态后重试。';
}
function operationDescriptor(value: OperationDescriptor | string): OperationDescriptor {
  return typeof value === 'string' ? describeOperation(value) : value;
}
