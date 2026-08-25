import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex, utcNow } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/;
const MCP_PROTOCOL_VERSION = '2025-06-18';

export class CleanMcpExchangeService {
  constructor({ db, context, operations, authorization, registry, policy, clock = utcNow, pepper, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db || !context || !operations || !registry) throw new TypeError('clean_mcp_dependencies_required');
    if (typeof pepper !== 'string' || pepper.length < 16) throw new TypeError('clean_mcp_pepper_required');
    this.db = db;
    this.context = context;
    this.operations = operations;
    this.authorization = authorization;
    this.registry = registry;
    this.policy = policy;
    this.clock = clock;
    this.pepper = String(pepper);
    this.bootstrapActorId = bootstrapActorId;
  }

  time() { const value = typeof this.clock === 'function' ? this.clock() : this.clock; return typeof value === 'string' ? value : new Date(value).toISOString(); }

  tools() {
    return this.dispatcher?.tools() || [];
  }

  createClient(input = {}, principal) {
    const actorId = actorOf(principal, this.bootstrapActorId);
    const name = bounded(input.name || 'MCP client', 160);
    const transport = ['http', 'stdio'].includes(String(input.transport)) ? String(input.transport) : 'stdio';
    const scope = normalizeScope(input.scope || input);
    for (const projectId of scope.project_ids) this.assertProjectAccess(projectId, principal, 'read');
    for (const tool of scope.tools) if (!this.toolEntry(tool)) throw new PlatformError('unknown_command', 'MCP tool is not registered', { tool }, 404);
    const ttl = clamp(Number(input.ttl_seconds || 3600), 300, 31_622_400);
    const token = `aiws_mcp_${randomBytes(32).toString('base64url')}`;
    const tokenHmac = this.hashToken(token);
    const prefix = token.slice(0, 20);
    const now = this.time();
    const expires = new Date(Date.parse(now) + ttl * 1000).toISOString();
    const id = opaqueId('mcp');
    const metadata = { actor_id: actorId, name, transport, endpoint: String(input.endpoint || ''), project_ids: scope.project_ids, tools: scope.tools, ttl_seconds: ttl };
    const key = requireKey(input.idempotency_key);
    const requestHash = sha256Hex(canonicalJson(metadata));
    const row = this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'mcp.client.create', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'mcp.client.create', kind: 'mcp.client.create', resourceType: 'mcp_client', resourceId: id, projectId: scope.project_ids[0] || null, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      tx.run(`INSERT INTO mcp_clients(id,actor_id,name,transport,endpoint,token_hmac,token_prefix,project_allowlist_json,tool_allowlist_json,expires_at,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'active',1,?,?)`, [id, actorId, name, transport, String(input.endpoint || ''), tokenHmac, prefix, canonicalJson(scope.project_ids), canonicalJson(scope.tools), expires, now, now]);
      this.operations.linkInTransaction(tx, operation.operation_id, [['mcp_client', id]], now);
      const response = { client: clientView(tx.get('SELECT * FROM mcp_clients WHERE id=?', [id])), token, protocol_version: MCP_PROTOCOL_VERSION, operation: this.operations.summary(operation) };
      // The raw token is returned only for this response.  The idempotency
      // replay record intentionally stores the redacted public projection.
      const replayResponse = { ...response };
      delete replayResponse.token;
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'mcp.client.create', idempotencyKey: key, requestHash, response: replayResponse, operationId: operation.operation_id, responseStatus: 201, now });
      return response;
    });
    return row;
  }

  listClients(principal, projectId = null) {
    const actorId = actorOf(principal, this.bootstrapActorId);
    const rows = this.db.query('SELECT * FROM mcp_clients WHERE actor_id=? ORDER BY created_at DESC,id DESC', [actorId]);
    return rows.filter((row) => !projectId || parseJson(row.project_allowlist_json, []).includes(String(projectId))).map(clientView);
  }

  revokeClient(clientId, input = {}, principal) {
    const actorId = actorOf(principal, this.bootstrapActorId);
    const row = this.db.get('SELECT * FROM mcp_clients WHERE id=?', [String(clientId)]);
    if (!row) throw new PlatformError('not_found', 'MCP client not found', {}, 404);
    if (row.actor_id !== actorId && actorId !== this.bootstrapActorId) throw new PlatformError('permission_denied', 'MCP client is outside actor scope', {}, 403);
    const expected = Number(input.expected_revision);
    if (expected !== Number(row.revision)) throw new PlatformError('revision_conflict', 'MCP client revision has changed', { expected_revision: expected, actual_revision: row.revision }, 409);
    const now = this.time();
    const key = requireKey(input.idempotency_key);
    const requestHash = sha256Hex(canonicalJson({ client_id: row.id, expected_revision: expected }));
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'mcp.client.revoke', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'mcp.client.revoke', kind: 'mcp.client.revoke', resourceType: 'mcp_client', resourceId: row.id, projectId: parseJson(row.project_allowlist_json, [])[0] || null, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      tx.run(`UPDATE mcp_clients SET status='revoked',revoked_at=?,revoked_by_actor_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`, [now, actorId, now, row.id, expected], 1);
      this.operations.linkInTransaction(tx, operation.operation_id, [['mcp_client', row.id]], now);
      const response = { client: clientView(tx.get('SELECT * FROM mcp_clients WHERE id=?', [row.id])), operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'mcp.client.revoke', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 200, now });
      return response;
    });
  }

  authenticate(token, { projectId = null, tool = null, principal = null } = {}) {
    const value = String(token || '');
    if (!value) throw new PlatformError('mcp_token_invalid', 'MCP client token is required', {}, 401);
    const hash = this.hashToken(value);
    const row = this.db.get('SELECT * FROM mcp_clients WHERE token_hmac=?', [hash]);
    if (!row) throw new PlatformError('mcp_token_invalid', 'MCP client token is invalid', {}, 401);
    const now = this.time();
    if (row.status !== 'active' || Date.parse(row.expires_at) <= Date.parse(now)) {
      if (row.status === 'active') this.db.run("UPDATE mcp_clients SET status='expired',revision=revision+1,updated_at=? WHERE id=? AND status='active'", [now, row.id]);
      throw new PlatformError('mcp_token_expired', 'MCP client token has expired', {}, 401);
    }
    const projects = parseJson(row.project_allowlist_json, []);
    const tools = parseJson(row.tool_allowlist_json, []);
    if (projectId && projects.length && !projects.includes(String(projectId))) throw new PlatformError('mcp_scope_denied', 'MCP client is not scoped to this project', {}, 403);
    if (tool && tools.length && !tools.includes(String(tool)) && !tools.includes(this.toolEntry(tool)?.command_id || '')) throw new PlatformError('mcp_scope_denied', 'MCP client is not scoped to this tool', {}, 403);
    if (principal && projectId) this.assertProjectAccess(projectId, principal, 'read');
    this.db.run('UPDATE mcp_clients SET last_used_at=?,usage_count=COALESCE(usage_count,0)+1,updated_at=? WHERE id=?', [now, now, row.id]);
    return { client: clientView(row), project_ids: projects.map(String), tools: tools.map(String), actor_id: row.actor_id };
  }

  createExchangeRequest(input = {}, principal) {
    const actorId = actorOf(principal, this.bootstrapActorId);
    const source = String(input.source_project_id || input.source_project || '');
    const target = String(input.target_project_id || input.target_project || '');
    if (!source || !target || source === target) throw new PlatformError('schema_invalid', 'source and target projects are required', {}, 400);
    this.assertProjectAccess(source, principal, 'read');
    const scope = normalizeScope(input.scope || input);
    const now = this.time();
    const ttl = clamp(Number(input.ttl_seconds || 3600), 60, 31_622_400);
    const expires = new Date(Date.parse(now) + ttl * 1000).toISOString();
    const id = opaqueId('exchange');
    const key = requireKey(input.idempotency_key);
    const requestHash = sha256Hex(canonicalJson({ source, target, scope, ttl_seconds: ttl }));
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'exchange.request.create', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'exchange.request.create', kind: 'exchange.request', resourceType: 'exchange_request', resourceId: id, projectId: source, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      tx.run(`INSERT INTO exchange_requests(id,source_project_id,target_project_id,requester_actor_id,scope_json,status,expires_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,'requested',?,1,?,?,?,?)`, [id, source, target, actorId, canonicalJson(scope), expires, now, now, actorId, actorId]);
      this.operations.linkInTransaction(tx, operation.operation_id, [['exchange_request', id]], now);
      const response = { request: exchangeRequestView(tx.get('SELECT * FROM exchange_requests WHERE id=?', [id])), operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'exchange.request.create', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 201, now });
      return response;
    });
  }

  listExchangeRequests(projectId, principal) {
    const id = String(projectId || '');
    this.assertProjectAccess(id, principal, 'read');
    return this.db.query('SELECT * FROM exchange_requests WHERE source_project_id=? OR target_project_id=? ORDER BY created_at DESC,id DESC', [id, id]).map(exchangeRequestView);
  }

  approveExchange(requestId, input = {}, principal) {
    const actorId = actorOf(principal, this.bootstrapActorId);
    const row = this.db.get('SELECT * FROM exchange_requests WHERE id=?', [String(requestId)]);
    if (!row) throw new PlatformError('not_found', 'exchange request not found', {}, 404);
    const side = String(input.side || input.approver_side || '').toLowerCase();
    const sourceSide = side === 'source' || (!side && this.isApprover(row.source_project_id, actorId));
    const targetSide = side === 'target' || (!side && !sourceSide && this.isApprover(row.target_project_id, actorId));
    if (!sourceSide && !targetSide) throw new PlatformError('permission_denied', 'actor is not an exchange approver', {}, 403);
    if (sourceSide && !this.isApprover(row.source_project_id, actorId)) throw new PlatformError('permission_denied', 'source approval is not permitted', {}, 403);
    if (targetSide && !this.isApprover(row.target_project_id, actorId)) throw new PlatformError('permission_denied', 'target approval is not permitted', {}, 403);
    const expected = Number(input.expected_revision);
    if (expected !== Number(row.revision)) throw new PlatformError('revision_conflict', 'exchange request revision has changed', { expected_revision: expected, actual_revision: row.revision }, 409);
    const now = this.time();
    const key = requireKey(input.idempotency_key);
    const requestHash = sha256Hex(canonicalJson({ request_id: row.id, side: sourceSide ? 'source' : 'target', expected_revision: expected }));
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'exchange.request.approve', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'exchange.request.approve', kind: 'exchange.approval', resourceType: 'exchange_request', resourceId: row.id, projectId: sourceSide ? row.source_project_id : row.target_project_id, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      if (sourceSide) tx.run(`UPDATE exchange_requests SET source_approver_actor_id=?,source_approved_at=?,status=CASE WHEN target_approved_at IS NULL THEN 'partially_approved' ELSE 'active' END,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [actorId, now, now, actorId, row.id, expected], 1);
      else tx.run(`UPDATE exchange_requests SET target_approver_actor_id=?,target_approved_at=?,status=CASE WHEN source_approved_at IS NULL THEN 'partially_approved' ELSE 'active' END,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [actorId, now, now, actorId, row.id, expected], 1);
      let grant = null;
      const next = tx.get('SELECT * FROM exchange_requests WHERE id=?', [row.id]);
      if (next.source_approved_at && next.target_approved_at && !next.grant_id) {
        const grantId = opaqueId('grant');
        tx.run(`INSERT INTO exchange_grants(id,source_project_id,target_project_id,grantee_actor_id,scope_json,status,expires_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id,request_id,source_approver_actor_id,target_approver_actor_id,source_approved_at,target_approved_at) VALUES(?,?,?,?,?,'active',?,1,?,?,?,?,?,?,?,?,?)`, [grantId, next.source_project_id, next.target_project_id, next.requester_actor_id, next.scope_json, next.expires_at, now, now, actorId, actorId, next.id, next.source_approver_actor_id, next.target_approver_actor_id, next.source_approved_at, next.target_approved_at]);
        tx.run('UPDATE exchange_requests SET grant_id=? WHERE id=?', [grantId, next.id]);
        grant = exchangeGrantView(tx.get('SELECT * FROM exchange_grants WHERE id=?', [grantId]));
      }
      this.operations.linkInTransaction(tx, operation.operation_id, [['exchange_request', row.id], ...(grant ? [['exchange_grant', grant.id]] : [])], now);
      const response = { request: exchangeRequestView(tx.get('SELECT * FROM exchange_requests WHERE id=?', [row.id])), grant, operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'exchange.request.approve', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 200, now });
      return response;
    });
  }

  rejectExchange(requestId, input = {}, principal) {
    const actorId = actorOf(principal, this.bootstrapActorId);
    const row = this.db.get('SELECT * FROM exchange_requests WHERE id=?', [String(requestId)]);
    if (!row) throw new PlatformError('not_found', 'exchange request not found', {}, 404);
    if (!this.isApprover(row.source_project_id, actorId) && !this.isApprover(row.target_project_id, actorId)) throw new PlatformError('permission_denied', 'actor is not an exchange approver', {}, 403);
    const expected = Number(input.expected_revision);
    if (expected !== Number(row.revision)) throw new PlatformError('revision_conflict', 'exchange request revision has changed', {}, 409);
    const key = requireKey(input.idempotency_key);
    const now = this.time();
    const requestHash = sha256Hex(canonicalJson({ request_id: row.id, expected_revision: expected, reject: true }));
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'exchange.request.reject', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'exchange.request.reject', kind: 'exchange.rejection', resourceType: 'exchange_request', resourceId: row.id, projectId: row.source_project_id, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      tx.run(`UPDATE exchange_requests SET status='rejected',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [now, actorId, row.id, expected], 1);
      this.operations.linkInTransaction(tx, operation.operation_id, [['exchange_request', row.id]], now);
      const response = { request: exchangeRequestView(tx.get('SELECT * FROM exchange_requests WHERE id=?', [row.id])), operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'exchange.request.reject', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 200, now });
      return response;
    });
  }

  revokeGrant(grantId, input = {}, principal) {
    const actorId = actorOf(principal, this.bootstrapActorId);
    const row = this.db.get('SELECT * FROM exchange_grants WHERE id=?', [String(grantId)]);
    if (!row) throw new PlatformError('not_found', 'exchange grant not found', {}, 404);
    if (!this.isApprover(row.source_project_id, actorId) && !this.isApprover(row.target_project_id, actorId)) throw new PlatformError('permission_denied', 'actor is not an exchange approver', {}, 403);
    const expected = Number(input.expected_revision);
    if (expected !== Number(row.revision)) throw new PlatformError('revision_conflict', 'exchange grant revision has changed', {}, 409);
    const now = this.time();
    const key = requireKey(input.idempotency_key);
    const requestHash = sha256Hex(canonicalJson({ grant_id: row.id, expected_revision: expected }));
    return this.db.withTransaction((tx) => {
      const prior = this.operations.getIdempotencyInTransaction(tx, { actorId, commandId: 'exchange.grant.revoke', idempotencyKey: key, requestHash, now });
      if (prior?.response_json) return { ...JSON.parse(prior.response_json), replayed: true };
      const operation = this.operations.createInTransaction(tx, { actorId, commandId: 'exchange.grant.revoke', kind: 'exchange.revoke', resourceType: 'exchange_grant', resourceId: row.id, projectId: row.target_project_id, requestHash, idempotencyKey: key, status: 'succeeded' }, now);
      tx.run(`UPDATE exchange_grants SET status='revoked',revoked_at=?,updated_at=?,updated_by_actor_id=?,revision=revision+1 WHERE id=? AND revision=?`, [now, now, actorId, row.id, expected], 1);
      this.operations.linkInTransaction(tx, operation.operation_id, [['exchange_grant', row.id]], now);
      const response = { grant: exchangeGrantView(tx.get('SELECT * FROM exchange_grants WHERE id=?', [row.id])), operation: this.operations.summary(operation) };
      this.operations.saveIdempotencyInTransaction(tx, { actorId, commandId: 'exchange.grant.revoke', idempotencyKey: key, requestHash, response, operationId: operation.operation_id, responseStatus: 200, now });
      return response;
    });
  }

  listGrants(projectId, principal) {
    this.assertProjectAccess(projectId, principal, 'read');
    return this.db.query('SELECT * FROM exchange_grants WHERE source_project_id=? OR target_project_id=? ORDER BY created_at DESC,id DESC', [String(projectId), String(projectId)]).map(exchangeGrantView);
  }

  async createGrantPack(grantId, input = {}, principal) {
    const actorId = actorOf(principal, this.bootstrapActorId);
    const grant = this.db.get('SELECT * FROM exchange_grants WHERE id=?', [String(grantId)]);
    if (!grant) throw new PlatformError('not_found', 'exchange grant not found', {}, 404);
    if (grant.status !== 'active' || (grant.expires_at && Date.parse(grant.expires_at) <= Date.parse(this.time()))) throw new PlatformError('exchange_grant_expired', 'exchange grant is expired or revoked', {}, 403);
    if (grant.grantee_actor_id && grant.grantee_actor_id !== actorId && actorId !== this.bootstrapActorId) throw new PlatformError('permission_denied', 'exchange grant actor scope denied', {}, 403);
    const targetPrincipal = { ...principal, actorId, effectiveActorId: actorId, projectId: grant.source_project_id };
    const scope = parseJson(grant.scope_json, {});
    const packInput = { ...input, require_authoritative: input.require_authoritative !== false, idempotency_key: input.idempotency_key, grant_id: grant.id, scope };
    const result = await this.context.createPack(grant.source_project_id, packInput, targetPrincipal);
    return { grant: exchangeGrantView(grant), pack: result.pack, operation: result.operation };
  }

  async dispatch(name, args = {}, principal, options = {}) {
    if (!this.dispatcher) throw new PlatformError('dispatcher_unavailable', 'Clean command dispatcher is unavailable', {}, 503);
    const dispatched = await this.dispatcher.dispatch(name, args, principal, { transport: options.transport || 'mcp' });
    return { ...dispatched, result: this.policy?.redact(dispatched.result).value || dispatched.result };
  }

  eventsForOperation(args, principal, options) {
    if (!options.events) throw new PlatformError('internal_error', 'event service is unavailable', {}, 500);
    const operation = this.operations.get(args.operation_id, { actorId: actorOf(principal, this.bootstrapActorId), projectId: args.project_id || null });
    return options.events.replay({ actorId: actorOf(principal, this.bootstrapActorId), projectId: operation.project_id, operationId: operation.operation_id, cursor: args.cursor || 0, limit: 500 });
  }

  toolEntry(name) {
    return this.dispatcher?.entryFor(name) || null;
  }

  assertProjectAccess(projectId, principal, action = 'read') {
    const id = String(projectId || '');
    if (!this.db.get('SELECT id FROM projects WHERE id=?', [id])) throw new PlatformError('not_found', 'project not found', {}, 404);
    if (this.authorization) this.authorization.assert(principal, action, id, { resource: 'project' });
    return id;
  }

  isApprover(projectId, actorId) {
    const row = this.db.get('SELECT owner_actor_id FROM projects WHERE id=?', [String(projectId)]);
    if (row?.owner_actor_id === String(actorId)) return true;
    return Boolean(this.db.get("SELECT 1 AS ok FROM project_memberships WHERE project_id=? AND actor_id=? AND status='active' AND role IN ('owner','admin')", [String(projectId), String(actorId)]));
  }

  hashToken(token) { return createHmac('sha256', this.pepper).update(String(token)).digest('hex'); }
}

export { MCP_PROTOCOL_VERSION };

function clientView(row) { return { id: row.id, actor_id: row.actor_id, name: row.name, transport: row.transport, endpoint: row.endpoint, token_prefix: row.token_prefix, project_allowlist: parseJson(row.project_allowlist_json, []), tool_allowlist: parseJson(row.tool_allowlist_json, []), expires_at: row.expires_at, last_used_at: row.last_used_at || null, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, revoked_at: row.revoked_at || null }; }
function exchangeRequestView(row) { return { id: row.id, source_project_id: row.source_project_id, target_project_id: row.target_project_id, requester_actor_id: row.requester_actor_id, source_approver_actor_id: row.source_approver_actor_id || null, target_approver_actor_id: row.target_approver_actor_id || null, scope: parseJson(row.scope_json, {}), status: row.status, expires_at: row.expires_at, grant_id: row.grant_id || null, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at }; }
function exchangeGrantView(row) { return { id: row.id, request_id: row.request_id || null, source_project_id: row.source_project_id, target_project_id: row.target_project_id, grantee_actor_id: row.grantee_actor_id || null, scope: parseJson(row.scope_json, {}), status: row.status, expires_at: row.expires_at, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, revoked_at: row.revoked_at || null }; }
function normalizeScope(value = {}) { const source = value.scope && typeof value.scope === 'object' ? value.scope : value; return { project_ids: unique(source.project_ids || source.projects || (source.project_id ? [source.project_id] : [])), tools: unique(source.tools || source.tool_allowlist || []), actions: unique(source.actions || ['read']), resources: unique(source.resources || ['context']) }; }
function unique(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function parseJson(value, fallback) { try { return value == null ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function actorOf(principal, fallback) { return String(principal?.effectiveActorId || principal?.actorId || fallback); }
function bounded(value, max) { const text = String(value || '').trim(); if (!text || text.length > max) throw new PlatformError('invalid_input', 'value is invalid', {}, 422); return text; }
function clamp(value, min, max) { return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : min; }
function requireKey(value) { const key = String(value || ''); if (!KEY.test(key)) throw new PlatformError('idempotency_required', 'Idempotency-Key is required', {}, 400); return key; }
