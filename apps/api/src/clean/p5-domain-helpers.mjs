import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

export function requirePrincipal(principal) {
  if (!principal?.actorId) throw new PlatformError('authentication_required', 'active session proof is required', {}, 401);
  return principal;
}

export function requireIdempotency(value) {
  const key = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(key)) {
    throw new PlatformError('idempotency_required', 'Idempotency-Key is required', {}, 400);
  }
  return key;
}

export function requireRevision(value, { allowZero = false } = {}) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < (allowZero ? 0 : 1)) {
    throw new PlatformError('expected_revision_required', 'expected revision is required', {}, 400);
  }
  return revision;
}

export function assertRevision(row, expected) {
  if (!row) throw new PlatformError('not_found', 'resource not found', {}, 404);
  if (Number(row.revision) !== Number(expected)) {
    throw new PlatformError('revision_conflict', 'resource revision has changed', {
      expected_revision: Number(expected), actual_revision: Number(row.revision)
    }, 409);
  }
}

export function assertProject(authorization, principal, action, projectId, resource = {}) {
  requirePrincipal(principal);
  return authorization.assert(principal, action, String(projectId), resource);
}

export function requestHash(value) {
  return sha256Hex(canonicalJson(value));
}

export function canonicalPayload(value = {}) {
  const json = canonicalJson(value && typeof value === 'object' ? value : {});
  return { value: JSON.parse(json), json, sha256: sha256Hex(json) };
}

export function priorResponse(operations, tx, { actorId, commandId, idempotencyKey, requestHash: hash, now }) {
  const row = operations.getIdempotencyInTransaction(tx, { actorId, commandId, idempotencyKey, requestHash: hash, now });
  return row?.response_json ? { ...JSON.parse(row.response_json), replayed: true } : null;
}

export function saveResponse(operations, tx, { actorId, commandId, idempotencyKey, requestHash: hash, response, operationId = null, status = 200, now }) {
  operations.saveIdempotencyInTransaction(tx, {
    actorId, commandId, idempotencyKey, requestHash: hash, response,
    operationId, responseStatus: status, now
  });
}

export function createOperation(operations, tx, {
  actorId, commandId, resourceType, resourceId, projectId, requestHash: hash,
  idempotencyKey = `internal-${opaqueId('key')}`, status = 'succeeded', now,
  operationId = null, parentOperationId = null
}) {
  return operations.createInTransaction(tx, {
    actorId, commandId, kind: commandId, resourceType, resourceId, projectId,
    requestHash: hash, request: { resource_type: resourceType, resource_id: resourceId, project_id: projectId },
    idempotencyKey, status,
    ...(operationId ? { operationId } : {}),
    ...(parentOperationId ? { parentOperationId } : {})
  }, now);
}

export function appendAggregate(events, tx, {
  aggregateType, aggregateId, revision, operationId = null, actorId, projectId = null,
  type, data = {}, payload = {}, now, allowSameRevision = false
}) {
  if (allowSameRevision) {
    return events.appendInTransaction(tx, {
      aggregateType, aggregateId, aggregateRevision: revision, operationId, actorId,
      projectId, type, data, aggregateHash: requestHash(payload), occurredAt: now,
      allowSameRevision: true
    });
  }
  return events.appendAggregateInTransaction(tx, {
    aggregateType, aggregateId, revision, operationId, actorId, projectId,
    type, data, payload, now
  });
}

export function operationView(operations, operationId, principal = null, projectId = null) {
  return operations.get(String(operationId), {
    actorId: principal?.actorId || null,
    projectId: projectId == null ? null : String(projectId)
  });
}

export function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

export function boundedString(value, maximum, { required = false, code = 'schema_invalid' } = {}) {
  const text = String(value ?? '');
  if ((required && !text.trim()) || text.length > maximum) {
    throw new PlatformError(code, 'value is outside the allowed bounds', {}, 422);
  }
  return text;
}

export function time(clock) {
  const value = typeof clock === 'function' ? clock() : new Date().toISOString();
  return typeof value === 'string' ? value : new Date(value).toISOString();
}
