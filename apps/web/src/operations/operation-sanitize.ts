import type { OperationFeedbackLevel, OperationRecord, OperationStatus } from './operation-store';

export function persistableOperation(record: OperationRecord) {
  const safe = sanitizeOperationRecord(record);
  return {
    id: safe.id, name: safe.name, status: safe.status, phase: safe.phase, startedAt: safe.startedAt, endedAt: safe.endedAt,
    durationMs: safe.durationMs, errorCode: safe.errorCode, httpStatus: safe.httpStatus, requestId: safe.requestId,
    retryable: safe.retryable, timeout: safe.timeout, reason: safe.reason, action: safe.action,
    method: safe.method, path: safe.path, feedback: safe.feedback
  };
}

export function sanitizeOperationRecord(value: Partial<OperationRecord>): OperationRecord {
  const status = ['running', 'succeeded', 'failed', 'cancelled'].includes(String(value.status)) ? value.status as OperationStatus : 'failed';
  const feedback = ['foreground', 'background', 'silent'].includes(String(value.feedback)) ? value.feedback as OperationFeedbackLevel : 'silent';
  const startedAt = validDate(value.startedAt) || new Date().toISOString();
  const endedAt = value.endedAt ? validDate(value.endedAt) : null;
  return {
    id: safeText(value.id, localOperationId('op'), 160), name: safeText(value.name, '操作'), status, phase: safeText(value.phase, ''),
    startedAt, endedAt, durationMs: Number.isFinite(Number(value.durationMs)) ? Math.max(0, Number(value.durationMs)) : null,
    errorCode: safeNullable(value.errorCode), httpStatus: Number.isFinite(Number(value.httpStatus)) ? Number(value.httpStatus) : null,
    requestId: safeNullable(value.requestId), retryable: value.retryable === true, timeout: value.timeout === true,
    reason: safeText(value.reason, ''), action: safeText(value.action, ''), method: safeMethod(value.method), path: safePath(value.path || ''), feedback
  };
}

export function safePath(value: string) {
  const path = String(value || '').split(/[?#]/, 1)[0];
  return safeText(path, '', 500).replace(/\b(sk-[a-z0-9_-]{8,})\b/gi, '***MASKED***');
}
export function safeMethod(value: unknown) { const method = String(value || 'GET').toUpperCase(); return /^[A-Z]{2,10}$/.test(method) ? method : 'GET'; }
export function safeNullable(value: unknown) { const text = safeText(value, '', 500); return text || null; }
export function safeText(value: unknown, fallback = '', limit = 2000) {
  let text = String(value ?? fallback).slice(0, limit);
  text = text.replace(/\b(sk-[a-z0-9_-]{8,})\b/gi, '***MASKED***');
  text = text.replace(/\b(api[_-]?key|token|authorization|password)(\s*[:=]\s*)([^\s]+)/gi, '$1$2***MASKED***');
  return text;
}
export function localOperationId(prefix: string) { return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`; }
function validDate(value: unknown) { const date = new Date(String(value || '')); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
