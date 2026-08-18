import fs from 'node:fs';
import path from 'node:path';
import { asJson, hashJson, id, now, parseJson, sha256, stableStringify } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';
import { AssistRepository } from './repository.mjs';
import { AssistRuntimeAdapter } from './runtime.mjs';

const TURN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class AssistService {
  constructor({ db, config, broker, operations, setup, auditStatement }) {
    this.config = config;
    this.operations = operations;
    this.setup = setup;
    this.auditStatement = auditStatement;
    this.repo = new AssistRepository(db);
    this.runtime = new AssistRuntimeAdapter({ broker, config });
    operations.registerHandler('assist.turn', {
      cancel: (operation) => this.runtime.cancelTurn(operation.external_ref),
      recover: (operation) => this.recoverOperation(operation)
    });
  }

  async list(projectId = null) {
    const rows = await this.repo.listSessions(projectId);
    return rows.map((row) => this.sessionView(row));
  }

  async get(sessionId) {
    const session = await this.repo.session(sessionId);
    if (!session) throw new AppError('not_found', 'Assist session not found');
    const turns = await this.repo.turns(sessionId);
    return { ...this.sessionView(session), turns: await Promise.all(turns.map((turn) => this.turnView(turn))) };
  }

  async getTurn(turnId) {
    const turn = await this.repo.turn(turnId);
    if (!turn) throw new AppError('not_found', 'Assist turn not found');
    return this.turnView(turn);
  }

  async createSession(input, ctx = {}) {
    const projectId = String(input?.project_id || '').trim();
    const project = await this.repo.project(projectId);
    if (!project) throw new AppError('not_found', 'project not found');
    const native = String(input?.mode || 'legacy') === 'native';
    if (native) {
      assert(this.config.assistNativeV6 === true, 'assist_runtime_unavailable', 'Assist native runtime is disabled', { status: 503, retryable: true });
      this.expected(input.expected_revision, 0);
    }
    const target = native
      ? await this.resolveScope(projectId, input?.scope || 'project', input?.scope_id || projectId)
      : this.legacyScope(projectId, input?.scope || 'project', input?.scope_id || projectId);
    const [[brief, workflow, repository], contextPack, runtimeBinding] = await Promise.all([
      this.repo.sessionBindings(projectId),
      native ? this.validatePack(projectId, input.context_pack_id) : null,
      native ? this.runtimeBinding() : null
    ]);
    const snapshot = {
      project_id: projectId, scope: target.scope, scope_id: target.scope_id,
      brief_revision: brief?.revision || null, brief_hash: brief?.content_hash || null,
      workflow_revision: workflow?.revision || null, workflow_hash: workflow?.graph_hash || null,
      repository_sha: repository?.head_sha || '', context_pack_id: contextPack?.id || null,
      context_pack_hash: contextPack?.pack_hash || '', selection_hash: contextPack?.selection_hash || '',
      policy_revision: Number(contextPack?.policy_revision || 0), context_pack_cas_hash: contextPack?.cas?.hash || '',
      context_pack_cas_path: contextPack?.cas?.relative || '', profile_id: runtimeBinding?.profile.profile_id || null,
      profile_revision: runtimeBinding?.profile.profile_revision || null, profile_hash: runtimeBinding?.profile.profile_hash || '',
      credential_ref: runtimeBinding?.profile.credential_ref || null, credential_revision: runtimeBinding?.profile.credential_revision || null,
      runner_digest: runtimeBinding?.profile.runner_digest || ''
    };
    const sessionId = id('ast');
    const snapshotId = id('ass');
    const timestamp = now();
    await this.repo.createSession({ sessionId, snapshotId, projectId, target, snapshot, compatibility: native ? 'native_v6' : 'legacy_compat', contextPack, timestamp, snapshotStatement: this.sessionSnapshotStatement({ id: snapshotId, sessionId, revision: 1, status: 'active', snapshot, target, actor: ctx.actor, timestamp }), audit: this.auditStatement('assist_session.created', 'assist_session', sessionId, { project_id: projectId, scope: target.scope, scope_hash: target.hash }, ctx.actor) });
    return (await this.get(sessionId));
  }

  async createTurn(sessionId, input, ctx = {}) {
    const session = await this.repo.session(sessionId);
    if (!session) throw new AppError('not_found', 'Assist session not found');
    assert(session.status === 'active', 'assist_session_inactive', 'Assist session is not active', { status: 409 });
    if (session.compatibility !== 'native_v6') return this.createLegacyTurn(session, input, ctx);
    this.expected(input.expected_revision, session.revision);
    const message = this.message(input.message);
    const goal = this.goal(input.goal);
    const plan = this.plan(input.plan);
    await this.validateCurrentBindings(session, { message, goal, plan });
    const turnId = id('atr');
    const turnNo = await this.repo.nextTurnNo(sessionId);
    const inputHash = hashJson({ message, goal, plan });
    const inputCas = this.writeCas(stableStringify({ message, goal, plan }), inputHash);
    const operation = await this.operations.create({ kind: 'assist.turn', resourceType: 'assist_turn', resourceId: turnId, actor: ctx.actor || 'local-user' });
    const timestamp = now();
    const snapshotId = id('ats');
    const sessionSnapshotId = id('ass');
    const sessionSnapshot = parseJson(session.snapshot_json, {});
    try {
      await this.repo.createNativeTurn({ turnId, session, turnNo, goal, plan, message, timestamp, inputHash, operationId: operation.operation_id, snapshotId, snapshotStatement: this.turnSnapshotStatement({ id: snapshotId, turnId, attempt: 1, revision: 1, status: 'queued', inputHash, inputCas, goal, plan, session, timestamp }), sessionSnapshotId, sessionSnapshotStatement: this.sessionSnapshotStatement({ id: sessionSnapshotId, sessionId, revision: Number(session.revision) + 1, status: session.status, snapshot: sessionSnapshot, target: { scope: session.scope, hash: hashJson({ project_id: session.project_id, scope: session.scope, scope_id: session.scope_id }) }, actor: ctx.actor, timestamp }), audit: this.auditStatement('assist_turn.created', 'assist_turn', turnId, { session_id: sessionId, turn_no: turnNo, attempt: 1, input_hash: inputHash }, ctx.actor) });
    } catch (error) {
      await this.operations.reconcile(operation.operation_id, { status: 'failed', error_code: 'operation_interrupted' }).catch(() => undefined);
      this.cleanupCas(inputCas);
      throw this.casError(error);
    }
    queueMicrotask(() => this.operations.run(operation.operation_id, (opCtx) => this.executeTurn(turnId, 1, opCtx)));
    return this.operations.receipt(await this.operations.get(operation.operation_id));
  }

  async retry(turnId, input, ctx = {}) {
    const turn = await this.repo.turn(turnId);
    if (!turn) throw new AppError('not_found', 'Assist turn not found');
    assert(turn.compatibility === 'native_v6', 'invalid_state', 'legacy Assist turns are not retryable', { status: 409 });
    assert(TURN_TERMINAL.has(turn.status), 'operation_terminal', 'Assist turn is still active', { status: 409 });
    this.expected(input.expected_revision, turn.revision);
    const session = await this.repo.session(turn.session_id);
    assert(session?.status === 'active', 'assist_session_inactive', 'Assist session is not active', { status: 409 });
    const first = await this.repo.attemptMessage(turnId, turn.attempt);
    const message = String(input.message || first?.content || '');
    const goal = input.goal == null ? parseJson(turn.goal_json, {}) : this.goal(input.goal);
    const plan = input.plan == null ? parseJson(turn.plan_json, []) : this.plan(input.plan);
    await this.validateCurrentBindings(session, { message, goal, plan });
    const attempt = Number(turn.attempt) + 1;
    const revision = Number(turn.revision) + 1;
    const operation = await this.operations.create({ kind: 'assist.turn', resourceType: 'assist_turn', resourceId: turnId, actor: ctx.actor || 'local-user' });
    const snapshotId = id('ats');
    const timestamp = now();
    const inputHash = hashJson({ message, goal, plan });
    const inputCas = this.writeCas(stableStringify({ message, goal, plan }), inputHash);
    try {
      await this.repo.retryTurn({ turn, turnId, attempt, revision, operationId: operation.operation_id, snapshotId, inputHash, inputCas, message, goal, plan, timestamp, snapshotStatement: this.turnSnapshotStatement({ id: snapshotId, turnId, attempt, revision, status: 'queued', inputHash, inputCas, goal, plan, session, timestamp }) });
    } catch (error) {
      await this.operations.reconcile(operation.operation_id, { status: 'failed', error_code: 'operation_interrupted' }).catch(() => undefined);
      this.cleanupCas(inputCas);
      throw this.casError(error);
    }
    queueMicrotask(() => this.operations.run(operation.operation_id, (opCtx) => this.executeTurn(turnId, attempt, opCtx)));
    return this.operations.receipt(await this.operations.get(operation.operation_id));
  }

  async cancel(turnId, input) {
    const turn = await this.repo.turn(turnId);
    if (!turn) throw new AppError('not_found', 'Assist turn not found');
    if (TURN_TERMINAL.has(turn.status)) throw new AppError('operation_terminal', 'Assist turn already reached a terminal state', { status: 409 });
    this.expected(input.expected_revision, turn.revision);
    const operation = await this.operations.get(turn.operation_id);
    await this.operations.cancel(operation.id, { expected_revision: operation.revision });
    await this.appendTurnSnapshot(turnId, turn.attempt, 'cancelled', { expectedRevision: turn.revision, errorCode: 'operation_cancelled' });
    return this.operations.receipt(await this.operations.get(operation.id));
  }

  async transition(sessionId, input, ctx = {}) {
    const action = String(input?.action || '');
    const next = { cancel: 'cancelled', interrupt: 'paused', resume: 'active', complete: 'completed' }[action];
    assert(next, 'invalid_input', 'Assist transition is invalid', { status: 422 });
    const session = await this.repo.session(sessionId);
    if (!session) throw new AppError('not_found', 'Assist session not found');
    if (session.compatibility === 'native_v6') this.expected(input.expected_revision, session.revision);
    const allowed = session.status === 'active' ? new Set(['cancel', 'interrupt', 'complete']) : session.status === 'paused' ? new Set(['cancel', 'resume', 'complete']) : new Set();
    assert(allowed.has(action), ['cancelled', 'completed'].includes(session.status) ? 'operation_terminal' : 'invalid_state', 'Assist session transition is invalid', { status: 409 });
    if (['cancelled', 'completed'].includes(session.status)) throw new AppError('operation_terminal', 'Assist session already reached a terminal state', { status: 409 });
    if (action === 'cancel') {
      const activeTurns = await this.repo.activeTurns(sessionId);
      for (const turn of activeTurns) await this.cancel(turn.id, { expected_revision: turn.revision }).catch((error) => {
        if (!['operation_terminal', 'revision_conflict'].includes(error?.code)) throw error;
      });
    }
    const timestamp = now();
    const revision = Number(session.revision) + 1;
    const sessionSnapshotId = id('ass');
    const sessionSnapshot = parseJson(session.snapshot_json, {});
    await this.repo.transitionSession({ session, next, action, revision, snapshotId: sessionSnapshotId, timestamp, snapshotStatement: this.sessionSnapshotStatement({ id: sessionSnapshotId, sessionId, revision, status: next, snapshot: sessionSnapshot, target: { scope: session.scope, hash: hashJson({ project_id: session.project_id, scope: session.scope, scope_id: session.scope_id }) }, actor: ctx.actor, timestamp }), audit: this.auditStatement(`assist_session.${action}`, 'assist_session', sessionId, { from: session.status, to: next }, ctx.actor) }).catch((error) => { throw this.casError(error); });
    return this.get(sessionId);
  }

  async events(sessionId, after = 0, consumerId = null) {
    if (!await this.repo.session(sessionId)) throw new AppError('not_found', 'Assist session not found');
    const events = await this.repo.events(sessionId, after);
    return consumerId ? { events, cursor: events.at(-1)?.cursor || Number(after) || 0, consumer_id: consumerId } : events;
  }

  async ack(sessionId, input) {
    if (!await this.repo.session(sessionId)) throw new AppError('not_found', 'Assist session not found');
    const expected = Number(input.expected_revision);
    assert(Number.isInteger(expected) && expected >= 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    const current = await this.repo.cursor(sessionId, String(input.consumer_id || 'default'));
    if (Number(current?.revision || 0) !== expected) throw new AppError('revision_conflict', 'event cursor revision changed', { status: 409, details: { current_revision: Number(current?.revision || 0) } });
    assert(Number(input.cursor) >= Number(current?.cursor || 0), 'cursor_regression', 'event cursor must be monotonic', { status: 409 });
    const result = await this.repo.ackCursor(sessionId, String(input.consumer_id || 'default'), Number(input.cursor || 0), expected);
    if (result.conflict) throw new AppError('revision_conflict', 'event cursor revision changed', { status: 409, details: { current_revision: result.current.revision } });
    return result;
  }

  async executeTurn(turnId, attempt, opCtx, { resume = false, externalRef = '' } = {}) {
    const turn = await this.repo.turn(turnId);
    const session = turn && await this.repo.session(turn.session_id);
    if (!turn || !session || Number(turn.attempt) !== Number(attempt)) throw new AppError('operation_interrupted', 'Assist turn checkpoint is stale');
    try {
      const input = await this.validateCurrentBindings(session, await this.inputFor(turn));
      await this.appendTurnSnapshot(turnId, attempt, 'running', { expectedRevision: turn.revision });
      const binding = await this.runtimeBinding(parseJson(session.snapshot_json, {}));
      const payload = { turn_id: turnId, attempt, project_id: session.project_id, context_pack_id: session.context_pack_id, context_pack_hash: session.context_pack_hash, input_hash: turn.input_hash, objective: input.message, ...binding };
      const outcome = resume
        ? await this.runtime.resumeTurn({ ...payload, external_ref: externalRef }, opCtx)
        : await this.runtime.startTurn(payload, opCtx);
      const completeResult = outcome.result && typeof outcome.result === 'object' ? outcome.result : {};
      const outputPayload = stableStringify(completeResult);
      const outputHash = sha256(outputPayload);
      const outputCas = this.writeCas(outputPayload, outputHash);
      const response = this.summary(completeResult.summary || 'Assist turn completed');
      const current = await this.repo.turn(turnId);
      const sessionNow = await this.repo.session(current.session_id);
      const previous = await this.repo.snapshot(current.head_snapshot_id);
      const revision = Number(current.revision) + 1;
      const snapshotId = id('ats');
      const timestamp = now();
      try {
        await this.repo.completeTurn({ turn: current, session: sessionNow, previous, attempt, response, outputCas, outputHash, revision, snapshotId, timestamp, audit: this.auditStatement('assist_turn.completed', 'assist_turn', turnId, { attempt, revision, output_hash: outputHash }, 'runtime') });
      } catch (error) {
        this.cleanupCas(outputCas);
        throw this.casError(error);
      }
      return { turn_id: turnId, attempt, status: 'completed', output_hash: outputHash };
    } catch (error) {
      const current = await this.repo.turn(turnId);
      if (current && !TURN_TERMINAL.has(current.status)) await this.appendTurnSnapshot(turnId, attempt, error.code === 'operation_cancelled' ? 'cancelled' : 'failed', { expectedRevision: current.revision, errorCode: error.code || 'assist_runtime_failed' }).catch(() => undefined);
      throw error;
    }
  }

  async recoverOperation(operation) {
    const turn = await this.repo.turn(operation.resource_id);
    if (!turn) return false;
    if (TURN_TERMINAL.has(turn.status)) {
      await this.operations.reconcile(operation, { status: turn.status, error_code: turn.status === 'failed' ? 'operation_interrupted' : undefined, result: { turn_id: turn.id, status: turn.status } });
      return true;
    }
    try { await this.validateCurrentBindings(await this.repo.session(turn.session_id), await this.inputFor(turn)); }
    catch (error) { await this.operations.reconcile(operation, { status: 'failed', error_code: error.code }); return true; }
    return (opCtx) => this.executeTurn(turn.id, turn.attempt, opCtx, { resume: true, externalRef: operation.external_ref || '' });
  }

  async appendTurnSnapshot(turnId, attempt, status, { expectedRevision, errorCode = null, outputCas = null } = {}) {
    const turn = await this.repo.turn(turnId);
    this.expected(expectedRevision, turn.revision);
    const session = await this.repo.session(turn.session_id);
    const revision = Number(turn.revision) + 1;
    const snapshotId = id('ats');
    const timestamp = now();
    const previous = await this.repo.snapshot(turn.head_snapshot_id);
    await this.repo.appendTurn({ turn, session, previous, attempt, status, revision, snapshotId, timestamp, errorCode, outputCas }).catch((error) => { throw this.casError(error); });
  }

  async createLegacyTurn(session, input, ctx) {
    const message = this.message(input.message);
    const goal = this.goal(input.goal);
    const plan = this.plan(input.plan);
    const turnNo = await this.repo.nextTurnNo(session.id);
    const turnId = id('atr');
    const operationId = id('aop');
    const receipt = { operation_id: operationId, resource_id: turnId, session_id: session.id, turn_id: turnId, status: 'failed', cursor: 0, error_code: 'assist_runtime_unavailable' };
    const timestamp = now();
    const snapshotId = id('ats');
    const inputHash = hashJson({ message, goal, plan });
    await this.repo.createLegacyTurn({ session, turnId, turnNo, operationId, receipt, message, goal, plan, timestamp, snapshotId, inputHash, snapshotStatement: this.turnSnapshotStatement({ id: snapshotId, turnId, attempt: 1, revision: 1, status: 'failed', inputHash, inputCas: {}, goal, plan, session, timestamp, errorCode: 'assist_runtime_unavailable' }), audit: this.auditStatement('assist_turn.created', 'assist_turn', turnId, { session_id: session.id, turn_no: turnNo, operation_id: operationId }, ctx.actor) });
    return { ...(await this.getTurn(turnId)), operation: receipt };
  }

  async resolveScope(projectId, rawScope, rawId) {
    const scope = String(rawScope);
    const scopeId = String(rawId).trim();
    assert(['project', 'workflow', 'workstream', 'task'].includes(scope), 'invalid_input', 'Assist scope is invalid', { status: 422 });
    let canonical = scopeId;
    if (scope === 'project') assert(scopeId === projectId, 'assist_scope_invalid', 'project scope does not belong to project', { status: 422 });
    else {
      const workflow = await this.repo.workflow(projectId, scope === 'workflow' ? Number(scopeId) : null);
      assert(workflow, 'assist_scope_invalid', 'Assist workflow scope does not belong to project', { status: 422 });
      const tasks = parseJson(workflow.tasks_json, []);
      if (scope === 'workflow') canonical = String(workflow.revision);
      if (scope === 'task') assert(tasks.some((task) => task.id === scopeId), 'assist_scope_invalid', 'Assist task scope does not belong to project', { status: 422 });
      if (scope === 'workstream') {
        const metadata = parseJson(workflow.metadata_json, {});
        const streams = Array.isArray(metadata.workstreams) ? metadata.workstreams : [];
        assert(streams.some((item) => item.id === scopeId) || tasks.some((task) => task.workstream_id === scopeId), 'assist_scope_invalid', 'Assist workstream scope does not belong to project', { status: 422 });
      }
    }
    return { scope, scope_id: canonical, hash: hashJson({ project_id: projectId, scope, scope_id: canonical }) };
  }

  legacyScope(projectId, rawScope, rawId) {
    const scope = String(rawScope);
    const scopeId = String(rawId).trim();
    assert(['project', 'workflow', 'workstream', 'task'].includes(scope) && scopeId.length > 0 && scopeId.length <= 160, 'invalid_input', 'Assist scope is invalid', { status: 422 });
    return { scope, scope_id: scopeId, hash: hashJson({ project_id: projectId, scope, scope_id: scopeId }) };
  }

  async validatePack(projectId, packId) {
    const pack = await this.repo.pack(projectId, packId);
    assert(pack, 'assist_context_pack_required', 'native Assist requires a project Context Pack', { status: 422 });
    assert(pack.schema_version === 'aiws.context_pack.v5', 'assist_context_pack_invalid', 'Context Pack schema is invalid', { status: 422 });
    const storedPack = parseJson(pack.pack_json, {});
    const { pack_hash: _embeddedHash, ...packPayload } = storedPack;
    assert(hashJson(packPayload) === pack.pack_hash && (!_embeddedHash || _embeddedHash === pack.pack_hash), 'assist_context_pack_invalid', 'Context Pack hash is invalid', { status: 409 });
    if (pack.selection_id) {
      const selection = await this.repo.selection(projectId, pack.selection_id);
      assert(selection && selection.selection_hash === pack.selection_hash && Number(selection.policy_revision) === Number(pack.policy_revision), 'assist_context_pack_invalid', 'Context Pack selection binding is invalid', { status: 409 });
    }
    const cas = this.writeCas(stableStringify(packPayload), pack.pack_hash);
    return { ...pack, cas };
  }

  async runtimeBinding(expected = null) {
    const profile = await this.setup?.repository?.activeCodexProfile();
    if (!profile || profile.credential_status !== 'active') throw new AppError('assist_runtime_unavailable', 'Assist requires an active Codex profile', { status: 503, retryable: true });
    const profileHash = hashJson({ id: profile.id, revision: Number(profile.revision), config_hash: profile.config_hash, credential_ref: profile.credential_ref, credential_revision: Number(profile.current_credential_revision), runner_digest: this.config.runnerDigest });
    if (expected && (expected.profile_id !== profile.id || Number(expected.profile_revision) !== Number(profile.revision) || expected.profile_hash !== profileHash || expected.credential_ref !== profile.credential_ref || Number(expected.credential_revision) !== Number(profile.current_credential_revision) || expected.runner_digest !== this.config.runnerDigest)) throw new AppError('assist_inputs_changed', 'Assist runtime binding changed', { status: 409 });
    let secret;
    try { secret = await this.setup.credentialSecret(profile.credential_ref); } catch { throw new AppError('assist_runtime_unavailable', 'Assist credential is unavailable', { status: 503, retryable: true }); }
    return {
      profile: { profile_id: profile.id, profile_revision: Number(profile.revision), profile_hash: profileHash, config_hash: profile.config_hash, label: profile.label, provider: profile.provider, model: profile.model, base_url: profile.base_url, wire_api: profile.wire_api, reasoning: profile.reasoning, timeout_ms: profile.timeout_ms, auth_kind: profile.auth_kind, credential_ref: profile.credential_ref, credential_revision: Number(profile.current_credential_revision), runner_digest: this.config.runnerDigest },
      credential: { ref: profile.credential_ref, kind: profile.auth_kind === 'oauth_bundle' ? 'codex_oauth_bundle' : 'codex_api_key', revision: Number(profile.current_credential_revision), auth: secret }
    };
  }

  async validateCurrentBindings(session, input) {
    const target = await this.resolveScope(session.project_id, session.scope, session.scope_id);
    const snapshot = parseJson(session.snapshot_json, {});
    if (target.hash !== hashJson({ project_id: session.project_id, scope: session.scope, scope_id: session.scope_id })) throw new AppError('assist_scope_changed', 'Assist scope changed', { status: 409 });
    const [brief, workflow, repository] = await this.repo.sessionBindings(session.project_id);
    if (['task', 'workstream'].includes(session.scope) && Number(workflow?.revision || 0) !== Number(snapshot.workflow_revision || 0)) throw new AppError('assist_scope_changed', 'Assist workflow binding changed', { status: 409 });
    if (Number(brief?.revision || 0) !== Number(snapshot.brief_revision || 0) || String(brief?.content_hash || '') !== String(snapshot.brief_hash || '') || String(repository?.head_sha || '') !== String(snapshot.repository_sha || '')) throw new AppError('assist_inputs_changed', 'Assist project inputs changed', { status: 409 });
    if (Number(workflow?.revision || 0) !== Number(snapshot.workflow_revision || 0) || String(workflow?.graph_hash || '') !== String(snapshot.workflow_hash || '')) throw new AppError(session.scope === 'workflow' ? 'assist_scope_changed' : 'assist_inputs_changed', 'Assist workflow input changed', { status: 409 });
    const pack = await this.validatePack(session.project_id, session.context_pack_id);
    if (pack.pack_hash !== session.context_pack_hash || pack.pack_hash !== snapshot.context_pack_hash || pack.selection_hash !== snapshot.selection_hash || Number(pack.policy_revision) !== Number(snapshot.policy_revision) || pack.cas.hash !== snapshot.context_pack_cas_hash || pack.cas.relative !== snapshot.context_pack_cas_path) throw new AppError('assist_inputs_changed', 'Assist Context Pack changed', { status: 409 });
    const calculated = hashJson({ message: input.message, goal: input.goal, plan: input.plan });
    if (input.expectedInputHash && calculated !== input.expectedInputHash) throw new AppError('assist_inputs_changed', 'Assist input changed', { status: 409 });
    return input;
  }

  async inputFor(turn) {
    const snapshot = await this.repo.inputSnapshot(turn.id, turn.attempt);
    if (!snapshot?.input_cas_hash || snapshot.input_cas_hash !== turn.input_hash || snapshot.input_cas_path !== path.posix.join('sha256', turn.input_hash.slice(0, 2), turn.input_hash)) throw new AppError('assist_payload_unavailable', 'Assist input payload is unavailable', { status: 503, retryable: true });
    const file = path.join(this.config.casRoot, turn.input_hash.slice(0, 2), turn.input_hash);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== turn.input_hash) throw new AppError('assist_payload_unavailable', 'Assist input payload is unavailable', { status: 503, retryable: true });
    let payload;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new AppError('assist_payload_unavailable', 'Assist input payload is unavailable', { status: 503, retryable: true }); }
    return { message: String(payload.message || ''), goal: this.goal(payload.goal), plan: this.plan(payload.plan), expectedInputHash: turn.input_hash };
  }

  writeCas(content, expectedHash = sha256(content)) {
    const hash = sha256(content);
    assert(hash === expectedHash, 'assist_inputs_changed', 'Assist CAS hash does not match payload', { status: 409 });
    const file = path.join(this.config.casRoot, hash.slice(0, 2), hash);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const created = !fs.existsSync(file);
    if (created) fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    return { hash, relative: path.posix.join('sha256', hash.slice(0, 2), hash), created };
  }

  cleanupCas(cas) {
    if (!cas?.hash || !cas.created) return;
    try { fs.rmSync(path.join(this.config.casRoot, cas.hash.slice(0, 2), cas.hash)); } catch { /* Shared or already-cleaned CAS entries are harmless. */ }
  }

  sessionSnapshotStatement({ id: snapshotId, sessionId, revision, status, snapshot, target, actor, timestamp }) {
    return this.repo.sessionSnapshotStatement({ snapshotId, sessionId, revision, status, snapshot, target, actor, timestamp });
  }

  turnSnapshotStatement({ id: snapshotId, turnId, attempt, revision, status, inputHash, inputCas, goal, plan, session, timestamp, errorCode = null }) {
    return this.repo.turnSnapshotStatement({ snapshotId, turnId, attempt, revision, status, inputHash, inputCas, goal, plan, session, timestamp, errorCode });
  }

  async turnView(turn) {
    return this.repo.turnView(turn);
  }

  sessionView(row) { return { ...row, snapshot: parseJson(row.snapshot_json, {}) }; }
  expected(value, current) {
    const expected = Number(value);
    assert(Number.isInteger(expected) && expected >= 0, 'expected_revision_required', 'expected_revision is required', { status: 400 });
    if (expected !== Number(current)) throw new AppError('revision_conflict', 'Assist revision changed', { status: 409, details: { current_revision: Number(current) } });
  }
  message(value) { const result = String(value || '').trim(); assert(result.length >= 1 && result.length <= 100000, 'invalid_input', 'Assist message is required', { status: 422 }); return result; }
  goal(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  plan(value) { return Array.isArray(value) ? value.slice(0, 100) : []; }
  summary(value) { return String(value || '').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]').replace(/[\r\n\t]/g, ' ').slice(0, 2000); }
  casError(error) { return String(error?.message).includes('transaction_precondition_failed') ? new AppError('revision_conflict', 'Assist revision changed', { status: 409 }) : error; }
}
