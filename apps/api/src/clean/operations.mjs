import { canonicalJson, canonicalHash, opaqueId, sha256Hex, utcNow, parseCanonicalJson } from './canonical.mjs';
import { EventService } from './events.mjs';
import { DEFAULT_REDACTION_POLICY } from './redaction.mjs';

export const OPERATION_STATUSES = Object.freeze(['accepted', 'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'expired']);
export const TERMINAL_OPERATION_STATUSES = Object.freeze(new Set(['succeeded', 'failed', 'cancelled', 'expired']));

const TRANSITIONS = Object.freeze({
  accepted: new Set(['queued', 'cancelled', 'expired']),
  queued: new Set(['running', 'paused', 'cancelled', 'expired']),
  running: new Set(['paused', 'succeeded', 'failed', 'cancelled', 'expired']),
  paused: new Set(['running', 'cancelled', 'expired']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set()
});

export class OperationError extends Error {
  constructor(code, message, details = {}, status = 409) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.status = status;
    this.retryable = code === 'revision_conflict' || code === 'operation_failed';
    this.details = details;
  }
}

export class OperationService {
  constructor({ db, events = null, policy = DEFAULT_REDACTION_POLICY, clock = utcNow, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db) throw new TypeError('operation_database_required');
    this.db = db;
    this.events = events || new EventService({ db, policy, clock });
    this.policy = policy;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.executors = new Map();
    this.active = new Map();
  }

  create(input = {}) {
    const now = this.#time();
    return this.db.withTransaction((tx) => this.createInTransaction(tx, input, now));
  }

  createInTransaction(tx, input = {}, now = this.#time()) {
    const actorId = String(input.actorId || this.bootstrapActorId);
    const commandId = String(input.commandId || input.kind || 'operation.execute');
    const commandVersion = Number(input.commandVersion || 2);
    const requestHash = normalizeHash(input.requestHash || sha256Hex(canonicalJson(input.request || {})));
    const idempotencyKey = String(input.idempotencyKey || `internal-${opaqueId('key')}`);
    const existing = tx.get('SELECT * FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actorId, commandId, idempotencyKey]);
    if (existing) {
      if (isExpired(existing.expires_at, now)) tx.run('DELETE FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actorId, commandId, idempotencyKey]);
      else {
        if (existing.request_hash !== requestHash) throw new OperationError('idempotency_conflict', 'idempotency key was used with a different request', { command_id: commandId, idempotency_key: idempotencyKey }, 409);
        if (existing.operation_id) return { ...this.receiptFromRow(tx.get('SELECT * FROM operations WHERE id=?', [existing.operation_id])), replayed: true };
      }
    }
    const operationId = String(input.operationId || opaqueId('op'));
    const resourceType = String(input.resourceType || '');
    const resourceId = String(input.resourceId || '');
    const projectId = input.projectId == null ? null : String(input.projectId);
    const status = input.status || 'accepted';
    if (!TRANSITIONS[status]) throw new OperationError('invalid_state', 'operation status is invalid', { status }, 422);
    tx.run(`INSERT INTO operations(id,command_id,command_version,kind,status,resource_type,resource_id,project_id,actor_id,request_hash,external_ref,result_json,error_code,error_details_json,revision,created_at,updated_at,started_at,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [operationId, commandId, commandVersion, String(input.kind || commandId), status, resourceType, resourceId, projectId, actorId, requestHash, '', '{}', '', '{}', 1, now, now, status === 'running' ? now : null, TERMINAL_OPERATION_STATUSES.has(status) ? now : null]);
    tx.run(`INSERT INTO operation_links(id,operation_id,aggregate_type,aggregate_id,relation,created_at) VALUES(?,?,?,?,?,?)`, [opaqueId('link'), operationId, resourceType || 'operation', resourceId || operationId, 'target', now]);
    if (input.parentOperationId) {
      tx.run(`INSERT INTO operation_links(id,operation_id,aggregate_type,aggregate_id,relation,created_at) VALUES(?,?,?,?,?,?)`, [opaqueId('link'), operationId, 'operation', String(input.parentOperationId), 'retry_of', now]);
    }
    const payload = operationPayload({ id: operationId, commandId, commandVersion, kind: String(input.kind || commandId), status, resourceType, resourceId, projectId, actorId, requestHash, revision: 1, result: {}, errorCode: '', createdAt: now, updatedAt: now });
    const payloadJson = canonicalJson(payload);
    tx.run(`INSERT INTO aggregate_revisions(id,aggregate_type,aggregate_id,revision,payload_json,payload_sha256,operation_id,actor_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, [opaqueId('rev'), 'operation', operationId, 1, payloadJson, sha256Hex(payloadJson), operationId, actorId, now]);
    const event = this.events.appendInTransaction(tx, { aggregateType: 'operation', aggregateId: operationId, aggregateRevision: 1, aggregateHash: sha256Hex(payloadJson), operationId, actorId, projectId, type: `operation.${status}`, data: { status, operation_id: operationId, resource_id: resourceId || null }, occurredAt: now });
    tx.run(`INSERT INTO idempotency_keys(actor_id,command_id,idempotency_key,request_hash,response_status,response_json,operation_id,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, [actorId, commandId, idempotencyKey, requestHash, 202, null, operationId, input.expiresAt || new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(), now]);
    const receipt = this.receiptFromRow(tx.get('SELECT * FROM operations WHERE id=?', [operationId]), event.sequence);
    // Keep the canonical receipt shape while exposing the small aliases used
    // by domain facades.  The aliases are projections, not a second ledger.
    const response = {
      ...receipt,
      id: operationId,
      resourceType,
      resourceId,
      event_sequence: event.sequence,
      cursor: event.sequence
    };
    tx.run('UPDATE idempotency_keys SET response_json=? WHERE actor_id=? AND command_id=? AND idempotency_key=?', [canonicalJson(response), actorId, commandId, idempotencyKey]);
    return response;
  }

  /**
   * Shared idempotency primitives for domain transactions.  Domain facades
   * may inspect and persist their response through this service, but never
   * write the idempotency table directly.
   */
  getIdempotencyInTransaction(tx, { actorId, commandId, idempotencyKey, requestHash, now = this.#time() } = {}) {
    const actor = String(actorId || this.bootstrapActorId);
    const command = String(commandId || 'operation.execute');
    const key = String(idempotencyKey || '');
    const hash = normalizeHash(requestHash || sha256Hex(canonicalJson({ actor, command, key })));
    const row = tx.get('SELECT * FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actor, command, key]);
    if (!row) return null;
    if (isExpired(row.expires_at, now)) {
      tx.run('DELETE FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actor, command, key]);
      return null;
    }
    if (row.request_hash !== hash) throw new OperationError('idempotency_conflict', 'idempotency key was used with a different request', { command_id: command }, 409);
    return row.response_json ? row : null;
  }

  saveIdempotencyInTransaction(tx, { actorId, commandId, idempotencyKey, requestHash, response, operationId = null, responseStatus = 200, expiresAt, now = this.#time() } = {}) {
    const actor = String(actorId || this.bootstrapActorId);
    const command = String(commandId || 'operation.execute');
    const key = String(idempotencyKey || '');
    const hash = normalizeHash(requestHash || sha256Hex(canonicalJson(response || {})));
    const payload = canonicalJson(response || {});
    const expiry = expiresAt || new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
    const existing = tx.get('SELECT actor_id FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actor, command, key]);
    if (existing) {
      tx.run('UPDATE idempotency_keys SET request_hash=?,response_status=?,response_json=?,operation_id=?,expires_at=? WHERE actor_id=? AND command_id=? AND idempotency_key=?', [hash, Number(responseStatus), payload, operationId, expiry, actor, command, key], 1);
      return;
    }
    tx.run('INSERT INTO idempotency_keys(actor_id,command_id,idempotency_key,request_hash,response_status,response_json,operation_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [actor, command, key, hash, Number(responseStatus), payload, operationId, expiry, now]);
  }

  /**
   * Add aggregate links from inside the caller's transaction.  All domains
   * use this entry point so link deduplication and redaction boundaries stay
   * identical for setup, identity, and project workflows.
   */
  linkInTransaction(tx, operationId, links = [], now = this.#time()) {
    const id = String(operationId || '');
    if (!id) throw new OperationError('operation_required', 'operation id is required', {}, 400);
    const values = Array.isArray(links) ? links : [links];
    const inserted = [];
    for (const value of values) {
      const [aggregateType, aggregateId, relation = 'target'] = Array.isArray(value)
        ? value
        : [value?.aggregateType || value?.aggregate_type, value?.aggregateId || value?.aggregate_id, value?.relation || 'target'];
      const type = String(aggregateType || '');
      const aggregate = String(aggregateId || '');
      const rel = String(relation || 'target');
      if (!type || !aggregate) throw new OperationError('link_invalid', 'operation link target is required', {}, 400);
      const existing = tx.get('SELECT id FROM operation_links WHERE operation_id=? AND aggregate_type=? AND aggregate_id=? AND relation=? LIMIT 1', [id, type, aggregate, rel]);
      if (existing) continue;
      const linkId = opaqueId('link');
      tx.run('INSERT INTO operation_links(id,operation_id,aggregate_type,aggregate_id,relation,created_at) VALUES(?,?,?,?,?,?)', [linkId, id, type, aggregate, rel, now]);
      inserted.push({ id: linkId, operation_id: id, aggregate_type: type, aggregate_id: aggregate, relation: rel, created_at: now });
    }
    return inserted;
  }

  /** Return a stable, redacted summary for envelopes and Evidence. */
  summary(operationIdOrRow) {
    const row = typeof operationIdOrRow === 'object' && operationIdOrRow
      ? operationIdOrRow
      : this.db.get('SELECT * FROM operations WHERE id=?', [String(operationIdOrRow || '')]);
    if (!row) return null;
    const receipt = this.receiptFromRow(row);
    return {
      operation_id: receipt.operation_id,
      command_id: receipt.command_id,
      status: receipt.status,
      revision: receipt.revision,
      resource_type: receipt.resource_type,
      resource_id: receipt.resource_id,
      project_id: receipt.project_id,
      terminal: TERMINAL_OPERATION_STATUSES.has(receipt.status),
      retryable: receipt.retryable,
      poll_uri: receipt.poll_uri,
      events_uri: receipt.events_uri
    };
  }

  get(operationId, { actorId = null, projectId = null } = {}) {
    const row = this.db.get('SELECT * FROM operations WHERE id=?', [String(operationId)]);
    if (!row) throw new OperationError('operation_not_found', 'operation not found', { operation_id: operationId }, 404);
    if (actorId && row.actor_id !== actorId && actorId !== this.bootstrapActorId) throw new OperationError('permission_denied', 'operation is outside the actor scope', {}, 403);
    if (projectId != null && (row.project_id || null) !== String(projectId)) throw new OperationError('scope_denied', 'operation is outside the project scope', {}, 403);
    return this.view(row);
  }

  transition(operationId, to, input = {}) {
    const now = this.#time();
    return this.db.withTransaction((tx) => this.transitionInTransaction(tx, operationId, to, input, now));
  }

  transitionInTransaction(tx, operationId, to, input = {}, now = this.#time()) {
      const target = String(to);
      const actorId = String(input.actorId || this.bootstrapActorId);
      const idempotencyKey = input.idempotencyKey ? String(input.idempotencyKey) : null;
      const commandId = String(input.commandId || (target === 'cancelled' ? 'operations.cancel' : `operation.${target}`));
      const requestHash = input.requestHash ? normalizeHash(input.requestHash) : null;
      if (idempotencyKey) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(idempotencyKey) || !requestHash) throw new OperationError('idempotency_required', 'idempotency request metadata is invalid', {}, 400);
        const priorRequest = tx.get('SELECT * FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actorId, commandId, idempotencyKey]);
        if (priorRequest) {
          if (isExpired(priorRequest.expires_at, now)) tx.run('DELETE FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actorId, commandId, idempotencyKey]);
          else {
            if (priorRequest.request_hash !== requestHash) throw new OperationError('idempotency_conflict', 'idempotency key was used with a different request', { command_id: commandId }, 409);
            if (priorRequest.response_json) return { ...JSON.parse(priorRequest.response_json), replayed: true };
          }
        }
      }
      const current = tx.get('SELECT * FROM operations WHERE id=?', [String(operationId)]);
      if (!current) throw new OperationError('operation_not_found', 'operation not found', { operation_id: operationId }, 404);
      if (target === 'cancelled' && !current.cancel_requested_at) throw new OperationError('state_conflict', 'operation cancellation must be requested before acknowledgement', { status: current.status }, 409);
      if (!TRANSITIONS[current.status]?.has(target)) throw new OperationError('state_conflict', 'state_conflict: operation transition is invalid', { from: current.status, to: target }, 409);
      const expected = Number(input.expectedRevision);
      if (!Number.isInteger(expected) || expected < 1) throw new OperationError('expected_revision_required', 'expected revision is required', { current_revision: current.revision }, 400);
      if (Number(current.revision) !== expected) throw new OperationError('revision_conflict', 'operation revision has changed', { expected_revision: expected, actual_revision: current.revision }, 409);
      if (actorId !== this.bootstrapActorId && current.actor_id !== actorId) throw new OperationError('permission_denied', 'operation belongs to another actor', {}, 403);
      if (input.projectId != null && (current.project_id || null) !== String(input.projectId)) throw new OperationError('scope_denied', 'operation is outside the project scope', {}, 403);
      const result = this.policy.redact(input.result || {}).value;
      const errorDetails = this.policy.redact(input.errorDetails || {}).value;
      const completed = TERMINAL_OPERATION_STATUSES.has(target);
      tx.run(`UPDATE operations SET status=?,result_json=?,error_code=?,error_details_json=?,revision=revision+1,updated_at=?,started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,completed_at=CASE WHEN ?=1 THEN ? ELSE completed_at END WHERE id=? AND status=? AND revision=?`, [target, canonicalJson(result), String(input.errorCode || ''), canonicalJson(errorDetails), now, target, now, completed ? 1 : 0, completed ? now : null, operationId, current.status, expected], 1);
      const nextRevision = expected + 1;
      const nextRow = tx.get('SELECT * FROM operations WHERE id=?', [String(operationId)]);
      const payload = operationPayload({ ...nextRow, commandId: nextRow.command_id, commandVersion: nextRow.command_version, resourceType: nextRow.resource_type, resourceId: nextRow.resource_id, projectId: nextRow.project_id, actorId: nextRow.actor_id, requestHash: nextRow.request_hash, revision: nextRevision, result, errorCode: input.errorCode || '', createdAt: nextRow.created_at, updatedAt: now });
      const payloadJson = canonicalJson(payload);
      tx.run(`INSERT INTO aggregate_revisions(id,aggregate_type,aggregate_id,revision,payload_json,payload_sha256,operation_id,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, [opaqueId('rev'), 'operation', operationId, nextRevision, payloadJson, sha256Hex(payloadJson), operationId, actorId, now]);
      const event = this.events.appendInTransaction(tx, { aggregateType: 'operation', aggregateId: operationId, aggregateRevision: nextRevision, aggregateHash: sha256Hex(payloadJson), operationId, actorId: nextRow.actor_id, projectId: nextRow.project_id, type: `operation.${target}`, data: { status: target, operation_id: operationId, error_code: input.errorCode || undefined, result: completed ? result : undefined }, occurredAt: now });
      const response = { ...this.receiptFromRow(nextRow), cursor: event.sequence };
      if (idempotencyKey) {
        const expiresAt = input.expiresAt || new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
        const existingKey = tx.get('SELECT actor_id FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actorId, commandId, idempotencyKey]);
        if (existingKey) tx.run('UPDATE idempotency_keys SET response_status=?,response_json=?,operation_id=? WHERE actor_id=? AND command_id=? AND idempotency_key=?', [completed ? 200 : 202, canonicalJson(response), operationId, actorId, commandId, idempotencyKey]);
        else tx.run(`INSERT INTO idempotency_keys(actor_id,command_id,idempotency_key,request_hash,response_status,response_json,operation_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, [actorId, commandId, idempotencyKey, requestHash, completed ? 200 : 202, canonicalJson(response), operationId, expiresAt, now]);
      }
      return response;
  }

  requestCancel(operationId, input = {}) {
    const now = this.#time();
    return this.db.withTransaction((tx) => this.requestCancelInTransaction(tx, operationId, input, now));
  }

  requestCancelInTransaction(tx, operationId, input = {}, now = this.#time()) {
      const actorId = String(input.actorId || this.bootstrapActorId);
      const commandId = String(input.commandId || 'operations.cancel');
      const idempotencyKey = String(input.idempotencyKey || '');
      const requestHash = input.requestHash ? normalizeHash(input.requestHash) : null;
      if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(idempotencyKey) || !requestHash) throw new OperationError('idempotency_required', 'idempotency request metadata is invalid', {}, 400);
      const priorRequest = tx.get('SELECT * FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actorId, commandId, idempotencyKey]);
      if (priorRequest) {
        if (isExpired(priorRequest.expires_at, now)) tx.run('DELETE FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actorId, commandId, idempotencyKey]);
        else {
          if (priorRequest.request_hash !== requestHash) throw new OperationError('idempotency_conflict', 'idempotency key was used with a different request', { command_id: commandId }, 409);
          if (priorRequest.response_json) return { ...JSON.parse(priorRequest.response_json), replayed: true };
        }
      }
      const current = tx.get('SELECT * FROM operations WHERE id=?', [String(operationId)]);
      if (!current) throw new OperationError('operation_not_found', 'operation not found', { operation_id: operationId }, 404);
      if (TERMINAL_OPERATION_STATUSES.has(current.status)) throw new OperationError('state_conflict', 'terminal operation cannot be cancelled', { status: current.status }, 409);
      const expected = Number(input.expectedRevision);
      if (!Number.isInteger(expected) || expected < 1) throw new OperationError('expected_revision_required', 'expected revision is required', { current_revision: current.revision }, 400);
      if (Number(current.revision) !== expected) throw new OperationError('revision_conflict', 'operation revision has changed', { expected_revision: expected, actual_revision: current.revision }, 409);
      if (actorId !== this.bootstrapActorId && current.actor_id !== actorId) throw new OperationError('permission_denied', 'operation belongs to another actor', {}, 403);
      if (input.projectId != null && (current.project_id || null) !== String(input.projectId)) throw new OperationError('scope_denied', 'operation is outside the project scope', {}, 403);
      if (current.cancel_requested_at) throw new OperationError('state_conflict', 'operation cancellation was already requested', { cancel_requested_at: current.cancel_requested_at }, 409);
      tx.run(`UPDATE operations SET cancel_requested_at=?,cancel_requested_by_actor_id=?,revision=revision+1,updated_at=?
        WHERE id=? AND revision=? AND cancel_requested_at IS NULL`, [now, actorId, now, String(operationId), expected], 1);
      const nextRow = tx.get('SELECT * FROM operations WHERE id=?', [String(operationId)]);
      const payloadJson = canonicalJson(operationPayload(nextRow));
      const nextRevision = expected + 1;
      tx.run(`INSERT INTO aggregate_revisions(id,aggregate_type,aggregate_id,revision,payload_json,payload_sha256,operation_id,actor_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`, [opaqueId('rev'), 'operation', String(operationId), nextRevision, payloadJson, sha256Hex(payloadJson), String(operationId), actorId, now]);
      const event = this.events.appendInTransaction(tx, { aggregateType: 'operation', aggregateId: String(operationId), aggregateRevision: nextRevision, aggregateHash: sha256Hex(payloadJson), operationId: String(operationId), actorId, projectId: nextRow.project_id, type: 'operation.cancel_requested', data: { status: nextRow.status, operation_id: String(operationId), cancellation_requested: true, reason: input.reason || undefined }, occurredAt: now });
      const response = { ...this.receiptFromRow(nextRow, event.sequence), cancellation_requested: true };
      const expiresAt = input.expiresAt || new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
      const existingKey = tx.get('SELECT actor_id FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actorId, commandId, idempotencyKey]);
      if (existingKey) tx.run('UPDATE idempotency_keys SET response_status=202,response_json=?,operation_id=? WHERE actor_id=? AND command_id=? AND idempotency_key=?', [canonicalJson(response), String(operationId), actorId, commandId, idempotencyKey]);
      else tx.run(`INSERT INTO idempotency_keys(actor_id,command_id,idempotency_key,request_hash,response_status,response_json,operation_id,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`, [actorId, commandId, idempotencyKey, requestHash, 202, canonicalJson(response), String(operationId), expiresAt, now]);
      return response;
  }

  queue(operationId, input = {}) { return this.transition(operationId, 'queued', input); }
  start(operationId, input = {}) { return this.transition(operationId, 'running', input); }
  pause(operationId, input = {}) { return this.transition(operationId, 'paused', input); }
  succeed(operationId, input = {}) { return this.transition(operationId, 'succeeded', input); }
  fail(operationId, input = {}) { return this.transition(operationId, 'failed', input); }
  cancel(operationId, input = {}) {
    return this.requestCancel(operationId, input).then((result) => {
      if (result.replayed) return result;
      const active = this.active.has(String(operationId));
      this.abort(operationId);
      if (!active) queueMicrotask(() => {
        const current = this.db.get('SELECT revision,status,cancel_requested_at FROM operations WHERE id=?', [String(operationId)]);
        if (current?.cancel_requested_at && !TERMINAL_OPERATION_STATUSES.has(current.status)) this.acknowledgeCancel(operationId, { expectedRevision: Number(current.revision) }).catch(() => undefined);
      });
      return result;
    });
  }

  acknowledgeCancel(operationId, input = {}) {
    const current = this.db.get('SELECT revision,status,cancel_requested_at FROM operations WHERE id=?', [String(operationId)]);
    if (!current) throw new OperationError('operation_not_found', 'operation not found', { operation_id: operationId }, 404);
    if (!current.cancel_requested_at) throw new OperationError('state_conflict', 'operation cancellation was not requested', { status: current.status }, 409);
    return this.transition(operationId, 'cancelled', { ...input, expectedRevision: input.expectedRevision ?? Number(current.revision), commandId: 'operation.cancel_acknowledged' });
  }

  retry(operationId, input = {}) {
    const prior = this.get(operationId);
    if (!['failed', 'expired'].includes(prior.status)) throw new OperationError('state_conflict', 'only failed or expired operations can be retried', { status: prior.status }, 409);
    return this.create({ ...input, commandId: prior.command_id, commandVersion: prior.command_version, kind: prior.kind, resourceType: prior.resource_type, resourceId: prior.resource_id, projectId: prior.project_id, actorId: input.actorId || prior.actor_id, request: { retry_of: operationId, ...input.request }, parentOperationId: operationId });
  }

  eventsFor(operationId, options = {}) {
    this.get(operationId, options);
    return this.events.replay({ ...options, operationId: String(operationId) });
  }

  registerExecutor(operationId, executor) {
    if (typeof executor !== 'function') throw new TypeError('operation_executor_required');
    this.executors.set(String(operationId), executor);
    queueMicrotask(() => this.run(operationId, executor).catch(() => undefined));
    return this.get(operationId);
  }

  async run(operationId, executor = this.executors.get(String(operationId))) {
    if (typeof executor !== 'function') return this.get(operationId);
    let current = this.get(operationId);
    const controller = new AbortController();
    this.active.set(String(operationId), controller);
    try {
      if (current.status === 'accepted') current = await this.queue(operationId, { expectedRevision: current.revision });
      if (current.status === 'queued') current = await this.start(operationId, { expectedRevision: current.revision });
      const context = {
        operationId: String(operationId),
        signal: controller.signal,
        emit: (type, data = {}) => {
          const latest = this.get(operationId);
          const head = this.db.get("SELECT current_hash FROM aggregate_heads WHERE aggregate_type='operation' AND aggregate_id=?", [String(operationId)]);
          return this.events.append({ aggregateType: 'operation', aggregateId: String(operationId), aggregateRevision: latest.revision, aggregateHash: head.current_hash, allowSameRevision: true, operationId: String(operationId), actorId: current.actor_id, projectId: current.project_id, type, data });
        },
        ensureActive: () => { if (controller.signal.aborted) throw new OperationError('operation_cancelled', 'operation was cancelled', {}, 409); }
      };
      const result = await executor(context);
      context.ensureActive();
      current = this.get(operationId);
      return await this.succeed(operationId, { expectedRevision: current.revision, result });
    } catch (error) {
      const latest = this.get(operationId);
      if (latest.status === 'cancelled') return latest;
      if (controller.signal.aborted && latest.cancellation_requested) return await this.acknowledgeCancel(operationId, { expectedRevision: latest.revision });
      const errorDetails = { message: String(error?.message || 'operation failed').replace(/(?:sk|gh[opurs])_[A-Za-z0-9_-]{8,}/g, '<redacted-token>').replace(/[A-Za-z]:[\\/][^\s"']+|\/(?:Users|home|tmp|var)\/[^\s"']+/g, '<redacted-path>').slice(0, 300) };
      if (error?.code === 'provider_request_failed' && error?.details && typeof error.details === 'object') {
        for (const key of ['provider_code', 'rpc_method', 'provider_error_type']) if (typeof error.details[key] === 'string' && error.details[key]) errorDetails[key] = error.details[key].slice(0, 120);
      }
      return await this.fail(operationId, { expectedRevision: latest.revision, errorCode: /^[a-z][a-z0-9_.-]{2,100}$/.test(String(error?.code || '')) ? error.code : 'operation_failed', errorDetails });
    } finally {
      this.active.delete(String(operationId));
      this.executors.delete(String(operationId));
    }
  }

  abort(operationId) {
    this.active.get(String(operationId))?.abort();
  }

  receipt(operationId) {
    return this.receiptFromRow(this.db.get('SELECT * FROM operations WHERE id=?', [String(operationId)]));
  }

  listByCommand(commandId, { statuses = [], actorId = null } = {}) {
    const clauses = ['command_id=?'];
    const params = [String(commandId || '')];
    const allowedStatuses = Array.isArray(statuses) ? statuses.map((value) => String(value)).filter(Boolean) : [];
    if (allowedStatuses.length) {
      clauses.push(`status IN (${allowedStatuses.map(() => '?').join(',')})`);
      params.push(...allowedStatuses);
    }
    if (actorId && String(actorId) !== this.bootstrapActorId) {
      clauses.push('actor_id=?');
      params.push(String(actorId));
    }
    return this.db.query(`SELECT * FROM operations WHERE ${clauses.join(' AND ')} ORDER BY created_at,id`, params)
      .map((row) => this.receiptFromRow(row));
  }

  findByResource(resourceType, resourceId, { actorId = null } = {}) {
    const row = this.db.get('SELECT * FROM operations WHERE resource_type=? AND resource_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [String(resourceType || ''), String(resourceId || '')]);
    if (!row) return null;
    if (actorId && String(actorId) !== this.bootstrapActorId && row.actor_id !== String(actorId)) {
      throw new OperationError('permission_denied', 'operation belongs to another actor', {}, 403);
    }
    return this.receiptFromRow(row);
  }

  links(operationId) {
    const id = String(operationId);
    this.get(id);
    return this.db.query('SELECT id,operation_id,aggregate_type,aggregate_id,relation,created_at FROM operation_links WHERE operation_id=? ORDER BY created_at,id', [id]);
  }

  getReceipt(operationId) {
    const receipt = this.receipt(operationId);
    if (!receipt) throw new OperationError('operation_not_found', 'operation not found', { operation_id: operationId }, 404);
    return receipt;
  }

  receiptFromRow(row, cursor = null) {
    if (!row) return null;
    const receipt = {
      id: row.id,
      operation_id: row.id,
      command_id: row.command_id,
      command_version: Number(row.command_version),
      kind: row.kind,
      status: row.status,
      resource_type: row.resource_type || null,
      resource_id: row.resource_id || null,
      actor_id: row.actor_id,
      project_id: row.project_id || null,
      revision: Number(row.revision),
      accepted_revision: Number(row.revision),
      cursor: cursor == null ? Number(this.db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE operation_id=?', [row.id])?.sequence || 0) : Number(cursor),
      result: parseCanonicalJson(row.result_json, {}),
      error_code: row.error_code || null,
      error_details: parseCanonicalJson(row.error_details_json, {}),
      retryable: Boolean(parseCanonicalJson(row.error_details_json, {}).retryable),
      audit_reference: this.db.get('SELECT id FROM audit_events WHERE operation_id=? ORDER BY created_at,id LIMIT 1', [row.id])?.id || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || null
    };
    receipt.cancellation_requested = Boolean(row.cancel_requested_at);
    receipt.cancel_requested_at = row.cancel_requested_at || null;
    receipt.poll_uri = `/api/v2/operations/${encodeURIComponent(row.id)}`;
    receipt.events_uri = `/api/v2/operations/${encodeURIComponent(row.id)}/events`;
    receipt.replay_uri = `${receipt.events_uri}?format=json`;
    receipt.operation = {
      id: receipt.id,
      kind: receipt.kind,
      status: receipt.status,
      resource_type: receipt.resource_type,
      resource_id: receipt.resource_id,
      accepted_revision: receipt.accepted_revision,
      poll_uri: receipt.poll_uri,
      events_uri: receipt.events_uri,
      replay_uri: receipt.replay_uri
    };
    return receipt;
  }

  view(row) {
    return this.receiptFromRow(row);
  }

  #time() {
    const value = typeof this.clock === 'function' ? this.clock() : this.clock;
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
}

function operationPayload(row) {
  return {
    id: row.id,
    command_id: row.commandId || row.command_id,
    command_version: Number(row.commandVersion || row.command_version || 2),
    kind: row.kind,
    status: row.status,
    resource_type: row.resourceType || row.resource_type || '',
    resource_id: row.resourceId || row.resource_id || '',
    project_id: row.projectId ?? row.project_id ?? null,
    actor_id: row.actorId || row.actor_id,
    request_hash: row.requestHash || row.request_hash,
    revision: Number(row.revision),
    result: row.result || parseCanonicalJson(row.result_json, {}),
    error_code: row.errorCode || row.error_code || '',
    cancel_requested_at: row.cancelRequestedAt || row.cancel_requested_at || null,
    cancel_requested_by_actor_id: row.cancelRequestedByActorId || row.cancel_requested_by_actor_id || null,
    created_at: row.createdAt || row.created_at,
    updated_at: row.updatedAt || row.updated_at
  };
}

function isExpired(value, now) {
  const expiry = Date.parse(String(value || ''));
  const current = Date.parse(String(now || ''));
  return Number.isFinite(expiry) && Number.isFinite(current) && expiry <= current;
}

function normalizeHash(value) {
  const hash = String(value).replace(/^sha256:/, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new OperationError('invalid_request', 'request hash must be SHA-256', {}, 400);
  return hash;
}
