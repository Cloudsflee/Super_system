import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { routeParams } from './registry.mjs';
import { CleanDatabaseError } from './database.mjs';
import { CursorError } from './cursor.mjs';
import { OperationError } from './operations.mjs';
import { PlatformError } from './platform.mjs';
import { assertCleanV2 } from '@aiws/contracts/clean-v2';

const RETIRED_API_PREFIX = ['/api', 'v1'].join('/');

export function createCleanHttpHandler({ runtime, registry, maxBodyBytes = runtime?.config?.maxBodyBytes || 1024 * 1024 } = {}) {
  if (!runtime || !registry) throw new TypeError('clean_http_runtime_required');
  return async function cleanHttpHandler(req, res) {
    const requestId = requestIdFor(req);
    const url = new URL(req.url || '/', 'http://v3-clean.local');
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    try {
      if (pathname === '/livez' && req.method === 'GET') return sendSuccess(res, requestId, { status: 'live', runtime: 'v3-clean' }, { resourceType: 'health', policy: runtime.policy });
      if (runtime.recovery && pathname !== '/livez') await runtime.recovery;
      if (pathname === '/readyz' && req.method === 'GET') {
        if (!runtime.ready) throw new HttpError('not_ready', 'clean runtime is not ready', { reason: runtime.readinessReason || 'startup', receipt_reference: runtime.readinessReceipt || null }, 503, true);
        return sendSuccess(res, requestId, { status: 'ready', runtime: 'v3-clean', schema_family: runtime.metadata.family, user_version: runtime.metadata.user_version }, { resourceType: 'health', policy: runtime.policy });
      }
      if (pathname === RETIRED_API_PREFIX || pathname.startsWith(`${RETIRED_API_PREFIX}/`)) throw new HttpError('route_retired', 'the requested API route is retired', { migration_receipt_reference: runtime.retiredRouteReceipt }, 410, false);
      if (!runtime.ready && pathname.startsWith('/api/v2/')) throw new HttpError('not_ready', 'clean runtime is not ready', { reason: runtime.readinessReason || 'startup', receipt_reference: runtime.readinessReceipt || null }, 503, true);
      if (!pathname.startsWith('/api/v2/')) throw new HttpError('not_found', 'route not found', {}, 404, false);
      const entry = registry.match(req.method, pathname);
      if (!entry) throw new HttpError('not_found', 'route not found', { path: pathname }, 404, false);
      const params = routeParams(entry.path, pathname);
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
        return sendSuccess(res, requestId, safe, { status: 201, resourceType: 'setup', outputSchema: entry.output_schema, revision: 1, etag: etagFor(safe, 1), policy: runtime.policy, setCookie: proof ? sessionCookie(proof) : null });
      }
      const actor = runtime.p2 && runtime.identity
        ? runtime.identity.principalFromRequest(req)
        : runtime.platform.actorContext({ actorId: req.headers['x-actor-id'], projectId: req.headers['x-project-id'], scopes: parseScopes(req.headers['x-scopes']) });
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

async function handleP3Route({ entry, params, url, req, res, requestId, runtime, actor, bodyReader }) {
  validateQuery(url, new Set());
  const command = entry.command_id;
  let body = {};
  if (req.method !== 'GET') {
    body = await bodyReader();
    if (req.headers['idempotency-key'] && body.idempotency_key == null) body.idempotency_key = String(req.headers['idempotency-key']);
    hydrateMutationHeaders(entry, req, body);
    if (command === 'brief.confirm') body.brief_revision = Number(params.revision);
    assertCleanV2(entry.input_schema, body);
  }
  const service = runtime.projectWorkflow;
  let data;
  let status = 200;
  switch (command) {
    case 'project.list': data = { projects: service.listProjects(actor) }; break;
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

function sendSuccess(res, requestId, data, { status = 200, resourceType = 'resource', revision = null, etag = null, policy = null, setCookie = null, outputSchema = null } = {}) {
  const scanned = policy?.redact(data) || { value: data, redactions: [] };
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
      setCookie = data.proof ? sessionCookie(data.proof) : null;
      data = stripProof(data);
      status = 201;
      break;
    }
    case 'session.revoke': data = await runtime.identity.revokeSession(params.id, { actorId: actor.actorId, expectedRevision: expectedRevision(req, body), idempotencyKey: requireIdempotency(req, body), reason: body.reason }); break;
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

function sessionCookie(proof) {
  return `aiws_session=${encodeURIComponent(String(proof))}; Path=/; HttpOnly; SameSite=Strict`;
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

function replayLimit(url) {
  const value = singleQueryValue(url, 'limit');
  if (value == null) return 500;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 500) throw new HttpError('schema_invalid', 'event limit must be an integer from 1 to 500', {}, 400, false);
  return Number(value);
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

function etagFor(value, explicitRevision = null) {
  const revision = explicitRevision ?? value?.revision ?? value?.resource_revision ?? value?.account?.revision ?? value?.actor?.revision ?? value?.team?.revision ?? value?.membership?.revision ?? value?.session?.revision ?? value?.invitation?.revision ?? value?.entry?.revision ?? value?.credential?.revision ?? value?.profile?.revision ?? 0;
  return `rev-${Number(revision)}-sha256:${sha256Hex(canonicalJson(value))}`;
}

function isTerminalOperation(status) {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(String(status));
}
