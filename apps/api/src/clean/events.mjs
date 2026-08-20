import { canonicalJson, opaqueId, sha256Hex, utcNow, parseCanonicalJson } from './canonical.mjs';
import { encodeCursor, decodeCursor, CursorError } from './cursor.mjs';
import { DEFAULT_REDACTION_POLICY } from './redaction.mjs';

const TERMINAL_EVENT = /(?:succeeded|completed|failed|cancelled|expired|terminal)$/;

export class EventService {
  constructor({ db, policy = DEFAULT_REDACTION_POLICY, clock = utcNow, cursorSecret = 'v3-clean-local-cursor', authorize = () => true } = {}) {
    if (!db) throw new TypeError('event_database_required');
    this.db = db;
    this.policy = policy;
    this.clock = clock;
    this.cursorSecret = cursorSecret;
    this.authorize = authorize;
    this.subscribers = new Set();
  }

  append(input = {}) {
    return this.db.withTransaction((tx) => this.appendInTransaction(tx, input));
  }

  appendInTransaction(tx, input = {}) {
    const aggregateType = String(input.aggregateType || 'operation');
    const aggregateId = String(input.aggregateId || '');
    const actorId = String(input.actorId || 'actor_system_bootstrap');
    const revision = Number(input.aggregateRevision || 1);
    if (!aggregateId || !Number.isInteger(revision) || revision < 1) throw new Error('event_aggregate_invalid');
    const occurredAt = input.occurredAt || this.clock();
    const redacted = this.policy.redact(input.data || {});
    if (redacted.redactions.length) {
      const failureJson = canonicalJson({ status: 'redacted_failure', redactions: redacted.redactions });
      tx.run(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`, [opaqueId('receipt'), 'event.redaction', 'failed', failureJson, sha256Hex(failureJson), null, occurredAt || this.clock(), null]);
    }
    const dataJson = canonicalJson(redacted.value);
    const dataSha = sha256Hex(dataJson);
    const eventId = String(input.eventId || opaqueId('evt'));
    const result = tx.run(`INSERT INTO events(id,type,aggregate_type,aggregate_id,aggregate_revision,operation_id,actor_id,project_id,occurred_at,data_json,data_sha256,redactions_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
      eventId,
      String(input.type || 'operation.progress'),
      aggregateType,
      aggregateId,
      revision,
      input.operationId || null,
      actorId,
      input.projectId || null,
      occurredAt,
      dataJson,
      dataSha,
      canonicalJson(redacted.redactions)
    ]);
    const sequence = Number(result.lastInsertRowid);
    const current = tx.get('SELECT current_revision,current_hash,last_event_sequence FROM aggregate_heads WHERE aggregate_type=? AND aggregate_id=?', [aggregateType, aggregateId]);
    const aggregateHash = String(input.aggregateHash || dataSha);
    if (!current) {
      if (revision !== 1) throw revisionConflict(0, revision - 1);
      tx.run(`INSERT INTO aggregate_heads(aggregate_type,aggregate_id,current_revision,current_hash,last_event_sequence,updated_at)
        VALUES(?,?,?,?,?,?)`, [aggregateType, aggregateId, revision, aggregateHash, sequence, occurredAt]);
    } else if (input.allowSameRevision === true && Number(current.current_revision) === revision) {
      tx.run(`UPDATE aggregate_heads SET last_event_sequence=?,updated_at=?
        WHERE aggregate_type=? AND aggregate_id=? AND current_revision=?`, [sequence, occurredAt, aggregateType, aggregateId, revision], 1);
    } else {
      if (Number(current.current_revision) !== revision - 1) throw revisionConflict(Number(current.current_revision), revision - 1);
      tx.run(`UPDATE aggregate_heads SET current_revision=?,current_hash=?,last_event_sequence=?,updated_at=?
        WHERE aggregate_type=? AND aggregate_id=? AND current_revision=?`, [revision, aggregateHash, sequence, occurredAt, aggregateType, aggregateId, revision - 1], 1);
    }
    if (input.audit !== false) {
      const auditPayload = canonicalJson(this.policy.redact(input.auditData || { type: input.type, sequence }).value);
      tx.run(`INSERT INTO audit_events(id,event_id,operation_id,actor_id,action,entity_type,entity_id,data_json,data_sha256,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [opaqueId('audit'), eventId, input.operationId || null, actorId, String(input.auditAction || input.type || 'event.append'), aggregateType, aggregateId, auditPayload, sha256Hex(auditPayload), occurredAt]);
    }
    const event = this.#view({
      id: eventId,
      sequence,
      type: String(input.type || 'operation.progress'),
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      aggregate_revision: revision,
      operation_id: input.operationId || null,
      actor_id: actorId,
      project_id: input.projectId || null,
      occurred_at: occurredAt,
      data_json: dataJson,
      data_sha256: dataSha,
      redactions_json: canonicalJson(redacted.redactions)
    });
    tx.afterCommit(() => this.#publish(event));
    return event;
  }

  /**
   * Append an aggregate revision, event/head update, and audit record through
   * one shared transaction entry point.  Domain services must not duplicate
   * this SQL because aggregate CAS semantics belong to the event ledger.
   */
  appendAggregateInTransaction(tx, input = {}) {
    const aggregateType = String(input.aggregateType || '');
    const aggregateId = String(input.aggregateId || '');
    const revision = Number(input.revision ?? input.aggregateRevision);
    if (!aggregateType || !aggregateId || !Number.isInteger(revision) || revision < 1) throw new Error('aggregate_revision_invalid');
    const payloadValue = input.payload == null ? {} : input.payload;
    const payloadJson = typeof payloadValue === 'string' ? payloadValue : canonicalJson(payloadValue);
    const payloadHash = sha256Hex(payloadJson);
    tx.run('INSERT INTO aggregate_revisions(id,aggregate_type,aggregate_id,revision,payload_json,payload_sha256,operation_id,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [opaqueId('rev'), aggregateType, aggregateId, revision, payloadJson, payloadHash, input.operationId || null, String(input.actorId || 'actor_system_bootstrap'), input.now || input.occurredAt || this.clock()]);
    return this.appendInTransaction(tx, {
      ...input,
      aggregateType,
      aggregateId,
      aggregateRevision: revision,
      aggregateHash: payloadHash,
      occurredAt: input.now || input.occurredAt || this.clock()
    });
  }

  replay({ actorId = 'actor_system_bootstrap', projectId = null, operationId = null, aggregateType = null, aggregateId = null, cursor = null, limit = 500, consumerId = null, now = new Date() } = {}) {
    const query = { operation_id: operationId, aggregate_type: aggregateType, aggregate_id: aggregateId };
    let after = 0;
    if (cursor) {
      if (/^\d+$/.test(String(cursor))) after = Number(cursor);
      else after = decodeCursor(cursor, { actorId, projectId, stream: streamName(query), query, secret: this.cursorSecret, now }).sequence;
    }
    const bounded = Math.max(1, Math.min(500, Number(limit) || 500));
    const clauses = ['sequence > ?'];
    const params = [after];
    if (projectId != null) { clauses.push('project_id=?'); params.push(String(projectId)); }
    if (operationId) { clauses.push('operation_id=?'); params.push(String(operationId)); }
    if (aggregateType) { clauses.push('aggregate_type=?'); params.push(String(aggregateType)); }
    if (aggregateId) { clauses.push('aggregate_id=?'); params.push(String(aggregateId)); }
    const rows = this.db.query(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY sequence LIMIT ?`, [...params, bounded]);
    if (!this.authorize({ actorId, projectId, events: rows })) {
      const error = new Error('permission_denied');
      error.code = 'permission_denied';
      error.status = 403;
      error.details = { project_id: projectId };
      throw error;
    }
    const events = rows.map((row) => this.#view(row));
    const last = events.at(-1)?.sequence || after;
    const terminal = events.some((event) => TERMINAL_EVENT.test(event.type));
    const nextCursor = encodeCursor({ actorId, projectId, stream: streamName(query), sequence: last, query, secret: this.cursorSecret });
    let cursorReceipt = null;
    if (consumerId) {
      cursorReceipt = this.ackCursor({ actorId, consumerId, stream: streamName(query), projectId, cursor: last, query });
    }
    return { events, next_cursor: nextCursor, terminal, resource: resourceFromEvents(events), cursor_sequence: last, cursor: cursorReceipt };
  }

  ackCursor({ actorId = 'actor_system_bootstrap', consumerId = 'default', stream = 'events', projectId = null, cursor, query = {}, expectedRevision = null, expiresAt, now = this.clock() } = {}) {
    let sequence;
    if (/^\d+$/.test(String(cursor))) sequence = Number(cursor);
    else sequence = decodeCursor(cursor, { actorId, projectId, stream, query, secret: this.cursorSecret, now }).sequence;
    const existing = this.db.get('SELECT * FROM event_cursors WHERE actor_id=? AND consumer_id=? AND stream=?', [actorId, consumerId, stream]);
    const expected = expectedRevision == null ? Number(existing?.revision || 0) : Number(expectedRevision);
    if (existing && Number(existing.revision) !== expected) throw revisionConflict(Number(existing.revision), expected);
    if (existing && sequence < Number(existing.cursor_sequence)) throw new CursorError('cursor_regression', 'event cursor must be monotonic', { current_cursor: existing.cursor_sequence });
    const timestamp = typeof now === 'string' ? now : new Date(now).toISOString();
    if (existing && Date.parse(existing.expires_at) <= Date.parse(timestamp)) {
      const restartCursor = encodeCursor({ actorId, projectId, stream, sequence: 0, query, expiresAt: new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1000).toISOString(), secret: this.cursorSecret });
      throw new CursorError('cursor_expired', 'event cursor has expired', { restart_cursor: restartCursor });
    }
    const expiry = expiresAt || new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1000).toISOString();
    if (!existing) {
      this.db.run(`INSERT INTO event_cursors(actor_id,consumer_id,stream,project_id,cursor_sequence,revision,expires_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`, [actorId, consumerId, stream, projectId, sequence, 1, expiry, timestamp]);
      return { actor_id: actorId, consumer_id: consumerId, stream, cursor_sequence: sequence, revision: 1, expires_at: expiry };
    }
    this.db.run(`UPDATE event_cursors SET project_id=?,cursor_sequence=?,revision=revision+1,expires_at=?,updated_at=?
      WHERE actor_id=? AND consumer_id=? AND stream=? AND revision=?`, [projectId, sequence, expiry, timestamp, actorId, consumerId, stream, expected], 1);
    return { actor_id: actorId, consumer_id: consumerId, stream, cursor_sequence: sequence, revision: expected + 1, expires_at: expiry };
  }

  subscribe({ operationId = null, aggregateType = null, aggregateId = null, afterSequence = 0 } = {}, listener) {
    if (typeof listener !== 'function') throw new TypeError('event_listener_required');
    const subscription = { operationId: operationId == null ? null : String(operationId), aggregateType: aggregateType == null ? null : String(aggregateType), aggregateId: aggregateId == null ? null : String(aggregateId), afterSequence: Number(afterSequence) || 0, listener };
    this.subscribers.add(subscription);
    return () => this.subscribers.delete(subscription);
  }

  sseFrames(replay, { heartbeat = true } = {}) {
    return replay.events.map((event) => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      + (heartbeat && !replay.terminal ? ': heartbeat\n\n' : '');
  }

  #publish(event) {
    for (const subscription of [...this.subscribers]) {
      if (event.sequence <= subscription.afterSequence) continue;
      if (subscription.operationId && event.operation_id !== subscription.operationId) continue;
      if (subscription.aggregateType && event.aggregate.type !== subscription.aggregateType) continue;
      if (subscription.aggregateId && event.aggregate.id !== subscription.aggregateId) continue;
      subscription.afterSequence = event.sequence;
      try { subscription.listener(event); } catch { /* a disconnected subscriber is removed by its transport */ }
    }
  }

  #view(row) {
    if (!row) return null;
    return {
      id: row.id,
      sequence: Number(row.sequence),
      type: row.type,
      aggregate: { type: row.aggregate_type, id: row.aggregate_id, revision: Number(row.aggregate_revision) },
      operation_id: row.operation_id || null,
      actor_id: row.actor_id,
      project_id: row.project_id || null,
      occurred_at: row.occurred_at,
      data: parseCanonicalJson(row.data_json, {}),
      data_sha256: `sha256:${row.data_sha256}`,
      redactions: parseCanonicalJson(row.redactions_json, [])
    };
  }
}

function streamName(query) {
  if (query.operation_id) return `operation:${query.operation_id}`;
  if (query.aggregate_type && query.aggregate_id) return `${query.aggregate_type}:${query.aggregate_id}`;
  return 'events';
}

function resourceFromEvents(events) {
  const last = events.at(-1);
  return last ? { id: last.aggregate.id, type: last.aggregate.type, revision: last.aggregate.revision } : null;
}

function revisionConflict(actual, expected) {
  const error = new Error('revision_conflict');
  error.code = 'revision_conflict';
  error.status = 409;
  error.details = { actual_revision: actual, expected_revision: expected };
  return error;
}
