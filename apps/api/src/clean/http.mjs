import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { routeParams } from './registry.mjs';
import { CleanDatabaseError } from './database.mjs';
import { CursorError } from './cursor.mjs';
import { OperationError } from './operations.mjs';
import { PlatformError } from './platform.mjs';
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { assertCleanV2, CLEAN_V2_SCHEMAS } from '@aiws/contracts/clean-v2';

const RETIRED_API_PREFIX = ['/api', 'v1'].join('/');
const CORS_REQUEST_HEADERS = new Set(['accept', 'content-type', 'idempotency-key', 'x-expected-revision', 'if-match', 'last-event-id', 'x-request-id']);

export function createCleanHttpHandler({ runtime, registry, maxBodyBytes = runtime?.config?.maxBodyBytes || 1024 * 1024 } = {}) {
  if (!runtime || !registry) throw new TypeError('clean_http_runtime_required');
  const mcpBoundary = runtime.p4 ? createMcpSdkBoundary(runtime) : null;
  return async function cleanHttpHandler(req, res) {
    const requestId = requestIdFor(req);
    const url = new URL(req.url || '/', 'http://v3-clean.local');
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (applyCors(req, res, runtime.config, registry, pathname)) return;
      if (pathname === '/livez' && req.method === 'GET') return sendSuccess(res, requestId, { status: 'live', runtime: 'v3-clean' }, { resourceType: 'health', policy: runtime.policy });
      if (runtime.recovery && pathname !== '/livez') await runtime.recovery;
      if (pathname === '/readyz' && req.method === 'GET') {
        if (!runtime.ready) throw new HttpError('not_ready', 'clean runtime is not ready', { reason: runtime.readinessReason || 'startup', receipt_reference: runtime.readinessReceipt || null }, 503, true);
        return sendSuccess(res, requestId, { status: 'ready', runtime: 'v3-clean', runtime_phase: runtime.runtimePhase, schema_family: runtime.metadata.family, user_version: runtime.metadata.user_version }, { resourceType: 'health', policy: runtime.policy });
      }
      if (pathname === RETIRED_API_PREFIX || pathname.startsWith(`${RETIRED_API_PREFIX}/`)) throw new HttpError('route_retired', 'the requested API route is retired', { migration_receipt_reference: runtime.retiredRouteReceipt }, 410, false);
      if (!runtime.ready && pathname.startsWith('/api/v2/')) throw new HttpError('not_ready', 'clean runtime is not ready', { reason: runtime.readinessReason || 'startup', receipt_reference: runtime.readinessReceipt || null }, 503, true);
      if (!pathname.startsWith('/api/v2/')) throw new HttpError('not_found', 'route not found', {}, 404, false);
      const entry = registry.match(req.method, pathname);
      if (!entry) throw new HttpError('not_found', 'route not found', { path: pathname }, 404, false);
      const params = routeParams(entry.path, pathname);
      if (entry.command_id === 'github.webhook.receive') {
        validateQuery(url, new Set());
        const rawBody = await readRaw(req, maxBodyBytes);
        const result = await runtime.p8Service.receiveGithubWebhook(rawBody, req.headers);
        return sendSuccess(res, requestId, result, { resourceType: 'delivery_webhook', outputSchema: entry.output_schema, policy: runtime.policy });
      }
      if (entry.command_id === 'setup.get') {
        validateQuery(url, new Set());
        return sendSuccess(res, requestId, runtime.identity?.setupState?.() || { needs_setup: false, actor_count: 0, bootstrap_actor_id: runtime.metadata.bootstrap_actor_id }, { resourceType: 'setup', outputSchema: entry.output_schema, policy: runtime.policy });
      }
      if (entry.command_id === 'setup.complete') {
        validateQuery(url, new Set());
        const body = await readJson(req, maxBodyBytes);
        validateFields(body, new Set(['display_name', 'team_name', 'ttl_seconds', 'idempotency_key', 'expected_revision']));
        const idempotencyKey = requireIdempotency(req, body);
        const expected = expectedRevisionOptional(req, body, 0);
        if (body.idempotency_key == null) body.idempotency_key = idempotencyKey;
        if (body.expected_revision == null) body.expected_revision = expected;
        assertCleanV2(entry.input_schema, body);
        if (!runtime.identity) throw new HttpError('not_ready', 'identity domain is unavailable', {}, 503, true);
        const result = await runtime.identity.setupComplete(body, { idempotencyKey, expectedRevision: expected });
        const safe = stripProof(result);
        const proof = result?.session?.proof;
        return sendSuccess(res, requestId, safe, { status: 201, resourceType: 'setup', outputSchema: entry.output_schema, revision: 1, etag: etagFor(safe, 1), policy: runtime.policy, setCookie: proof ? sessionCookie(proof, body.ttl_seconds) : null });
      }
      if (entry.command_id === 'setup.session.create') {
        validateQuery(url, new Set());
        assertLoopbackSameOrigin(req, runtime.config);
        const body = await readJson(req, maxBodyBytes);
        validateFields(body, new Set(['ttl_seconds', 'idempotency_key']));
        const idempotencyKey = requireIdempotency(req, body);
        const created = await runtime.identity.createLocalOwnerSession({ ttlSeconds: body.ttl_seconds, idempotencyKey });
        const proof = created.proof;
        const safe = sessionReceipt(created);
        return sendSuccess(res, requestId, safe, { status: 201, resourceType: 'session', outputSchema: entry.output_schema, revision: safe.session?.revision || 1, etag: etagFor(safe, safe.session?.revision || 1), policy: runtime.policy, setCookie: proof ? sessionCookie(proof, body.ttl_seconds) : null });
      }
      // MCP and Gateway have their own proof at the transport boundary.  All
      // other Clean routes continue to use the session principal resolver.
      const actor = runtime.p4 && entry.phase === 'p4' && ['mcp.rpc', 'gateway.forward'].includes(entry.command_id)
        ? null
        : runtime.p2 && runtime.identity
          ? runtime.identity.principalFromRequest(req)
          : runtime.platform.actorContext({ actorId: req.headers['x-actor-id'], projectId: req.headers['x-project-id'], scopes: parseScopes(req.headers['x-scopes']) });
      if (runtime.p10 && entry.phase === 'p10') {
        return await handleP5Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader: () => readJson(req, maxBodyBytes) });
      }
      if (runtime.p9 && entry.phase === 'p9') {
        return await handleP9Route({ entry, url, req, res, requestId, runtime, actor });
      }
      if (runtime.p8 && entry.phase === 'p8') {
        return await handleP5Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader: () => readJson(req, maxBodyBytes) });
      }
      if (runtime.p7 && entry.phase === 'p7') {
        return await handleP5Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader: () => readJson(req, Math.max(maxBodyBytes, entry.command_id === 'asset.capture' ? 36 * 1024 * 1024 : maxBodyBytes)) });
      }
      if (runtime.p6 && entry.phase === 'p6') {
        return await handleP5Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader: () => readJson(req, maxBodyBytes) });
      }
      if (runtime.p5 && entry.phase === 'p5') {
        return await handleP5Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader: () => readJson(req, Math.max(maxBodyBytes, entry.command_id === 'attachment.create' ? 15 * 1024 * 1024 : maxBodyBytes)) });
      }
      if (runtime.p4 && entry.phase === 'p4') {
        return await handleP4Route({ entry, params, url, req, res, requestId, runtime, actor, mcpBoundary, bodyReader: () => readJson(req, maxBodyBytes) });
      }
      if (runtime.p3 && runtime.projectWorkflow && entry.phase === 'p3') {
        return await handleP3Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader: () => readJson(req, maxBodyBytes) });
      }
      if (runtime.p2 && runtime.identity && entry.command_id !== 'operations.get' && entry.command_id !== 'operations.events' && entry.command_id !== 'operations.cancel') {
        return await handleIdentityRoute({ entry, params, url, req, res, requestId, runtime, actor, bodyReader: () => readJson(req, maxBodyBytes) });
      }
      if (entry.command_id === 'operations.get') {
        validateQuery(url, new Set());
        const operation = runtime.operations.get(params.id, { actorId: actor.actorId, projectId: actor.projectId });
        assertOperationAuthorized(runtime, actor, operation, 'read');
        return sendSuccess(res, requestId, operation, { resourceType: 'operation', outputSchema: entry.output_schema, revision: operation.revision, etag: etagFor(operation), policy: runtime.policy });
      }
      if (entry.command_id === 'operations.events') {
        validateQuery(url, new Set(['format', 'cursor', 'limit']));
        const format = singleQueryValue(url, 'format');
        if (format != null && format !== 'json') throw new HttpError('schema_invalid', 'event format must be json when provided', {}, 400, false);
        const queryCursor = singleQueryValue(url, 'cursor');
        if (queryCursor === '') throw new HttpError('schema_invalid', 'event cursor must not be empty', {}, 400, false);
        const headerCursor = req.headers['last-event-id'] == null ? null : String(req.headers['last-event-id']);
        if (queryCursor != null && headerCursor != null && queryCursor !== headerCursor) throw new HttpError('invalid_request', 'cursor query and Last-Event-ID differ', {}, 400, false);
        const limit = replayLimit(url);
        const operation = runtime.operations.get(params.id, { actorId: actor.actorId, projectId: actor.projectId });
        assertOperationAuthorized(runtime, actor, operation, 'read');
        const replayInput = { actorId: actor.actorId, projectId: actor.projectId, operationId: params.id, cursor: queryCursor ?? headerCursor, limit };
        const wantsSse = format !== 'json' && String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
        if (!wantsSse) {
          const replay = runtime.events.replay(replayInput);
          const terminal = replay.terminal || isTerminalOperation(operation.status);
          return sendSuccess(res, requestId, { events: replay.events, next_cursor: replay.next_cursor, terminal, resource: { id: operation.operation_id, type: 'operation', revision: operation.revision } }, { resourceType: 'operation_events', outputSchema: entry.output_schema, revision: operation.revision, etag: etagFor(operation), policy: runtime.policy });
        }
        const buffered = [];
        let initialized = false;
        let closed = false;
        let lastSequence = 0;
        let heartbeat = null;
        const writeEvent = (event) => {
          if (closed || event.sequence <= lastSequence) return;
          try { assertOperationAuthorized(runtime, actor, operation, 'read'); } catch { closeStream(); return; }
          lastSequence = event.sequence;
          res.write(runtime.events.sseFrames({ events: [event], terminal: false }, { heartbeat: false }));
          if (/operation\.(?:succeeded|failed|cancelled|expired)$/.test(event.type)) closeStream();
        };
        const unsubscribe = runtime.events.subscribe({ operationId: params.id }, (event) => {
          if (!initialized) buffered.push(event);
          else writeEvent(event);
        });
        let replay;
        try { replay = runtime.events.replay(replayInput); } catch (error) { unsubscribe(); throw error; }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'x-request-id': requestId });
        res.flushHeaders?.();
        res.write(runtime.events.sseFrames(replay, { heartbeat: false }));
        lastSequence = replay.cursor_sequence;
        initialized = true;
        for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) writeEvent(event);
        if (!closed && (replay.terminal || isTerminalOperation(operation.status))) closeStream();
        if (!closed) {
          res.write(': heartbeat\n\n');
          heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15_000);
          heartbeat.unref?.();
          res.once('close', closeStream);
        }
        return;

        function closeStream() {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
          if (!res.writableEnded) res.end();
        }
      }
      if (entry.command_id === 'operations.cancel') {
        validateQuery(url, new Set());
        const body = await readJson(req, maxBodyBytes);
        validateFields(body, new Set(['expected_revision', 'idempotency_key', 'reason']));
        validateCancelBody(body);
        const idempotencyKey = requireIdempotency(req, body);
        const expected = expectedRevision(req, body);
        const requestHash = sha256Hex(canonicalJson({ operation_id: params.id, expected_revision: expected, reason: body.reason ?? null }));
        const operation = runtime.operations.get(params.id, { actorId: actor.actorId, projectId: actor.projectId });
        assertOperationAuthorized(runtime, actor, operation, 'run');
        const result = await runtime.operations.cancel(params.id, { actorId: actor.actorId, projectId: actor.projectId, expectedRevision: expected, idempotencyKey, requestHash, reason: body.reason });
        return sendSuccess(res, requestId, result, { status: 202, resourceType: 'operation', outputSchema: entry.output_schema, revision: result.revision, etag: etagFor(result), policy: runtime.policy });
      }
      throw new HttpError('not_found', 'route not found', {}, 404, false);
    } catch (error) {
      return sendError(res, requestId, error, runtime);
    }
  };
}

async function handleP9Route({ entry, url, req, res, requestId, runtime, actor }) {
  if (entry.command_id !== 'events.project.replay') throw new HttpError('not_found', 'route not found', {}, 404, false);
  validateQuery(url, new Set(['project_id', 'cursor', 'limit', 'format']));
  const projectId = singleQueryValue(url, 'project_id');
  if (!projectId) throw new HttpError('schema_invalid', 'project_id is required', {}, 400, false);
  const format = singleQueryValue(url, 'format');
  if (format != null && format !== 'json') throw new HttpError('schema_invalid', 'event format must be json when provided', {}, 400, false);
  const queryCursor = singleQueryValue(url, 'cursor');
  if (queryCursor === '') throw new HttpError('schema_invalid', 'event cursor must not be empty', {}, 400, false);
  if (queryCursor != null && /^\d+$/.test(queryCursor)) throw new HttpError('cursor_invalid', 'query cursor must be signed', {}, 400, false);
  const limit = replayLimit(url, 200);
  const queryInput = { project_id: projectId, ...(queryCursor == null ? {} : { cursor: queryCursor }), ...(singleQueryValue(url, 'limit') == null ? {} : { limit }), ...(format == null ? {} : { format }) };
  assertCleanV2(entry.input_schema, queryInput);
  authorizeProjectEvents(runtime, actor, projectId);
  const headerCursor = req.headers['last-event-id'] == null ? null : String(req.headers['last-event-id']).trim();
  if (headerCursor != null && !/^\d+$/.test(headerCursor)) throw new HttpError('cursor_invalid', 'Last-Event-ID must be a global event sequence', {}, 400, false);
  const replayInput = { actorId: actor.actorId, projectId, cursor: headerCursor ?? queryCursor, limit };
  const wantsSse = format !== 'json' && String(req.headers.accept || '').toLowerCase().includes('text/event-stream');
  if (!wantsSse) {
    const replay = runtime.events.replay(replayInput);
    const data = { events: replay.events, project_id: projectId, next_cursor: replay.next_cursor, cursor_sequence: replay.cursor_sequence, has_more: replay.has_more };
    return sendSuccess(res, requestId, data, { resourceType: 'project_events', outputSchema: entry.output_schema, policy: runtime.policy });
  }

  const buffered = [];
  let initialized = false;
  let closed = false;
  let lastSequence = Number(headerCursor || 0);
  let heartbeat = null;
  const reauthorize = () => {
    const principal = runtime.identity.principalFromRequest(req);
    authorizeProjectEvents(runtime, principal, projectId);
    return principal;
  };
  const closeStream = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  const writeEvent = (event) => {
    if (closed || event.sequence <= lastSequence) return;
    try { reauthorize(); } catch { closeStream(); return; }
    lastSequence = event.sequence;
    res.write(runtime.events.sseFrames({ events: [event], terminal: false }, { heartbeat: false }));
  };
  const unsubscribe = runtime.events.subscribe({ projectId }, (event) => {
    if (!initialized) buffered.push(event);
    else writeEvent(event);
  });
  let replay;
  try {
    reauthorize();
    replay = runtime.events.replay(replayInput);
  } catch (error) {
    unsubscribe();
    throw error;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'x-request-id': requestId });
  res.flushHeaders?.();
  res.write(runtime.events.sseFrames(replay, { heartbeat: false }));
  lastSequence = replay.cursor_sequence;
  initialized = true;
  for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) writeEvent(event);
  if (replay.has_more) closeStream();
  if (!closed) {
    const writeHeartbeat = () => {
      try { reauthorize(); } catch { closeStream(); return; }
      if (!closed) res.write(': heartbeat\n\n');
    };
    writeHeartbeat();
    heartbeat = setInterval(writeHeartbeat, 15_000);
    heartbeat.unref?.();
    res.once('close', closeStream);
  }
}

function authorizeProjectEvents(runtime, principal, projectId) {
  if (!runtime.authorization) throw new HttpError('not_ready', 'authorization is unavailable', {}, 503, true);
  return runtime.authorization.assert(principal, 'operations:read', projectId, { resource: 'events' });
}

async function handleP5Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader }) {
  if (!actor) throw new HttpError('authentication_required', 'active session proof is required', {}, 401, false);
  const command = entry.command_id;
  const schema = CLEAN_V2_SCHEMAS[entry.input_schema] || { properties: {} };
  const allowedQuery = new Set(req.method === 'GET' ? Object.keys(schema.properties || {}) : []);
  validateQuery(url, allowedQuery);
  let body = {};
  if (req.method !== 'GET') {
    body = await bodyReader();
    hydrateP5MutationHeaders(entry, req, body);
    validateFields(body, new Set(Object.keys(schema.properties || {})));
  }
  const args = p5DispatchArguments(command, params, url, body, schema);
  const dispatched = await runtime.dispatcher.dispatch(command, args, actor, { transport: 'rest' });
  let data = dispatched.result;
  // Domain services keep ergonomic direct views for their in-process callers;
  // the public transport normalizes those views to the registered receipt
  // shape without changing the service contract.
  if (command === 'assist.session.create' && data && data.id && !data.session) data = { session: data, operation: null };
  let status = p5Status(command, data);
  const operationId = data?.operation?.operation_id || data?.operation_id;
  if (entry.long_running && operationId) {
    data = runtime.operations.get(operationId, { actorId: actor.actorId, projectId: data?.project_id || null });
    status = 202;
  }
  if (['attachment.content', 'attachment.preview'].includes(command)
      && /(?:^|,)\s*application\/octet-stream(?:\s*;|\s*,|$)/i.test(String(req.headers.accept || ''))) {
    return sendBinaryAttachment(res, requestId, data, runtime);
  }
  if (command === 'asset.content') return sendBinaryAsset(res, requestId, data);
  const revision = p5Revision(data);
  return sendSuccess(res, requestId, data, { status, resourceType: p5ResourceType(command), outputSchema: entry.output_schema, revision, etag: etagFor(data, revision), policy: runtime.policy, preserveKeys: command === 'provider.codex.discovery' ? ['credential_available'] : [] });
}

function sendBinaryAttachment(res, requestId, value, runtime) {
  const encoded = String(value?.content_base64 || '');
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); } catch { throw new HttpError('attachment_unavailable', 'attachment content is unavailable', {}, 410, false); }
  const mediaType = String(value?.media_type || 'application/octet-stream').split(';', 1)[0] || 'application/octet-stream';
  const hash = value?.attachment?.content_sha256 || value?.attachment?.preview_sha256 || sha256Hex(bytes);
  const headers = {
    'content-type': mediaType,
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
    etag: `sha256:${hash}`
  };
  res.writeHead(200, headers);
  res.end(bytes);
  return null;
}

function sendBinaryAsset(res, requestId, value) {
  const encoded = String(value?.content_base64 || '');
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); } catch { throw new HttpError('asset_unavailable', 'asset content is unavailable', {}, 410, false); }
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new HttpError('asset_tamper', 'asset content encoding changed', {}, 503, false);
  const mediaType = String(value?.media_type || 'application/octet-stream').split(';', 1)[0] || 'application/octet-stream';
  const hash = value?.version?.content_sha256 || sha256Hex(bytes);
  res.writeHead(200, { 'content-type': mediaType, 'content-length': String(bytes.byteLength), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId, etag: `sha256:${hash}` });
  res.end(bytes);
  return null;
}

function p5DispatchArguments(command, params, url, body, schema) {
  const args = { ...body, ...params };
  if (args.id) {
    if (command === 'assist.turn.create' || command.startsWith('assist.session') || command.startsWith('assist.goal') || command.startsWith('assist.reference')) args.session_id ||= args.id;
    else if (command.startsWith('assist.turn')) args.turn_id ||= args.id;
    else if (command.startsWith('attachment.')) args.attachment_id ||= args.id;
    else if (command.startsWith('change.batch')) args.batch_id ||= args.id;
    else if (command.startsWith('approval.')) args.approval_id ||= args.id;
    else if (command.startsWith('user.input')) args.input_id ||= args.id;
    else if (command.startsWith('proposal.')) args.proposal_id ||= args.id;
    else if (command.startsWith('terminal.')) args.terminal_id ||= args.id;
    else if (command.startsWith('bridge.')) args.device_id ||= args.id;
    else if (command.startsWith('runner.profile')) args.profile_id ||= args.id;
    else if (command.startsWith('execution.')) args.execution_id ||= args.id;
    else if (command === 'parser.run.start') args.asset_id ||= args.id;
    else if (command.startsWith('parser.run')) args.parser_run_id ||= args.id;
    else if (command.startsWith('asset.')) args.asset_id ||= args.id;
    else if (command.startsWith('evidence.')) args.execution_id ||= args.id;
    else if (command === 'quality.list' || command === 'quality.start') args.execution_id ||= args.id;
    else if (command.startsWith('quality.')) args.quality_review_id ||= args.id;
    else if (command.startsWith('outcome.waiver.revoke')) args.waiver_id ||= args.id;
    else if (command.startsWith('outcome.')) args.execution_id ||= args.id;
    else if (command === 'github.repository.list') args.profile_id ||= args.id;
    else if (command.startsWith('delivery.')) args.delivery_id ||= args.id;
    else if (command.startsWith('deployment.candidate') || command === 'deployment.verify') args.candidate_id ||= args.id;
    else if (command.startsWith('import.')) args.import_id ||= args.id;
    else if (command === 'operations.replay') args.operation_id ||= args.id;
  }
  const properties = schema.properties || {};
  if (reqIsGetSchema(schema)) {
    for (const key of Object.keys(properties)) {
      if (args[key] != null) continue;
      const value = queryValue(url, key);
      if (value == null) continue;
      const definition = properties[key] || {};
      if (definition.type === 'integer' || definition.anyOf?.some((item) => item.type === 'integer')) {
        if (!/^\d+$/.test(value)) throw new HttpError('schema_invalid', `${key} must be an integer`, {}, 400, false);
        args[key] = Number(value);
      } else if (definition.type === 'boolean' || definition.anyOf?.some((item) => item.type === 'boolean')) {
        if (value !== 'true' && value !== 'false') throw new HttpError('schema_invalid', `${key} must be a boolean`, {}, 400, false);
        args[key] = value === 'true';
      } else args[key] = value;
    }
  }
  // Path aliases are transport details. Keep only fields declared by the
  // command schema before the dispatcher performs its strict validation.
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) delete args[key];
  return args;
}

function reqIsGetSchema(schema) { return schema && !Object.hasOwn(schema.properties || {}, 'idempotency_key'); }

function hydrateP5MutationHeaders(entry, req, body) {
  const key = requireIdempotency(req, body); if (body.idempotency_key == null) body.idempotency_key = key;
  if (body.expected_revision == null) {
    const raw = req.headers['x-expected-revision'] || req.headers['if-match'];
    if (raw == null && entry.expected_revision === 'parent') body.expected_revision = 0;
    else {
      const value = parseRevision(String(raw || ''));
      if (!Number.isInteger(value) || value < 0 || (entry.expected_revision !== 'parent' && value < 1)) throw new HttpError('expected_revision_required', 'expected revision is required', {}, 400, false);
      body.expected_revision = value;
    }
  } else {
    const value = Number(body.expected_revision); if (!Number.isInteger(value) || value < 0 || (entry.expected_revision !== 'parent' && value < 1)) throw new HttpError('schema_invalid', 'expected_revision is invalid', {}, 400, false); body.expected_revision = value;
  }
  return body;
}

function p5Status(command, value) {
  if (['assist.turn.create', 'assist.turn.retry', 'change.batch.apply', 'change.batch.undo', 'runner.profile.probe', 'execution.start', 'execution.resume', 'execution.stage.replay', 'parser.run.start', 'parser.run.retry', 'quality.start', 'quality.retry', 'outcome.evaluate', 'delivery.submit', 'delivery.intent.create', 'delivery.intent.ready', 'delivery.intent.merge', 'delivery.reconcile', 'deployment.verify', 'backup.create', 'restore.prepare', 'system.reset.prepare', 'operations.replay', 'provider.codex.device_login.start', 'provider.codex.device_login.cancel'].includes(command)) return 202;
  if (['assist.session.create', 'assist.reference.create', 'attachment.create', 'change.batch.create', 'approval.create', 'user.input.create', 'proposal.create', 'terminal.open', 'bridge.pair', 'bridge.transfer.create', 'runner.profile.create', 'execution.create', 'execution.replan', 'asset.capture', 'asset.relation.create', 'asset.attest', 'outcome.waiver.create', 'outcome.waiver.revoke', 'delivery.policy.create', 'deployment.candidate.create', 'brief.template.create', 'project.deletion.prepare', 'repository.deletion.prepare', 'assist.session.fork', 'assist.session.side_thread', 'assist.configuration.create', 'assist.review.comment', 'assist.review.request_changes', 'provider.codex.discovery.import'].includes(command)) return value?.replayed ? 200 : 201;
  return 200;
}

function p5Revision(value) { return value?.revision ?? value?.session?.revision ?? value?.turn?.revision ?? value?.goal?.revision ?? value?.attachment?.revision ?? value?.batch?.revision ?? value?.approval?.revision ?? value?.input?.revision ?? value?.proposal?.revision ?? value?.terminal?.revision ?? value?.device?.revision ?? value?.transfer?.revision ?? value?.profile?.revision ?? value?.template?.revision ?? value?.comment?.revision ?? value?.execution?.revision ?? value?.asset?.revision ?? value?.parser_run?.revision ?? value?.quality_review?.revision ?? value?.evaluation?.revision ?? value?.waiver?.revision ?? value?.policy?.revision ?? value?.delivery?.revision ?? value?.intent?.revision ?? value?.intent?.generation ?? value?.candidate?.revision ?? value?.operation?.revision ?? null; }
function p5ResourceType(command) { if (command.startsWith('provider.codex.discovery')) return 'provider_discovery'; if (command.startsWith('provider.codex.device_login')) return 'provider_device_login'; if (command.startsWith('provider.github.')) return 'provider_github_setup'; if (command.startsWith('assist.review')) return 'assist_review_comment'; if (command.startsWith('assist.')) return command.startsWith('assist.turn') ? 'assist_turn' : 'assist_session'; if (command.startsWith('profile.')) return 'profile'; if (command.startsWith('brief.template')) return 'brief_template'; if (command.startsWith('project.deletion')) return 'project_deletion_intent'; if (command.startsWith('repository.deletion')) return 'repository_deletion_intent'; if (command.startsWith('attachment.')) return 'attachment'; if (command.startsWith('file.')) return 'file_ref'; if (command.startsWith('change.batch')) return 'file_change_batch'; if (command.startsWith('approval.')) return 'runtime_approval'; if (command.startsWith('user.input')) return 'runtime_user_input'; if (command.startsWith('proposal.')) return 'semantic_proposal'; if (command.startsWith('terminal.')) return 'terminal_session'; if (command.startsWith('bridge.transfer')) return 'bridge_transfer'; if (command.startsWith('bridge.')) return 'bridge_device'; if (command.startsWith('runner.profile')) return 'runner_profile'; if (command.startsWith('execution.')) return 'execution'; if (command.startsWith('asset.') || command.startsWith('evidence.')) return 'asset'; if (command.startsWith('parser.')) return 'parser_run'; if (command.startsWith('quality.')) return 'quality_review'; if (command.startsWith('outcome.')) return 'outcome_evaluation'; if (command.startsWith('delivery.')) return 'delivery'; if (command.startsWith('github.')) return 'github_repository'; if (command.startsWith('deployment.')) return 'deployment_candidate'; if (command.startsWith('backup.') || command.startsWith('restore.') || command.startsWith('system.reset')) return 'backup'; if (command.startsWith('import.')) return 'import_batch'; if (command.startsWith('cas.gc')) return 'cas_gc'; return 'resource'; }

async function handleP4Route({ entry, params, url, req, res, requestId, runtime, actor, mcpBoundary, bodyReader }) {
  const command = entry.command_id;
  let body = {};
  let principal = actor;

  // Protocol transports carry their own envelope and proof.  The MCP token is
  // deliberately never copied into a domain argument or a receipt.
  if (command === 'mcp.rpc') {
    body = await bodyReader();
    return handleMcpRpc({ body, req, res, requestId, runtime, mcpBoundary });
  }
  if (command === 'gateway.forward') {
    body = await bodyReader();
    return handleGatewayForward({ entry, body, req, res, requestId, runtime });
  }
  if (!principal) throw new HttpError('authentication_required', 'active session proof is required', {}, 401, false);

  const allowedQuery = p4QueryFields(command);
  validateQuery(url, allowedQuery);
  if (req.method !== 'GET') {
    body = await bodyReader();
    // Header values are authoritative and are also accepted by the browser
    // adapter, which intentionally keeps them out of JSON payloads.
    hydrateP4MutationHeaders(entry, req, body);
  }
  const args = p4DispatchArguments(command, params, url, body);
  if (command === 'context.read' && !args.node_id) throw new HttpError('schema_invalid', 'node_id is required', {}, 400, false);
  if (command === 'context.projection.events' && args.format !== 'json' && String(req.headers.accept || '').toLowerCase().includes('text/event-stream')) {
    assertCleanV2(entry.input_schema, args);
    return handleProjectionEventsSse({ args, req, res, runtime, principal });
  }
  const dispatched = await runtime.dispatcher.dispatch(command, args, principal, { transport: 'rest' });
  let data = dispatched.result;
  let status = p4Status(command, data);

  const operationId = data?.operation?.operation_id || data?.operation_id;
  const revision = p4Revision(data);
  // Long-running commands expose the canonical shared operation receipt.  The
  // domain job remains available through the project-scoped job endpoint.
  if (entry.long_running && operationId) {
    const operation = runtime.operations.get(operationId, { actorId: principal.actorId, projectId: params.project_id || data?.project_id || null });
    data = operation;
    status = 202;
  }
  return sendSuccess(res, requestId, data, { status, resourceType: p4ResourceType(command), outputSchema: entry.output_schema, revision: revision ?? p4Revision(data), etag: etagFor(data, revision), policy: runtime.policy, preserveKeys: command === 'mcp.client.create' && !data.replayed ? ['token'] : [] });
}

function p4DispatchArguments(command, params, url, body) {
  const args = { ...body, ...params };
  for (const key of ['q', 'query', 'node_id', 'version_id', 'project_id', 'status']) {
    const value = queryValue(url, key);
    if (value != null && args[key] == null) args[key] = value;
  }
  if (['context.search'].includes(command)) args.limit = queryNumber(url, 'limit', 100);
  if (command === 'context.projection.events') {
    args.cursor = queryNumber(url, 'cursor', 0);
    args.limit = queryNumber(url, 'limit', 500);
    const format = queryValue(url, 'format');
    if (format != null) args.format = format;
  }
  if (command === 'mcp.client.revoke') args.client_id = params.id;
  if (command.startsWith('exchange.request.') && params.id) args.request_id = params.id;
  if (command.startsWith('exchange.grant.') && params.id) args.grant_id = params.id;
  if (command === 'exchange.request.create') args.source_project_id ||= params.project_id;
  return args;
}

function handleProjectionEventsSse({ args, req, res, runtime, principal }) {
  let initialized = false;
  let closed = false;
  let lastSequence = 0;
  let heartbeat = null;
  const buffered = [];
  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  const writeEvent = (event) => {
    if (closed || event.sequence <= lastSequence) return;
    try { runtime.context.job(args.project_id, args.job_id, principal); } catch { close(); return; }
    lastSequence = event.sequence;
    res.write(runtime.events.sseFrames({ events: [event], terminal: false }, { heartbeat: false }));
    if (/context_projection\.(?:completed|failed|cancelled)$/.test(event.type)) close();
  };
  const unsubscribe = runtime.events.subscribe({ aggregateType: 'context_projection_job', aggregateId: args.job_id }, (event) => {
    if (!initialized) buffered.push(event);
    else writeEvent(event);
  });
  let replay;
  try { replay = runtime.context.eventsForJob(args.project_id, args.job_id, principal, args.cursor, args.limit); }
  catch (error) { unsubscribe(); throw error; }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive' });
  res.flushHeaders?.();
  res.write(runtime.events.sseFrames(replay, { heartbeat: false }));
  lastSequence = replay.events.at(-1)?.sequence || Number(args.cursor || 0);
  initialized = true;
  for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) writeEvent(event);
  if (replay.terminal) close();
  else if (!closed) {
    res.write(': heartbeat\n\n');
    heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15_000);
    heartbeat.unref?.();
    req.once('close', close);
  }
}

function p4Status(command, data) {
  if (['context.projection.rebuild', 'context.projection.cancel', 'context.projection.retry'].includes(command)) return 202;
  if (['context.source.create', 'context.selection.create', 'context.pack.create', 'mcp.client.create', 'exchange.request.create', 'exchange.grant.pack.create'].includes(command)) return data?.replayed ? 200 : 201;
  return 200;
}

async function handleMcpRpc({ body, req, res, requestId, runtime, mcpBoundary }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('schema_invalid', 'MCP request must be an object', {}, 400, false);
  const id = Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null;
  const params = body.params && typeof body.params === 'object' ? body.params : {};
  const token = mcpTokenFromRequest(req);
  let auth;
  try {
    auth = runtime.mcp.authenticate(token, { projectId: params.arguments?.project_id || params.project_id || null, tool: params.name || null });
  } catch (error) {
    return sendMcpError(res, requestId, id, error);
  }
  if (!mcpBoundary) return sendMcpError(res, requestId, id, new HttpError('not_ready', 'MCP transport is unavailable', {}, 503, true));
  const requestedVersion = String(req.headers['mcp-protocol-version'] || '2025-06-18');
  if (requestedVersion !== '2025-06-18') return sendMcpError(res, requestId, id, new HttpError('mcp_protocol_unsupported', 'MCP protocol version is not supported', { supported: '2025-06-18' }, 400, false));
  req.auth = {
    token,
    clientId: auth.client.id,
    scopes: ['mcp:call'],
    expiresAt: Math.floor(Date.parse(auth.client.expires_at) / 1000),
    extra: { actor_id: auth.actor_id, project_ids: auth.project_ids, tools: auth.tools }
  };
  res.setHeader('x-request-id', requestId);
  res.setHeader('mcp-protocol-version', '2025-06-18');
  try {
    await mcpBoundary.handle(req, res, body);
    return;
  } catch (error) {
    if (res.headersSent) throw error;
    return sendMcpError(res, requestId, id, error);
  }
}

function createMcpSdkBoundary(runtime) {
  const sessions = new Map();
  const createSession = (clientId) => {
    const server = new McpSdkServer({ name: 'aiws-v3-clean', version: '4' }, { capabilities: { tools: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const auth = authFromMcpExtra(extra);
      return { tools: filteredMcpTools(runtime.dispatcher.tools(), auth).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: CLEAN_V2_SCHEMAS[tool.input_schema],
        outputSchema: CLEAN_V2_SCHEMAS[tool.output_schema],
        annotations: { readOnlyHint: tool.mapping === 'resource', openWorldHint: false }
      })) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const auth = authFromMcpExtra(extra);
      const name = String(request.params.name || '');
      const args = request.params.arguments && typeof request.params.arguments === 'object' ? { ...request.params.arguments } : {};
      const projectId = args.project_id || null;
      runtime.mcp.authenticate(extra.authInfo?.token, { projectId, tool: name });
      const dispatched = await runtime.mcp.dispatch(name, args, mcpPrincipal(auth, projectId), { events: runtime.events, projectWorkflow: runtime.projectWorkflow });
      return {
        command_id: dispatched.command_id,
        command_version: dispatched.command_version,
        structuredContent: dispatched.result,
        content: [{ type: 'text', text: JSON.stringify(dispatched.result) }],
        _meta: { command_id: dispatched.command_id, command_version: dispatched.command_version }
      };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
      const auth = authFromMcpExtra(extra);
      return { resources: auth.project_ids.map((projectId) => ({ uri: `aiws://context/${projectId}/map`, name: `Context map ${projectId}`, mimeType: 'application/json' })) };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const auth = authFromMcpExtra(extra);
      const uri = String(request.params.uri || '');
      const match = uri.match(/^aiws:\/\/context\/([^/]+)\/map$/);
      if (!match) throw new PlatformError('not_found', 'MCP resource not found', {}, 404);
      runtime.mcp.authenticate(extra.authInfo?.token, { projectId: match[1], tool: 'context_map' });
      const dispatched = await runtime.mcp.dispatch('context_map', { project_id: match[1] }, mcpPrincipal(auth, match[1]));
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(dispatched.result) }], _meta: { command_id: dispatched.command_id } };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
    const connected = server.connect(transport);
    return { server, transport, connected, clientId };
  };
  return {
    async handle(req, res, body) {
      const sessionId = String(req.headers['mcp-session-id'] || '');
      let state = sessionId ? sessions.get(sessionId) : null;
      if (!state) {
        if (String(body?.method || '') !== 'initialize') throw new PlatformError('mcp_session_required', 'MCP initialize is required', {}, 400);
        state = createSession(req.auth.clientId);
      } else if (state.clientId !== req.auth.clientId) {
        throw new PlatformError('mcp_scope_denied', 'MCP session belongs to another client', {}, 403);
      }
      await state.connected;
      await state.transport.handleRequest(req, res, body);
      if (state.transport.sessionId && !sessions.has(state.transport.sessionId)) {
        sessions.set(state.transport.sessionId, state);
        state.transport.onclose = () => sessions.delete(state.transport.sessionId);
      }
    }
  };
}

function authFromMcpExtra(extra) {
  const info = extra?.authInfo;
  if (!info?.clientId || !info?.extra?.actor_id) throw new PlatformError('mcp_token_invalid', 'MCP authentication context is missing', {}, 401);
  return { client: { id: String(info.clientId) }, actor_id: String(info.extra.actor_id), project_ids: (info.extra.project_ids || []).map(String), tools: (info.extra.tools || []).map(String) };
}

function mcpPrincipal(auth, projectId) {
  return { actorId: auth.actor_id, effectiveActorId: auth.actor_id, subjectActorId: auth.actor_id, scopes: ['*'], projectId: projectId || null, mcpClientId: auth.client.id };
}

async function handleGatewayForward({ entry, body, req, res, requestId, runtime }) {
  const destination = body && typeof body === 'object' ? body : {};
  assertCleanV2(entry.input_schema, destination);
  const commandName = destination.name || destination.command || destination.tool || destination.command_id;
  const args = destination.arguments && typeof destination.arguments === 'object' ? destination.arguments : (destination.args && typeof destination.args === 'object' ? destination.args : {});
  const token = destination.mcp_token || mcpTokenFromRequest(req);
  const dispatch = async (payload) => {
    const name = payload.name || payload.command || payload.tool || payload.command_id;
    const callArgs = payload.arguments && typeof payload.arguments === 'object' ? payload.arguments : (payload.args && typeof payload.args === 'object' ? payload.args : {});
    const auth = runtime.mcp.authenticate(token, { projectId: callArgs.project_id || null, tool: name });
    const principal = { actorId: auth.actor_id, effectiveActorId: auth.actor_id, subjectActorId: auth.actor_id, scopes: ['*'], projectId: callArgs.project_id || null, mcpClientId: auth.client.id };
    return runtime.mcp.dispatch(name, callArgs, principal, { events: runtime.events, projectWorkflow: runtime.projectWorkflow, transport: 'gateway' });
  };
  // The signature covers the complete forwarding body, including the command
  // and arguments, but the token is only used in memory by the dispatcher.
  const forwarded = { ...destination, ...(commandName ? { name: commandName } : {}), arguments: args };
  const result = await runtime.gateway.forward({ headers: req.headers, method: req.method, path: new URL(req.url, 'http://v3-clean.local').pathname, body: destination, dispatch: () => dispatch(forwarded) });
  return sendSuccess(res, requestId, result, { resourceType: 'gateway_forward', outputSchema: entry.output_schema, policy: runtime.policy });
}

function sendMcpResult(res, requestId, id, result) {
  const payload = { jsonrpc: '2.0', id, result, request_id: requestId };
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId, 'mcp-protocol-version': '2025-06-18' });
  res.end(JSON.stringify(payload));
  return payload;
}

function sendMcpError(res, requestId, id, error) {
  const mapped = mapError(error);
  const payload = { jsonrpc: '2.0', id, error: { code: mcpErrorNumber(mapped.code), message: mapped.message, data: { code: mapped.code, details: mapped.details || {} } }, request_id: requestId };
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId, 'mcp-protocol-version': '2025-06-18' });
  res.end(JSON.stringify(payload));
  return payload;
}

function filteredMcpTools(tools, auth) {
  const allow = new Set((auth?.tools || []).map(String));
  if (!allow.size) return tools;
  return tools.filter((tool) => allow.has(tool.name) || allow.has(tool.command_id));
}

function mcpTokenFromRequest(req) {
  const direct = req.headers['x-aiws-mcp-token'];
  if (direct) return String(direct);
  const authorization = String(req.headers.authorization || '');
  return /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
}

function mcpErrorNumber(code) {
  if (code === 'mcp_method_not_found' || code === 'unknown_command') return -32601;
  if (code === 'schema_invalid' || code === 'unknown_field') return -32602;
  if (code === 'mcp_token_invalid' || code === 'authentication_required') return -32001;
  return -32000;
}

function p4QueryFields(command) {
  const common = new Set();
  if (command === 'context.source.list') return new Set(['q', 'query']);
  if (command === 'context.search') return new Set(['q', 'query', 'limit']);
  if (command === 'context.read' || command === 'context.node.get') return new Set(['node_id', 'version_id']);
  if (command === 'context.projection.events') return new Set(['cursor', 'limit', 'format']);
  if (command === 'mcp.client.list') return new Set(['project_id']);
  if (command === 'exchange.request.list' || command === 'exchange.grant.list') return new Set(['status']);
  return common;
}

function queryValue(url, name) {
  const value = url.searchParams.getAll(name);
  if (value.length > 1) throw new HttpError('schema_invalid', `${name} must be provided once`, {}, 400, false);
  return value[0] ?? null;
}

function queryNumber(url, name, fallback) {
  const value = queryValue(url, name);
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new HttpError('schema_invalid', `${name} must be an integer`, {}, 400, false);
  return Number(value);
}

function hydrateP4MutationHeaders(entry, req, body) {
  const idempotencyKey = requireIdempotency(req, body);
  if (body.idempotency_key == null) body.idempotency_key = idempotencyKey;
  if (body.expected_revision == null) {
    const raw = req.headers['x-expected-revision'] || req.headers['if-match'];
    if (raw == null) throw new HttpError('expected_revision_required', 'expected revision is required', {}, 400, false);
    const value = parseRevision(String(raw));
    if (!Number.isInteger(value) || value < 0) throw new HttpError('invalid_request', 'revision header is invalid', {}, 400, false);
    body.expected_revision = value;
  } else if (!Number.isInteger(Number(body.expected_revision)) || Number(body.expected_revision) < 0) {
    throw new HttpError('schema_invalid', 'expected_revision must be a non-negative integer', {}, 400, false);
  } else body.expected_revision = Number(body.expected_revision);
  return body;
}

function p4Revision(value) {
  return value?.revision ?? value?.resource_revision ?? value?.job?.revision ?? value?.source?.revision ?? value?.selection?.revision ?? value?.pack?.revision ?? value?.client?.revision ?? value?.request?.revision ?? value?.grant?.revision ?? value?.operation?.revision ?? null;
}

function p4ResourceType(command) {
  if (command.startsWith('context.projection')) return 'context_projection';
  if (command.startsWith('context.source')) return 'context_source';
  if (command.startsWith('context.selection')) return 'context_selection';
  if (command.startsWith('context.pack') || command === 'exchange.grant.pack.create') return 'context_pack';
  if (command.startsWith('context.')) return 'context';
  if (command.startsWith('mcp.')) return 'mcp';
  if (command.startsWith('exchange.request')) return 'exchange_request';
  if (command.startsWith('exchange.grant')) return 'exchange_grant';
  if (command.startsWith('gateway.')) return 'gateway';
  return 'resource';
}

async function handleP3Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader }) {
  const command = entry.command_id;
  validateQuery(url, command === 'project.list' ? new Set(['include_archived', 'status']) : new Set());
  let body = {};
  if (req.method !== 'GET') {
    body = await bodyReader();
    if (req.headers['idempotency-key'] && body.idempotency_key == null) body.idempotency_key = String(req.headers['idempotency-key']);
    hydrateMutationHeaders(entry, req, body);
    if (command === 'critic.evaluate') {
      // Critic status and issues are produced by the server adapter. Client
      // payloads may carry context, but cannot force a passing verdict.
      delete body.status;
      delete body.issues;
      delete body.candidate;
    }
    if (command === 'brief.confirm') body.brief_revision = Number(params.revision);
    assertCleanV2(entry.input_schema, body);
  }
  const service = runtime.projectWorkflow;
  let data;
  let status = 200;
  switch (command) {
    case 'project.list': data = { projects: service.listProjects(actor, { includeArchived: parseBooleanQuery(url, 'include_archived'), status: singleQueryValue(url, 'status') }) }; break;
    case 'project.create': data = p3ProjectEnvelope(await service.createProject(body, actor)); status = 201; break;
    case 'project.get': {
      const project = service.getProject(params.id, actor);
      data = p3ProjectEnvelope(project);
      break;
    }
    case 'project.update': data = p3ProjectEnvelope(await service.updateProject(params.id, body, actor)); break;
    case 'project.archive': data = p3ProjectEnvelope(await service.archiveProject(params.id, body, actor)); break;
    case 'project.restore': data = p3ProjectEnvelope(await service.restoreProject(params.id, body, actor)); break;
    case 'intake.get': data = { intake: service.getIntake(params.project_id, actor) }; break;
    case 'intake.submit': data = await service.submitIntake(params.project_id, body, actor); status = 202; break;
    case 'intake.retry': data = await service.retryIntake(params.project_id, body, actor); status = 202; break;
    case 'intake.cancel': data = await service.cancelIntake(params.project_id, body, actor); break;
    case 'brief.list': data = { briefs: service.listBriefs(params.project_id, actor) }; break;
    case 'brief.create': data = await service.createBrief(params.project_id, body, actor); status = 201; break;
    case 'brief.get': data = { revision_record: service.getBrief(params.project_id, Number(params.revision), actor) }; break;
    case 'brief.confirm': {
      const confirmed = await service.confirmBrief(params.project_id, { ...body, brief_revision: Number(params.revision) }, actor);
      const normalized = p3ProjectEnvelope(confirmed);
      data = { project: normalized.project, brief: confirmed.brief, operation: confirmed.operation, replayed: confirmed.replayed };
      break;
    }
    case 'brief.preview': data = { revision_record: service.previewBrief(params.project_id, Number(params.revision), actor) }; break;
    case 'repository.connection.list': data = { connections: service.listRepositoryConnections(params.project_id, actor) }; break;
    case 'repository.connection.create': data = await service.createRepositoryConnection(params.project_id, body, actor); status = 201; break;
    case 'repository.connection.update': data = await service.updateRepositoryConnection(params.id, body, actor); break;
    case 'repository.target.list': data = { targets: service.listRepositoryTargets(params.id, actor) }; break;
    case 'repository.target.create': data = await service.createRepositoryTarget(params.id, body, actor); status = 201; break;
    case 'repository.line.list': data = { lines: service.listRepositoryLines(params.project_id, actor) }; break;
    case 'repository.line.reconcile': data = await service.reconcileRepositoryLine(params.id, body, actor); break;
    case 'repository.workspace.list': data = { workspaces: service.listRepositoryWorkspaces(params.project_id, actor) }; break;
    case 'repository.workspace.create': data = await service.createRepositoryWorkspace(params.project_id, body, actor); status = 201; break;
    case 'repository.workspace.refresh': data = await service.refreshRepositoryWorkspace(params.id, body, actor); break;
    case 'repository.workspace.lock': data = await service.lockRepositoryWorkspace(params.id, body, actor); break;
    case 'repository.workspace.release': data = await service.releaseRepositoryWorkspace(params.id, body, actor); break;
    case 'workflow.list': data = { workflows: service.listWorkflows(params.project_id, actor) }; break;
    case 'workflow.get': data = { workflow: service.getWorkflow(params.project_id, actor) }; break;
    case 'workflow.revise': data = await service.reviseWorkflow(params.project_id, body, actor); break;
    case 'workflow.generation.list': data = { generations: service.listGenerations(params.project_id, actor) }; break;
    case 'generation.start': data = await service.startGeneration(params.project_id, body, actor); status = 202; break;
    case 'workflow.generation.get': {
      const expanded = service.getGeneration(params.id, actor);
      const { critic = null, proposal = null, ...generation } = expanded;
      data = { generation, critic, proposal };
      break;
    }
    case 'generation.retry': data = await service.retryGeneration(params.id, body, actor); status = 202; break;
    case 'generation.cancel': data = await service.cancelGeneration(params.id, body, actor); break;
    case 'critic.evaluate': data = await service.evaluateCritic(params.id, body, actor); break;
    case 'workflow.proposal.get': data = { proposal: service.getProposal(params.id, actor) }; break;
    case 'workflow.proposal.apply': data = await service.applyProposal(params.id, body, actor); break;
    case 'outcome.requirement.list': data = { requirements: service.listOutcomeRequirements(params.project_id, actor) }; break;
    case 'outcome.requirement.create': data = await service.createOutcomeRequirement(params.project_id, body, actor); status = 201; break;
    default: throw new HttpError('not_found', 'route not found', {}, 404, false);
  }
  if (entry.long_running) {
    const operationId = data?.operation?.operation_id || data?.operation_id;
    if (!operationId) throw new HttpError('internal_error', 'long-running command did not return an operation', {}, 500, false);
    data = runtime.operations.get(operationId, { actorId: actor.actorId });
  }
  const revision = p3Revision(data);
  return sendSuccess(res, requestId, data, { status, resourceType: p3ResourceType(command), outputSchema: entry.output_schema, revision, etag: etagFor(data, revision), policy: runtime.policy });
}

export class HttpError extends Error {
  constructor(code, message, details = {}, status = 500, retryable = false) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

function sendSuccess(res, requestId, data, { status = 200, resourceType = 'resource', revision = null, etag = null, policy = null, setCookie = null, outputSchema = null, preserveKeys = [] } = {}) {
  const scanned = redactResponse(data, policy, preserveKeys);
  data = scanned.value;
  if (outputSchema) {
    try {
      assertCleanV2(outputSchema, data);
    } catch {
      throw new HttpError('internal_error', 'response does not match the registered contract', { schema_id: outputSchema }, 500, false);
    }
  }
  const meta = { api_version: '2', resource_type: resourceType, redactions: scanned.redactions };
  if (revision != null) meta.resource_revision = Number(revision);
  if (etag) meta.etag = etag;
  const payload = { request_id: requestId, data, meta };
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId };
  if (etag) headers.etag = etag;
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
  return payload;
}

function redactResponse(value, policy, preserveKeys = []) {
  if (!policy) return { value, redactions: [] };
  const keys = new Set(preserveKeys.map(String));
  if (!keys.size) return policy.redact(value);
  const preserved = [];
  const clone = structuredCloneSafe(value);
  const walk = (node, path = '$') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}[${index}]`));
    for (const [key, item] of Object.entries(node)) {
      const current = `${path}.${key}`;
      if (keys.has(key) && (item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
        preserved.push([current, item]);
        delete node[key];
      } else walk(item, current);
    }
  };
  walk(clone);
  const scanned = policy.redact(clone);
  const restoredPaths = new Set(preserved.map(([path]) => path));
  scanned.redactions = scanned.redactions.filter((finding) => !restoredPaths.has(finding.path));
  for (const [path, original] of preserved) setPath(scanned.value, path, original);
  return scanned;
}

function structuredCloneSafe(value) {
  if (value === undefined) return value;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function setPath(root, path, value) {
  const parts = path.replace(/^\$\.?/, '').match(/[^.[\]]+|\[(\d+)\]/g)?.map((part) => part.startsWith('[') ? Number(part.slice(1, -1)) : part) || [];
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (current == null) return;
    current = current[part];
  }
  if (current && parts.length) current[parts[parts.length - 1]] = value;
}

async function handleIdentityRoute({ entry, params, url, req, res, requestId, runtime, actor, bodyReader }) {
  const command = entry.command_id;
  let body = {};
  if (req.method !== 'GET') body = await bodyReader();
  if (req.headers['idempotency-key'] && body.idempotency_key == null) body.idempotency_key = String(req.headers['idempotency-key']);
  if (req.method !== 'GET') hydrateMutationHeaders(entry, req, body);
  const allowed = identityFields(command);
  validateFields(body, allowed);
  if (req.method !== 'GET') assertCleanV2(entry.input_schema, body);
  validateQuery(url, new Set());
  let data;
  let status = 200;
  let revision = null;
  let setCookie = null;
  switch (command) {
    case 'account.get': data = { account: runtime.identity.account(actor) }; break;
    case 'account.update': data = await runtime.identity.updateActor(actor.actorId, body, actor, 'account.update'); break;
    case 'actor.list': data = { actors: runtime.identity.actors(actor) }; break;
    case 'actor.create': data = await runtime.identity.createActor(body, actor); status = 201; break;
    case 'actor.update': data = await runtime.identity.updateActor(params.id, body, actor); break;
    case 'actor.suspend': data = await runtime.identity.setActorStatus(params.id, 'suspended', body, actor); break;
    case 'actor.activate': data = await runtime.identity.setActorStatus(params.id, 'active', body, actor); break;
    case 'actor.revoke': data = await runtime.identity.setActorStatus(params.id, 'revoked', body, actor); break;
    case 'actor.switch': {
      const expected = expectedRevision(req, body);
      data = await runtime.identity.actorSwitch({ sessionId: params.id, targetActorId: body.target_actor_id || body.effective_actor_id, principal: actor, expectedRevision: expected, idempotencyKey: requireIdempotency(req, body) });
      break;
    }
    case 'session.list': data = { sessions: runtime.identity.sessions(actor) }; break;
    case 'session.create': {
      data = await runtime.identity.createSession({ subjectActorId: actor.subjectActorId, effectiveActorId: actor.effectiveActorId, ttlSeconds: body.ttl_seconds, actorId: actor.actorId, idempotencyKey: requireIdempotency(req, body), expectedRevision: body.expected_revision });
      setCookie = data.proof ? sessionCookie(data.proof, body.ttl_seconds) : null;
      data = sessionReceipt(data);
      status = 201;
      break;
    }
    case 'session.revoke': data = sessionReceipt(await runtime.identity.revokeSession(params.id, { actorId: actor.actorId, expectedRevision: expectedRevision(req, body), idempotencyKey: requireIdempotency(req, body), reason: body.reason })); break;
    case 'team.list': data = { teams: runtime.identity.teams(actor) }; break;
    case 'team.create': data = await runtime.identity.createTeam(body, actor); status = 201; break;
    case 'team.get': data = { team: runtime.identity.team(params.id, actor) }; break;
    case 'team.status': data = await runtime.identity.setTeamStatus(params.id, body.status, body, actor); break;
    case 'team.members.list': data = { memberships: runtime.identity.memberships(params.id, actor) }; break;
    case 'team.member.grant': data = await runtime.identity.grantMembership(params.id, body, actor); status = 201; break;
    case 'team.member.status': data = await runtime.identity.setMembershipStatus(params.membership_id, body.status, body, actor); break;
    case 'project.members.list': data = { memberships: runtime.identity.projectMembers(params.project_id, actor) }; break;
    case 'membership.grant': data = await runtime.identity.grantProjectMembership(params.project_id, body, actor); status = 201; break;
    case 'membership.status': data = await runtime.identity.setProjectMembershipStatus(params.project_id, params.membership_id, body.status, body, actor); break;
    case 'project.invitations.list': data = { invitations: runtime.identity.projectInvitations(params.project_id, actor) }; break;
    case 'invitation.create': data = await runtime.identity.createProjectInvitation(params.project_id, body, actor); status = 201; break;
    case 'invitation.accept': data = await runtime.identity.acceptProjectInvitation(params.project_id, params.invitation_id, body, actor); break;
    case 'invitation.revoke': data = await runtime.identity.revokeProjectInvitation(params.project_id, params.invitation_id, body, actor); break;
    case 'project.permissions.list': data = { entries: runtime.identity.aclEntries(params.project_id, actor) }; break;
    case 'acl.set': data = await runtime.identity.setAclEntry(params.project_id, body, actor); status = 201; break;
    case 'credential.list': data = { credentials: runtime.identity.credentials(actor) }; break;
    case 'credential.create': data = await runtime.identity.createCredential(body, actor); status = 201; break;
    case 'credential.rebind': data = await runtime.identity.rebindCredential(params.id, body, actor); status = 202; break;
    case 'credential.rotate': data = await runtime.identity.rotateCredential(params.id, body, actor); status = 202; break;
    case 'credential.revoke': data = await runtime.identity.revokeCredential(params.id, body, actor); break;
    case 'profile.list': data = { profiles: runtime.identity.profiles(actor) }; break;
    case 'profile.create': data = await runtime.identity.createProfile(body, actor); status = 201; break;
    case 'profile.probe': data = await runtime.identity.probeProfile(params.id, body, actor); status = 202; break;
    default: throw new HttpError('not_found', 'route not found', {}, 404, false);
  }
  revision = data?.revision || data?.account?.revision || data?.actor?.revision || data?.team?.revision || data?.membership?.revision || data?.session?.revision || data?.invitation?.revision || data?.entry?.revision || data?.credential?.revision || data?.profile?.revision || null;
  const operation = data?.operation || (data?.operation_id ? data : null);
  if (operation && status === 200 && entry.long_running) status = 202;
  return sendSuccess(res, requestId, data, { status, resourceType: resourceTypeFor(command), outputSchema: entry.output_schema, revision, etag: etagFor(data, revision), policy: runtime.policy, setCookie });
}

function identityFields(command) {
  const base = new Set(['idempotency_key', 'expected_revision']);
  const fields = {
    'actor.create': ['kind', 'display_name', 'metadata'],
    'account.update': ['display_name'],
    'actor.update': ['display_name'],
    'actor.lifecycle': ['reason'],
    'actor.switch': ['target_actor_id', 'effective_actor_id'],
    'session.create': ['ttl_seconds'],
    'session.lifecycle': ['reason'],
    'team.create': ['name'],
    'team.status': ['status'],
    'team.member.grant': ['actor_id', 'role'],
    'team.member.status': ['status', 'reason'],
    'membership.grant': ['actor_id', 'role'],
    'membership.status': ['status', 'reason'],
    'invitation.create': ['invitee_actor_id', 'actor_id', 'invitee_ref', 'role', 'expires_at'],
    'invitation.accept': [],
    'invitation.revoke': [],
    'acl.set': ['id', 'principal_actor_id', 'principal_team_id', 'actor_id', 'team_id', 'resource', 'action', 'effect'],
    'credential.create': ['provider', 'scope', 'external_ref', 'origin'],
    'credential.rebind': ['proof'],
    'credential.rotate': ['proof'],
    'credential.revoke': ['reason'],
    'profile.create': ['provider', 'label', 'credential_ref_id', 'credential_id', 'config'],
    'profile.probe': []
  };
  const key = fields[command] || fields[command.replace(/\.(activate|suspend|revoke)$/, '.lifecycle')] || [];
  return new Set([...base, ...key, ...(command === 'team.member.grant' ? [] : [])]);
}

function resourceTypeFor(command) {
  if (command.startsWith('actor') || command.startsWith('account.')) return 'actor';
  if (command.startsWith('session')) return 'session';
  if (command.startsWith('team')) return 'team';
  if (command.startsWith('membership')) return 'project_membership';
  if (command.startsWith('project.members')) return 'project_membership';
  if (command.startsWith('invitation') || command.startsWith('project.invitations')) return 'project_invitation';
  if (command.startsWith('acl') || command.startsWith('project.permissions')) return 'project_acl';
  if (command.startsWith('credential')) return 'credential';
  if (command.startsWith('profile')) return 'profile';
  return 'identity';
}

function p3ResourceType(command) {
  if (command.startsWith('project.')) return 'project';
  if (command.startsWith('intake.')) return 'project_intake';
  if (command.startsWith('brief.')) return 'brief';
  if (command.startsWith('repository.connection')) return 'repository_connection';
  if (command.startsWith('repository.target')) return 'repository_target';
  if (command.startsWith('repository.line')) return 'repository_line';
  if (command.startsWith('repository.workspace')) return 'repository_workspace';
  if (command.startsWith('generation.') || command.startsWith('workflow.generation') || command.startsWith('critic.')) return 'workflow_generation';
  if (command.startsWith('workflow.proposal')) return 'workflow_proposal';
  if (command.startsWith('workflow.')) return 'workflow';
  if (command.startsWith('outcome.')) return 'outcome_requirement';
  return 'project';
}

function p3Revision(value) {
  return value?.revision
    ?? value?.project?.revision
    ?? value?.intake?.revision
    ?? value?.brief?.revision
    ?? value?.revision_record?.revision
    ?? value?.connection?.revision
    ?? value?.target?.revision
    ?? value?.line?.revision
    ?? value?.workspace?.revision
    ?? value?.workflow?.revision
    ?? value?.generation?.revision
    ?? value?.critic?.policy_revision
    ?? value?.proposal?.revision
    ?? value?.requirement?.revision
    ?? null;
}

function p3ProjectEnvelope(value) {
  const expanded = value?.project || value || {};
  const { intake, brief, workflow, operation: nestedOperation, ...project } = expanded;
  return {
    project,
    ...(intake === undefined ? {} : { intake }),
    ...(brief === undefined ? {} : { brief }),
    ...(workflow === undefined ? {} : { workflow }),
    ...((value?.operation || nestedOperation) ? { operation: value?.operation || nestedOperation } : {}),
    ...(value?.replayed == null ? {} : { replayed: Boolean(value.replayed) })
  };
}

function assertOperationAuthorized(runtime, actor, operation, action) {
  if (runtime.authorization && operation.project_id) {
    runtime.authorization.assert(actor, action, operation.project_id, { operationId: operation.operation_id, resource: 'operation' });
    return;
  }
  runtime.platform.assertAuthorized(actor, action === 'read' ? 'operations:read' : 'operations:control', {});
}

function sessionReceipt(value = {}) {
  const safe = stripProof(value);
  const { operation, replayed, ...session } = safe;
  return { session, ...(operation ? { operation } : {}), ...(replayed === true ? { replayed: true } : {}) };
}

function stripProof(value) {
  if (Array.isArray(value)) return value.map(stripProof);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (['proof', 'session_proof', 'token', 'secret'].includes(key)) continue;
    output[key] = stripProof(item);
  }
  return output;
}

function sessionCookie(proof, ttlSeconds = 30 * 24 * 60 * 60) {
  const ttl = Number.isInteger(Number(ttlSeconds)) ? Math.max(300, Math.min(90 * 24 * 60 * 60, Number(ttlSeconds))) : 30 * 24 * 60 * 60;
  return `aiws_session=${encodeURIComponent(String(proof))}; Path=/; Max-Age=${ttl}; HttpOnly; SameSite=Strict`;
}

function assertLoopbackSameOrigin(req, config = {}) {
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']) {
    throw new HttpError('local_session_denied', 'local session recovery does not accept forwarded requests', {}, 403, false);
  }
  const remoteAddress = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1'].includes(remoteAddress)) {
    throw new HttpError('local_session_denied', 'local session recovery requires a loopback connection', {}, 403, false);
  }
  const host = String(req.headers.host || '');
  let requestOrigin;
  let hostname;
  try {
    const parsed = new URL(`${req.socket?.encrypted ? 'https' : 'http'}://${host}`);
    requestOrigin = parsed.origin;
    hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    throw new HttpError('local_session_denied', 'local session recovery host is invalid', {}, 403, false);
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new HttpError('local_session_denied', 'local session recovery requires a loopback host', {}, 403, false);
  }
  const origin = String(req.headers.origin || '');
  const trustedOrigins = new Set([requestOrigin, ...(config.corsOrigins || [])]);
  if (!origin || !trustedOrigins.has(origin) || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
    throw new HttpError('local_session_denied', 'local session recovery requires an exact same-origin request', {}, 403, false);
  }
}

function sendError(res, requestId, error, runtime) {
  const mapped = mapError(error);
  const scanned = runtime?.policy?.redact(mapped.details || {}) || { value: {}, redactions: [] };
  const payload = { request_id: requestId, error: { code: mapped.code, message: mapped.message, details: scanned.value, retryable: Boolean(mapped.retryable), redactions: scanned.redactions } };
  if (!res.headersSent) res.writeHead(mapped.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId });
  res.end(JSON.stringify(payload));
  return payload;
}

function mapError(error) {
  if (error instanceof HttpError || error instanceof OperationError || error instanceof PlatformError || error instanceof CursorError || error instanceof CleanDatabaseError) return error;
  const code = String(error?.code || error?.message || 'internal_error');
  if (code === 'schema_invalid' || code === 'unknown_field') return new HttpError(code, code === 'unknown_field' ? 'request contains unknown fields' : 'request does not match schema', error.details || {}, Number(error.status || 400), false);
  if (code === 'transaction_precondition_failed') return new HttpError('revision_conflict', 'revision precondition failed', {}, 409, true);
  if (code === 'redaction_blocked') return new HttpError('redaction_blocked', 'payload was rejected by the redaction policy', error.details || {}, 422, false);
  // Domain owners use small purpose-specific Error subclasses (CAS, vault,
  // projection and provider adapters). Preserve their public code/status so a
  // transport cannot turn a deterministic conflict into an opaque 500.
  if (error && typeof error === 'object' && /^[a-z][a-z0-9_.-]{2,80}$/.test(code) && Number.isInteger(Number(error.status)) && Number(error.status) >= 400 && Number(error.status) <= 599) {
    return new HttpError(code, String(error.message || code).slice(0, 240), error.details || {}, Number(error.status), Boolean(error.retryable));
  }
  return new HttpError('internal_error', 'internal error', {}, 500, false);
}

function requestIdFor(req) {
  const supplied = String(req.headers['x-request-id'] || '');
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(supplied) ? supplied : `req_${randomUUID().replaceAll('-', '')}`;
}

function parseScopes(value) {
  if (!value) return undefined;
  return String(value).split(/[\s,]+/).map((item) => item.trim()).filter(Boolean).slice(0, 50);
}

function requireIdempotency(req, body = {}) {
  const value = String(req.headers['idempotency-key'] || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(value)) throw new HttpError('idempotency_required', 'Idempotency-Key header is required', {}, 400, false);
  if (body?.idempotency_key != null && String(body.idempotency_key) !== value) throw new HttpError('invalid_request', 'idempotency key header and body differ', {}, 400, false);
  return value;
}

function expectedRevision(req, body) {
  const expectedHeader = req.headers['x-expected-revision'];
  const matchHeader = req.headers['if-match'];
  const fromExpectedHeader = expectedHeader ? parseRevision(String(expectedHeader)) : null;
  const fromMatchHeader = matchHeader ? parseRevision(String(matchHeader)) : null;
  if (expectedHeader && fromExpectedHeader == null) throw new HttpError('invalid_request', 'X-Expected-Revision is invalid', {}, 400, false);
  if (matchHeader && fromMatchHeader == null) throw new HttpError('invalid_request', 'If-Match is invalid', {}, 400, false);
  if (fromExpectedHeader != null && fromMatchHeader != null && fromExpectedHeader !== fromMatchHeader) throw new HttpError('invalid_request', 'revision headers differ', {}, 400, false);
  const fromHeader = fromExpectedHeader ?? fromMatchHeader;
  const fromBody = body?.expected_revision == null ? null : Number(body.expected_revision);
  if (fromHeader != null && fromBody != null && fromHeader !== fromBody) throw new HttpError('invalid_request', 'expected revision header and body differ', {}, 400, false);
  const value = fromHeader ?? fromBody;
  if (!Number.isInteger(value) || value < 1) throw new HttpError('expected_revision_required', 'expected revision is required', {}, 400, false);
  return value;
}

function expectedRevisionOptional(req, body, fallback = null) {
  const header = req.headers['x-expected-revision'] || req.headers['if-match'];
  const bodyValue = body?.expected_revision;
  if (header == null && bodyValue == null) return fallback;
  if (fallback === 0) {
    const fromHeader = header == null ? null : parseRevision(String(header));
    const fromBody = bodyValue == null ? null : Number(bodyValue);
    if (fromHeader != null && fromBody != null && fromHeader !== fromBody) throw new HttpError('invalid_request', 'expected revision header and body differ', {}, 400, false);
    const value = fromHeader ?? fromBody;
    if (!Number.isInteger(value) || value !== 0) throw new HttpError('expected_revision_required', 'initial setup revision must be 0', {}, 400, false);
    return value;
  }
  return expectedRevision(req, body);
}

function hydrateMutationHeaders(entry, req, body) {
  requireIdempotency(req, body);
  if (body.expected_revision != null) return body;
  const raw = req.headers['x-expected-revision'] || req.headers['if-match'];
  if (raw == null) throw new HttpError('expected_revision_required', 'expected revision is required', {}, 400, false);
  const value = parseRevision(String(raw));
  const minimum = entry.expected_revision === 'parent' ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) throw new HttpError('invalid_request', 'revision header is invalid', {}, 400, false);
  body.expected_revision = value;
  return body;
}

function parseRevision(value) {
  const match = String(value).trim().replace(/^"|"$/g, '').match(/^(?:rev-)?(\d+)(?:-.*)?$/);
  return match ? Number(match[1]) : null;
}

function validateFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('schema_invalid', 'request body must be an object', {}, 400, false);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new HttpError('unknown_field', 'request contains unknown fields', { fields: unknown.slice(0, 20) }, 400, false);
}

function validateCancelBody(body) {
  if (body.idempotency_key != null && typeof body.idempotency_key !== 'string') throw new HttpError('schema_invalid', 'idempotency_key must be a string', {}, 400, false);
  if (body.expected_revision != null && (!Number.isInteger(body.expected_revision) || body.expected_revision < 1)) throw new HttpError('schema_invalid', 'expected_revision must be a positive integer', {}, 400, false);
  if (body.reason != null && typeof body.reason !== 'string') throw new HttpError('schema_invalid', 'reason must be a string', {}, 400, false);
}

function validateQuery(url, allowed) {
  const fields = [...new Set(url.searchParams.keys())];
  const unknown = fields.filter((field) => !allowed.has(field));
  if (unknown.length) throw new HttpError('unknown_field', 'request contains unknown query fields', { fields: unknown.slice(0, 20) }, 400, false);
}

function singleQueryValue(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new HttpError('schema_invalid', `${name} must be provided once`, {}, 400, false);
  return values.length ? values[0] : null;
}

function parseBooleanQuery(url, name) {
  const value = singleQueryValue(url, name);
  if (value == null) return false;
  if (value !== 'true' && value !== 'false') throw new HttpError('schema_invalid', `${name} must be a boolean`, {}, 400, false);
  return value === 'true';
}

function replayLimit(url, defaultLimit = 500) {
  const value = singleQueryValue(url, 'limit');
  if (value == null) return defaultLimit;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 500) throw new HttpError('schema_invalid', 'event limit must be an integer from 1 to 500', {}, 400, false);
  return Number(value);
}

function applyCors(req, res, config, registry, pathname) {
  const originHeader = req.headers.origin;
  const origin = originHeader == null ? null : String(originHeader);
  const allowedOrigins = new Set(config?.corsOrigins || []);
  const requestOrigin = `${req.socket?.encrypted ? 'https' : 'http'}://${String(req.headers.host || '')}`;
  const sameOrigin = origin != null && origin === requestOrigin;
  if (origin != null && !sameOrigin) {
    if (origin === 'null' || !allowedOrigins.has(origin)) {
      throw new HttpError('cors_origin_denied', 'request origin is not allowed', {}, 403, false);
    }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-expose-headers', 'x-request-id, etag');
    const existingVary = String(res.getHeader('vary') || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (!existingVary.some((item) => item.toLowerCase() === 'origin')) existingVary.push('Origin');
    res.setHeader('vary', existingVary.join(', '));
  }
  if (req.method !== 'OPTIONS') return false;
  if (!origin) throw new HttpError('cors_origin_denied', 'preflight origin is required', {}, 403, false);
  const requestedMethod = String(req.headers['access-control-request-method'] || '').toUpperCase();
  if (!requestedMethod) throw new HttpError('invalid_request', 'preflight method is required', {}, 400, false);
  const healthRoute = ['/livez', '/readyz'].includes(pathname) && requestedMethod === 'GET';
  if (!healthRoute && !registry.match(requestedMethod, pathname)) {
    throw new HttpError('cors_method_denied', 'preflight method is not allowed', {}, 403, false);
  }
  const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const deniedHeaders = requestedHeaders.filter((header) => !CORS_REQUEST_HEADERS.has(header));
  if (deniedHeaders.length) throw new HttpError('cors_headers_denied', 'preflight headers are not allowed', { headers: deniedHeaders }, 403, false);
  res.setHeader('access-control-allow-methods', requestedMethod);
  if (requestedHeaders.length) res.setHeader('access-control-allow-headers', requestedHeaders.join(', '));
  res.setHeader('access-control-max-age', '600');
  res.writeHead(204);
  res.end();
  return true;
}

async function readJson(req, maxBytes) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > maxBytes) throw new HttpError('payload_too_large', 'request body is too large', { max_bytes: maxBytes }, 413, false);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError('payload_too_large', 'request body is too large', { max_bytes: maxBytes }, 413, false);
    chunks.push(chunk);
  }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError('schema_invalid', 'request body is not valid JSON', {}, 400, false); }
}

async function readRaw(req, maxBytes) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > maxBytes) throw new HttpError('payload_too_large', 'request body is too large', { max_bytes: maxBytes }, 413, false);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError('payload_too_large', 'request body is too large', { max_bytes: maxBytes }, 413, false);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

function etagFor(value, explicitRevision = null) {
  const revision = explicitRevision ?? value?.revision ?? value?.resource_revision ?? value?.account?.revision ?? value?.actor?.revision ?? value?.team?.revision ?? value?.membership?.revision ?? value?.session?.revision ?? value?.invitation?.revision ?? value?.entry?.revision ?? value?.credential?.revision ?? value?.profile?.revision ?? 0;
  return `rev-${Number(revision)}-sha256:${sha256Hex(canonicalJson(value))}`;
}

function isTerminalOperation(status) {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(String(status));
}
