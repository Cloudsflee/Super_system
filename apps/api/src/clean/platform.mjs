import { canonicalJson, opaqueId, sha256Hex, utcNow } from './canonical.mjs';
import { DEFAULT_REDACTION_POLICY } from './redaction.mjs';
import { EventService } from './events.mjs';
import { PrincipalResolver } from './principal.mjs';
import { PlatformError } from './platform-error.mjs';

export { PlatformError } from './platform-error.mjs';

export class CleanPlatform {
  constructor({ db, events = null, policy = DEFAULT_REDACTION_POLICY, clock = utcNow, bootstrapActorId = 'actor_system_bootstrap', authorize = null, principalResolver = null } = {}) {
    if (!db) throw new TypeError('platform_database_required');
    this.db = db;
    this.policy = policy;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.events = events || new EventService({ db, policy, clock });
    this.principalResolver = principalResolver || new PrincipalResolver({ db, bootstrapActorId });
    this.authorize = typeof authorize === 'function' ? authorize : ((context) => context.actorId === this.bootstrapActorId);
  }

  actorContext(input = {}) {
    return this.principalResolver.resolve(input);
  }

  assertAuthorized(context, action = 'read', resource = {}) {
    const normalized = context?.actorId ? context : this.actorContext(context || {});
    if (!normalized.scopes.some((scope) => scope === '*' || scope === action || scope === 'operations:control' || (action.endsWith(':read') && scope.endsWith(':read')))) {
      throw new PlatformError('scope_denied', 'requested scope is not granted', { action }, 403);
    }
    if (!this.authorize({ ...normalized, action, resource })) throw new PlatformError('permission_denied', 'policy denied the requested resource', { action }, 403);
    if (normalized.projectId != null && resource.projectId != null && String(resource.projectId) !== String(normalized.projectId)) throw new PlatformError('project_denied', 'resource is outside the project scope', {}, 403);
    return normalized;
  }

  async withTransaction(context = {}, callback) {
    const actor = this.actorContext(context);
    this.assertAuthorized(actor, context.action || 'operations:control', context.resource || {});
    return this.db.withTransaction((tx) => callback({ tx, actor, now: this.#time(), events: this.events, policy: this.policy }));
  }

  async mutateAggregate(input = {}) {
    const actor = this.actorContext(input);
    const commandId = String(input.commandId || 'aggregate.mutate');
    const idempotencyKey = String(input.idempotencyKey || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(idempotencyKey)) throw new PlatformError('idempotency_required', 'Idempotency-Key is required', {}, 400);
    const requestHash = normalizeHash(input.requestHash || sha256Hex(canonicalJson(input.request || {})));
    const aggregateType = String(input.aggregateType || 'aggregate');
    const aggregateId = String(input.aggregateId || opaqueId(aggregateType));
    const timestamp = this.#time();
    this.assertAuthorized(actor, input.action || 'operations:control', { projectId: input.projectId });
    return this.db.withTransaction((tx) => {
      let existing = tx.get('SELECT * FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actor.actorId, commandId, idempotencyKey]);
      if (existing) {
        if (isExpired(existing.expires_at, timestamp)) {
          tx.run('DELETE FROM idempotency_keys WHERE actor_id=? AND command_id=? AND idempotency_key=?', [actor.actorId, commandId, idempotencyKey]);
          existing = null;
        }
        else {
          if (existing.request_hash !== requestHash) throw new PlatformError('idempotency_conflict', 'Idempotency-Key request hash differs', { command_id: commandId }, 409);
          if (existing.response_json) return { ...JSON.parse(existing.response_json), replayed: true };
        }
      }
      const current = tx.get('SELECT * FROM aggregate_heads WHERE aggregate_type=? AND aggregate_id=?', [aggregateType, aggregateId]);
      const currentRevision = Number(current?.current_revision || 0);
      const expected = input.expectedRevision == null ? null : Number(input.expectedRevision);
      if (expected != null && (!Number.isInteger(expected) || expected !== currentRevision)) throw new PlatformError('revision_conflict', 'aggregate revision has changed', { expected_revision: expected, actual_revision: currentRevision }, 409);
      const nextRevision = currentRevision + 1;
      const applied = awaitMaybe(input.apply, { tx, actor, currentRevision, nextRevision, aggregateId, aggregateType, now: timestamp });
      const payload = this.policy.redact(applied?.payload ?? input.payload ?? {}).value;
      const payloadJson = canonicalJson(payload);
      const payloadHash = sha256Hex(payloadJson);
      tx.run(`INSERT INTO aggregate_revisions(id,aggregate_type,aggregate_id,revision,payload_json,payload_sha256,operation_id,actor_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`, [opaqueId('rev'), aggregateType, aggregateId, nextRevision, payloadJson, payloadHash, input.operationId || null, actor.actorId, timestamp]);
      const event = this.events.appendInTransaction(tx, {
        aggregateType,
        aggregateId,
        aggregateRevision: nextRevision,
        aggregateHash: payloadHash,
        operationId: input.operationId || null,
        actorId: actor.actorId,
        projectId: input.projectId || actor.projectId,
        type: input.eventType || `${aggregateType}.updated`,
        data: applied?.eventData || input.eventData || { revision: nextRevision },
        occurredAt: timestamp,
        auditAction: input.auditAction || commandId
      });
      if (input.operationId) {
        tx.run(`INSERT OR IGNORE INTO operation_links(id,operation_id,aggregate_type,aggregate_id,relation,created_at)
          VALUES(?,?,?,?,?,?)`, [opaqueId('link'), String(input.operationId), aggregateType, aggregateId, 'target', timestamp]);
      }
      const response = {
        id: aggregateId,
        aggregate_type: aggregateType,
        revision: nextRevision,
        etag: `rev-${nextRevision}-sha256:${payloadHash}`,
        event_id: event.id,
        event_sequence: event.sequence,
        data: this.policy.redact(applied?.result ?? input.result ?? { id: aggregateId, revision: nextRevision }).value,
        redactions: event.redactions
      };
      if (!existing) tx.run(`INSERT INTO idempotency_keys(actor_id,command_id,idempotency_key,request_hash,response_status,response_json,operation_id,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`, [actor.actorId, commandId, idempotencyKey, requestHash, Number(input.responseStatus || 200), canonicalJson(response), input.operationId || null, input.expiresAt || new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1000).toISOString(), timestamp]);
      else tx.run('UPDATE idempotency_keys SET response_status=?,response_json=? WHERE actor_id=? AND command_id=? AND idempotency_key=?', [Number(input.responseStatus || 200), canonicalJson(response), actor.actorId, commandId, idempotencyKey]);
      return response;
    });
  }

  createReceipt({ id: requestedId = null, kind, payload, status = 'created', casSha256 = null, expiresAt = null } = {}) {
    const clean = this.policy.redact(payload || {});
    const payloadJson = canonicalJson(clean.value);
    if (clean.redactions.length) {
      const failure = canonicalJson({ status: 'redacted_failure', kind: String(kind || 'platform.receipt'), redactions: clean.redactions });
      this.db.run(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`, [opaqueId('receipt'), 'receipt.redaction', 'failed', failure, sha256Hex(failure), null, this.#time(), null]);
    }
    const id = requestedId ? String(requestedId) : opaqueId('receipt');
    this.db.run(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?)`, [id, String(kind || 'platform.receipt'), status, payloadJson, sha256Hex(payloadJson), casSha256 ? normalizeHash(casSha256) : null, this.#time(), expiresAt]);
    return { receipt_id: id, kind: String(kind || 'platform.receipt'), status, payload: clean.value, payload_sha256: `sha256:${sha256Hex(payloadJson)}`, redactions: clean.redactions };
  }

  receipt(id) {
    const row = this.db.get('SELECT * FROM receipt_manifests WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'receipt not found', {}, 404);
    return { receipt_id: row.id, kind: row.kind, status: row.status, payload: JSON.parse(row.payload_json), payload_sha256: `sha256:${row.payload_sha256}`, cas_sha256: row.cas_sha256 ? `sha256:${row.cas_sha256}` : null, created_at: row.created_at, expires_at: row.expires_at || null };
  }

  redact(value) { return this.policy.redact(value).value; }

  #time() {
    const value = typeof this.clock === 'function' ? this.clock() : this.clock;
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }
}

export function withTransaction(platform, context, callback) {
  if (!platform || typeof platform.withTransaction !== 'function') throw new TypeError('clean_platform_required');
  return platform.withTransaction(context, callback);
}

function normalizeHash(value) {
  const hash = String(value).replace(/^sha256:/, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new PlatformError('invalid_request', 'request hash must be SHA-256', {}, 400);
  return hash;
}

function awaitMaybe(value, argument) {
  // Mutation callbacks are synchronous by contract so a transaction cannot be
  // accidentally yielded to another request. Promise returns are rejected.
  const result = typeof value === 'function' ? value(argument) : value;
  if (result && typeof result.then === 'function') throw new PlatformError('invalid_request', 'transaction callback must be synchronous', {}, 400);
  return result || {};
}

function isExpired(value, now) {
  const expiry = Date.parse(String(value || ''));
  const current = Date.parse(String(now || ''));
  return Number.isFinite(expiry) && Number.isFinite(current) && expiry <= current;
}
