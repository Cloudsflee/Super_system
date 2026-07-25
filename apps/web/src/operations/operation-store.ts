import {
  localOperationId,
  persistableOperation,
  safeMethod,
  safeNullable,
  safePath,
  safeText,
  sanitizeOperationRecord
} from './operation-sanitize';

export const OPERATION_STORAGE_KEY = 'aiws-operation-diagnostics-v1';

export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type OperationFeedbackLevel = 'foreground' | 'background' | 'silent';

export type OperationDescriptor = {
  name: string;
  feedback: OperationFeedbackLevel;
  phase?: string;
  timeoutMs?: number;
  safeRetry?: boolean;
  idempotencyKey?: string;
};

export type OperationRecord = {
  id: string;
  name: string;
  status: OperationStatus;
  phase: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  httpStatus: number | null;
  requestId: string | null;
  retryable: boolean;
  timeout: boolean;
  reason: string;
  action: string;
  method: string;
  path: string;
  feedback: OperationFeedbackLevel;
};

type RequestFailure = {
  code?: string | null;
  status?: number | null;
  requestId?: string | null;
  retryable?: boolean;
  timeout?: boolean;
  phase?: string;
  message?: string;
  action?: string;
};

let records = loadRecords();
const listeners = new Set<() => void>();
const retries = new Map<string, () => Promise<unknown>>();
const backgroundFailures = new Map<string, { count: number; firstAt: number }>();

export function operationRecords() {
  return records;
}

export function subscribeOperations(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginOperation(input: {
  id?: string;
  descriptor: OperationDescriptor;
  method: string;
  path: string;
  requestId?: string | null;
}) {
  const timestamp = new Date().toISOString();
  const record: OperationRecord = {
    id: input.id || localOperationId('op'),
    name: safeText(input.descriptor.name, '操作'),
    status: 'running',
    phase: safeText(input.descriptor.phase, '正在请求'),
    startedAt: timestamp,
    endedAt: null,
    durationMs: null,
    errorCode: null,
    httpStatus: null,
    requestId: safeNullable(input.requestId),
    retryable: false,
    timeout: false,
    reason: '',
    action: '',
    method: safeMethod(input.method),
    path: safePath(input.path),
    feedback: input.descriptor.feedback
  };
  put(record);
  return record.id;
}

export function completeOperation(
  id: string,
  patch: Partial<Pick<OperationRecord, 'phase' | 'requestId' | 'reason'>> = {}
) {
  update(id, (record) => finish(record, 'succeeded', { ...patch, phase: patch.phase || '已完成' }));
  const record = records.find((item) => item.id === id);
  if (record) backgroundFailures.delete(record.name);
}

export function cancelOperation(id: string, reason = '操作已取消') {
  update(id, (record) => finish(record, 'cancelled', { phase: '已取消', reason, retryable: false }));
}

export function failOperation(id: string, failure: RequestFailure) {
  update(id, (record) => {
    const escalation = record.feedback === 'background' ? backgroundEscalation(record.name) : false;
    return finish(record, 'failed', {
      phase: safeText(failure.phase, '请求失败'),
      errorCode: safeNullable(failure.code),
      httpStatus: Number.isFinite(Number(failure.status)) ? Number(failure.status) : null,
      requestId: safeNullable(failure.requestId) || record.requestId,
      retryable: failure.retryable === true,
      timeout: failure.timeout === true,
      reason: safeText(failure.message, '操作失败'),
      action: safeText(failure.action, ''),
      feedback: escalation ? 'foreground' : record.feedback
    });
  });
}

export function recordRequestFailure(
  input: { name?: string; method: string; path: string; feedback?: OperationFeedbackLevel } & RequestFailure
) {
  const descriptor: OperationDescriptor = {
    name: input.name || `读取 ${safePath(input.path)}`,
    feedback: input.feedback || 'silent',
    phase: input.phase || '读取数据'
  };
  const id = beginOperation({ descriptor, method: input.method, path: input.path, requestId: input.requestId });
  failOperation(id, input);
  return id;
}

export function recordSystemFailure(name: string, value: unknown, phase = '界面运行') {
  if (isAbort(value) || wasRecorded(value)) return null;
  const id = beginOperation({ descriptor: { name, feedback: 'foreground', phase }, method: 'SYSTEM', path: 'client' });
  failOperation(id, {
    code: 'client_runtime_error',
    phase,
    message: errorMessage(value),
    action: '刷新页面；若问题再次出现，请复制诊断详情。',
    retryable: false
  });
  return id;
}

export function upsertExternalOperation(input: {
  id: string;
  name: string;
  status: OperationStatus;
  phase: string;
  startedAt?: string;
  endedAt?: string | null;
  errorCode?: string | null;
  retryable?: boolean;
  reason?: string;
  action?: string;
  path?: string;
}) {
  const existing = records.find((item) => item.id === input.id);
  if (!existing) {
    const id = beginOperation({
      id: input.id,
      descriptor: { name: input.name, feedback: 'background', phase: input.phase },
      method: 'POST',
      path: input.path || '/codex/docker/build'
    });
    update(id, (record) => externalPatch(record, input));
    return id;
  }
  update(input.id, (record) => externalPatch(record, input));
  return input.id;
}

export function registerOperationRetry(id: string, retry: () => Promise<unknown>) {
  retries.set(id, retry);
}
export function operationRetry(id: string) {
  return retries.get(id) || null;
}
export function dismissOperation(id: string) {
  update(id, (record) => ({ ...record, feedback: 'silent' }));
}
export function clearBackgroundFailure(name: string) {
  backgroundFailures.delete(name);
}

export function clearOperations() {
  records = [];
  retries.clear();
  backgroundFailures.clear();
  persist();
  emit();
}

export function diagnosticJson(selection = records) {
  return JSON.stringify(
    {
      format: 'aiws-operation-diagnostics-v1',
      generated_at: new Date().toISOString(),
      records: selection.slice(0, 100).map(persistableOperation)
    },
    null,
    2
  );
}

function externalPatch(record: OperationRecord, input: Parameters<typeof upsertExternalOperation>[0]) {
  const endedAt = input.status === 'running' ? null : input.endedAt || new Date().toISOString();
  return sanitizeOperationRecord({
    ...record,
    name: input.name,
    status: input.status,
    phase: input.phase,
    startedAt: input.startedAt || record.startedAt,
    endedAt,
    durationMs: endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(input.startedAt || record.startedAt)) : null,
    errorCode: input.errorCode || null,
    retryable: input.retryable === true,
    reason: input.reason || '',
    action: input.action || '',
    feedback: 'background'
  });
}

function finish(record: OperationRecord, status: OperationStatus, patch: Partial<OperationRecord>) {
  const endedAt = new Date().toISOString();
  return sanitizeOperationRecord({
    ...record,
    ...patch,
    status,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(record.startedAt))
  });
}

function put(record: OperationRecord) {
  records = [sanitizeOperationRecord(record), ...records.filter((item) => item.id !== record.id)].slice(0, 100);
  persist();
  emit();
}

function update(id: string, updater: (record: OperationRecord) => OperationRecord) {
  let changed = false;
  records = records.map((record) => {
    if (record.id !== id) return record;
    changed = true;
    return sanitizeOperationRecord(updater(record));
  });
  if (!changed) return;
  persist();
  emit();
}

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  try {
    sessionStorage.setItem(OPERATION_STORAGE_KEY, JSON.stringify(records.slice(0, 100).map(persistableOperation)));
  } catch {
    /* Diagnostics must never break the user operation. */
  }
}

function loadRecords(): OperationRecord[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(OPERATION_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 100).map(sanitizeOperationRecord) : [];
  } catch {
    return [];
  }
}

function backgroundEscalation(name: string) {
  const now = Date.now(),
    current = backgroundFailures.get(name) || { count: 0, firstAt: now };
  current.count += 1;
  backgroundFailures.set(name, current);
  return current.count >= 3 || now - current.firstAt >= 30_000;
}

function isAbort(value: unknown) {
  return value instanceof DOMException
    ? value.name === 'AbortError'
    : value instanceof Error && value.name === 'AbortError';
}
function wasRecorded(value: unknown) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'operationRecorded' in value &&
    (value as { operationRecorded?: boolean }).operationRecorded
  );
}
function errorMessage(value: unknown) {
  return safeText(value instanceof Error ? value.message : value, '未知界面错误');
}
