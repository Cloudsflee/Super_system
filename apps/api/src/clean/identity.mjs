import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex, utcNow, parseCanonicalJson } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { AuthorizationService, PROJECT_ROLES, TEAM_ROLES } from './authorization.mjs';
import { ActorService } from './actor-service.mjs';
import { SessionService } from './session-service.mjs';
import { TeamAccessService } from './team-access-service.mjs';
import { CredentialProfileService } from './credential-profile-service.mjs';
import { IDENTITY_OWNER_TABLES } from './identity-helpers.mjs';

const ACTOR_KINDS = new Set(['user', 'service', 'agent']);
const ACTOR_STATES = new Set(['active', 'suspended', 'revoked']);
const TEAM_STATES = new Set(['active', 'suspended', 'archived']);
const MEMBERSHIP_STATES = new Set(['invited', 'active', 'suspended', 'revoked', 'expired']);
const CREDENTIAL_STATES = new Set(['rebind_required', 'pending', 'active', 'failed', 'revoked']);
const PROFILE_STATES = new Set(['unprobed', 'probing', 'available', 'unavailable', 'rebind_required']);
const ACTOR_TRANSITIONS = Object.freeze({
  active: new Set(['suspended', 'revoked']),
  suspended: new Set(['active', 'revoked']),
  revoked: new Set()
});
const TEAM_TRANSITIONS = Object.freeze({
  active: new Set(['suspended', 'archived']),
  suspended: new Set(['active', 'archived']),
  archived: new Set()
});
const TEAM_MEMBERSHIP_TRANSITIONS = Object.freeze({
  invited: new Set(['active', 'revoked', 'expired']),
  active: new Set(['suspended', 'revoked', 'expired']),
  suspended: new Set(['active', 'revoked', 'expired']),
  revoked: new Set(),
  expired: new Set()
});
const PROJECT_MEMBERSHIP_TRANSITIONS = Object.freeze({
  active: new Set(['suspended', 'revoked', 'expired']),
  suspended: new Set(['active', 'revoked', 'expired']),
  revoked: new Set(),
  expired: new Set()
});

class IdentityCoreService {
  constructor({ db, events, operations = null, policy = null, clock = utcNow, bootstrapActorId = 'actor_system_bootstrap', sessionSecret = 'v3-clean-local-session', authorization = null, projectScopeResolver = null, vault = null, providerAdapters = {} } = {}) {
    if (!db) throw new TypeError('identity_database_required');
    this.db = db;
    this.events = events;
    this.operations = operations;
    this.policy = policy;
    this.clock = clock;
    this.bootstrapActorId = String(bootstrapActorId);
    this.sessionSecret = String(sessionSecret);
    this.authorization = authorization || new AuthorizationService({ db, projectScopeResolver, clock: () => this.#time() });
    this.projectScopeResolver = projectScopeResolver;
    this.vault = vault;
    this.providerAdapters = providerAdapters;
    if (this.db && operations) this.db.__cleanOperations = operations;
    if (this.events) this.events.operations = operations;
  }

  account(principal = null) {
    const actorId = String(principal?.effectiveActorId || principal?.actorId || this.bootstrapActorId);
    const row = this.db.get(`SELECT id,kind,display_name,status,metadata_json,revision,created_at,updated_at FROM actors WHERE id=?`, [actorId]);
    if (!row) throw notFound('actor');
    return actorView(row);
  }

  actors(principal, { includeSystem = false } = {}) {
    requirePrincipal(principal);
    const systemClause = includeSystem ? '' : "AND candidate.kind <> 'system'";
    const rows = this.db.query(`SELECT DISTINCT candidate.id,candidate.kind,candidate.display_name,candidate.status,candidate.metadata_json,candidate.revision,candidate.created_at,candidate.updated_at
      FROM actors candidate
      WHERE (candidate.id=? OR candidate.created_by_actor_id=? OR EXISTS (
        SELECT 1 FROM team_memberships viewer_tm
        JOIN teams viewer_team ON viewer_team.id=viewer_tm.team_id
        JOIN team_memberships candidate_tm ON candidate_tm.team_id=viewer_tm.team_id
        WHERE viewer_tm.actor_id=? AND viewer_tm.status='active' AND viewer_team.status='active'
          AND candidate_tm.actor_id=candidate.id AND candidate_tm.status IN ('active','suspended')
      )) ${systemClause}
      ORDER BY candidate.created_at,candidate.id`, [principal.actorId, principal.actorId, principal.actorId]);
    return rows.map(actorView);
  }

  setupState() {
    const actorCount = Number(this.db.get("SELECT count(*) AS count FROM actors WHERE kind <> 'system'")?.count || 0);
    return { needs_setup: actorCount === 0, actor_count: actorCount, bootstrap_actor_id: this.bootstrapActorId };
  }

  /** Atomically creates the first user, default team, owner membership and session. */
  setupComplete(input = {}, context = {}) {
    const displayName = requiredName(input.display_name || input.displayName || 'Local owner');
    const teamName = requiredName(input.team_name || input.teamName || `${displayName}'s Team`);
    this.#assertSafe({ display_name: displayName, team_name: teamName });
    const idempotencyKey = requireKey(context.idempotencyKey || input.idempotency_key || `setup-${opaqueId('key')}`);
    const requestHash = hashRequest({ display_name: displayName, team_name: teamName });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, this.bootstrapActorId, 'setup.complete', idempotencyKey, requestHash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const existing = tx.get("SELECT id FROM actors WHERE kind <> 'system' LIMIT 1");
      if (existing) throw new PlatformError('state_conflict', 'initial setup has already completed', { actor_id: existing.id }, 409);
      const actorId = opaqueId('actor_user');
      const teamId = opaqueId('team');
      const membershipId = opaqueId('membership');
      const sessionId = opaqueId('session');
      const proof = randomBytes(32).toString('base64url');
      const proofHash = this.#proofHash(proof);
      const metadata = { source: 'setup.complete' };
      const metadataJson = canonicalJson(metadata);
      tx.run(`INSERT INTO actors(id,kind,display_name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [actorId, 'user', displayName, 'active', metadataJson, sha256Hex(metadataJson), 1, now, now, this.bootstrapActorId, this.bootstrapActorId]);
      tx.run(`INSERT INTO teams(id,name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [teamId, teamName, 'active', '{}', sha256Hex('{}'), 1, now, now, actorId, actorId]);
      tx.run(`INSERT INTO team_memberships(id,team_id,actor_id,role,status,revision,invited_by_actor_id,accepted_by_actor_id,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [membershipId, teamId, actorId, 'owner', 'active', 1, actorId, actorId, now, now, actorId, actorId]);
      tx.run(`INSERT INTO sessions(id,subject_actor_id,effective_actor_id,proof_hash,expires_at,last_seen_at,revoked_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,NULL,1,?,?,?,?)`, [sessionId, actorId, actorId, proofHash, expiry(now, Number(input.ttl_seconds || 30 * 24 * 60 * 60)), now, now, now, actorId, actorId]);
      const operation = createInlineOperation(tx, { events: this.events, actorId, commandId: 'setup.complete', resourceType: 'actor', resourceId: actorId, requestHash, now });
      appendAggregate(tx, this.events, { aggregateType: 'actor', aggregateId: actorId, revision: 1, operationId: operation.id, actorId, type: 'actor.created', data: { actor_id: actorId, kind: 'user' }, payload: actorPayload({ id: actorId, kind: 'user', display_name: displayName, status: 'active', revision: 1 }), now });
      appendAggregate(tx, this.events, { aggregateType: 'team', aggregateId: teamId, revision: 1, operationId: operation.id, actorId, type: 'team.created', data: { team_id: teamId }, payload: { id: teamId, name: teamName, status: 'active', revision: 1 }, now });
      appendAggregate(tx, this.events, { aggregateType: 'team_membership', aggregateId: membershipId, revision: 1, operationId: operation.id, actorId, type: 'team.membership.granted', data: { membership_id: membershipId, team_id: teamId, actor_id: actorId, role: 'owner' }, payload: { id: membershipId, team_id: teamId, actor_id: actorId, role: 'owner', status: 'active', revision: 1 }, now });
      appendAggregate(tx, this.events, { aggregateType: 'session', aggregateId: sessionId, revision: 1, operationId: operation.id, actorId, type: 'session.created', data: { session_id: sessionId, subject_actor_id: actorId, effective_actor_id: actorId }, payload: { id: sessionId, subject_actor_id: actorId, effective_actor_id: actorId, expires_at: expiry(now, Number(input.ttl_seconds || 30 * 24 * 60 * 60)), revision: 1 }, now });
      appendAggregate(tx, this.events, { aggregateType: 'setup', aggregateId: 'setup', revision: 1, operationId: operation.id, actorId, type: 'setup.completed', data: { actor_id: actorId, team_id: teamId }, payload: { status: 'complete', actor_id: actorId, team_id: teamId, revision: 1 }, now });
      linkOperation(tx, operation.id, 'actor', actorId, now);
      linkOperation(tx, operation.id, 'team', teamId, now);
      linkOperation(tx, operation.id, 'team_membership', membershipId, now);
      linkOperation(tx, operation.id, 'session', sessionId, now);
      linkOperation(tx, operation.id, 'setup', 'setup', now);
      const response = { actor: this.#actorIn(tx, actorId), team: this.#teamIn(tx, teamId), membership: this.#membershipIn(tx, membershipId), session: { id: sessionId, subject_actor_id: actorId, effective_actor_id: actorId, expires_at: expiry(now, Number(input.ttl_seconds || 30 * 24 * 60 * 60)), revision: 1, proof } , operation: operationView(operation) };
      saveIdempotency(tx, this.bootstrapActorId, 'setup.complete', idempotencyKey, requestHash, withoutProof(response), operation.id, now);
      return response;
    });
  }

  authenticateProof(proof, { touch = true } = {}) {
    const value = String(proof || '');
    if (!/^[A-Za-z0-9_-]{40,200}$/.test(value)) throw new PlatformError('authentication_required', 'active session proof is required', {}, 401);
    const row = this.db.get(`SELECT s.*, subject.status AS subject_status, effective.status AS effective_status, effective.kind AS effective_kind, effective.revision AS effective_revision
      FROM sessions s JOIN actors subject ON subject.id=s.subject_actor_id JOIN actors effective ON effective.id=s.effective_actor_id
      WHERE s.proof_hash=?`, [this.#proofHash(value)]);
    if (!row) throw new PlatformError('session_invalid', 'session proof is invalid', {}, 401);
    const now = this.#time();
    if (row.revoked_at) throw new PlatformError('session_revoked', 'session is revoked', {}, 401);
    if (Date.parse(row.expires_at) <= Date.parse(now)) throw new PlatformError('session_expired', 'session has expired', {}, 401);
    if (row.subject_status !== 'active' || row.effective_status !== 'active') throw new PlatformError('account_disabled', 'session actor is unavailable', {}, 403);
    if (touch) this.db.run('UPDATE sessions SET last_seen_at=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revoked_at IS NULL', [now, now, row.subject_actor_id, row.id]);
    return Object.freeze({ actorId: row.effective_actor_id, effectiveActorId: row.effective_actor_id, subjectActorId: row.subject_actor_id, sessionId: row.id, scopes: ['*'], sessionRevision: Number(row.revision), actorRevision: Number(row.effective_revision || 1), kind: row.effective_kind, projectId: null, proof: undefined });
  }

  principalFromRequest(request) {
    const proof = extractProof(request);
    if (!proof) throw new PlatformError('authentication_required', 'active session proof is required', {}, 401);
    const principal = this.authenticateProof(proof);
    const requestedActorId = String(request?.headers?.['x-actor-id'] || '').trim();
    if (!requestedActorId || requestedActorId === principal.effectiveActorId) return principal;
    // The bootstrap system principal is an internal fixture identity, never a
    // delegation target. Treat a client-supplied reference to it as spoofed
    // metadata and keep the authenticated session principal.
    if (requestedActorId === this.bootstrapActorId) return principal;
    const delegationProof = String(request?.headers?.['x-service-credential'] || request?.headers?.['x-credential-proof'] || '').trim();
    if (!delegationProof) throw new PlatformError('permission_denied', 'actor delegation requires a service credential', {}, 403);
    const target = this.#requiredActor(requestedActorId);
    if (!['service', 'agent'].includes(target.kind)) throw new PlatformError('permission_denied', 'actor delegation cannot target a user', {}, 403);
    const credential = this.#findDelegationCredential(principal, delegationProof, target.id);
    if (!credential) throw new PlatformError('authentication_required', 'service credential is invalid', {}, 401);
    const managed = this.db.get(`SELECT 1 AS ok FROM team_memberships subject_tm
      JOIN teams team ON team.id=subject_tm.team_id AND team.status='active'
      JOIN team_memberships target_tm ON target_tm.team_id=subject_tm.team_id
      WHERE subject_tm.actor_id=? AND subject_tm.status='active' AND subject_tm.role IN ('owner','admin')
        AND target_tm.actor_id=? AND target_tm.status='active'`, [principal.subjectActorId, target.id]);
    if (!managed) throw new PlatformError('permission_denied', 'target actor is outside the managed team', {}, 403);
    const scope = parseCanonicalJson(credential.scope_json, {});
    const scopes = Array.isArray(scope.scopes) ? scope.scopes.map(String) : (Array.isArray(scope.actions) ? scope.actions.map(String) : ['*']);
    return Object.freeze({ ...principal, actorId: target.id, effectiveActorId: target.id, kind: target.kind, scopes: [...new Set(scopes)], delegatedByActorId: principal.subjectActorId, serviceCredentialId: credential.id });
  }

  session(id, principal = null) {
    const row = this.db.get(`SELECT id,subject_actor_id,effective_actor_id,expires_at,last_seen_at,revoked_at,revision,created_at,updated_at FROM sessions WHERE id=?`, [String(id)]);
    if (!row) throw notFound('session');
    if (principal && principal.subjectActorId !== row.subject_actor_id && principal.actorId !== this.bootstrapActorId) throw forbidden('session is outside actor scope');
    return sessionView(row, this.#time());
  }

  sessions(principal) {
    const actorId = String(principal?.subjectActorId || principal?.actorId || '');
    if (!actorId) throw new PlatformError('authentication_required', 'active session proof is required', {}, 401);
    return this.db.query(`SELECT id,subject_actor_id,effective_actor_id,expires_at,last_seen_at,revoked_at,revision,created_at,updated_at FROM sessions WHERE subject_actor_id=? ORDER BY created_at DESC,id`, [actorId]).map((row) => sessionView(row, this.#time()));
  }

  createSession({ subjectActorId, effectiveActorId = subjectActorId, ttlSeconds = 30 * 24 * 60 * 60, actorId = subjectActorId, idempotencyKey = null, expectedRevision = null } = {}) {
    const ttl = Number(ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 300 || ttl > 90 * 24 * 60 * 60) throw new PlatformError('schema_invalid', 'session ttl is invalid', {}, 422);
    const subject = this.#requiredActor(subjectActorId);
    const effective = this.#requiredActor(effectiveActorId);
    if (subject.kind !== 'user' && actorId !== this.bootstrapActorId) throw forbidden('only a user can create a session');
    const key = requireKey(idempotencyKey || `session-${opaqueId('key')}`);
    const hash = hashRequest({ subject_actor_id: subject.id, effective_actor_id: effective.id, ttl_seconds: ttl });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, actorId, 'session.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      if (expectedRevision != null && Number(expectedRevision) !== Number(subject.revision)) throw revisionConflict(expectedRevision, subject.revision);
      const id = opaqueId('session');
      const proof = randomBytes(32).toString('base64url');
      tx.run(`INSERT INTO sessions(id,subject_actor_id,effective_actor_id,proof_hash,expires_at,last_seen_at,revoked_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,NULL,1,?,?,?,?)`, [id, subject.id, effective.id, this.#proofHash(proof), expiry(now, ttl), now, now, now, actorId, actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId, commandId: 'session.create', resourceType: 'session', resourceId: id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'session', aggregateId: id, revision: 1, operationId: op.id, actorId, type: 'session.created', data: { session_id: id, subject_actor_id: subject.id, effective_actor_id: effective.id }, payload: { id, subject_actor_id: subject.id, effective_actor_id: effective.id, expires_at: expiry(now, ttl), revision: 1 }, now });
      linkOperation(tx, op.id, 'session', id, now);
      const response = { ...sessionView(tx.get('SELECT * FROM sessions WHERE id=?', [id]), now), proof, operation: operationView(op) };
      saveIdempotency(tx, actorId, 'session.create', key, hash, withoutProof(response), op.id, now);
      return response;
    });
  }

  revokeSession(id, { actorId, expectedRevision, idempotencyKey, reason = '' } = {}) {
    return this.#sessionMutation(id, { actorId, expectedRevision, idempotencyKey, commandId: 'session.revoke', eventType: 'session.revoked', mutate: (tx, row, now) => {
      tx.run(`UPDATE sessions SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=? WHERE id=? AND revision=?`, [now, now, String(id), Number(expectedRevision)], 1);
      return { reason: String(reason).slice(0, 200) };
    }});
  }

  actorSwitch({ sessionId, targetActorId, principal, expectedRevision, idempotencyKey } = {}) {
    const session = this.db.get('SELECT * FROM sessions WHERE id=?', [String(sessionId || principal?.sessionId || '')]);
    if (!session) throw notFound('session');
    if (!principal || principal.sessionId !== session.id) throw forbidden('session is outside actor scope');
    const target = this.#requiredActor(targetActorId);
    const returnsToSubject = target.kind === 'user' && target.id === principal.subjectActorId;
    if (!returnsToSubject && !['service', 'agent'].includes(target.kind)) throw new PlatformError('permission_denied', 'actor.switch cannot impersonate another user', {}, 403);
    if (!returnsToSubject) {
      const manages = this.db.get(`SELECT 1 AS ok FROM team_memberships subject_tm
        JOIN teams team ON team.id=subject_tm.team_id AND team.status='active'
        JOIN team_memberships target_tm ON target_tm.team_id=subject_tm.team_id
        WHERE subject_tm.actor_id=? AND subject_tm.status='active' AND subject_tm.role IN ('owner','admin') AND target_tm.actor_id=? AND target_tm.status='active'`, [principal.subjectActorId, target.id]);
      if (!manages) throw forbidden('target actor is outside the managed team');
    }
    const key = requireKey(idempotencyKey);
    const hash = hashRequest({ session_id: session.id, target_actor_id: target.id, expected_revision: Number(expectedRevision) });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.subjectActorId, 'actor.switch', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM sessions WHERE id=?', [session.id]);
      if (Number(current.revision) !== Number(expectedRevision)) throw revisionConflict(expectedRevision, current.revision);
      tx.run('UPDATE sessions SET effective_actor_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', [target.id, now, session.id, Number(expectedRevision)], 1);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.subjectActorId, commandId: 'actor.switch', resourceType: 'session', resourceId: session.id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'session', aggregateId: session.id, revision: Number(expectedRevision) + 1, operationId: op.id, actorId: principal.subjectActorId, type: 'actor.switched', data: { session_id: session.id, subject_actor_id: session.subject_actor_id, effective_actor_id: target.id }, payload: { id: session.id, subject_actor_id: session.subject_actor_id, effective_actor_id: target.id, revision: Number(expectedRevision) + 1 }, now });
      linkOperation(tx, op.id, 'session', session.id, now);
      const response = { ...sessionView(tx.get('SELECT * FROM sessions WHERE id=?', [session.id]), now), operation: operationView(op) };
      saveIdempotency(tx, principal.subjectActorId, 'actor.switch', key, hash, response, op.id, now);
      return response;
    });
  }

  createActor(input = {}, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'manage', null);
    const kind = String(input.kind || 'service');
    if (!ACTOR_KINDS.has(kind) || kind === 'user') throw new PlatformError('schema_invalid', 'actor kind is invalid', {}, 422);
    const displayName = requiredName(input.display_name || input.displayName);
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ kind, display_name: displayName });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'actor.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = opaqueId(`actor_${kind}`);
      const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
      this.#assertSafe({ display_name: displayName, metadata });
      const json = canonicalJson(metadata);
      tx.run(`INSERT INTO actors(id,kind,display_name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [id, kind, displayName, 'active', json, sha256Hex(json), 1, now, now, principal.actorId, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'actor.create', resourceType: 'actor', resourceId: id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'actor', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, type: 'actor.created', data: { actor_id: id, kind }, payload: { id, kind, display_name: displayName, status: 'active', revision: 1 }, now });
      linkOperation(tx, op.id, 'actor', id, now);
      const response = { actor: actorView(tx.get('SELECT * FROM actors WHERE id=?', [id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'actor.create', key, hash, response, op.id, now);
      return response;
    });
  }

  updateActor(actorId, input = {}, principal, commandId = 'actor.update') {
    requirePrincipal(principal);
    const target = this.#requiredActor(actorId);
    if (target.kind === 'system') throw forbidden('system actor is immutable');
    if (principal.actorId !== target.id) this.#assertActorManage(target, principal);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const displayName = requiredName(input.display_name || target.display_name);
    this.#assertSafe({ display_name: displayName });
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ actor_id: target.id, display_name: displayName, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, commandId, key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM actors WHERE id=?', [target.id]);
      if (Number(current.revision) !== expected) throw revisionConflict(expected, current.revision);
      tx.run(`UPDATE actors SET display_name=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [displayName, now, principal.actorId, target.id, expected], 1);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId, resourceType: 'actor', resourceId: target.id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'actor', aggregateId: target.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, type: 'actor.updated', data: { actor_id: target.id, revision: expected + 1 }, payload: { id: target.id, display_name: displayName, status: current.status, revision: expected + 1 }, now });
      linkOperation(tx, op.id, 'actor', target.id, now);
      const response = { actor: actorView(tx.get('SELECT * FROM actors WHERE id=?', [target.id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, commandId, key, hash, response, op.id, now);
      return response;
    });
  }

  setActorStatus(actorId, status, input = {}, principal) {
    requirePrincipal(principal);
    const target = this.#requiredActor(actorId);
    if (target.kind === 'system') throw forbidden('system actor is immutable');
    if (principal.actorId !== target.id) this.#assertActorManage(target, principal);
    if (!ACTOR_STATES.has(status) || !ACTOR_TRANSITIONS[target.status]?.has(status)) throw new PlatformError('state_conflict', 'actor status transition is invalid', {}, 409);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ actor_id: target.id, status, expected_revision: expected });
    const commandId = { active: 'actor.activate', suspended: 'actor.suspend', revoked: 'actor.revoke' }[status];
    const eventType = { active: 'actor.activated', suspended: 'actor.suspended', revoked: 'actor.revoked' }[status];
    return this.#simpleActorMutation({ target, status, expected, key, hash, principal, commandId, eventType });
  }

  createTeam(input = {}, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'write', null);
    const name = requiredName(input.name);
    this.#assertSafe({ name });
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ name });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'team.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = opaqueId('team');
      tx.run(`INSERT INTO teams(id,name,status,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, [id, name, 'active', '{}', sha256Hex('{}'), 1, now, now, principal.actorId, principal.actorId]);
      const membershipId = opaqueId('membership');
      tx.run(`INSERT INTO team_memberships(id,team_id,actor_id,role,status,revision,invited_by_actor_id,accepted_by_actor_id,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [membershipId, id, principal.actorId, 'owner', 'active', 1, principal.actorId, principal.actorId, now, now, principal.actorId, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'team.create', resourceType: 'team', resourceId: id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'team', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, type: 'team.created', data: { team_id: id }, payload: { id, name, status: 'active', revision: 1 }, now });
      appendAggregate(tx, this.events, { aggregateType: 'team_membership', aggregateId: membershipId, revision: 1, operationId: op.id, actorId: principal.actorId, type: 'team.membership.granted', data: { membership_id: membershipId, team_id: id, actor_id: principal.actorId, role: 'owner' }, payload: { id: membershipId, team_id: id, actor_id: principal.actorId, role: 'owner', status: 'active', revision: 1 }, now });
      linkOperation(tx, op.id, 'team', id, now);
      linkOperation(tx, op.id, 'team_membership', membershipId, now);
      const response = { team: this.#teamIn(tx, id), membership: this.#membershipIn(tx, membershipId), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'team.create', key, hash, response, op.id, now);
      return response;
    });
  }

  teams(principal) {
    requirePrincipal(principal);
    return this.db.query(`SELECT t.* FROM teams t JOIN team_memberships tm ON tm.team_id=t.id WHERE tm.actor_id=? AND tm.status IN ('active','suspended') ORDER BY t.created_at,t.id`, [principal.actorId]).map(teamView);
  }

  team(teamId, principal) {
    requirePrincipal(principal);
    const row = this.db.get('SELECT * FROM teams WHERE id=?', [String(teamId)]);
    if (!row) throw notFound('team');
    if (!this.db.get("SELECT 1 AS ok FROM team_memberships WHERE team_id=? AND actor_id=? AND status IN ('active','suspended')", [teamId, principal.actorId])) throw forbidden('team is outside actor scope');
    return teamView(row);
  }

  setTeamStatus(teamId, status, input = {}, principal) {
    requirePrincipal(principal);
    this.#assertTeamManage(teamId, principal, { allowSuspended: true });
    const current = this.db.get('SELECT * FROM teams WHERE id=?', [String(teamId)]);
    if (!current) throw notFound('team');
    if (!TEAM_STATES.has(status) || !TEAM_TRANSITIONS[current.status]?.has(status)) throw new PlatformError('state_conflict', 'team status transition is invalid', {}, 409);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ team_id: current.id, status, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'team.status', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const row = tx.get('SELECT * FROM teams WHERE id=?', [current.id]);
      if (Number(row.revision) !== expected) throw revisionConflict(expected, row.revision);
      tx.run('UPDATE teams SET status=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, now, principal.actorId, row.id, expected], 1);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'team.status', resourceType: 'team', resourceId: row.id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'team', aggregateId: row.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, type: `team.${status}`, data: { team_id: row.id, status }, payload: { id: row.id, name: row.name, status, revision: expected + 1 }, now });
      linkOperation(tx, op.id, 'team', row.id, now);
      const response = { team: teamView(tx.get('SELECT * FROM teams WHERE id=?', [row.id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'team.status', key, hash, response, op.id, now);
      return response;
    });
  }

  memberships(teamId, principal) {
    requirePrincipal(principal);
    this.team(teamId, principal);
    return this.db.query(`SELECT tm.*,a.kind,a.display_name,a.status AS actor_status FROM team_memberships tm JOIN actors a ON a.id=tm.actor_id WHERE tm.team_id=? ORDER BY tm.created_at,tm.id`, [String(teamId)]).map(membershipView);
  }

  grantMembership(teamId, input = {}, principal) {
    requirePrincipal(principal);
    const manager = this.#assertTeamManage(teamId, principal);
    const actor = this.#requiredActor(input.actor_id || input.actorId);
    const role = String(input.role || 'member');
    if (!TEAM_ROLES.includes(role)) throw new PlatformError('schema_invalid', 'team role is invalid', {}, 422);
    if (role === 'owner' && manager.role !== 'owner') throw forbidden('only an owner can grant the owner role');
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ team_id: String(teamId), actor_id: actor.id, role });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'team.member.grant', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM team_memberships WHERE team_id=? AND actor_id=?', [String(teamId), actor.id]);
      if (current?.role === 'owner' && manager.role !== 'owner') throw forbidden('only an owner can manage an owner membership');
      if (current && ['revoked', 'expired'].includes(current.status)) throw new PlatformError('state_conflict', 'terminal membership cannot be reactivated', { status: current.status }, 409);
      const id = current?.id || opaqueId('membership');
      const revision = Number(current?.revision || 0) + 1;
      if (current) tx.run(`UPDATE team_memberships SET role=?,status='active',revision=?,updated_at=?,updated_by_actor_id=?,invited_by_actor_id=? WHERE id=?`, [role, revision, now, principal.actorId, principal.actorId, id]);
      else tx.run(`INSERT INTO team_memberships(id,team_id,actor_id,role,status,revision,invited_by_actor_id,accepted_by_actor_id,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [id, teamId, actor.id, role, 'active', revision, principal.actorId, principal.actorId, now, now, principal.actorId, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'team.member.grant', resourceType: 'team_membership', resourceId: id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'team_membership', aggregateId: id, revision, operationId: op.id, actorId: principal.actorId, type: 'team.membership.granted', data: { membership_id: id, team_id: teamId, actor_id: actor.id, role, status: 'active' }, payload: { id, team_id: teamId, actor_id: actor.id, role, status: 'active', revision }, now });
      linkOperation(tx, op.id, 'team_membership', id, now);
      const response = { membership: membershipView(tx.get('SELECT tm.*,a.kind,a.display_name,a.status AS actor_status FROM team_memberships tm JOIN actors a ON a.id=tm.actor_id WHERE tm.id=?', [id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'team.member.grant', key, hash, response, op.id, now);
      return response;
    });
  }

  setMembershipStatus(membershipId, status, input = {}, principal) {
    requirePrincipal(principal);
    const row = this.db.get('SELECT * FROM team_memberships WHERE id=?', [String(membershipId)]);
    if (!row) throw notFound('membership');
    const manager = this.#assertTeamManage(row.team_id, principal);
    if (row.role === 'owner' && manager.role !== 'owner') throw forbidden('only an owner can manage an owner membership');
    if (!MEMBERSHIP_STATES.has(status) || !TEAM_MEMBERSHIP_TRANSITIONS[row.status]?.has(status)) throw new PlatformError('state_conflict', 'membership transition is invalid', {}, 409);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ membership_id: row.id, status, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'team.member.status', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM team_memberships WHERE id=?', [row.id]);
      if (Number(current.revision) !== expected) throw revisionConflict(expected, current.revision);
      if (current.role === 'owner' && current.status === 'active' && status !== 'active') this.#assertAnotherTeamOwner(tx, current.team_id, current.id);
      tx.run('UPDATE team_memberships SET status=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, now, principal.actorId, row.id, expected], 1);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'team.member.status', resourceType: 'team_membership', resourceId: row.id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'team_membership', aggregateId: row.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, type: `team.membership.${status}`, data: { membership_id: row.id, status }, payload: { id: row.id, team_id: row.team_id, actor_id: row.actor_id, role: row.role, status, revision: expected + 1 }, now });
      linkOperation(tx, op.id, 'team_membership', row.id, now);
      const response = { membership: membershipView(tx.get('SELECT tm.*,a.kind,a.display_name,a.status AS actor_status FROM team_memberships tm JOIN actors a ON a.id=tm.actor_id WHERE tm.id=?', [row.id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'team.member.status', key, hash, response, op.id, now);
      return response;
    });
  }

  grantProjectMembership(projectId, input = {}, principal) {
    requirePrincipal(principal);
    this.#assertProjectReference(projectId);
    const actor = this.#requiredActor(input.actor_id || input.actorId);
    const role = String(input.role || 'viewer');
    if (!PROJECT_ROLES.includes(role)) throw new PlatformError('schema_invalid', 'project role is invalid', {}, 422);
    const projectHasMembers = Boolean(this.db.get('SELECT 1 AS ok FROM project_memberships WHERE project_id=? AND status=\'active\' LIMIT 1', [String(projectId)]));
    const teamManager = Boolean(this.db.get("SELECT 1 AS ok FROM team_memberships WHERE actor_id=? AND status='active' AND role IN ('owner','admin') LIMIT 1", [principal.actorId]));
    if (projectHasMembers) {
      this.authorization.assert(principal, 'member.manage', projectId);
      const managerRole = this.#projectRole(projectId, principal.actorId);
      if (role === 'owner' && managerRole !== 'owner') throw forbidden('only a project owner can grant the owner role');
    }
    else if (!teamManager || actor.id !== principal.actorId || role !== 'owner') throw forbidden('first project membership must bind the team owner');
    const key = requireKey(input.idempotency_key);
    const expected = input.expected_revision == null ? null : nonNegativeRevision(input.expected_revision);
    const hash = hashRequest({ project_id: String(projectId), actor_id: actor.id, role, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'membership.grant', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM project_memberships WHERE project_id=? AND actor_id=?', [String(projectId), actor.id]);
      if (current && ['revoked', 'expired'].includes(current.status)) throw new PlatformError('state_conflict', 'terminal project membership cannot be reactivated', { status: current.status }, 409);
      if (current?.role === 'owner' && projectHasMembers && this.#projectRole(projectId, principal.actorId) !== 'owner') throw forbidden('only a project owner can manage an owner membership');
      if (expected != null && Number(current?.revision || 0) !== expected) throw revisionConflict(expected, current?.revision || 0);
      const id = current?.id || opaqueId('project_membership');
      const revision = Number(current?.revision || 0) + 1;
      if (current) tx.run('UPDATE project_memberships SET role=?,status=\'active\',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=?', [role, revision, now, principal.actorId, id]);
      else tx.run(`INSERT INTO project_memberships(id,project_id,actor_id,role,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, [id, String(projectId), actor.id, role, 'active', revision, now, now, principal.actorId, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'membership.grant', resourceType: 'project_membership', resourceId: id, projectId, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'project_membership', aggregateId: id, revision, operationId: op.id, actorId: principal.actorId, projectId, type: 'membership.granted', data: { membership_id: id, project_id: String(projectId), actor_id: actor.id, role }, payload: { id, project_id: String(projectId), actor_id: actor.id, role, status: 'active', revision }, now });
      linkOperation(tx, op.id, 'project_membership', id, now);
      const response = { membership: projectMembershipView(tx.get('SELECT pm.*,a.kind,a.display_name FROM project_memberships pm JOIN actors a ON a.id=pm.actor_id WHERE pm.id=?', [id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'membership.grant', key, hash, response, op.id, now);
      return response;
    });
  }

  projectMembers(projectId, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'read', projectId);
    return this.db.query(`SELECT pm.*,a.kind,a.display_name FROM project_memberships pm JOIN actors a ON a.id=pm.actor_id WHERE pm.project_id=? ORDER BY pm.created_at,pm.id`, [String(projectId)]).map(projectMembershipView);
  }

  projectInvitations(projectId, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'read', projectId);
    return this.db.query('SELECT * FROM project_invitations WHERE project_id=? ORDER BY created_at,id', [String(projectId)]).map(invitationView);
  }

  createProjectInvitation(projectId, input = {}, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'member.manage', projectId);
    const role = String(input.role || 'viewer');
    if (!PROJECT_ROLES.includes(role)) throw new PlatformError('schema_invalid', 'project role is invalid', {}, 422);
    const inviteeActorId = input.invitee_actor_id || input.actor_id || null;
    const inviteeRef = String(input.invitee_ref || '');
    if (!inviteeActorId && !inviteeRef) throw new PlatformError('schema_invalid', 'invitation target is required', {}, 422);
    if (inviteeActorId) this.#requiredActor(inviteeActorId);
    this.#assertSafe({ invitee_ref: inviteeRef });
    if (inviteeActorId && this.db.get("SELECT 1 AS ok FROM project_memberships WHERE project_id=? AND actor_id=? AND status IN ('active','suspended')", [String(projectId), String(inviteeActorId)])) throw new PlatformError('state_conflict', 'actor is already a project member', {}, 409);
    if (role === 'owner' && this.#projectRole(projectId, principal.actorId) !== 'owner') throw forbidden('only a project owner can invite an owner');
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ project_id: String(projectId), invitee_actor_id: inviteeActorId, invitee_ref: inviteeRef, role, expires_at: input.expires_at || null });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'invitation.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = opaqueId('invitation');
      tx.run(`INSERT INTO project_invitations(id,project_id,invitee_actor_id,invitee_ref,role,status,expires_at,revision,created_at,updated_at,created_by_actor_id,accepted_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,'pending',?,1,?,?,?,NULL,?)`, [id, String(projectId), inviteeActorId, inviteeRef, role, input.expires_at || null, now, now, principal.actorId, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'invitation.create', resourceType: 'project_invitation', resourceId: id, projectId, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'project_invitation', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, projectId, type: 'invitation.created', data: { invitation_id: id, project_id: String(projectId), role }, payload: { id, project_id: String(projectId), invitee_actor_id: inviteeActorId, invitee_ref: inviteeRef, role, status: 'pending', revision: 1 }, now });
      linkOperation(tx, op.id, 'project_invitation', id, now);
      const response = { invitation: invitationView(tx.get('SELECT * FROM project_invitations WHERE id=?', [id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'invitation.create', key, hash, response, op.id, now);
      return response;
    });
  }

  acceptProjectInvitation(projectId, invitationId, input = {}, principal) {
    requirePrincipal(principal);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const hash = hashRequest({ project_id: String(projectId), invitation_id: String(invitationId), expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const row = tx.get('SELECT * FROM project_invitations WHERE id=? AND project_id=?', [String(invitationId), String(projectId)]);
      if (!row) throw notFound('invitation');
      if (!row.invitee_actor_id || row.invitee_actor_id !== principal.actorId) throw forbidden('invitation is outside actor scope');
      if (row.status !== 'pending' || (row.expires_at && Date.parse(row.expires_at) <= Date.parse(now))) throw new PlatformError('state_conflict', 'invitation is not active', { status: row.status }, 409);
      const prior = getIdempotency(tx, principal.actorId, 'invitation.accept', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      if (Number(row.revision) !== expected) throw revisionConflict(expected, row.revision);
      tx.run("UPDATE project_invitations SET status='accepted',accepted_by_actor_id=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [principal.actorId, now, principal.actorId, row.id, expected], 1);
      const existing = tx.get('SELECT * FROM project_memberships WHERE project_id=? AND actor_id=?', [String(projectId), principal.actorId]);
      if (existing) throw new PlatformError('state_conflict', 'actor is already a project member', {}, 409);
      const membershipId = opaqueId('project_membership');
      tx.run(`INSERT INTO project_memberships(id,project_id,actor_id,role,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,'active',1,?,?,?,?)`, [membershipId, String(projectId), principal.actorId, row.role, now, now, row.created_by_actor_id, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'invitation.accept', resourceType: 'project_invitation', resourceId: row.id, projectId, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'project_invitation', aggregateId: row.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, projectId, type: 'invitation.accepted', data: { invitation_id: row.id, actor_id: principal.actorId }, payload: { id: row.id, project_id: String(projectId), role: row.role, status: 'accepted', revision: expected + 1 }, now });
      appendAggregate(tx, this.events, { aggregateType: 'project_membership', aggregateId: membershipId, revision: 1, operationId: op.id, actorId: principal.actorId, projectId, type: 'membership.granted', data: { membership_id: membershipId, project_id: String(projectId), actor_id: principal.actorId, role: row.role }, payload: { id: membershipId, project_id: String(projectId), actor_id: principal.actorId, role: row.role, status: 'active', revision: 1 }, now });
      linkOperation(tx, op.id, 'project_invitation', row.id, now);
      linkOperation(tx, op.id, 'project_membership', membershipId, now);
      const response = { invitation: invitationView(tx.get('SELECT * FROM project_invitations WHERE id=?', [row.id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'invitation.accept', key, hash, response, op.id, now);
      return response;
    });
  }

  revokeProjectInvitation(projectId, invitationId, input = {}, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'member.manage', projectId);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const key = requireKey(input.idempotency_key);
    const now = this.#time();
    const hash = hashRequest({ project_id: String(projectId), invitation_id: String(invitationId), expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const row = tx.get('SELECT * FROM project_invitations WHERE id=? AND project_id=?', [String(invitationId), String(projectId)]);
      if (!row) throw notFound('invitation');
      const prior = getIdempotency(tx, principal.actorId, 'invitation.revoke', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      if (Number(row.revision) !== expected) throw revisionConflict(expected, row.revision);
      if (row.status !== 'pending') throw new PlatformError('state_conflict', 'invitation is not active', { status: row.status }, 409);
      tx.run("UPDATE project_invitations SET status='revoked',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, principal.actorId, row.id, expected], 1);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'invitation.revoke', resourceType: 'project_invitation', resourceId: row.id, projectId, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'project_invitation', aggregateId: row.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, projectId, type: 'invitation.revoked', data: { invitation_id: row.id }, payload: { id: row.id, project_id: String(projectId), role: row.role, status: 'revoked', revision: expected + 1 }, now });
      linkOperation(tx, op.id, 'project_invitation', row.id, now);
      const response = { invitation: invitationView(tx.get('SELECT * FROM project_invitations WHERE id=?', [row.id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'invitation.revoke', key, hash, response, op.id, now);
      return response;
    });
  }

  setProjectMembershipStatus(projectId, membershipId, status, input = {}, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'member.manage', projectId);
    if (!PROJECT_MEMBERSHIP_TRANSITIONS[String(this.db.get('SELECT status FROM project_memberships WHERE id=? AND project_id=?', [String(membershipId), String(projectId)])?.status || '')]?.has(String(status))) throw new PlatformError('state_conflict', 'project membership transition is invalid', {}, 409);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ project_id: String(projectId), membership_id: String(membershipId), status, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM project_memberships WHERE id=? AND project_id=?', [String(membershipId), String(projectId)]);
      if (!current) throw notFound('project membership');
      const prior = getIdempotency(tx, principal.actorId, 'membership.status', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      if (Number(current.revision) !== expected) throw revisionConflict(expected, current.revision);
      const managerRole = this.#projectRole(projectId, principal.actorId);
      if (current.role === 'owner' && managerRole !== 'owner') throw forbidden('only a project owner can manage an owner membership');
      if (current.role === 'owner' && current.status === 'active' && status !== 'active') this.#assertAnotherProjectOwner(tx, projectId, current.id);
      tx.run('UPDATE project_memberships SET status=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [String(status), now, principal.actorId, current.id, expected], 1);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'membership.status', resourceType: 'project_membership', resourceId: current.id, projectId, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'project_membership', aggregateId: current.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, projectId, type: `membership.${status}`, data: { membership_id: current.id, status: String(status) }, payload: { id: current.id, project_id: String(projectId), actor_id: current.actor_id, role: current.role, status: String(status), revision: expected + 1 }, now });
      linkOperation(tx, op.id, 'project_membership', current.id, now);
      const response = { membership: projectMembershipView(tx.get('SELECT pm.*,a.kind,a.display_name FROM project_memberships pm JOIN actors a ON a.id=pm.actor_id WHERE pm.id=?', [current.id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'membership.status', key, hash, response, op.id, now);
      return response;
    });
  }

  aclEntries(projectId, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'read', projectId);
    return this.db.query('SELECT * FROM project_acl_entries WHERE project_id=? ORDER BY created_at,id', [String(projectId)]).map(aclView);
  }

  setAclEntry(projectId, input = {}, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'acl.manage', projectId);
    const effect = String(input.effect || 'allow');
    if (!['allow', 'deny'].includes(effect)) throw new PlatformError('schema_invalid', 'ACL effect is invalid', {}, 422);
    const action = String(input.action || 'read');
    const actorId = input.principal_actor_id || input.actor_id || null;
    const teamId = input.principal_team_id || input.team_id || null;
    if ((actorId == null) === (teamId == null)) throw new PlatformError('schema_invalid', 'exactly one ACL principal is required', {}, 422);
    this.#assertSafe({ action, resource: String(input.resource || '*') });
    const key = requireKey(input.idempotency_key);
    const expected = input.expected_revision == null ? null : nonNegativeRevision(input.expected_revision);
    const hash = hashRequest({ project_id: String(projectId), actor_id: actorId, team_id: teamId, action, effect, resource: input.resource || '*', expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'acl.set', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = String(input.id || opaqueId('acl'));
      const current = tx.get('SELECT * FROM project_acl_entries WHERE id=? AND project_id=?', [id, String(projectId)]);
      if (!current && input.id && tx.get('SELECT id FROM project_acl_entries WHERE id=?', [id])) throw forbidden('ACL entry is outside project scope');
      const policyHead = tx.get("SELECT current_revision FROM aggregate_heads WHERE aggregate_type='project_policy' AND aggregate_id=?", [String(projectId)]);
      const policyRevisionBefore = Number(policyHead?.current_revision || 0);
      const revisionBefore = current ? Number(current.revision) : policyRevisionBefore;
      if (expected != null && revisionBefore !== expected) throw revisionConflict(expected, revisionBefore);
      const revision = Number(current?.revision || 0) + 1;
      const policyRevision = Number(policyHead?.current_revision || 0) + 1;
      if (current) tx.run(`UPDATE project_acl_entries SET principal_actor_id=?,principal_team_id=?,resource=?,action=?,effect=?,policy_revision=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [actorId, teamId, String(input.resource || '*'), action, effect, policyRevision, revision, now, principal.actorId, id, expected ?? current.revision], 1);
      else tx.run(`INSERT INTO project_acl_entries(id,project_id,principal_actor_id,principal_team_id,resource,action,effect,policy_revision,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, String(projectId), actorId, teamId, String(input.resource || '*'), action, effect, policyRevision, revision, now, now, principal.actorId, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'acl.set', resourceType: 'project_acl', resourceId: id, projectId, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'project_acl', aggregateId: id, revision, operationId: op.id, actorId: principal.actorId, projectId, type: effect === 'deny' ? 'acl.denied' : 'acl.allowed', data: { acl_id: id, action, effect, policy_revision: policyRevision }, payload: { id, project_id: String(projectId), action, effect, resource: String(input.resource || '*'), policy_revision: policyRevision, revision }, now });
      appendAggregate(tx, this.events, { aggregateType: 'project_policy', aggregateId: String(projectId), revision: policyRevision, operationId: op.id, actorId: principal.actorId, projectId, type: 'acl.policy.updated', data: { acl_id: id, action, effect, policy_revision: policyRevision }, payload: { project_id: String(projectId), policy_revision: policyRevision, changed_entry_id: id }, now });
      linkOperation(tx, op.id, 'project_acl', id, now);
      linkOperation(tx, op.id, 'project_policy', String(projectId), now);
      const response = { entry: aclView(tx.get('SELECT * FROM project_acl_entries WHERE id=?', [id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'acl.set', key, hash, response, op.id, now);
      return response;
    });
  }

  async createCredential(input = {}, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'credential.manage', null);
    const provider = String(input.provider || '');
    if (!['codex', 'github', 'mcp'].includes(provider)) throw new PlatformError('schema_invalid', 'credential provider is invalid', {}, 422);
    const externalRef = String(input.external_ref || input.externalRef || opaqueId('external'));
    const scope = input.scope && typeof input.scope === 'object' ? input.scope : {};
    const metadata = { origin: input.origin || 'clean', external_ref: externalRef };
    this.#assertSafe({ provider, scope, external_ref: externalRef, origin: metadata.origin });
    const id = opaqueId('credential');
    const now = this.#time();
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ provider, external_ref: externalRef, scope });
    const response = await this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'credential.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const scopeJson = canonicalJson(scope);
      const metadataJson = canonicalJson(metadata);
      tx.run(`INSERT INTO credential_refs(id,owner_actor_id,provider,scope_json,status,external_ref,metadata_json,metadata_sha256,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, principal.actorId, provider, scopeJson, 'rebind_required', externalRef, metadataJson, sha256Hex(metadataJson), 1, now, now, principal.actorId, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'credential.create', resourceType: 'credential', resourceId: id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'credential', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, type: 'credential.created', data: { credential_id: id, provider, status: 'rebind_required' }, payload: { id, provider, scope, status: 'rebind_required', external_ref: externalRef, revision: 1 }, now });
      linkOperation(tx, op.id, 'credential', id, now);
      const result = { credential: credentialView(tx.get('SELECT * FROM credential_refs WHERE id=?', [id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'credential.create', key, hash, result, op.id, now);
      return result;
    });
    return response;
  }

  credentials(principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'read', null);
    return this.db.query('SELECT * FROM credential_refs WHERE owner_actor_id=? ORDER BY created_at,id', [principal.actorId]).map(credentialView);
  }

  profiles(principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'read', null);
    return this.db.query('SELECT * FROM provider_profiles WHERE owner_actor_id=? ORDER BY created_at,id', [principal.actorId]).map(profileView);
  }

  async recoverPending() {
    const rows = this.db.query(`SELECT id,status,revision,command_id,resource_type,resource_id FROM operations
      WHERE command_id IN ('credential.rebind','credential.rotate','profile.probe') AND status IN ('accepted','queued','running') ORDER BY created_at,id`);
    const recovered = [];
    for (const row of rows) {
      const now = this.#time();
      const receipt = await this.db.withTransaction((tx) => {
        const currentOperation = tx.get('SELECT * FROM operations WHERE id=?', [row.id]);
        const terminal = this.#failOperationInTransaction(tx, currentOperation, 'external_result_unknown', now);
        if (row.resource_type === 'credential') {
          const resource = tx.get("SELECT * FROM credential_refs WHERE id=? AND status='pending'", [row.resource_id]);
          if (resource) {
            const revision = Number(resource.revision) + 1;
            tx.run("UPDATE credential_refs SET status='failed',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [revision, now, currentOperation.actor_id, resource.id, resource.revision], 1);
            appendAggregate(tx, this.events, { aggregateType: 'credential', aggregateId: resource.id, revision, operationId: row.id, actorId: currentOperation.actor_id, type: 'credential.failed', data: { credential_id: resource.id, status: 'failed', error_code: 'external_result_unknown', retryable: true }, payload: { id: resource.id, provider: resource.provider, status: 'failed', external_ref: resource.external_ref, revision }, now });
          }
        }
        if (row.resource_type === 'profile') {
          const resource = tx.get("SELECT * FROM provider_profiles WHERE id=? AND status='probing'", [row.resource_id]);
          if (resource) {
            const revision = Number(resource.revision) + 1;
            tx.run("UPDATE provider_profiles SET status='unavailable',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [revision, now, currentOperation.actor_id, resource.id, resource.revision], 1);
            appendAggregate(tx, this.events, { aggregateType: 'profile', aggregateId: resource.id, revision, operationId: row.id, actorId: currentOperation.actor_id, type: 'profile.probe.failed', data: { profile_id: resource.id, status: 'unavailable', error_code: 'external_result_unknown', retryable: true }, payload: { id: resource.id, provider: resource.provider, status: 'unavailable', revision }, now });
          }
        }
        return terminal;
      });
      recovered.push(receipt.operation_id || receipt.id);
    }
    return recovered;
  }

  createProfile(input = {}, principal) {
    requirePrincipal(principal);
    this.authorization.assert(principal, 'credential.manage', null);
    const provider = String(input.provider || '');
    if (!['codex', 'github', 'mcp'].includes(provider)) throw new PlatformError('schema_invalid', 'profile provider is invalid', {}, 422);
    const label = requiredName(input.label || `${provider} profile`);
    const config = input.config && typeof input.config === 'object' ? input.config : {};
    this.#assertSafe({ provider, label, config });
    const credentialRef = input.credential_ref_id || input.credential_id || null;
    const credential = credentialRef ? this.db.get('SELECT id,status FROM credential_refs WHERE id=? AND owner_actor_id=?', [credentialRef, principal.actorId]) : null;
    if (credentialRef && !credential) throw notFound('credential');
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ provider, label, config, credential_ref_id: credentialRef });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'profile.create', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const id = opaqueId('profile');
      const configJson = canonicalJson(config);
      const initialStatus = credentialRef && credential?.status !== 'active' ? 'rebind_required' : 'unprobed';
      tx.run(`INSERT INTO provider_profiles(id,owner_actor_id,provider,label,credential_ref_id,config_json,config_sha256,status,last_probe_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, principal.actorId, provider, label, credentialRef, configJson, sha256Hex(configJson), initialStatus, null, 1, now, now, principal.actorId, principal.actorId]);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'profile.create', resourceType: 'profile', resourceId: id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'profile', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, type: 'profile.created', data: { profile_id: id, provider }, payload: { id, provider, label, status: initialStatus, revision: 1 }, now });
      linkOperation(tx, op.id, 'profile', id, now);
      const response = { profile: profileView(tx.get('SELECT * FROM provider_profiles WHERE id=?', [id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'profile.create', key, hash, response, op.id, now);
      return response;
    });
  }

  async rebindCredential(credentialId, input = {}, principal) {
    return this.#bindCredential(credentialId, input, principal, 'credential.rebind', 'credential.rebound');
  }

  rotateCredential(credentialId, input = {}, principal) {
    return this.#bindCredential(credentialId, input, principal, 'credential.rotate', 'credential.rotated');
  }

  async #bindCredential(credentialId, input, principal, commandId, eventType) {
    requirePrincipal(principal);
    const row = this.db.get('SELECT * FROM credential_refs WHERE id=? AND owner_actor_id=?', [String(credentialId), principal.actorId]);
    if (!row) throw notFound('credential');
    const key = requireKey(input.idempotency_key);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const proof = input.proof == null ? '' : String(input.proof);
    if (!proof || proof.length > 4096) throw new PlatformError('schema_invalid', 'credential proof is invalid', {}, 422);
    const allowedStates = commandId === 'credential.rotate' ? new Set(['active']) : new Set(['rebind_required', 'failed']);
    const hash = hashRequest({ credential_id: row.id, expected_revision: expected, proof_fingerprint: this.#proofHash(proof) });
    if (!this.operations) throw new PlatformError('internal_error', 'operation service is unavailable', {}, 503);
    const pending = await this.db.withTransaction((tx) => {
      const now = this.#time();
      const op = this.operations.createInTransaction(tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, request: { credential_id: row.id, expected_revision: expected }, resourceType: 'credential', resourceId: row.id }, now);
      if (op.replayed) return { operation: op, replayed: true };
      const current = tx.get('SELECT * FROM credential_refs WHERE id=? AND owner_actor_id=?', [row.id, principal.actorId]);
      if (Number(current.revision) !== expected) throw revisionConflict(expected, current.revision);
      if (!allowedStates.has(current.status)) throw new PlatformError('state_conflict', 'credential state does not allow this command', { status: current.status, command_id: commandId }, 409);
      const revision = expected + 1;
      tx.run("UPDATE credential_refs SET status='pending',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [revision, now, principal.actorId, row.id, expected], 1);
      appendAggregate(tx, this.events, { aggregateType: 'credential', aggregateId: row.id, revision, operationId: op.operation_id, actorId: principal.actorId, type: `${commandId}.queued`, data: { credential_id: row.id, status: 'pending' }, payload: { id: row.id, provider: row.provider, status: 'pending', external_ref: row.external_ref, revision }, now });
      linkOperation(tx, op.operation_id, 'credential', row.id, now);
      return { operation: op, replayed: false, revision };
    });
    if (pending.replayed) return pending.operation;
    const op = pending.operation;
    let vaultRef = null;
    try {
      await this.operations.queue(op.operation_id, { actorId: principal.actorId, expectedRevision: op.revision });
      await this.operations.start(op.operation_id, { actorId: principal.actorId, expectedRevision: op.revision + 1 });
      if (!this.vault) throw new PlatformError('vault_unavailable', 'credential vault is unavailable', {}, 503);
      vaultRef = this.vault.put(`${row.id}.v${pending.revision + 1}`, proof).external_ref;
      const receipt = await this.db.withTransaction((tx) => {
        const now = this.#time();
        const current = tx.get('SELECT * FROM credential_refs WHERE id=?', [row.id]);
        if (Number(current.revision) !== pending.revision || current.status !== 'pending') throw revisionConflict(pending.revision, current.revision);
        const revision = pending.revision + 1;
        tx.run("UPDATE credential_refs SET status='active',external_ref=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [vaultRef, revision, now, principal.actorId, row.id, pending.revision], 1);
        appendAggregate(tx, this.events, { aggregateType: 'credential', aggregateId: row.id, revision, operationId: op.operation_id, actorId: principal.actorId, type: eventType, data: { credential_id: row.id, status: 'active' }, payload: { id: row.id, provider: row.provider, status: 'active', external_ref: vaultRef, revision }, now });
        linkOperation(tx, op.operation_id, 'credential', row.id, now);
        const latest = tx.get('SELECT * FROM operations WHERE id=?', [op.operation_id]);
        return this.operations.transitionInTransaction(tx, op.operation_id, 'succeeded', { actorId: principal.actorId, expectedRevision: latest.revision, result: { credential_id: row.id, status: 'active', resource_revision: revision } }, now);
      });
      if (String(row.external_ref).startsWith('vault:') && row.external_ref !== vaultRef) try { this.vault.remove(row.external_ref); } catch { /* an orphan remains encrypted and unreferenced */ }
      return receipt;
    } catch (error) {
      if (vaultRef) try { this.vault?.remove(vaultRef); } catch { /* retain original failure */ }
      const errorCode = operationErrorCode(error, `${commandId.replace('.', '_')}_failed`);
      return await this.db.withTransaction((tx) => {
        const now = this.#time();
        const current = tx.get('SELECT * FROM credential_refs WHERE id=?', [row.id]);
        if (current?.status === 'pending' && Number(current.revision) === pending.revision) {
          const revision = pending.revision + 1;
          tx.run("UPDATE credential_refs SET status='failed',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [revision, now, principal.actorId, row.id, pending.revision], 1);
          appendAggregate(tx, this.events, { aggregateType: 'credential', aggregateId: row.id, revision, operationId: op.operation_id, actorId: principal.actorId, type: 'credential.failed', data: { credential_id: row.id, status: 'failed', error_code: errorCode, retryable: true }, payload: { id: row.id, provider: row.provider, status: 'failed', external_ref: row.external_ref, revision }, now });
        }
        return this.#failOperationInTransaction(tx, tx.get('SELECT * FROM operations WHERE id=?', [op.operation_id]), errorCode, now);
      });
    }
  }

  revokeCredential(credentialId, input = {}, principal) {
    requirePrincipal(principal);
    const row = this.db.get('SELECT * FROM credential_refs WHERE id=? AND owner_actor_id=?', [String(credentialId), principal.actorId]);
    if (!row) throw notFound('credential');
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const key = requireKey(input.idempotency_key);
    const hash = hashRequest({ credential_id: row.id, expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, 'credential.revoke', key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM credential_refs WHERE id=?', [row.id]);
      if (Number(current.revision) !== expected) throw revisionConflict(expected, current.revision);
      tx.run("UPDATE credential_refs SET status='revoked',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, principal.actorId, row.id, expected], 1);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId: 'credential.revoke', resourceType: 'credential', resourceId: row.id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'credential', aggregateId: row.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, type: 'credential.revoked', data: { credential_id: row.id, status: 'revoked' }, payload: { id: row.id, provider: row.provider, status: 'revoked', external_ref: row.external_ref, revision: expected + 1 }, now });
      linkOperation(tx, op.id, 'credential', row.id, now);
      const response = { credential: credentialView(tx.get('SELECT * FROM credential_refs WHERE id=?', [row.id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, 'credential.revoke', key, hash, response, op.id, now);
      return response;
    }).then((result) => {
      if (String(row.external_ref).startsWith('vault:')) try { this.vault?.remove(row.external_ref); } catch { /* metadata remains revoked */ }
      return result;
    });
  }

  async probeProfile(profileId, input = {}, principal) {
    requirePrincipal(principal);
    const row = this.db.get('SELECT * FROM provider_profiles WHERE id=? AND owner_actor_id=?', [String(profileId), principal.actorId]);
    if (!row) throw notFound('profile');
    if (row.credential_ref_id) {
      const credential = this.db.get('SELECT status FROM credential_refs WHERE id=? AND owner_actor_id=?', [row.credential_ref_id, principal.actorId]);
      if (!credential || credential.status !== 'active') throw new PlatformError('rebind_required', 'profile credential requires rebind', { credential_ref_id: row.credential_ref_id }, 409);
    }
    const key = requireKey(input.idempotency_key);
    const expected = positiveRevision(input.expected_revision ?? input.expectedRevision);
    const hash = hashRequest({ profile_id: row.id, expected_revision: expected });
    if (!this.operations) throw new PlatformError('internal_error', 'operation service is unavailable', {}, 503);
    const pending = await this.db.withTransaction((tx) => {
      const now = this.#time();
      const op = this.operations.createInTransaction(tx, { actorId: principal.actorId, commandId: 'profile.probe', idempotencyKey: key, requestHash: hash, request: { profile_id: row.id, expected_revision: expected }, resourceType: 'profile', resourceId: row.id }, now);
      if (op.replayed) return { operation: op, replayed: true };
      const current = tx.get('SELECT * FROM provider_profiles WHERE id=? AND owner_actor_id=?', [row.id, principal.actorId]);
      if (Number(current.revision) !== expected) throw revisionConflict(expected, current.revision);
      if (!['unprobed', 'available', 'unavailable'].includes(current.status)) throw new PlatformError('state_conflict', 'profile state does not allow probing', { status: current.status }, 409);
      const revision = expected + 1;
      tx.run("UPDATE provider_profiles SET status='probing',revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [revision, now, principal.actorId, row.id, expected], 1);
      appendAggregate(tx, this.events, { aggregateType: 'profile', aggregateId: row.id, revision, operationId: op.operation_id, actorId: principal.actorId, type: 'profile.probe.queued', data: { profile_id: row.id, status: 'probing' }, payload: { id: row.id, provider: row.provider, status: 'probing', revision }, now });
      linkOperation(tx, op.operation_id, 'profile', row.id, now);
      return { operation: op, replayed: false, revision };
    });
    if (pending.replayed) return pending.operation;
    const op = pending.operation;
    await this.operations.queue(op.operation_id, { actorId: principal.actorId, expectedRevision: op.revision });
    await this.operations.start(op.operation_id, { actorId: principal.actorId, expectedRevision: op.revision + 1 });
    let result = { available: true, provider: row.provider, adapter: 'fake-contract' };
    try {
      const adapter = this.providerAdapters[row.provider];
      if (adapter?.probe) result = await adapter.probe({ profile: profileView(row) });
      return await this.db.withTransaction((tx) => {
        const now = this.#time();
        const current = tx.get('SELECT * FROM provider_profiles WHERE id=?', [row.id]);
        if (Number(current.revision) !== pending.revision || current.status !== 'probing') throw revisionConflict(pending.revision, current.revision);
        const status = result?.available === false ? 'unavailable' : 'available';
        const revision = pending.revision + 1;
        tx.run('UPDATE provider_profiles SET status=?,last_probe_at=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, now, revision, now, principal.actorId, row.id, pending.revision], 1);
        appendAggregate(tx, this.events, { aggregateType: 'profile', aggregateId: row.id, revision, operationId: op.operation_id, actorId: principal.actorId, type: 'profile.probed', data: { profile_id: row.id, status }, payload: { id: row.id, provider: row.provider, status, revision }, now });
        linkOperation(tx, op.operation_id, 'profile', row.id, now);
        const latest = tx.get('SELECT * FROM operations WHERE id=?', [op.operation_id]);
        return this.operations.transitionInTransaction(tx, op.operation_id, 'succeeded', { actorId: principal.actorId, expectedRevision: latest.revision, result: { profile_id: row.id, status, adapter: String(result?.adapter || 'fake-contract'), resource_revision: revision } }, now);
      });
    } catch (error) {
      const errorCode = operationErrorCode(error, 'profile_probe_failed');
      return this.db.withTransaction((tx) => {
        const now = this.#time();
        const current = tx.get('SELECT * FROM provider_profiles WHERE id=?', [row.id]);
        if (current?.status === 'probing' && Number(current.revision) === pending.revision) {
          const revision = pending.revision + 1;
          tx.run("UPDATE provider_profiles SET status='unavailable',last_probe_at=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, revision, now, principal.actorId, row.id, pending.revision], 1);
          appendAggregate(tx, this.events, { aggregateType: 'profile', aggregateId: row.id, revision, operationId: op.operation_id, actorId: principal.actorId, type: 'profile.probe.failed', data: { profile_id: row.id, status: 'unavailable', error_code: errorCode, retryable: true }, payload: { id: row.id, provider: row.provider, status: 'unavailable', revision }, now });
        }
        return this.#failOperationInTransaction(tx, tx.get('SELECT * FROM operations WHERE id=?', [op.operation_id]), errorCode, now);
      });
    }
  }

  #failOperationInTransaction(tx, operation, errorCode, now) {
    if (!operation) throw new PlatformError('operation_not_found', 'operation not found', {}, 404);
    let current = operation;
    if (current.status === 'accepted') {
      this.operations.transitionInTransaction(tx, current.id, 'queued', { actorId: current.actor_id, expectedRevision: current.revision }, now);
      current = tx.get('SELECT * FROM operations WHERE id=?', [current.id]);
    }
    if (current.status === 'queued' || current.status === 'paused') {
      this.operations.transitionInTransaction(tx, current.id, 'running', { actorId: current.actor_id, expectedRevision: current.revision }, now);
      current = tx.get('SELECT * FROM operations WHERE id=?', [current.id]);
    }
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(current.status)) return this.operations.receiptFromRow(current);
    return this.operations.transitionInTransaction(tx, current.id, 'failed', { actorId: current.actor_id, expectedRevision: current.revision, errorCode, errorDetails: { retryable: true } }, now);
  }

  #sessionMutation(id, { actorId, expectedRevision, idempotencyKey, commandId, eventType, mutate }) {
    const key = requireKey(idempotencyKey);
    const expected = positiveRevision(expectedRevision);
    const hash = hashRequest({ id: String(id), expected_revision: expected });
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const row = tx.get('SELECT * FROM sessions WHERE id=?', [String(id)]);
      if (!row) throw notFound('session');
      if (String(actorId) !== row.subject_actor_id && String(actorId) !== this.bootstrapActorId) throw forbidden('session is outside actor scope');
      const prior = getIdempotency(tx, actorId, commandId, key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      if (Number(row.revision) !== expected) throw revisionConflict(expected, row.revision);
      mutate(tx, row, now);
      const op = createInlineOperation(tx, { events: this.events, actorId, commandId, resourceType: 'session', resourceId: row.id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'session', aggregateId: row.id, revision: expected + 1, operationId: op.id, actorId, type: eventType, data: { session_id: row.id }, payload: { id: row.id, subject_actor_id: row.subject_actor_id, effective_actor_id: row.effective_actor_id, revoked: true, revision: expected + 1 }, now });
      linkOperation(tx, op.id, 'session', row.id, now);
      const response = { session: sessionView(tx.get('SELECT * FROM sessions WHERE id=?', [row.id]), now), operation: operationView(op) };
      saveIdempotency(tx, actorId, commandId, key, hash, response, op.id, now);
      return response;
    });
  }

  #simpleActorMutation({ target, status, expected, key, hash, principal, commandId, eventType }) {
    const now = this.#time();
    return this.db.withTransaction((tx) => {
      const prior = getIdempotency(tx, principal.actorId, commandId, key, hash, now);
      if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
      const current = tx.get('SELECT * FROM actors WHERE id=?', [target.id]);
      if (Number(current.revision) !== expected) throw revisionConflict(expected, current.revision);
      tx.run('UPDATE actors SET status=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, now, principal.actorId, target.id, expected], 1);
      const op = createInlineOperation(tx, { events: this.events, actorId: principal.actorId, commandId, resourceType: 'actor', resourceId: target.id, requestHash: hash, now });
      appendAggregate(tx, this.events, { aggregateType: 'actor', aggregateId: target.id, revision: expected + 1, operationId: op.id, actorId: principal.actorId, type: eventType, data: { actor_id: target.id, status }, payload: { id: target.id, kind: target.kind, display_name: target.display_name, status, revision: expected + 1 }, now });
      linkOperation(tx, op.id, 'actor', target.id, now);
      const response = { actor: actorView(tx.get('SELECT * FROM actors WHERE id=?', [target.id])), operation: operationView(op) };
      saveIdempotency(tx, principal.actorId, commandId, key, hash, response, op.id, now);
      return response;
    });
  }

  #assertTeamManage(teamId, principal, { allowSuspended = false } = {}) {
    const row = this.db.get(`SELECT tm.role,t.status AS team_status FROM team_memberships tm JOIN teams t ON t.id=tm.team_id WHERE tm.team_id=? AND tm.actor_id=? AND tm.status='active'`, [String(teamId), principal.actorId]);
    if (!row || !['owner', 'admin'].includes(row.role)) throw forbidden('team membership management denied');
    if (row.team_status === 'archived' || (!allowSuspended && row.team_status !== 'active')) throw new PlatformError('state_conflict', 'team is not active', { status: row.team_status }, 409);
    return row;
  }

  #assertProjectReference(projectId) {
    if (typeof this.projectScopeResolver !== 'function') throw new PlatformError('project_denied', 'project reference is outside the clean scope', {}, 403);
    let resolved = false;
    try { resolved = Boolean(this.projectScopeResolver(String(projectId), {})); } catch { resolved = false; }
    if (!resolved) throw new PlatformError('project_denied', 'project reference is outside the clean scope', {}, 403);
  }

  #projectRole(projectId, actorId) {
    return this.db.get("SELECT role FROM project_memberships WHERE project_id=? AND actor_id=? AND status='active'", [String(projectId), String(actorId)])?.role || null;
  }

  #assertAnotherTeamOwner(tx, teamId, membershipId) {
    const row = tx.get("SELECT 1 AS ok FROM team_memberships WHERE team_id=? AND id<>? AND role='owner' AND status='active' LIMIT 1", [String(teamId), String(membershipId)]);
    if (!row) throw new PlatformError('state_conflict', 'team must retain an active owner', {}, 409);
  }

  #assertAnotherProjectOwner(tx, projectId, membershipId) {
    const row = tx.get("SELECT 1 AS ok FROM project_memberships WHERE project_id=? AND id<>? AND role='owner' AND status='active' LIMIT 1", [String(projectId), String(membershipId)]);
    if (!row) throw new PlatformError('state_conflict', 'project must retain an active owner', {}, 409);
  }

  #assertActorManage(target, principal) {
    const managed = this.db.get(`SELECT 1 AS ok FROM team_memberships manager_tm
      JOIN teams team ON team.id=manager_tm.team_id AND team.status='active'
      JOIN team_memberships target_tm ON target_tm.team_id=manager_tm.team_id
      WHERE manager_tm.actor_id=? AND manager_tm.status='active' AND manager_tm.role IN ('owner','admin')
        AND target_tm.actor_id=? AND target_tm.status IN ('active','suspended') LIMIT 1`, [principal.actorId, target.id]);
    const unassignedCreator = target.created_by_actor_id === principal.actorId
      && !this.db.get("SELECT 1 AS ok FROM team_memberships WHERE actor_id=? AND status IN ('active','suspended') LIMIT 1", [target.id]);
    if (!managed && !unassignedCreator) throw forbidden('actor is outside the managed team');
  }

  #requiredActor(id) {
    const row = this.db.get('SELECT * FROM actors WHERE id=?', [String(id || '')]);
    if (!row) throw notFound('actor');
    return row;
  }

  #findDelegationCredential(principal, proof, targetActorId) {
    const rows = this.db.query(`SELECT id,owner_actor_id,scope_json,external_ref FROM credential_refs
      WHERE status='active' AND owner_actor_id IN (?,?) ORDER BY created_at,id`, [principal.subjectActorId, targetActorId]);
    for (const row of rows) {
      if (!String(row.external_ref || '').startsWith('vault:') || !this.vault) continue;
      try {
        const stored = Buffer.from(this.vault.read(row.external_ref));
        const candidate = Buffer.from(String(proof));
        if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) return row;
      } catch { /* an unreadable vault entry is not a valid delegation proof */ }
    }
    return null;
  }

  #actorIn(tx, id) { return actorView(tx.get('SELECT * FROM actors WHERE id=?', [id])); }
  #teamIn(tx, id) { return teamView(tx.get('SELECT * FROM teams WHERE id=?', [id])); }
  #membershipIn(tx, id) { return membershipView(tx.get('SELECT tm.*,a.kind,a.display_name,a.status AS actor_status FROM team_memberships tm JOIN actors a ON a.id=tm.actor_id WHERE tm.id=?', [id])); }
  #proofHash(proof) { return createHmac('sha256', this.sessionSecret).update(String(proof), 'utf8').digest('hex'); }
  #assertSafe(value) { return this.policy?.assertSafe ? this.policy.assertSafe(value) : value; }
  #time() { const value = typeof this.clock === 'function' ? this.clock() : this.clock; return typeof value === 'string' ? value : new Date(value).toISOString(); }
}

/**
 * Stable Identity facade.  Setup remains a cross-owner transaction on the
 * core; all other public calls are routed to an explicit owner service.
 */
export class IdentityService {
  constructor(options = {}) {
    this.core = new IdentityCoreService(options);
    for (const key of ['db', 'events', 'operations', 'policy', 'clock', 'bootstrapActorId', 'sessionSecret', 'authorization', 'projectScopeResolver', 'vault', 'providerAdapters']) {
      this[key] = this.core[key];
    }
    this.actorService = new ActorService({ core: this.core });
    this.sessionService = new SessionService({ core: this.core });
    this.teamAccessService = new TeamAccessService({ core: this.core });
    this.credentialProfileService = new CredentialProfileService({ core: this.core });
  }

  ownerForCommand(commandId) {
    const command = String(commandId || '');
    if (command.startsWith('session.')) return 'Session';
    if (command.startsWith('team.') || command.startsWith('membership.') || command.startsWith('invitation.') || command.startsWith('acl.') || command.startsWith('project.')) return 'TeamAccess';
    if (command.startsWith('credential.') || command.startsWith('profile.')) return 'CredentialProfile';
    return 'Actor';
  }

  ownerInventory() {
    return Object.freeze({
      Actor: this.actorService.tables,
      Session: this.sessionService.tables,
      TeamAccess: this.teamAccessService.tables,
      CredentialProfile: this.credentialProfileService.tables
    });
  }

  account(...args) { return this.actorService.account(...args); }
  actors(...args) { return this.actorService.list(...args); }
  setupState(...args) { return this.core.setupState(...args); }
  setupComplete(...args) { return this.core.setupComplete(...args); }

  authenticateProof(...args) { return this.sessionService.authenticateProof(...args); }
  principalFromRequest(...args) { return this.sessionService.principalFromRequest(...args); }
  session(...args) { return this.sessionService.get(...args); }
  sessions(...args) { return this.sessionService.list(...args); }
  createSession(...args) { return this.sessionService.create(...args); }
  revokeSession(...args) { return this.sessionService.revoke(...args); }

  actorSwitch(...args) { return this.actorService.switch(...args); }
  createActor(...args) { return this.actorService.create(...args); }
  updateActor(...args) { return this.actorService.update(...args); }
  setActorStatus(...args) { return this.actorService.setStatus(...args); }

  createTeam(...args) { return this.teamAccessService.createTeam(...args); }
  teams(...args) { return this.teamAccessService.listTeams(...args); }
  team(...args) { return this.teamAccessService.getTeam(...args); }
  setTeamStatus(...args) { return this.teamAccessService.setTeamStatus(...args); }
  memberships(...args) { return this.teamAccessService.memberships(...args); }
  grantMembership(...args) { return this.teamAccessService.grantMembership(...args); }
  setMembershipStatus(...args) { return this.teamAccessService.setMembershipStatus(...args); }
  grantProjectMembership(...args) { return this.teamAccessService.grantProjectMembership(...args); }
  projectMembers(...args) { return this.teamAccessService.projectMembers(...args); }
  projectInvitations(...args) { return this.teamAccessService.projectInvitations(...args); }
  createProjectInvitation(...args) { return this.teamAccessService.createInvitation(...args); }
  acceptProjectInvitation(...args) { return this.teamAccessService.acceptInvitation(...args); }
  revokeProjectInvitation(...args) { return this.teamAccessService.revokeInvitation(...args); }
  setProjectMembershipStatus(...args) { return this.teamAccessService.setProjectMembershipStatus(...args); }
  aclEntries(...args) { return this.teamAccessService.aclEntries(...args); }
  setAclEntry(...args) { return this.teamAccessService.setAclEntry(...args); }

  createCredential(...args) { return this.credentialProfileService.createCredential(...args); }
  credentials(...args) { return this.credentialProfileService.listCredentials(...args); }
  profiles(...args) { return this.credentialProfileService.listProfiles(...args); }
  recoverPending(...args) { return this.core.recoverPending(...args); }
  createProfile(...args) { return this.credentialProfileService.createProfile(...args); }
  rebindCredential(...args) { return this.credentialProfileService.rebind(...args); }
  rotateCredential(...args) { return this.credentialProfileService.rotate(...args); }
  revokeCredential(...args) { return this.credentialProfileService.revoke(...args); }
  probeProfile(...args) { return this.credentialProfileService.probeProfile(...args); }
}

export const IdentityDomainService = IdentityService;

function appendAggregate(tx, events, { aggregateType, aggregateId, revision, operationId, actorId, projectId = null, type, data, payload, now }) {
  if (!events || typeof events.appendAggregateInTransaction !== 'function') throw new TypeError('clean_event_service_required');
  return events.appendAggregateInTransaction(tx, { aggregateType, aggregateId, revision, operationId: operationId || null, actorId, projectId, type, data, payload, now });
}

function createInlineOperation(tx, { events, actorId, commandId, resourceType, resourceId, projectId = null, requestHash, now }) {
  const operations = events?.operations;
  if (!operations || typeof operations.createInTransaction !== 'function') throw new TypeError('clean_operation_service_required');
  tx.__cleanOperations = operations;
  return operations.createInTransaction(tx, {
    actorId,
    commandId,
    kind: commandId,
    resourceType,
    resourceId,
    projectId,
    requestHash,
    request: { resource_type: resourceType, resource_id: resourceId, project_id: projectId },
    idempotencyKey: `inline-${opaqueId('key')}`,
    status: 'succeeded'
  }, now);
}

function linkOperation(tx, operationId, aggregateType, aggregateId, now) {
  const operations = tx?.__cleanOperations;
  if (!operations || typeof operations.linkInTransaction !== 'function') throw new TypeError('clean_operation_service_required');
  return operations.linkInTransaction(tx, operationId, [[aggregateType, aggregateId]], now);
}

function getIdempotency(tx, actorId, commandId, key, requestHash, now) {
  const operations = tx?.__cleanOperations;
  if (!operations || typeof operations.getIdempotencyInTransaction !== 'function') throw new TypeError('clean_operation_service_required');
  return operations.getIdempotencyInTransaction(tx, { actorId, commandId, idempotencyKey: key, requestHash, now });
}

function saveIdempotency(tx, actorId, commandId, key, requestHash, response, operationId, now) {
  const operations = tx?.__cleanOperations;
  if (!operations || typeof operations.saveIdempotencyInTransaction !== 'function') throw new TypeError('clean_operation_service_required');
  return operations.saveIdempotencyInTransaction(tx, { actorId, commandId, idempotencyKey: key, requestHash, response, operationId, now });
}

function operationView(value) { return { operation_id: value.id, status: 'succeeded', revision: Number(value.revision || 1), resource_type: value.resourceType || null, resource_id: value.resourceId || null, audit_reference: value.audit_reference || null, terminal: true }; }
function actorPayload(value) { return { id: value.id, kind: value.kind, display_name: value.display_name, status: value.status, revision: Number(value.revision) }; }
function actorView(row) { return { id: row.id, kind: row.kind, display_name: row.display_name, status: row.status, metadata: parseCanonicalJson(row.metadata_json, {}), revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function teamView(row) { return row ? { id: row.id, name: row.name, status: row.status, metadata: parseCanonicalJson(row.metadata_json, {}), revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at } : null; }
function membershipView(row) { return row ? { id: row.id, team_id: row.team_id, actor_id: row.actor_id, role: row.role, status: row.status, actor: row.display_name ? { kind: row.kind, display_name: row.display_name, status: row.actor_status } : undefined, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at } : null; }
function projectMembershipView(row) { return row ? { id: row.id, project_id: row.project_id, actor_id: row.actor_id, role: row.role, status: row.status, actor: row.display_name ? { kind: row.kind, display_name: row.display_name } : undefined, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at } : null; }
function invitationView(row) { return row ? { id: row.id, project_id: row.project_id, invitee_actor_id: row.invitee_actor_id || null, invitee_ref: row.invitee_ref || '', role: row.role, status: row.status, expires_at: row.expires_at || null, accepted_by_actor_id: row.accepted_by_actor_id || null, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at } : null; }
function aclView(row) { return row ? { id: row.id, project_id: row.project_id, principal_actor_id: row.principal_actor_id, principal_team_id: row.principal_team_id, resource: row.resource, action: row.action, effect: row.effect, policy_revision: Number(row.policy_revision), revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at } : null; }
function credentialView(row) { return { id: row.id, owner_actor_id: row.owner_actor_id, provider: row.provider, scope: parseCanonicalJson(row.scope_json, {}), status: row.status, external_ref: row.external_ref, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function profileView(row) { return { id: row.id, owner_actor_id: row.owner_actor_id, provider: row.provider, label: row.label, credential_ref_id: row.credential_ref_id, config: parseCanonicalJson(row.config_json, {}), status: row.status, last_probe_at: row.last_probe_at || null, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function sessionView(row, now = new Date().toISOString()) { return { id: row.id, subject_actor_id: row.subject_actor_id, effective_actor_id: row.effective_actor_id, status: row.revoked_at ? 'revoked' : (Date.parse(row.expires_at) <= Date.parse(String(now)) ? 'expired' : 'active'), expires_at: row.expires_at, last_seen_at: row.last_seen_at, revoked_at: row.revoked_at || null, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function requiredName(value) { const text = String(value || '').trim(); if (!text || text.length > 160) throw new PlatformError('schema_invalid', 'name is required', {}, 422); return text; }
function positiveRevision(value) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new PlatformError('expected_revision_required', 'expected revision is required', {}, 400); return number; }
function nonNegativeRevision(value) { const number = Number(value); if (!Number.isInteger(number) || number < 0) throw new PlatformError('expected_revision_required', 'expected revision is required', {}, 400); return number; }
function requireKey(value) { const key = String(value || ''); if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(key)) throw new PlatformError('idempotency_required', 'Idempotency-Key is required', {}, 400); return key; }
function hashRequest(value) { return sha256Hex(canonicalJson(value)); }
function operationErrorCode(error, fallback) {
  const value = String(error?.code || '');
  return /^[a-z][a-z0-9_.-]{2,100}$/.test(value) ? value : fallback;
}
function expiry(now, seconds) { return new Date(Date.parse(now) + Number(seconds) * 1000).toISOString(); }
function revisionConflict(expected, actual) { return new PlatformError('revision_conflict', 'resource revision has changed', { expected_revision: Number(expected), actual_revision: Number(actual) }, 409); }
function notFound(resource) { return new PlatformError('not_found', `${resource} not found`, {}, 404); }
function forbidden(message) { return new PlatformError('permission_denied', message, {}, 403); }
function requirePrincipal(principal) { if (!principal?.actorId) throw new PlatformError('authentication_required', 'active session proof is required', {}, 401); }
function extractProof(request) {
  const cookie = String(request?.headers?.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('aiws_session='));
  if (cookie) return decodeURIComponent(cookie.slice('aiws_session='.length));
  return null;
}

function withoutProof(value) {
  if (Array.isArray(value)) return value.map(withoutProof);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'proof').map(([key, item]) => [key, withoutProof(item)]));
}

export { extractProof, actorView, teamView, membershipView, projectMembershipView, aclView, credentialView, profileView, sessionView };
