import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { DeterministicAppServerAdapter, APP_SERVER_SCHEMA_SHA256 } from './app-server-adapter.mjs';
import {
  appendAggregate, assertProject, assertRevision, boundedString, canonicalPayload,
  createOperation, parseJson, priorResponse, requestHash, requireIdempotency,
  requirePrincipal, requireRevision, saveResponse, time
} from './p5-domain-helpers.mjs';

const SESSION_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TURN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const OPERATION_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const INTERACTION_TERMINAL = new Set(['approved', 'rejected', 'expired', 'cancelled']);

export class CleanAssistService {
  constructor({ db, cas, events, operations, authorization, vault, clock, providerAdapter, providerAdapters = {}, bootstrapActorId = 'actor_system_bootstrap', config = {} } = {}) {
    if (!db || !cas || !events || !operations || !authorization) throw new TypeError('assist_service_dependencies_required');
    this.db = db;
    this.cas = cas;
    this.events = events;
    this.operations = operations;
    this.authorization = authorization;
    this.vault = vault;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.config = config;
    this.provider = providerAdapter || new DeterministicAppServerAdapter();
    this.providerAdapters = providerAdapters;
    this.turnFixtures = new Map();
    this.running = new Map();
  }

  async probeProvider() {
    const result = await this.provider.probe();
    if (String(result?.protocol_version || '') !== '2' || String(result?.schema_sha256 || '') !== APP_SERVER_SCHEMA_SHA256) {
      throw new PlatformError('provider_protocol_drift', 'app-server protocol schema changed', {
        expected_schema_sha256: APP_SERVER_SCHEMA_SHA256,
        actual_schema_sha256: String(result?.schema_sha256 || '')
      }, 503);
    }
    return result;
  }

  listSessions(input = {}, principal) {
    requirePrincipal(principal);
    const projectId = input.project_id == null ? null : String(input.project_id);
    if (projectId) assertProject(this.authorization, principal, 'read', projectId, { resource: 'assist' });
    const rows = projectId
      ? this.db.query('SELECT * FROM assist_sessions WHERE project_id=? ORDER BY updated_at DESC,id', [projectId])
      : this.db.query('SELECT * FROM assist_sessions WHERE created_by_actor_id=? ORDER BY updated_at DESC,id', [principal.actorId]);
    return { sessions: rows.filter((row) => !input.status || row.status === String(input.status)).map(sessionView) };
  }

  getSession(sessionId, principal) {
    const row = this.sessionRow(sessionId);
    this.assertSession(principal, row, 'read');
    return this.bundle(row);
  }

  async createSession(input = {}, principal) {
    requirePrincipal(principal);
    const projectId = String(input.project_id || '');
    assertProject(this.authorization, principal, 'write', projectId, { resource: 'assist' });
    const scope = String(input.scope || 'project');
    if (!['project', 'workflow', 'workstream', 'task'].includes(scope)) throw new PlatformError('schema_invalid', 'Assist scope is invalid', {}, 422);
    const scopeId = String(input.scope_id || projectId);
    const project = this.db.get('SELECT * FROM projects WHERE id=?', [projectId]);
    if (!project) throw new PlatformError('not_found', 'project not found', {}, 404);
    if (scope === 'project' && scopeId !== projectId) throw new PlatformError('assist_scope_invalid', 'scope does not belong to project', {}, 422);
    const pack = this.db.get('SELECT * FROM context_packs WHERE id=? AND project_id=? AND status=?', [String(input.context_pack_id || ''), projectId, 'sealed']);
    if (!pack) throw new PlatformError('context_pack_required', 'a sealed Context Pack is required', {}, 422);
    const profile = this.profileFor(input.profile_id, principal);
    const credential = this.credentialFor(profile, principal);
    const workspace = input.repository_workspace_id
      ? this.db.get('SELECT * FROM repository_workspaces WHERE id=? AND project_id=?', [String(input.repository_workspace_id), projectId])
      : this.db.get("SELECT * FROM repository_workspaces WHERE project_id=? AND status IN ('ready','released') ORDER BY created_at,id LIMIT 1", [projectId]);
    if (input.repository_workspace_id && !workspace) throw new PlatformError('not_found', 'repository workspace not found', {}, 404);
    const now = time(this.clock);
    const idempotencyKey = requireIdempotency(input.idempotency_key);
    const hash = requestHash({ project_id: projectId, scope, scope_id: scopeId, context_pack_id: pack.id, profile_id: profile.id, repository_workspace_id: workspace?.id || null });
    const replay = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.session.create', idempotencyKey, requestHash: hash, now }));
    if (replay) return replay;
    const provider = await this.probeProvider().catch((error) => { throw normalizeProviderError(error); });
    const sessionId = opaqueId('assist_session');
    const snapshot = {
      project_id: projectId, scope, scope_id: scopeId,
      brief_revision: positiveSnapshotRevision(project.current_brief_revision),
      brief_hash: String(project.confirmed_brief_hash || ''),
      workflow_revision: positiveSnapshotRevision(project.current_workflow_revision),
      workflow_hash: '', repository_workspace_id: workspace?.id || null,
      repository_revision: workspace ? Number(workspace.revision) : null, repository_hash: '',
      context_pack_id: pack.id, context_pack_hash: pack.pack_hash,
      profile_id: profile.id, profile_revision: Number(profile.revision), profile_hash: sha256Hex(profile.config_json || '{}'),
      credential_ref_id: credential.id, credential_revision: Number(credential.revision),
      provider_schema_sha256: String(provider.schema_sha256 || APP_SERVER_SCHEMA_SHA256)
    };
    const session = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.session.create', idempotencyKey, requestHash: hash, now });
      if (prior) return prior;
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.session.create', resourceType: 'assist_session', resourceId: sessionId, projectId, requestHash: hash, idempotencyKey: `internal-${opaqueId('key')}`, status: 'succeeded', now });
      const configId = opaqueId('assist_config');
      const snapshotPayload = canonicalPayload(snapshot);
      tx.run(`INSERT INTO assist_sessions(id,project_id,scope,scope_id,brief_revision,brief_hash,workflow_revision,workflow_hash,repository_workspace_id,repository_revision,repository_hash,context_pack_id,context_pack_hash,profile_id,profile_revision,profile_hash,credential_ref_id,credential_revision,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?,?,?)`, [sessionId, projectId, scope, scopeId, snapshot.brief_revision, snapshot.brief_hash, snapshot.workflow_revision, snapshot.workflow_hash, snapshot.repository_workspace_id, snapshot.repository_revision, snapshot.repository_hash, pack.id, pack.pack_hash, profile.id, profile.revision, snapshot.profile_hash, credential.id, credential.revision, now, now, principal.actorId, principal.actorId]);
      tx.run('INSERT INTO assist_configurations(id,session_id,revision,snapshot_json,snapshot_sha256,provider_schema_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?)', [configId, sessionId, 1, snapshotPayload.json, snapshotPayload.sha256, snapshot.provider_schema_sha256 || snapshotPayload.sha256, now, principal.actorId]);
      appendAggregate(this.events, tx, { aggregateType: 'assist_session', aggregateId: sessionId, revision: 1, operationId: op.id, actorId: principal.actorId, projectId, type: 'assist_session.created', data: { session_id: sessionId, project_id: projectId, scope }, payload: { id: sessionId, project_id: projectId, scope, scope_id: scopeId, status: 'active', revision: 1 }, now });
      this.operations.linkInTransaction(tx, op.id, [['assist_session', sessionId]], now);
      const response = { session: sessionView(tx.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId])), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.session.create', idempotencyKey, requestHash: hash, response, operationId: op.id, status: 201, now });
      return response;
    });
    if (session?.replayed) return session;
    let credentialBytes;
    try {
      credentialBytes = this.credentialBytes(credential);
      const thread = await this.provider.startThread({
        profile_revision: profile.revision,
        credential: credentialBytes,
        provider_config: this.providerConfig(profile),
        cwd: this.workspaceCwd(workspace),
        runtime_workspace_roots: this.workspaceCwd(workspace) ? [this.workspaceCwd(workspace)] : undefined
      });
      this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId]);
        if (!current) return;
        tx.run('UPDATE assist_sessions SET provider_thread_id=?,updated_at=? WHERE id=? AND revision=?', [String(thread.thread_id || ''), now, sessionId, current.revision]);
      });
    } catch (error) {
      await this.failSession(sessionId, normalizeProviderError(error), principal);
      throw normalizeProviderError(error);
    } finally {
      credentialBytes?.fill(0);
    }
    return { ...session, session: sessionView(this.db.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId])) };
  }

  async createTurn(input = {}, principal) {
    requirePrincipal(principal);
    const session = this.sessionRow(input.session_id);
    this.assertSession(principal, session, 'run');
    const expected = requireRevision(input.expected_revision);
    const message = boundedString(input.message, 262144, { required: true });
    const goal = input.goal && typeof input.goal === 'object' ? input.goal : {};
    const inputHash = requestHash({ message, goal, references: input.references || [] });
    const now = time(this.clock);
    const commandId = 'assist.turn.create';
    const idempotencyKey = requireIdempotency(input.idempotency_key);
    const hash = requestHash({ session_id: session.id, expected_revision: expected, input_hash: inputHash });
    const replay = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey, requestHash: hash, now }));
    if (replay) return replay;
    if (session.status !== 'active') throw new PlatformError('assist_session_inactive', 'Assist session is not active', {}, 409);
    assertRevision(session, expected);
    const content = this.cas.put(message, { mediaType: 'text/plain', metadata: { kind: 'assist.user_message', session_id: session.id } });
    const turnId = opaqueId('assist_turn');
    const operation = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey, requestHash: hash, now });
      if (prior) return prior;
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'assist_turn', resourceId: turnId, projectId: session.project_id, requestHash: hash, idempotencyKey: `internal-${opaqueId('key')}`, status: 'queued', now });
      const turnNo = Number(tx.get('SELECT COALESCE(MAX(turn_no),0)+1 AS next FROM assist_turns WHERE session_id=?', [session.id]).next);
      tx.run(`INSERT INTO assist_turns(id,session_id,turn_no,attempt,operation_id,status,input_hash,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,'queued',?,1,?,?,?,?)`, [turnId, session.id, turnNo, 1, op.id, inputHash, now, now, principal.actorId, principal.actorId]);
      tx.run('INSERT INTO assist_messages(id,session_id,turn_id,attempt,sequence,role,kind,provider_item_id,content_sha256,content_cas_hash,terminal,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [opaqueId('assist_message'), session.id, turnId, 1, 1, 'user', 'message', null, content.hash, content.hash, 1, now]);
      appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: turnId, revision: 1, operationId: op.id, actorId: principal.actorId, projectId: session.project_id, type: 'assist_turn.queued', data: { turn_id: turnId, session_id: session.id, attempt: 1 }, payload: { id: turnId, session_id: session.id, status: 'queued', attempt: 1, input_hash: inputHash, revision: 1 }, now });
      tx.run('UPDATE assist_sessions SET revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [now, principal.actorId, session.id, expected]);
      const currentSession = tx.get('SELECT * FROM assist_sessions WHERE id=?', [session.id]);
      appendAggregate(this.events, tx, { aggregateType: 'assist_session', aggregateId: session.id, revision: Number(currentSession.revision), operationId: op.id, actorId: principal.actorId, projectId: session.project_id, type: 'assist_turn.created', data: { turn_id: turnId }, payload: { id: session.id, status: currentSession.status, revision: Number(currentSession.revision) }, now });
      this.operations.linkInTransaction(tx, op.id, [['assist_turn', turnId], ['assist_session', session.id]], now);
      const response = this.operations.receiptFromRow(tx.get('SELECT * FROM operations WHERE id=?', [op.id]));
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey, requestHash: hash, response, operationId: op.id, status: 202, now });
      return response;
    }).catch((error) => { try { this.removeCasIfUnreferenced(content.hash); } catch {} throw error; });
    if (operation.replayed) return operation;
    this.turnFixtures.set(turnId, input.fixture || {});
    if (!input.defer) queueMicrotask(() => this.executeTurn(turnId, principal).catch(() => undefined));
    return operation;
  }

  async executeTurn(turnId, principal = null, { resume = false } = {}) {
    const turn = this.db.get('SELECT * FROM assist_turns WHERE id=?', [String(turnId)]);
    if (!turn) throw new PlatformError('not_found', 'Assist turn not found', {}, 404);
    const session = this.sessionRow(turn.session_id);
    const actor = principal || { actorId: turn.created_by_actor_id, effectiveActorId: turn.created_by_actor_id, scopes: ['*'] };
    const operation = this.db.get('SELECT * FROM operations WHERE id=?', [turn.operation_id]);
    if (!operation || TURN_TERMINAL.has(turn.status)) return this.turnView(turn);
    this.running.set(turn.id, true);
    let credentialBytes = null;
    try {
      if (resume) {
        const interaction = this.interactionResolution(turn.id);
        if (interaction.pending) return this.turnView(turn);
        if (interaction.rejected) throw new PlatformError('assist_interaction_rejected', 'runtime interaction was not approved', { status: interaction.rejected.status }, 409);
      }
      if (operation.status === 'queued' || operation.status === 'paused') await this.operations.start(operation.id, { expectedRevision: Number(operation.revision), actorId: actor.actorId, projectId: session.project_id });
      const currentSession = this.sessionRow(session.id);
      const credential = this.credentialForSession(currentSession, actor);
      const providerConfig = this.providerConfigForSession(currentSession);
      credentialBytes = this.credentialBytes(credential);
      const resolutions = resume ? this.interactionResolutions(turn.id) : [];
      const cwd = this.workspaceCwd(currentSession.repository_workspace_id);
      const thread = currentSession.provider_thread_id
        ? await this.provider.resumeThread({ thread_id: currentSession.provider_thread_id, credential: credentialBytes, provider_config: providerConfig, resolutions })
        : await this.provider.startThread({ profile_revision: currentSession.profile_revision, credential: credentialBytes, provider_config: providerConfig, cwd, runtime_workspace_roots: cwd ? [cwd] : undefined });
      if (!currentSession.provider_thread_id && thread.thread_id) this.db.run('UPDATE assist_sessions SET provider_thread_id=?,updated_at=? WHERE id=?', [thread.thread_id, time(this.clock), session.id]);
      await this.setTurnStatus(turn, 'running', actor);
      const userMessage = this.db.get("SELECT content_cas_hash FROM assist_messages WHERE turn_id=? AND role='user' ORDER BY sequence LIMIT 1", [turn.id]);
      const message = userMessage ? this.cas.read(userMessage.content_cas_hash).toString('utf8') : '';
      const storedFixture = this.turnFixtures.get(turn.id) || {};
      const fixture = resume ? { ...storedFixture, pending_approval: undefined, pending_input: undefined } : storedFixture;
      const result = await this.provider.startTurn({ thread_id: thread.thread_id || currentSession.provider_thread_id, turn_id: turn.provider_turn_id || undefined, message, input_hash: turn.input_hash, fixture, resume, resolutions, cwd, runtime_workspace_roots: cwd ? [cwd] : undefined });
      if (result?.turn_id) await this.bindProviderTurn(turn.id, result.turn_id, actor);
      const processed = await this.processProviderEvents(turn.id, result, actor);
      if (processed.awaiting) return this.turnView(this.db.get('SELECT * FROM assist_turns WHERE id=?', [turn.id]));
      if (!processed.complete || !processed.assistant) throw new PlatformError('assist_output_incomplete', 'provider output did not satisfy completion invariants', { missing: processed.missing }, 502);
      return await this.completeTurn(turn.id, processed, actor);
    } catch (error) {
      const normalized = normalizeAssistError(error);
      await this.failTurn(turn.id, normalized, actor).catch(() => undefined);
      throw normalized;
    } finally {
      credentialBytes?.fill(0);
      this.running.delete(turn.id);
    }
  }

  async processProviderEvents(turnId, result, principal) {
    const events = Array.isArray(result?.events) ? result.events : [];
    let expected = 1;
    let terminal = false;
    let assistant = null;
    const toolCalls = new Map();
    let awaiting = null;
    for (const event of events) {
      const sequence = Number(event.sequence);
      if (sequence !== expected) throw new PlatformError('assist_output_incomplete', 'provider event sequence is not continuous', { expected_sequence: expected, actual_sequence: sequence }, 502);
      expected += 1;
      const method = String(event.method || '');
      const params = event.params && typeof event.params === 'object' ? event.params : {};
      if (method === 'item/started' && params.kind === 'tool_call') toolCalls.set(String(params.item_id || opaqueId('tool')), false);
      if (method === 'item/completed') {
        const itemId = String(params.item_id || opaqueId('provider_item'));
        const content = String(params.content || params.summary || '');
        if (params.role === 'assistant' || params.kind === 'message') assistant = { itemId, content };
        if (params.kind === 'tool_result' || params.role === 'tool') toolCalls.set(itemId, params.terminal === true || params.status === 'completed');
        if (content) await this.appendProviderMessage(turnId, itemId, params.role === 'assistant' ? 'assistant' : params.role === 'tool' ? 'tool' : 'reasoning_summary', params.kind || 'message', content, sequence, principal);
      }
      if (['approval/request', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
        awaiting = { kind: 'approval', request: params };
      }
      if (['userInput/request', 'item/tool/requestUserInput'].includes(method)) {
        awaiting = { kind: 'input', request: params };
      }
      if (method === 'turn/completed' || method === 'turn/failed') terminal = method === 'turn/completed';
      if (awaiting) break;
    }
    const pending = awaiting ? await this.pauseForInteraction(turnId, awaiting, principal) : [];
    if (awaiting) return { awaiting: pending.length > 0, complete: false, assistant, missing: [] };
    const missing = [];
    if (!terminal) missing.push('provider_terminal_notification');
    if (!assistant) missing.push('assistant_response');
    for (const [itemId, done] of toolCalls) if (!done) missing.push(`tool_terminal_result:${itemId}`);
    const pendingRows = this.db.query("SELECT id FROM runtime_approvals WHERE assist_turn_id=? AND status='pending' UNION ALL SELECT id FROM runtime_user_inputs WHERE assist_turn_id=? AND status='pending'", [turnId, turnId]);
    if (pendingRows.length) missing.push('pending_interaction');
    return { awaiting: false, complete: missing.length === 0, assistant, missing, sequence: expected - 1, events };
  }

  async appendProviderMessage(turnId, providerItemId, role, kind, content, sequence, principal) {
    const turn = this.db.get('SELECT * FROM assist_turns WHERE id=?', [turnId]);
    if (!turn || TURN_TERMINAL.has(turn.status)) return;
    const bytes = this.cas.put(content, { mediaType: 'text/plain', metadata: { kind: `assist.${kind}`, turn_id: turnId } });
    const now = time(this.clock);
    this.db.withTransaction((tx) => {
      const existing = tx.get('SELECT id FROM assist_messages WHERE turn_id=? AND provider_item_id=?', [turnId, providerItemId]);
      if (existing) return;
      const next = Number(tx.get('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM assist_messages WHERE turn_id=?', [turnId]).next);
      tx.run('INSERT INTO assist_messages(id,session_id,turn_id,attempt,sequence,role,kind,provider_item_id,content_sha256,content_cas_hash,terminal,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [opaqueId('assist_message'), turn.session_id, turnId, turn.attempt, next, role, kind, providerItemId, bytes.hash, bytes.hash, 1, now]);
      const current = tx.get('SELECT * FROM assist_turns WHERE id=?', [turnId]);
      tx.run('UPDATE assist_turns SET last_provider_sequence=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=?', [sequence, now, principal.actorId, turnId]);
      appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: turnId, revision: Number(current.revision) + 1, operationId: turn.operation_id, actorId: principal.actorId, projectId: this.db.get('SELECT project_id FROM assist_sessions WHERE id=?', [turn.session_id]).project_id, type: 'assist_message.received', data: { turn_id: turnId, role, sequence }, payload: { id: turnId, status: current.status, revision: Number(current.revision) + 1, message_hash: bytes.hash }, now });
    });
  }

  async pauseForInteraction(turnId, awaiting, principal) {
    const turn = this.db.get('SELECT * FROM assist_turns WHERE id=?', [turnId]);
    const session = this.sessionRow(turn.session_id);
    const now = time(this.clock);
    if (awaiting.kind === 'approval') {
      const action = boundedString(awaiting.request.action || 'provider.command', 160, { required: true });
      const request = awaiting.request.request && typeof awaiting.request.request === 'object' ? awaiting.request.request : {};
      const row = await this.db.withTransaction((tx) => {
        const id = opaqueId('approval'); const requestPayload = canonicalPayload(request);
        tx.run(`INSERT INTO runtime_approvals(id,project_id,operation_id,assist_turn_id,action,action_sha256,request_json,request_sha256,status,requested_revision,expires_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
          VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?,?,?,?,?)`, [id, session.project_id, turn.operation_id, turnId, action, sha256Hex(action), requestPayload.json, requestPayload.sha256, Number(turn.revision), new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(), 1, now, now, principal.actorId, principal.actorId]);
        appendAggregate(this.events, tx, { aggregateType: 'runtime_approval', aggregateId: id, revision: 1, operationId: turn.operation_id, actorId: principal.actorId, projectId: session.project_id, type: 'runtime_approval.requested', data: { approval_id: id, action }, payload: { id, project_id: session.project_id, action, status: 'pending', revision: 1 }, now });
        return tx.get('SELECT * FROM runtime_approvals WHERE id=?', [id]);
      });
      await this.setTurnStatus(turn, 'awaiting_input', principal);
      const op = this.db.get('SELECT * FROM operations WHERE id=?', [turn.operation_id]);
      if (op && op.status === 'running') await this.operations.pause(op.id, { expectedRevision: Number(op.revision), actorId: principal.actorId, projectId: session.project_id, errorDetails: { waiting: 'approval' } });
      return [row];
    }
    const prompt = boundedString(awaiting.request.prompt_summary || 'Input required', 1000, { required: true });
    const schema = awaiting.request.input_schema && typeof awaiting.request.input_schema === 'object' ? awaiting.request.input_schema : {};
    const row = await this.db.withTransaction((tx) => {
      const id = opaqueId('user_input'); const schemaPayload = canonicalPayload(schema);
      tx.run(`INSERT INTO runtime_user_inputs(id,project_id,operation_id,assist_turn_id,prompt_summary,input_schema_json,input_schema_sha256,status,requested_revision,expires_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`, [id, session.project_id, turn.operation_id, turnId, prompt, schemaPayload.json, schemaPayload.sha256, Number(turn.revision), new Date(Date.parse(now) + 15 * 60 * 1000).toISOString(), 1, now, now, principal.actorId, principal.actorId]);
      appendAggregate(this.events, tx, { aggregateType: 'runtime_user_input', aggregateId: id, revision: 1, operationId: turn.operation_id, actorId: principal.actorId, projectId: session.project_id, type: 'runtime_user_input.requested', data: { input_id: id, prompt_summary: prompt }, payload: { id, project_id: session.project_id, status: 'pending', revision: 1 }, now });
      return tx.get('SELECT * FROM runtime_user_inputs WHERE id=?', [id]);
    });
    await this.setTurnStatus(turn, 'awaiting_input', principal);
    const op = this.db.get('SELECT * FROM operations WHERE id=?', [turn.operation_id]);
    if (op && op.status === 'running') await this.operations.pause(op.id, { expectedRevision: Number(op.revision), actorId: principal.actorId, projectId: session.project_id, errorDetails: { waiting: 'user_input' } });
    return [row];
  }

  async completeTurn(turnId, processed, principal) {
    const now = time(this.clock);
    const assistant = processed.assistant;
    const output = this.cas.put(assistant.content, { mediaType: 'text/plain', metadata: { kind: 'assist.assistant_summary', turn_id: turnId } });
    const result = await this.db.withTransaction((tx) => {
      const turn = tx.get('SELECT * FROM assist_turns WHERE id=?', [turnId]);
      if (!turn) throw new PlatformError('not_found', 'Assist turn not found', {}, 404);
      if (TURN_TERMINAL.has(turn.status)) return this.turnView(turn);
      const session = tx.get('SELECT * FROM assist_sessions WHERE id=?', [turn.session_id]);
      const op = tx.get('SELECT * FROM operations WHERE id=?', [turn.operation_id]);
      const nextRevision = Number(turn.revision) + 1;
      tx.run(`UPDATE assist_turns SET status='completed',output_hash=?,terminal_notification_received=1,revision=?,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [output.hash, nextRevision, now, now, principal.actorId, turnId, turn.revision], 1);
      appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: turnId, revision: nextRevision, operationId: turn.operation_id, actorId: principal.actorId, projectId: session.project_id, type: 'assist_turn.completed', data: { turn_id: turnId, output_hash: output.hash, sequence: processed.sequence }, payload: { id: turnId, session_id: session.id, status: 'completed', attempt: turn.attempt, output_hash: output.hash, revision: nextRevision }, now });
      if (op && op.status === 'running') this.operations.transitionInTransaction(tx, op.id, 'succeeded', { expectedRevision: Number(op.revision), actorId: principal.actorId, projectId: session.project_id, result: { turn_id: turnId, output_hash: output.hash } }, now);
      return this.turnView(tx.get('SELECT * FROM assist_turns WHERE id=?', [turnId]));
    });
    return result;
  }

  async failTurn(turnId, error, principal) {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const turn = tx.get('SELECT * FROM assist_turns WHERE id=?', [turnId]);
      if (!turn || TURN_TERMINAL.has(turn.status)) return this.turnView(turn);
      const session = tx.get('SELECT * FROM assist_sessions WHERE id=?', [turn.session_id]);
      let op = tx.get('SELECT * FROM operations WHERE id=?', [turn.operation_id]);
      const nextRevision = Number(turn.revision) + 1;
      tx.run(`UPDATE assist_turns SET status='failed',error_code=?,error_details_json=?,revision=?,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?`, [String(error.code || 'assist_runtime_failed'), canonicalJson({ message: String(error.message || '').slice(0, 240) }), nextRevision, now, now, principal.actorId, turnId, turn.revision], 1);
      appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: turnId, revision: nextRevision, operationId: turn.operation_id, actorId: principal.actorId, projectId: session.project_id, type: 'assist_turn.failed', data: { turn_id: turnId, error_code: String(error.code || 'assist_runtime_failed') }, payload: { id: turnId, session_id: session.id, status: 'failed', error_code: String(error.code || 'assist_runtime_failed'), revision: nextRevision }, now });
      if (op && !OPERATION_TERMINAL.has(op.status)) {
        if (op.status === 'accepted') {
          this.operations.transitionInTransaction(tx, op.id, 'queued', { expectedRevision: Number(op.revision), actorId: principal.actorId, projectId: session.project_id }, now);
          op = tx.get('SELECT * FROM operations WHERE id=?', [op.id]);
        }
        if (op.status === 'queued' || op.status === 'paused') {
          this.operations.transitionInTransaction(tx, op.id, 'running', { expectedRevision: Number(op.revision), actorId: principal.actorId, projectId: session.project_id }, now);
          op = tx.get('SELECT * FROM operations WHERE id=?', [op.id]);
        }
        if (op.status === 'running') this.operations.transitionInTransaction(tx, op.id, 'failed', { expectedRevision: Number(op.revision), actorId: principal.actorId, projectId: session.project_id, errorCode: String(error.code || 'assist_runtime_failed'), errorDetails: { message: String(error.message || '').slice(0, 240) } }, now);
      }
      return this.turnView(tx.get('SELECT * FROM assist_turns WHERE id=?', [turnId]));
    });
  }

  async bindProviderTurn(turnId, providerTurnId, principal) {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const turn = tx.get('SELECT * FROM assist_turns WHERE id=?', [turnId]);
      if (!turn || turn.provider_turn_id === String(providerTurnId)) return turn;
      if (turn.provider_turn_id) throw new PlatformError('provider_protocol_drift', 'provider turn id changed', {}, 503);
      const session = tx.get('SELECT project_id FROM assist_sessions WHERE id=?', [turn.session_id]);
      const next = Number(turn.revision) + 1;
      tx.run('UPDATE assist_turns SET provider_turn_id=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [String(providerTurnId), next, now, principal.actorId, turnId, turn.revision], 1);
      appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: turnId, revision: next, operationId: turn.operation_id, actorId: principal.actorId, projectId: session.project_id, type: 'assist_turn.provider_bound', data: { turn_id: turnId }, payload: { id: turnId, session_id: turn.session_id, status: turn.status, revision: next }, now });
      return tx.get('SELECT * FROM assist_turns WHERE id=?', [turnId]);
    });
  }

  async failSession(sessionId, error, principal) {
    const row = this.sessionRow(sessionId); if (!row || SESSION_TERMINAL.has(row.status)) return;
    const now = time(this.clock);
    this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId]); if (!current) return;
      tx.run("UPDATE assist_sessions SET status='failed',revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, principal.actorId, sessionId, current.revision], 1);
      appendAggregate(this.events, tx, { aggregateType: 'assist_session', aggregateId: sessionId, revision: Number(current.revision) + 1, actorId: principal.actorId, projectId: current.project_id, type: 'assist_session.failed', data: { session_id: sessionId, error_code: error.code }, payload: { id: sessionId, status: 'failed', revision: Number(current.revision) + 1 }, now });
    });
  }

  async setTurnStatus(turn, status, principal) {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM assist_turns WHERE id=?', [turn.id]);
      if (!current || current.status === status) return current;
      const next = Number(current.revision) + 1;
      tx.run('UPDATE assist_turns SET status=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, next, now, principal.actorId, turn.id, current.revision], 1);
      const session = tx.get('SELECT project_id FROM assist_sessions WHERE id=?', [current.session_id]);
      appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: current.id, revision: next, operationId: current.operation_id, actorId: principal.actorId, projectId: session.project_id, type: `assist_turn.${status}`, data: { turn_id: current.id }, payload: { id: current.id, status, revision: next }, now });
      return tx.get('SELECT * FROM assist_turns WHERE id=?', [turn.id]);
    });
  }

  async pauseSession(sessionId, input, principal) { return this.transitionSession(sessionId, 'paused', input, principal, 'assist.session.pause'); }
  async resumeSession(sessionId, input, principal) {
    const result = await this.transitionSession(sessionId, 'active', input, principal, 'assist.session.resume');
    if (result.replayed) return result;
    const awaiting = this.db.query("SELECT id FROM assist_turns WHERE session_id=? AND status='awaiting_input' ORDER BY turn_no", [sessionId]);
    for (const row of awaiting) queueMicrotask(() => this.executeTurn(row.id, principal, { resume: true }).catch(() => undefined));
    return result;
  }
  async cancelSession(sessionId, input, principal) { return this.transitionSession(sessionId, 'cancelled', input, principal, 'assist.session.cancel'); }

  async transitionSession(sessionId, status, input, principal, commandId) {
    const row = this.sessionRow(sessionId); this.assertSession(principal, row, 'write');
    const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key);
    const hash = requestHash({ session_id: row.id, expected_revision: expected, status, reason: String(input.reason || '') }); const now = time(this.clock);
    const result = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId]); assertRevision(current, expected);
      if (SESSION_TERMINAL.has(current.status)) throw new PlatformError('operation_terminal', 'Assist session is terminal', {}, 409);
      if (current.status === status) throw new PlatformError('state_conflict', 'Assist session already has the requested status', { status }, 409);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'assist_session', resourceId: sessionId, projectId: current.project_id, requestHash: hash, status: 'succeeded', now });
      const next = Number(current.revision) + 1;
      tx.run('UPDATE assist_sessions SET status=?,revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, next, now, principal.actorId, sessionId, expected], 1);
      const eventType = commandId === 'assist.session.resume' ? 'assist_session.resumed' : `assist_session.${status}`;
      appendAggregate(this.events, tx, { aggregateType: 'assist_session', aggregateId: sessionId, revision: next, operationId: op.id, actorId: principal.actorId, projectId: current.project_id, type: eventType, data: { session_id: sessionId }, payload: { id: sessionId, project_id: current.project_id, status, revision: next }, now });
      this.operations.linkInTransaction(tx, op.id, [['assist_session', sessionId]], now);
      const response = { session: sessionView(tx.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId])), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 200, now });
      return response;
    });
    if (status === 'cancelled' && !result.replayed) {
      for (const active of this.db.query("SELECT id,revision FROM assist_turns WHERE session_id=? AND status NOT IN ('completed','failed','cancelled')", [sessionId])) {
        await this.cancelTurnState(active.id, { expected_revision: active.revision, idempotency_key: `session-cancel-${opaqueId('key')}` }, principal, { commandId: 'assist.turn.cancel', eventType: 'assist_turn.cancelled' });
      }
    }
    return result;
  }

  async retryTurn(turnId, input, principal) {
    const row = this.db.get('SELECT * FROM assist_turns WHERE id=?', [String(turnId)]);
    if (!row) throw new PlatformError('not_found', 'Assist turn not found', {}, 404);
    const session = this.sessionRow(row.session_id); this.assertSession(principal, session, 'run');
    const expected = requireRevision(input.expected_revision);
    const messageRow = this.db.get("SELECT content_cas_hash FROM assist_messages WHERE turn_id=? AND role='user' ORDER BY sequence LIMIT 1", [row.id]);
    const message = input.message == null ? (messageRow ? this.cas.read(messageRow.content_cas_hash).toString('utf8') : '') : boundedString(input.message, 262144, { required: true });
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ turn_id: row.id, expected_revision: expected, message_sha256: sha256Hex(message) });
    const replay = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.turn.retry', idempotencyKey: key, requestHash: hash, now })); if (replay) return replay;
    assertRevision(row, expected);
    if (!TURN_TERMINAL.has(row.status)) throw new PlatformError('state_conflict', 'turn is not terminal', {}, 409);
    const content = this.cas.put(message, { mediaType: 'text/plain', metadata: { kind: 'assist.user_message.retry', turn_id: row.id } });
    const result = await this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.turn.retry', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM assist_turns WHERE id=?', [row.id]);
      assertRevision(current, expected);
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.turn.retry', resourceType: 'assist_turn', resourceId: row.id, projectId: session.project_id, requestHash: hash, parentOperationId: row.operation_id, idempotencyKey: `internal-${opaqueId('key')}`, status: 'queued', now });
      const next = Number(current.revision) + 1;
      const nextInputHash = requestHash({ message });
      tx.run("UPDATE assist_turns SET attempt=attempt+1,status='queued',operation_id=?,provider_turn_id=NULL,input_hash=?,output_hash='',error_code='',error_details_json='{}',terminal_notification_received=0,last_provider_sequence=0,revision=?,updated_at=?,completed_at=NULL,updated_by_actor_id=? WHERE id=? AND revision=?", [op.id, nextInputHash, next, now, principal.actorId, row.id, expected], 1);
      const seq = Number(tx.get('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM assist_messages WHERE turn_id=?', [row.id]).next);
      tx.run('INSERT INTO assist_messages(id,session_id,turn_id,attempt,sequence,role,kind,provider_item_id,content_sha256,content_cas_hash,terminal,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [opaqueId('assist_message'), row.session_id, row.id, Number(row.attempt) + 1, seq, 'user', 'message', null, content.hash, content.hash, 1, now]);
      appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: row.id, revision: next, operationId: op.id, actorId: principal.actorId, projectId: session.project_id, type: 'assist_turn.queued', data: { turn_id: row.id, attempt: Number(row.attempt) + 1 }, payload: { id: row.id, status: 'queued', attempt: Number(row.attempt) + 1, revision: next, input_hash: nextInputHash }, now });
      this.operations.linkInTransaction(tx, op.id, [['assist_turn', row.id], ['operation', row.operation_id, 'retry_of']], now);
      const response = this.operations.receiptFromRow(tx.get('SELECT * FROM operations WHERE id=?', [op.id]));
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.turn.retry', idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 202, now });
      return response;
    });
    if (!result.replayed) {
      this.turnFixtures.set(row.id, input.fixture || {});
      queueMicrotask(() => this.executeTurn(row.id, principal).catch(() => undefined));
    }
    return result;
  }

  async cancelTurn(turnId, input, principal) {
    return this.cancelTurnState(turnId, input, principal, { commandId: 'assist.turn.cancel', eventType: 'assist_turn.cancelled' });
  }

  async cancelTurnState(turnId, input, principal, { commandId, eventType }) {
    const row = this.db.get('SELECT * FROM assist_turns WHERE id=?', [String(turnId)]);
    if (!row) throw new PlatformError('not_found', 'Assist turn not found', {}, 404);
    const session = this.sessionRow(row.session_id);
    this.assertSession(principal, session, 'run');
    const expected = requireRevision(input.expected_revision);
    const key = requireIdempotency(input.idempotency_key);
    const hash = requestHash({ turn_id: row.id, expected_revision: expected, reason: String(input.reason || '') });
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM assist_turns WHERE id=?', [row.id]);
      assertRevision(current, expected);
      if (TURN_TERMINAL.has(current.status)) throw new PlatformError('state_conflict', 'Assist turn is terminal', { status: current.status }, 409);
      let op = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]);
      if (!op || OPERATION_TERMINAL.has(op.status)) throw new PlatformError('state_conflict', 'Assist operation is terminal', { status: op?.status || null }, 409);
      this.operations.requestCancelInTransaction(tx, op.id, {
        actorId: principal.actorId,
        projectId: session.project_id,
        expectedRevision: Number(op.revision),
        idempotencyKey: key,
        requestHash: hash,
        commandId,
        reason: input.reason || undefined
      }, now);
      op = tx.get('SELECT * FROM operations WHERE id=?', [op.id]);
      this.operations.transitionInTransaction(tx, op.id, 'cancelled', { expectedRevision: Number(op.revision), actorId: principal.actorId, projectId: session.project_id, commandId: `${commandId}.acknowledged` }, now);
      const next = Number(current.revision) + 1;
      tx.run("UPDATE assist_turns SET status='cancelled',error_code='operation_cancelled',revision=?,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [next, now, now, principal.actorId, current.id, current.revision], 1);
      appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: current.id, revision: next, operationId: current.operation_id, actorId: principal.actorId, projectId: session.project_id, type: eventType, data: { turn_id: current.id }, payload: { id: current.id, session_id: current.session_id, status: 'cancelled', revision: next }, now });
      const response = { turn: this.turnView(tx.get('SELECT * FROM assist_turns WHERE id=?', [current.id])), operation: this.operations.receiptFromRow(tx.get('SELECT * FROM operations WHERE id=?', [op.id])) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 200, now });
      return response;
    });
  }

  async steerTurn(turnId, input, principal, commandId = 'assist.turn.steer') {
    const row = this.db.get('SELECT * FROM assist_turns WHERE id=?', [String(turnId)]); if (!row) throw new PlatformError('not_found', 'Assist turn not found', {}, 404);
    const session = this.sessionRow(row.session_id); this.assertSession(principal, session, 'run');
    const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const message = boundedString(input.message || '', 262144, { required: true }); const now = time(this.clock); const hash = requestHash({ turn_id: row.id, expected_revision: expected, message_sha256: sha256Hex(message), command_id: commandId });
    const replay = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now })); if (replay) return replay;
    assertRevision(row, expected); if (TURN_TERMINAL.has(row.status)) throw new PlatformError('state_conflict', 'Assist turn is terminal', { status: row.status }, 409);
    await this.provider.steerTurn({ thread_id: session.provider_thread_id, turn_id: row.provider_turn_id, message });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM assist_turns WHERE id=?', [row.id]); assertRevision(current, expected); const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'assist_turn', resourceId: row.id, projectId: session.project_id, requestHash: hash, status: 'succeeded', now }); const next = Number(current.revision) + 1;
      tx.run('UPDATE assist_turns SET revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [next, now, principal.actorId, row.id, expected], 1); const eventType = commandId === 'assist.turn.follow-ups' ? 'assist_turn.follow_up' : 'assist_turn.steered'; appendAggregate(this.events, tx, { aggregateType: 'assist_turn', aggregateId: row.id, revision: next, operationId: op.id, actorId: principal.actorId, projectId: session.project_id, type: eventType, data: { turn_id: row.id, message_sha256: sha256Hex(message) }, payload: { id: row.id, status: current.status, revision: next }, now }); this.operations.linkInTransaction(tx, op.id, [['assist_turn', row.id], ['operation', current.operation_id, 'related']], now);
      const response = { turn: this.turnView(tx.get('SELECT * FROM assist_turns WHERE id=?', [row.id])), operation: this.operations.summary(op), steered: true }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 200, now }); return response;
    });
  }

  async interruptTurn(turnId, input, principal) {
    const row = this.db.get('SELECT * FROM assist_turns WHERE id=?', [String(turnId)]); if (!row) throw new PlatformError('not_found', 'Assist turn not found', {}, 404);
    const session = this.sessionRow(row.session_id); this.assertSession(principal, session, 'run');
    const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const hash = requestHash({ turn_id: row.id, expected_revision: expected, reason: String(input.reason || '') }); const now = time(this.clock);
    const replay = await this.db.withTransaction((tx) => priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'assist.turn.interrupt', idempotencyKey: key, requestHash: hash, now })); if (replay) return { ...replay, interrupted: true };
    assertRevision(row, expected);
    await this.provider.interruptTurn({ thread_id: session.provider_thread_id, turn_id: row.provider_turn_id });
    const result = await this.cancelTurnState(row.id, input, principal, { commandId: 'assist.turn.interrupt', eventType: 'assist_turn.interrupted' });
    return { ...result, interrupted: true };
  }

  listEvents(sessionId, input = {}, principal) {
    const row = this.sessionRow(sessionId); this.assertSession(principal, row, 'read');
    const after = input.cursor == null ? 0 : input.cursor;
    return this.events.replay({ actorId: principal.actorId, projectId: row.project_id, aggregateType: 'assist_session', aggregateId: row.id, cursor: after, limit: input.limit || 500 });
  }

  getGoal(sessionId, principal) {
    const row = this.sessionRow(sessionId); this.assertSession(principal, row, 'read');
    const goal = this.db.get('SELECT * FROM assist_goals WHERE session_id=? ORDER BY revision DESC LIMIT 1', [sessionId]);
    return { goal: goalView(goal) };
  }

  async updateGoal(sessionId, input, principal) {
    const row = this.sessionRow(sessionId); this.assertSession(principal, row, 'write');
    const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key);
    const payload = canonicalPayload(input.goal || {}); const now = time(this.clock); const commandId = 'assist.goal.update';
    const hash = requestHash({ session_id: row.id, expected_revision: expected, goal_sha256: payload.sha256 });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId]); assertRevision(current, expected);
      const id = opaqueId('assist_goal'); const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'assist_session', resourceId: sessionId, projectId: current.project_id, requestHash: hash, status: 'succeeded', now });
      const next = Number(current.revision) + 1; const goalRevision = Number(tx.get('SELECT COALESCE(MAX(revision),0)+1 AS next FROM assist_goals WHERE session_id=?', [sessionId]).next);
      tx.run('INSERT INTO assist_goals(id,session_id,revision,goal_json,goal_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?)', [id, sessionId, goalRevision, payload.json, payload.sha256, now, principal.actorId]);
      tx.run('UPDATE assist_sessions SET revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [next, now, principal.actorId, sessionId, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'assist_session', aggregateId: sessionId, revision: next, operationId: op.id, actorId: principal.actorId, projectId: current.project_id, type: 'assist_goal.updated', data: { session_id: sessionId, goal_id: id, revision: goalRevision }, payload: { id: sessionId, status: current.status, revision: next }, now });
      this.operations.linkInTransaction(tx, op.id, [['assist_session', sessionId], ['assist_goal', id]], now);
      const response = { goal: goalView(tx.get('SELECT * FROM assist_goals WHERE id=?', [id])), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 200, now });
      return response;
    });
  }

  listReferences(sessionId, principal) {
    const row = this.sessionRow(sessionId); this.assertSession(principal, row, 'read');
    return { references: this.db.query('SELECT * FROM assist_references WHERE session_id=? ORDER BY created_at,id', [sessionId]).map(referenceView) };
  }

  async createReference(sessionId, input, principal) {
    const row = this.sessionRow(sessionId); this.assertSession(principal, row, 'write');
    const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key);
    const referenceType = String(input.reference_type || ''); if (!['brief', 'workflow', 'repository', 'context_pack', 'attachment', 'file', 'operation'].includes(referenceType)) throw new PlatformError('schema_invalid', 'Assist reference type is invalid', {}, 422);
    const referenceId = boundedString(input.reference_id, 256, { required: true }); const referenceRevision = input.reference_revision == null ? null : Number(input.reference_revision);
    if (referenceRevision != null && (!Number.isInteger(referenceRevision) || referenceRevision < 0)) throw new PlatformError('schema_invalid', 'Assist reference revision is invalid', {}, 422);
    const referenceHash = String(input.reference_hash || '').toLowerCase(); if (referenceHash && !/^[a-f0-9]{64}$/.test(referenceHash)) throw new PlatformError('schema_invalid', 'Assist reference hash is invalid', {}, 422);
    const metadata = canonicalPayload(input.metadata || {}); const now = time(this.clock); const commandId = 'assist.reference.create';
    const hash = requestHash({ session_id: row.id, expected_revision: expected, reference_type: referenceType, reference_id: referenceId, reference_revision: referenceRevision, reference_hash: referenceHash, metadata_sha256: metadata.sha256 });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM assist_sessions WHERE id=?', [sessionId]); assertRevision(current, expected);
      const id = opaqueId('assist_reference'); const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'assist_session', resourceId: sessionId, projectId: current.project_id, requestHash: hash, status: 'succeeded', now }); const next = Number(current.revision) + 1;
      tx.run('INSERT INTO assist_references(id,session_id,reference_type,reference_id,reference_revision,reference_hash,metadata_json,metadata_sha256,created_at,created_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, sessionId, referenceType, referenceId, referenceRevision, referenceHash, metadata.json, metadata.sha256, now, principal.actorId]);
      tx.run('UPDATE assist_sessions SET revision=?,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [next, now, principal.actorId, sessionId, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'assist_session', aggregateId: sessionId, revision: next, operationId: op.id, actorId: principal.actorId, projectId: current.project_id, type: 'assist_reference.created', data: { session_id: sessionId, reference_id: id }, payload: { id: sessionId, status: current.status, revision: next }, now });
      this.operations.linkInTransaction(tx, op.id, [['assist_session', sessionId], ['assist_reference', id]], now);
      const response = { references: tx.query('SELECT * FROM assist_references WHERE session_id=? ORDER BY created_at,id', [sessionId]).map(referenceView), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 201, now });
      return response;
    });
  }

  // Interaction owner -----------------------------------------------------
  listApprovals(input = {}, principal) {
    requirePrincipal(principal); const projectId = input.project_id ? String(input.project_id) : null;
    if (projectId) assertProject(this.authorization, principal, 'approve', projectId, { resource: 'assist' });
    this.expireInteractions();
    const rows = projectId ? this.db.query('SELECT * FROM runtime_approvals WHERE project_id=? ORDER BY created_at DESC,id', [projectId]) : this.db.query('SELECT * FROM runtime_approvals WHERE created_by_actor_id=? OR decision_actor_id=? ORDER BY created_at DESC,id', [principal.actorId, principal.actorId]);
    return { approvals: rows.filter((x) => !input.status || x.status === String(input.status)).map(approvalView) };
  }
  async createApproval(input, principal) { return this.createInteraction('approval', input, principal); }
  async decideApproval(id, input, principal) {
    const result = await this.decideInteraction('approval', id, input, principal);
    if (!result.replayed) this.resumeForInteraction('approval', id, principal);
    return result;
  }
  listInputs(input = {}, principal) {
    requirePrincipal(principal); const projectId = input.project_id ? String(input.project_id) : null; if (projectId) assertProject(this.authorization, principal, 'read', projectId, { resource: 'assist' }); this.expireInteractions();
    const rows = projectId ? this.db.query('SELECT * FROM runtime_user_inputs WHERE project_id=? ORDER BY created_at DESC,id', [projectId]) : this.db.query('SELECT * FROM runtime_user_inputs WHERE created_by_actor_id=? OR answered_by_actor_id=? ORDER BY created_at DESC,id', [principal.actorId, principal.actorId]);
    return { inputs: rows.filter((row) => !input.status || row.status === String(input.status)).map(inputView) };
  }
  async createInput(input, principal) { return this.createInteraction('input', input, principal); }
  async answerInput(id, input, principal) { const result = await this.decideInteraction('input', id, { ...input, decision: 'approved', response: input.response }, principal); if (!result.replayed) this.resumeForInteraction('input', id, principal); return result; }
  async cancelInput(id, input, principal) { const result = await this.decideInteraction('input', id, { ...input, decision: 'cancelled' }, principal); if (!result.replayed) this.resumeForInteraction('input', id, principal); return result; }
  listProposals(input = {}, principal) {
    requirePrincipal(principal); const projectId = input.project_id ? String(input.project_id) : null; if (projectId) assertProject(this.authorization, principal, 'read', projectId, { resource: 'assist' });
    const rows = projectId ? this.db.query('SELECT * FROM semantic_proposals WHERE project_id=? ORDER BY created_at DESC,id', [projectId]) : this.db.query('SELECT * FROM semantic_proposals WHERE created_by_actor_id=? ORDER BY created_at DESC,id', [principal.actorId]); return { proposals: rows.map(proposalView) };
  }
  async createProposal(input, principal) {
    requirePrincipal(principal); const projectId = String(input.project_id); assertProject(this.authorization, principal, 'run', projectId, { resource: 'assist' });
    const expected = requireRevision(input.expected_revision, { allowZero: true }); const key = requireIdempotency(input.idempotency_key); const payload = canonicalPayload(input.payload || {}); const now = time(this.clock); const id = opaqueId('semantic_proposal'); const commandId = 'proposal.create';
    const proposalType = boundedString(input.proposal_type, 120, { required: true }); const targetType = boundedString(input.target_type, 120, { required: true }); const targetId = boundedString(input.target_id, 256, { required: true }); const targetRevision = Number(input.target_revision || 0); if (!Number.isInteger(targetRevision) || targetRevision < 0) throw new PlatformError('schema_invalid', 'proposal target revision is invalid', {}, 422);
    const hash = requestHash({ project_id: projectId, expected_revision: expected, operation_id: input.operation_id || null, assist_turn_id: input.assist_turn_id || null, proposal_type: proposalType, target_type: targetType, target_id: targetId, target_revision: targetRevision, payload_sha256: payload.sha256 });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'semantic_proposal', resourceId: id, projectId, requestHash: hash, status: 'succeeded', now });
      tx.run('INSERT INTO semantic_proposals(id,project_id,operation_id,assist_turn_id,proposal_type,target_type,target_id,target_revision,payload_json,payload_sha256,status,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,\'pending\',1,?,?,?,?)', [id, projectId, input.operation_id || op.id, input.assist_turn_id || null, proposalType, targetType, targetId, targetRevision, payload.json, payload.sha256, now, now, principal.actorId, principal.actorId]);
      appendAggregate(this.events, tx, { aggregateType: 'semantic_proposal', aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, projectId, type: 'semantic_proposal.created', data: { proposal_id: id }, payload: { id, project_id: projectId, status: 'pending', revision: 1 }, now });
      const links = [['semantic_proposal', id]]; if (input.operation_id) links.push(['operation', String(input.operation_id), 'parent']); if (input.assist_turn_id) links.push(['assist_turn', String(input.assist_turn_id), 'related']); this.operations.linkInTransaction(tx, op.id, links, now);
      const response = { proposal: proposalView(tx.get('SELECT * FROM semantic_proposals WHERE id=?', [id])), operation: this.operations.summary(op) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 201, now }); return response;
    });
  }
  async mutateProposal(id, action, input, principal) {
    const row = this.db.get('SELECT * FROM semantic_proposals WHERE id=?', [String(id)]); if (!row) throw new PlatformError('not_found', 'proposal not found', {}, 404); assertProject(this.authorization, principal, action === 'reject' ? 'approve' : 'write', row.project_id, { resource: 'assist' });
    if (!['apply', 'reject', 'undo'].includes(action)) throw new PlatformError('schema_invalid', 'proposal action is invalid', {}, 422); const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const commandId = `proposal.${action}`; const hash = requestHash({ proposal_id: row.id, expected_revision: expected, action }); const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get('SELECT * FROM semantic_proposals WHERE id=?', [row.id]); assertRevision(current, expected); if ((action === 'undo' && current.status !== 'approved') || (action !== 'undo' && current.status !== 'pending')) throw new PlatformError('state_conflict', action === 'undo' ? 'proposal is not applied' : 'proposal is not pending', { status: current.status }, 409);
      const status = action === 'apply' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled'; const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'semantic_proposal', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now }); const next = Number(current.revision) + 1;
      tx.run('UPDATE semantic_proposals SET status=?,applied_operation_id=CASE WHEN ?=\'apply\' THEN ? ELSE applied_operation_id END,revision=?,updated_at=?,decided_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, action, op.id, next, now, now, principal.actorId, row.id, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: 'semantic_proposal', aggregateId: row.id, revision: next, operationId: op.id, actorId: principal.actorId, projectId: row.project_id, type: `semantic_proposal.${action === 'apply' ? 'applied' : action === 'reject' ? 'rejected' : 'undone'}`, data: { proposal_id: row.id }, payload: { id: row.id, status, revision: next }, now }); this.operations.linkInTransaction(tx, op.id, [['semantic_proposal', row.id]], now);
      const response = { proposal: proposalView(tx.get('SELECT * FROM semantic_proposals WHERE id=?', [row.id])), operation: this.operations.summary(op) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 200, now }); return response;
    });
  }

  async createInteraction(kind, input, principal) {
    requirePrincipal(principal); const projectId = String(input.project_id); assertProject(this.authorization, principal, 'run', projectId, { resource: 'assist' }); const expected = requireRevision(input.expected_revision, { allowZero: true }); const key = requireIdempotency(input.idempotency_key); const now = time(this.clock); const ttl = Math.max(1, Math.min(86400, Number(input.ttl_seconds || 900))); const expires = new Date(Date.parse(now) + ttl * 1000).toISOString(); const commandId = kind === 'approval' ? 'approval.create' : 'user.input.create'; const id = opaqueId(kind === 'approval' ? 'approval' : 'user_input');
    const action = kind === 'approval' ? boundedString(input.action, 160, { required: true }) : null; const request = kind === 'approval' ? canonicalPayload(input.request || {}) : null; const prompt = kind === 'input' ? boundedString(input.prompt_summary, 1000, { required: true }) : null; const schema = kind === 'input' ? canonicalPayload(input.input_schema || {}) : null;
    const hash = requestHash({ kind, project_id: projectId, expected_revision: expected, operation_id: input.operation_id || null, assist_turn_id: input.assist_turn_id || null, action, request_sha256: request?.sha256 || null, prompt_summary: prompt, input_schema_sha256: schema?.sha256 || null, ttl_seconds: ttl });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const resourceType = kind === 'approval' ? 'runtime_approval' : 'runtime_user_input'; const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType, resourceId: id, projectId, requestHash: hash, status: 'succeeded', now }); const ownerOperationId = input.operation_id || op.id;
      if (kind === 'approval') tx.run('INSERT INTO runtime_approvals(id,project_id,operation_id,assist_turn_id,action,action_sha256,request_json,request_sha256,status,requested_revision,expires_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,?,\'pending\',?,?,?,?,?,?,?)', [id, projectId, ownerOperationId, input.assist_turn_id || null, action, sha256Hex(action), request.json, request.sha256, expected, expires, 1, now, now, principal.actorId, principal.actorId]);
      else tx.run('INSERT INTO runtime_user_inputs(id,project_id,operation_id,assist_turn_id,prompt_summary,input_schema_json,input_schema_sha256,status,requested_revision,expires_at,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(?,?,?,?,?,?,?,\'pending\',?,?,?,?,?,?,?)', [id, projectId, ownerOperationId, input.assist_turn_id || null, prompt, schema.json, schema.sha256, expected, expires, 1, now, now, principal.actorId, principal.actorId]);
      appendAggregate(this.events, tx, { aggregateType: resourceType, aggregateId: id, revision: 1, operationId: op.id, actorId: principal.actorId, projectId, type: `${resourceType}.requested`, data: kind === 'approval' ? { approval_id: id, action } : { input_id: id }, payload: { id, project_id: projectId, status: 'pending', revision: 1 }, now }); const links = [[resourceType, id]]; if (input.operation_id) links.push(['operation', String(input.operation_id), 'parent']); if (input.assist_turn_id) links.push(['assist_turn', String(input.assist_turn_id), 'related']); this.operations.linkInTransaction(tx, op.id, links, now);
      const response = kind === 'approval' ? { approval: approvalView(tx.get('SELECT * FROM runtime_approvals WHERE id=?', [id])), operation: this.operations.summary(op) } : { input: inputView(tx.get('SELECT * FROM runtime_user_inputs WHERE id=?', [id])), operation: this.operations.summary(op) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 201, now }); return response;
    });
  }
  async decideInteraction(kind, id, input, principal) {
    const table = kind === 'approval' ? 'runtime_approvals' : 'runtime_user_inputs'; const resourceType = kind === 'approval' ? 'runtime_approval' : 'runtime_user_input'; const row = this.db.get(`SELECT * FROM ${table} WHERE id=?`, [String(id)]); if (!row) throw new PlatformError('not_found', `${kind} not found`, {}, 404); assertProject(this.authorization, principal, kind === 'approval' ? 'approve' : 'write', row.project_id, { resource: 'assist' }); const expected = requireRevision(input.expected_revision); const key = requireIdempotency(input.idempotency_key); const status = input.decision === 'approved' ? 'approved' : input.decision === 'rejected' ? 'rejected' : 'cancelled'; if (kind === 'approval' && !['approved', 'rejected'].includes(status)) throw new PlatformError('schema_invalid', 'approval decision is invalid', {}, 422); const commandId = kind === 'approval' ? 'approval.decide' : status === 'cancelled' ? 'user.input.cancel' : 'user.input.answer'; const responsePayload = kind === 'input' ? canonicalPayload(input.response || {}) : null; const hash = requestHash({ id: row.id, expected_revision: expected, status, reason: String(input.reason || ''), response_sha256: responsePayload?.sha256 || null }); const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, now }); if (prior) return prior;
      const current = tx.get(`SELECT * FROM ${table} WHERE id=?`, [row.id]); assertRevision(current, expected); if (INTERACTION_TERMINAL.has(current.status)) throw new PlatformError('state_conflict', 'interaction is already decided', {}, 409); const op = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType, resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now }); const next = Number(current.revision) + 1;
      if (kind === 'approval') tx.run('UPDATE runtime_approvals SET status=?,decision_actor_id=?,decision_reason=?,revision=?,updated_at=?,decided_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, principal.actorId, String(input.reason || ''), next, now, now, principal.actorId, row.id, expected], 1); else tx.run('UPDATE runtime_user_inputs SET status=?,response_json=?,response_sha256=?,answered_by_actor_id=?,revision=?,updated_at=?,answered_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, responsePayload.json, responsePayload.sha256, principal.actorId, next, now, now, principal.actorId, row.id, expected], 1);
      appendAggregate(this.events, tx, { aggregateType: resourceType, aggregateId: row.id, revision: next, operationId: op.id, actorId: principal.actorId, projectId: row.project_id, type: `${resourceType}.${status}`, data: { id: row.id, status }, payload: { id: row.id, project_id: row.project_id, status, revision: next }, now }); const links = [[resourceType, row.id]]; if (row.operation_id && row.operation_id !== op.id) links.push(['operation', row.operation_id, 'parent']); this.operations.linkInTransaction(tx, op.id, links, now);
      const response = kind === 'approval' ? { approval: approvalView(tx.get('SELECT * FROM runtime_approvals WHERE id=?', [row.id])), operation: this.operations.summary(op) } : { input: inputView(tx.get('SELECT * FROM runtime_user_inputs WHERE id=?', [row.id])), operation: this.operations.summary(op) }; saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey: key, requestHash: hash, response, operationId: op.id, status: 200, now }); return response;
    });
  }
  expireInteractions() { const now = time(this.clock); this.db.run("UPDATE runtime_approvals SET status='expired',revision=revision+1,updated_at=?,decided_at=? WHERE status='pending' AND expires_at<=?", [now, now, now]); this.db.run("UPDATE runtime_user_inputs SET status='expired',revision=revision+1,updated_at=?,answered_at=? WHERE status='pending' AND expires_at<=?", [now, now, now]); }
  resumeForInteraction(kind, id, principal) { const table = kind === 'approval' ? 'runtime_approvals' : 'runtime_user_inputs'; const row = this.db.get(`SELECT assist_turn_id FROM ${table} WHERE id=?`, [String(id)]); if (row?.assist_turn_id) queueMicrotask(() => this.executeTurn(row.assist_turn_id, principal, { resume: true }).catch(() => undefined)); }

  interactionResolution(turnId) {
    const rows = this.db.query(`SELECT status FROM runtime_approvals WHERE assist_turn_id=?
      UNION ALL SELECT status FROM runtime_user_inputs WHERE assist_turn_id=?`, [String(turnId), String(turnId)]);
    return {
      pending: rows.some((row) => row.status === 'pending'),
      rejected: rows.find((row) => ['rejected', 'cancelled', 'expired'].includes(row.status)) || null
    };
  }

  interactionResolutions(turnId) {
    const approvals = this.db.query('SELECT id,status,decision_reason FROM runtime_approvals WHERE assist_turn_id=? AND status<>\'pending\' ORDER BY created_at,id', [String(turnId)]).map((row) => ({ kind: 'approval', id: row.id, status: row.status, response: { decision: row.status, reason: row.decision_reason || null } }));
    const inputs = this.db.query('SELECT id,status,response_json FROM runtime_user_inputs WHERE assist_turn_id=? AND status<>\'pending\' ORDER BY created_at,id', [String(turnId)]).map((row) => ({ kind: 'input', id: row.id, status: row.status, response: row.response_json ? parseJson(row.response_json, {}) : {} }));
    return [...approvals, ...inputs];
  }

  async recoverPending() {
    const rows = this.db.query("SELECT * FROM assist_turns WHERE status IN ('queued','running') ORDER BY created_at,id");
    for (const row of rows) {
      await this.failTurn(row.id, new PlatformError('external_result_unknown', 'provider result was unknown across restart', {}, 503), { actorId: row.created_by_actor_id, scopes: ['*'] });
    }
    return rows.length;
  }

  async close() { await this.provider?.close?.(); }

  sessionRow(id) { const row = this.db.get('SELECT * FROM assist_sessions WHERE id=?', [String(id)]); if (!row) throw new PlatformError('not_found', 'Assist session not found', {}, 404); return row; }
  assertSession(principal, row, action) { assertProject(this.authorization, principal, action, row.project_id, { resource: 'assist', operationId: null }); }
  profileFor(id, principal) { const row = id ? this.db.get('SELECT * FROM provider_profiles WHERE id=? AND owner_actor_id=?', [String(id), principal.actorId]) : this.db.get("SELECT * FROM provider_profiles WHERE owner_actor_id=? AND status='available' ORDER BY updated_at DESC,id LIMIT 1", [principal.actorId]); if (!row) throw new PlatformError('provider_profile_required', 'an available provider profile is required', {}, 422); if (row.status !== 'available') throw new PlatformError('provider_unavailable', 'provider profile is unavailable', {}, 503); return row; }
  credentialFor(profile, principal) { const row = this.db.get('SELECT * FROM credential_refs WHERE id=? AND owner_actor_id=?', [profile.credential_ref_id, principal.actorId]); if (!row || row.status !== 'active') throw new PlatformError('credential_rebind_required', 'provider credential proof is required', {}, 422); return row; }
  credentialForSession(session, principal) {
    const owner = String(session.created_by_actor_id || principal.actorId);
    const row = this.db.get(`SELECT c.* FROM credential_refs c JOIN provider_profiles p ON p.credential_ref_id=c.id
      WHERE p.id=? AND c.owner_actor_id=?`, [String(session.profile_id), owner]);
    if (!row || row.status !== 'active') throw new PlatformError('credential_rebind_required', 'provider credential proof is required', {}, 422);
    if (Number(row.revision) !== Number(session.credential_revision)) throw new PlatformError('assist_snapshot_drift', 'Assist credential revision changed', { snapshot: 'credential_revision' }, 409);
    return row;
  }
  providerConfig(profile) { return parseJson(profile?.config_json || '{}', {}); }
  providerConfigForSession(session) {
    const profile = this.db.get('SELECT * FROM provider_profiles WHERE id=?', [String(session.profile_id)]);
    if (!profile || Number(profile.revision) !== Number(session.profile_revision) || sha256Hex(profile.config_json || '{}') !== String(session.profile_hash || '')) {
      throw new PlatformError('assist_snapshot_drift', 'Assist provider profile revision changed', { snapshot: 'profile_revision' }, 409);
    }
    return this.providerConfig(profile);
  }
  credentialBytes(credential) {
    if (!credential || !String(credential.external_ref || '').startsWith('vault:') || !this.vault) throw new PlatformError('credential_rebind_required', 'provider credential proof is required', {}, 422);
    try {
      const bytes = Buffer.from(this.vault.read(credential.external_ref));
      if (!bytes.length || bytes.length > 4096) throw new Error('credential_size_invalid');
      return bytes;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError('credential_rebind_required', 'provider credential proof is required', {}, 422);
    }
  }
  workspaceCwd(workspaceId) {
    if (!workspaceId) return undefined;
    const workspace = this.db.get('SELECT project_id,relative_path FROM repository_workspaces WHERE id=?', [String(workspaceId)]);
    if (!workspace) return undefined;
    const root = path.resolve(String(this.config.workspaceRoot || this.config.home || process.cwd()));
    const candidate = path.resolve(root, String(workspace.relative_path || `projects/${workspace.project_id}/workspace`));
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new PlatformError('workspace_path_invalid', 'repository workspace path is invalid', {}, 422);
    return candidate;
  }
  turnView(row) { return turnView(row, this.db, this.cas); }
  bundle(row) { return { ...sessionView(row), turns: this.db.query('SELECT * FROM assist_turns WHERE session_id=? ORDER BY turn_no,id', [row.id]).map((turn) => this.turnView(turn)), goal: this.getGoal(row.id, { actorId: row.created_by_actor_id, scopes: ['*'] }).goal, references: this.listReferences(row.id, { actorId: row.created_by_actor_id, scopes: ['*'] }).references }; }
  removeCasIfUnreferenced(hash) { const count = this.db.get('SELECT (SELECT count(*) FROM assist_messages WHERE content_cas_hash=?) + (SELECT count(*) FROM attachments WHERE content_cas_hash=?) AS n', [hash, hash]); if (!Number(count?.n)) { try { this.cas.fileFor(hash); } catch {} } }
}

function sessionView(row) {
  return { id: row.id, project_id: row.project_id, scope: row.scope, scope_id: row.scope_id, context_pack_id: row.context_pack_id, context_pack_hash: row.context_pack_hash, profile_id: row.profile_id, profile_revision: Number(row.profile_revision), credential_revision: Number(row.credential_revision), provider_thread_id: row.provider_thread_id || null, status: row.status, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at };
}
function turnView(row, db, cas) {
  if (!row) return null;
  const messages = row.id && db && cas ? db.query('SELECT * FROM assist_messages WHERE turn_id=? ORDER BY sequence,id', [row.id]).map((message) => {
    let content = null;
    try { content = cas.read(message.content_cas_hash).toString('utf8'); } catch { content = null; }
    return { id: message.id, attempt: Number(message.attempt), sequence: Number(message.sequence), role: message.role, kind: message.kind, provider_item_id: message.provider_item_id || null, content, content_sha256: message.content_sha256, terminal: Boolean(message.terminal), created_at: message.created_at };
  }) : [];
  return { id: row.id, session_id: row.session_id, turn_no: Number(row.turn_no), attempt: Number(row.attempt), operation_id: row.operation_id, provider_turn_id: row.provider_turn_id || null, status: row.status, input_hash: row.input_hash, output_hash: row.output_hash || null, terminal_notification_received: Boolean(row.terminal_notification_received), last_provider_sequence: Number(row.last_provider_sequence), error_code: row.error_code || null, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at || null, messages };
}
function goalView(row) { return row ? { id: row.id, session_id: row.session_id, revision: Number(row.revision), goal: parseJson(row.goal_json, {}), goal_hash: row.goal_sha256, created_at: row.created_at } : null; }
function referenceView(row) { return { id: row.id, session_id: row.session_id, reference_type: row.reference_type, reference_id: row.reference_id, reference_revision: row.reference_revision == null ? null : Number(row.reference_revision), reference_hash: row.reference_hash || null, metadata: parseJson(row.metadata_json, {}), created_at: row.created_at }; }
function approvalView(row) { return { id: row.id, project_id: row.project_id, operation_id: row.operation_id || null, assist_turn_id: row.assist_turn_id || null, action: row.action, action_hash: row.action_sha256, request: parseJson(row.request_json, {}), status: row.status, requested_revision: Number(row.requested_revision), decision_actor_id: row.decision_actor_id || null, decision_reason: row.decision_reason || null, expires_at: row.expires_at, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, decided_at: row.decided_at || null }; }
function inputView(row) { return { id: row.id, project_id: row.project_id, operation_id: row.operation_id || null, assist_turn_id: row.assist_turn_id || null, prompt_summary: row.prompt_summary, input_schema: parseJson(row.input_schema_json, {}), response: row.response_json ? parseJson(row.response_json, {}) : null, status: row.status, requested_revision: Number(row.requested_revision), expires_at: row.expires_at, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, answered_at: row.answered_at || null }; }
function proposalView(row) { return { id: row.id, project_id: row.project_id, operation_id: row.operation_id || null, assist_turn_id: row.assist_turn_id || null, proposal_type: row.proposal_type, target_type: row.target_type, target_id: row.target_id, target_revision: Number(row.target_revision), payload: parseJson(row.payload_json, {}), payload_hash: row.payload_sha256, status: row.status, applied_operation_id: row.applied_operation_id || null, revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, decided_at: row.decided_at || null }; }
function normalizeProviderError(error) { if (error instanceof PlatformError) return error; return new PlatformError(String(error?.code || 'provider_unavailable'), 'provider adapter failed', { reason: String(error?.message || '').slice(0, 200) }, 503); }
function normalizeAssistError(error) { if (error instanceof PlatformError) return error; return new PlatformError(String(error?.code || 'assist_runtime_failed'), 'Assist runtime failed', { reason: String(error?.message || '').slice(0, 200) }, 502); }
function positiveSnapshotRevision(value) { const revision = Number(value); return Number.isInteger(revision) && revision > 0 ? revision : null; }
