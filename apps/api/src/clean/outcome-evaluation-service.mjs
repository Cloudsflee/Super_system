import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  appendAggregate, assertRevision, createOperation, priorResponse, requestHash,
  requireIdempotency, requirePrincipal, requireRevision, saveResponse, time
} from './p5-domain-helpers.mjs';

const EVALUATORS = new Set(['evidence_count', 'test_pass', 'digest_match', 'human_score']);

export class CleanOutcomeEvaluationService {
  constructor({ db, events, operations, authorization, clock, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db || !events || !operations || !authorization) throw new TypeError('outcome_service_dependencies_required');
    this.db = db;
    this.events = events;
    this.operations = operations;
    this.authorization = authorization;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.active = new Set();
    this.pending = new Map();
    this.unsubscribe = null;
  }

  get(executionId, principal) {
    const execution = this.executionRow(executionId, principal, 'read');
    const evaluation = this.db.get('SELECT * FROM outcome_evaluations WHERE execution_id=? ORDER BY generation DESC LIMIT 1', [execution.id]);
    return { evaluation: evaluation ? evaluationView(evaluation) : null, waivers: this.db.query('SELECT * FROM outcome_waivers WHERE execution_id=? ORDER BY created_at,id', [execution.id]).map(waiverView) };
  }

  evaluate(executionId, input = {}, principal) {
    const execution = this.executionRow(executionId, principal, 'run');
    const expected = requireRevision(input.expected_revision); assertRevision(execution, expected);
    const key = requireIdempotency(input.idempotency_key);
    const hash = requestHash({ execution_id: execution.id, execution_revision: expected, trigger: 'explicit' });
    return this.createEvaluationOperation(execution, principal.actorId, key, hash, 'outcome.evaluate');
  }

  createWaiver(executionId, input = {}, principal) {
    const execution = this.executionRow(executionId, principal, 'approve');
    const expected = requireRevision(input.expected_revision); assertRevision(execution, expected);
    const sessionHash = this.sessionProof(principal);
    const requirementId = input.requirement_id ? String(input.requirement_id) : null;
    if (requirementId) {
      const requirement = this.db.get('SELECT project_id FROM outcome_requirements WHERE id=?', [requirementId]);
      if (!requirement || requirement.project_id !== execution.project_id) throw new PlatformError('outcome_requirement_not_found', 'waiver requirement not found', {}, 404);
    }
    const reason = bounded(input.reason, 2000, 'waiver reason');
    const expiresAt = input.expires_at || null;
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new PlatformError('waiver_expiry_invalid', 'waiver expiry must be in the future', {}, 422);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const inputHash = requestHash({ execution_id: execution.id, requirement_id: requirementId, reason, expires_at: expiresAt, expected_revision: expected, session_proof_hash: sessionHash });
    const waiverId = opaqueId('outcome_waiver');
    const waiverHash = sha256Hex(canonicalJson({ id: waiverId, execution_id: execution.id, requirement_id: requirementId, action: 'grant', reason, input_sha256: inputHash, expires_at: expiresAt, actor_id: principal.actorId, created_at: now }));
    const response = this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'outcome.waiver.create', idempotencyKey: key, requestHash: inputHash, now });
      if (prior) return prior;
      assertRevision(tx.get('SELECT * FROM executions WHERE id=?', [execution.id]), expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'outcome.waiver.create', resourceType: 'outcome_waiver', resourceId: waiverId, projectId: execution.project_id, requestHash: inputHash, status: 'succeeded', now });
      tx.run(`INSERT INTO outcome_waivers(id,project_id,execution_id,requirement_id,action,revokes_waiver_id,reason,input_sha256,waiver_sha256,expires_at,created_at,created_by_actor_id)
        VALUES(?,?,?,?,'grant',NULL,?,?,?,?,?,?)`, [waiverId, execution.project_id, execution.id, requirementId, reason, inputHash, waiverHash, expiresAt, now, principal.actorId]);
      const row = tx.get('SELECT * FROM outcome_waivers WHERE id=?', [waiverId]);
      appendAggregate(this.events, tx, { aggregateType: 'outcome_waiver', aggregateId: waiverId, revision: 1, operationId: operation.id, actorId: principal.actorId, projectId: execution.project_id, type: 'outcome.waiver.created', data: { waiver_id: waiverId, execution_id: execution.id, requirement_id: requirementId, waiver_sha256: waiverHash }, payload: waiverPayload(row), now });
      this.operations.linkInTransaction(tx, operation.id, [['outcome_waiver', waiverId], ['execution', execution.id], ...(requirementId ? [['outcome_requirement', requirementId]] : [])], now);
      const value = { waiver: waiverView(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'outcome.waiver.create', idempotencyKey: key, requestHash: inputHash, response: value, operationId: operation.id, status: 201, now });
      tx.afterCommit(() => this.trigger(execution.id, `waiver:${waiverHash}`));
      return value;
    });
    return response;
  }

  revokeWaiver(id, input = {}, principal) {
    const grant = this.db.get("SELECT * FROM outcome_waivers WHERE id=? AND action='grant'", [String(id || '')]);
    if (!grant) throw new PlatformError('outcome_waiver_not_found', 'outcome waiver not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), 'approve', grant.project_id, { resource: 'outcome' });
    const expected = requireRevision(input.expected_revision);
    if (expected !== 1) throw new PlatformError('revision_conflict', 'immutable waiver revision changed', { expected_revision: expected, actual_revision: 1 }, 409);
    this.sessionProof(principal);
    if (this.db.get("SELECT id FROM outcome_waivers WHERE revokes_waiver_id=? AND action='revoke'", [grant.id])) throw new PlatformError('state_conflict', 'outcome waiver is already revoked', {}, 409);
    const reason = bounded(input.reason, 2000, 'waiver revocation reason');
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const inputHash = requestHash({ waiver_id: grant.id, reason, expected_revision: expected });
    const revokeId = opaqueId('outcome_waiver');
    const waiverHash = sha256Hex(canonicalJson({ id: revokeId, execution_id: grant.execution_id, action: 'revoke', revokes_waiver_id: grant.id, reason, input_sha256: inputHash, actor_id: principal.actorId, created_at: now }));
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'outcome.waiver.revoke', idempotencyKey: key, requestHash: inputHash, now });
      if (prior) return prior;
      if (tx.get("SELECT id FROM outcome_waivers WHERE revokes_waiver_id=? AND action='revoke'", [grant.id])) throw new PlatformError('state_conflict', 'outcome waiver is already revoked', {}, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'outcome.waiver.revoke', resourceType: 'outcome_waiver', resourceId: revokeId, projectId: grant.project_id, requestHash: inputHash, status: 'succeeded', now });
      tx.run(`INSERT INTO outcome_waivers(id,project_id,execution_id,requirement_id,action,revokes_waiver_id,reason,input_sha256,waiver_sha256,expires_at,created_at,created_by_actor_id)
        VALUES(?,?,?,?,'revoke',?,?,?,?,NULL,?,?)`, [revokeId, grant.project_id, grant.execution_id, grant.requirement_id, grant.id, reason, inputHash, waiverHash, now, principal.actorId]);
      const row = tx.get('SELECT * FROM outcome_waivers WHERE id=?', [revokeId]);
      appendAggregate(this.events, tx, { aggregateType: 'outcome_waiver', aggregateId: revokeId, revision: 1, operationId: operation.id, actorId: principal.actorId, projectId: grant.project_id, type: 'outcome.waiver.revoked', data: { waiver_id: revokeId, revokes_waiver_id: grant.id, execution_id: grant.execution_id, waiver_sha256: waiverHash }, payload: waiverPayload(row), now });
      this.operations.linkInTransaction(tx, operation.id, [['outcome_waiver', revokeId], ['outcome_waiver', grant.id, 'related'], ['execution', grant.execution_id]], now);
      const response = { waiver: waiverView(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'outcome.waiver.revoke', idempotencyKey: key, requestHash: inputHash, response, operationId: operation.id, status: 201, now });
      tx.afterCommit(() => this.trigger(grant.execution_id, `revoke:${waiverHash}`));
      return response;
    });
  }

  createEvaluationOperation(execution, actorId, idempotencyKey, hash, commandId) {
    const now = time(this.clock);
    const evaluationId = opaqueId('outcome_evaluation');
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId, commandId, idempotencyKey, requestHash: hash, now });
      if (prior) return prior;
      const operation = createOperation(this.operations, tx, { actorId, commandId, resourceType: 'outcome_evaluation', resourceId: evaluationId, projectId: execution.project_id, requestHash: hash, idempotencyKey: `op-${idempotencyKey}`, status: 'queued', now });
      this.operations.linkInTransaction(tx, operation.id, [['outcome_evaluation', evaluationId], ['execution', execution.id]], now);
      const response = { evaluation: { id: evaluationId, execution_id: execution.id, status: 'queued', revision: 1 }, waivers: this.db.query('SELECT * FROM outcome_waivers WHERE execution_id=? ORDER BY created_at,id', [execution.id]).map(waiverView), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId, commandId, idempotencyKey, requestHash: hash, response, operationId: operation.id, status: 202, now });
      tx.afterCommit(() => this.schedule(execution.id, evaluationId, operation.id));
      return response;
    });
  }

  schedule(executionId, evaluationId, operationId) {
    if (this.active.has(String(executionId))) {
      const key = String(executionId);
      const queue = this.pending.get(key) || [];
      if (!queue.some((item) => item.operationId === operationId)) queue.push({ evaluationId, operationId });
      this.pending.set(key, queue);
      return;
    }
    this.active.add(String(executionId));
    queueMicrotask(() => this.execute(executionId, evaluationId, operationId).catch(() => undefined).finally(() => {
      const key = String(executionId);
      this.active.delete(key);
      const queue = this.pending.get(key) || [];
      const next = queue.shift();
      if (queue.length) this.pending.set(key, queue); else this.pending.delete(key);
      if (next) this.schedule(executionId, next.evaluationId, next.operationId);
    }));
  }

  async execute(executionId, evaluationId, operationId) {
    let operation = this.operations.get(operationId);
    if (['accepted', 'queued', 'paused'].includes(operation.status)) operation = await this.operations.start(operation.id, { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id });
    try {
      const snapshot = this.snapshot(executionId);
      return this.db.withTransaction((tx) => {
        if (tx.get('SELECT id FROM outcome_evaluations WHERE operation_id=?', [operationId])) return tx.get('SELECT * FROM outcome_evaluations WHERE operation_id=?', [operationId]);
        const now = time(this.clock);
        const generation = Number(tx.get('SELECT COALESCE(MAX(generation),0) AS generation FROM outcome_evaluations WHERE execution_id=?', [executionId]).generation) + 1;
        const evaluated = evaluateRequirements(snapshot.requirements, snapshot);
        const payload = { schema_version: 'outcome.evaluation.v1', execution_id: executionId, generation, status: evaluated.status, score: evaluated.score, requirement_count: evaluated.results.length, passed_count: evaluated.passedCount, results: evaluated.results, input_hashes: snapshot.hashes };
        const evaluationJson = canonicalJson(payload);
        const evaluationHash = sha256Hex(evaluationJson);
        tx.run(`INSERT INTO outcome_evaluations(id,project_id,execution_id,generation,operation_id,status,requirement_count,passed_count,score,requirements_sha256,evidence_sha256,rubric_sha256,execution_input_sha256,human_decision_sha256,waiver_sha256,evaluation_json,evaluation_sha256,created_at,created_by_actor_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [evaluationId, snapshot.execution.project_id, executionId, generation, operationId, evaluated.status, evaluated.results.length, evaluated.passedCount, evaluated.score, snapshot.hashes.requirements_sha256, snapshot.hashes.evidence_sha256, snapshot.hashes.rubric_sha256, snapshot.hashes.execution_input_sha256, snapshot.hashes.human_decision_sha256, snapshot.hashes.waiver_sha256, evaluationJson, evaluationHash, now, operation.actor_id]);
        const summaryJson = canonicalJson({ status: evaluated.status, score: evaluated.score, generation });
        tx.run(`INSERT INTO digests(id,project_id,execution_id,asset_id,asset_version_id,digest_type,input_sha256,digest_sha256,summary_json,summary_sha256,created_at,created_by_actor_id)
          VALUES(?,?,?,NULL,NULL,'outcome',?,?,?,?,?,?)`, [opaqueId('digest'), snapshot.execution.project_id, executionId, snapshot.combinedHash, evaluationHash, summaryJson, sha256Hex(summaryJson), now, operation.actor_id]);
        appendAggregate(this.events, tx, { aggregateType: 'outcome_evaluation', aggregateId: evaluationId, revision: 1, operationId, actorId: operation.actor_id, projectId: snapshot.execution.project_id, type: 'outcome.evaluated', data: { evaluation_id: evaluationId, execution_id: executionId, generation, status: evaluated.status, score: evaluated.score, evaluation_sha256: evaluationHash }, payload: payload, now });
        const currentOperation = tx.get('SELECT * FROM operations WHERE id=?', [operationId]);
        if (currentOperation && !['succeeded', 'failed', 'cancelled', 'expired'].includes(currentOperation.status)) this.operations.transitionInTransaction(tx, operationId, 'succeeded', { expectedRevision: currentOperation.revision, actorId: currentOperation.actor_id, projectId: currentOperation.project_id, result: { evaluation_id: evaluationId, generation, status: evaluated.status, evaluation_sha256: evaluationHash } }, now);
        return tx.get('SELECT * FROM outcome_evaluations WHERE id=?', [evaluationId]);
      });
    } catch (error) {
      const current = this.operations.get(operationId);
      if (!['succeeded', 'failed', 'cancelled', 'expired'].includes(current.status)) await this.operations.fail(operationId, { expectedRevision: current.revision, actorId: current.actor_id, projectId: current.project_id, errorCode: String(error?.code || 'outcome_evaluation_failed').slice(0, 100) });
      throw error;
    }
  }

  snapshot(executionId) {
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [String(executionId)]);
    if (!execution) throw new PlatformError('execution_not_found', 'execution not found', {}, 404);
    const requirements = this.db.query('SELECT * FROM outcome_requirements WHERE project_id=? ORDER BY requirement_key,id', [execution.project_id]).slice(0, 100).map((row) => ({ id: row.id, requirement_key: row.requirement_key, rubric: parseJson(row.rubric_json, {}), rubric_sha256: row.rubric_sha256 }));
    const assets = this.db.query("SELECT id,asset_kind,current_version_id,status,revision FROM assets WHERE execution_id=? ORDER BY id", [execution.id]);
    const versions = assets.map((asset) => this.db.get('SELECT id,content_sha256,metadata_sha256 FROM asset_versions WHERE id=?', [asset.current_version_id])).filter(Boolean);
    const tests = this.db.query('SELECT check_id,status,input_sha256,output_sha256 FROM test_results WHERE execution_id=? ORDER BY check_id,id', [execution.id]);
    const digests = this.db.query("SELECT digest_type,input_sha256,digest_sha256 FROM digests WHERE execution_id=? AND digest_type<>'outcome' ORDER BY digest_type,id", [execution.id]);
    const inputs = this.db.query('SELECT ordinal,input_type,ref_id,ref_revision,ref_hash,metadata_sha256 FROM execution_inputs WHERE execution_id=? ORDER BY ordinal,id', [execution.id]);
    const quality = Number(this.db.metadata?.user_version || 0) >= 9
      ? this.db.get("SELECT * FROM quality_review_runs WHERE execution_id=? AND status='completed' AND stale_at IS NULL AND superseded_by_quality_review_id IS NULL ORDER BY completed_at DESC,id DESC LIMIT 1", [execution.id])
      : this.db.get("SELECT * FROM quality_review_runs WHERE execution_id=? AND status='completed' ORDER BY completed_at DESC,id DESC LIMIT 1", [execution.id]);
    const human = quality?.human_review_id ? this.db.get('SELECT * FROM human_reviews WHERE id=?', [quality.human_review_id]) : null;
    const waiverRows = this.db.query('SELECT * FROM outcome_waivers WHERE execution_id=? ORDER BY created_at,id', [execution.id]);
    const activeWaivers = activeWaiversFor(waiverRows, time(this.clock));
    const requirementSnapshot = requirements.map(({ rubric, ...row }) => ({ ...row, evaluator: String(rubric.evaluator || rubric.type || ''), rubric }));
    const evidenceSnapshot = { assets, versions, tests, digests };
    const hashes = {
      requirements_sha256: sha256Hex(canonicalJson(requirementSnapshot)),
      evidence_sha256: sha256Hex(canonicalJson(evidenceSnapshot)),
      rubric_sha256: quality?.rubric_sha256 || sha256Hex(canonicalJson({})),
      execution_input_sha256: sha256Hex(canonicalJson({ plan_sha256: execution.plan_sha256, generation: Number(execution.generation), inputs })),
      human_decision_sha256: human?.decision_sha256 || '',
      waiver_sha256: sha256Hex(canonicalJson(activeWaivers.map((row) => ({ id: row.id, requirement_id: row.requirement_id || null, waiver_sha256: row.waiver_sha256, expires_at: row.expires_at || null }))))
    };
    return { execution, requirements: requirementSnapshot, assets, tests, digests, quality, human, activeWaivers, hashes, combinedHash: sha256Hex(canonicalJson(hashes)) };
  }

  trigger(executionId, reason) {
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [String(executionId || '')]);
    if (!execution) return;
    const snapshot = this.snapshot(execution.id);
    const latest = this.db.get('SELECT * FROM outcome_evaluations WHERE execution_id=? ORDER BY generation DESC LIMIT 1', [execution.id]);
    if (latest && latest.requirements_sha256 === snapshot.hashes.requirements_sha256 && latest.evidence_sha256 === snapshot.hashes.evidence_sha256 && latest.rubric_sha256 === snapshot.hashes.rubric_sha256 && latest.execution_input_sha256 === snapshot.hashes.execution_input_sha256 && latest.human_decision_sha256 === snapshot.hashes.human_decision_sha256 && latest.waiver_sha256 === snapshot.hashes.waiver_sha256) return;
    const actorId = this.bootstrapActorId;
    const baseGeneration = Number(latest?.generation || 0);
    const key = `outcome-auto-${baseGeneration}-${snapshot.combinedHash.slice(0, 32)}`;
    const hash = requestHash({ execution_id: execution.id, trigger: 'state_change', base_generation: baseGeneration, snapshot_sha256: snapshot.combinedHash });
    this.createEvaluationOperation(execution, actorId, key, hash, 'outcome.evaluate');
  }

  async recoverPending() {
    const rows = this.db.query("SELECT * FROM operations WHERE command_id='outcome.evaluate' AND status IN ('accepted','queued','running','paused') ORDER BY created_at,id");
    for (const row of rows) {
      const executionId = this.db.get("SELECT aggregate_id FROM operation_links WHERE operation_id=? AND aggregate_type='execution' ORDER BY created_at,id LIMIT 1", [row.id])?.aggregate_id;
      if (executionId) this.schedule(executionId, row.resource_id, row.id);
    }
    for (const execution of this.db.query("SELECT id FROM executions WHERE status='completed' ORDER BY id")) this.trigger(execution.id, 'recovery');
    if (!this.unsubscribe) this.unsubscribe = this.events.subscribe({}, (event) => this.eventTrigger(event));
    return rows.length;
  }

  eventTrigger(event) {
    if (!/^(?:asset\.|quality_review\.decided|outcome\.waiver\.|outcome\.requirement\.|execution\.(?:completed|replanned))/.test(event.type)) return;
    if (event.type.startsWith('outcome.requirement.')) {
      for (const row of this.db.query('SELECT id FROM executions WHERE project_id=? ORDER BY id', [String(event.project_id || '')])) {
        queueMicrotask(() => { try { this.trigger(row.id, event.type); } catch { /* a later event or recovery retries */ } });
      }
      return;
    }
    let executionId = event.data.execution_id || null;
    if (!executionId && event.data.asset_id) executionId = this.db.get('SELECT execution_id FROM assets WHERE id=?', [event.data.asset_id])?.execution_id || null;
    if (!executionId && event.aggregate.type === 'quality_review') executionId = this.db.get('SELECT execution_id FROM quality_review_runs WHERE id=?', [event.aggregate.id])?.execution_id || null;
    if (executionId) queueMicrotask(() => { try { this.trigger(executionId, event.type); } catch { /* a later event or recovery retries */ } });
  }

  sessionProof(principal) {
    const session = principal?.sessionId ? this.db.get('SELECT proof_hash,revoked_at,expires_at,deleted_at FROM sessions WHERE id=?', [String(principal.sessionId)]) : null;
    if (!session || session.revoked_at || session.deleted_at || Date.parse(session.expires_at) <= Date.now()) throw new PlatformError('session_proof_required', 'active session proof is required for an outcome waiver', {}, 401);
    return session.proof_hash;
  }

  executionRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM executions WHERE id=?', [String(id || '')]);
    if (!row) throw new PlatformError('execution_not_found', 'execution not found', {}, 404);
    requirePrincipal(principal);
    this.authorization.assert(principal, action, row.project_id, { resource: 'outcome' });
    return row;
  }

  close() { this.unsubscribe?.(); this.unsubscribe = null; }
}

function evaluateRequirements(requirements, snapshot) {
  const results = requirements.map((requirement) => {
    const rubric = requirement.rubric || {};
    const evaluator = String(requirement.evaluator || '');
    if (!EVALUATORS.has(evaluator)) return result(requirement, evaluator, false, true, null, { supported: [...EVALUATORS] });
    if (evaluator === 'evidence_count') {
      const assets = snapshot.assets.filter((asset) => asset.status === 'active' && (!rubric.asset_kind || asset.asset_kind === rubric.asset_kind));
      const minimum = integer(rubric.minimum ?? rubric.count ?? 1, 0, 100000, 'evidence minimum');
      return result(requirement, evaluator, assets.length >= minimum, false, assets.length, { minimum, asset_kind: rubric.asset_kind || null });
    }
    if (evaluator === 'test_pass') {
      const rows = rubric.check_id ? snapshot.tests.filter((item) => item.check_id === String(rubric.check_id)) : snapshot.tests;
      const passed = rows.length > 0 && rows.every((item) => item.status === 'passed');
      return result(requirement, evaluator, passed, rows.length === 0, { total: rows.length, passed: rows.filter((item) => item.status === 'passed').length }, { check_id: rubric.check_id || null });
    }
    if (evaluator === 'digest_match') {
      const expected = String(rubric.expected_sha256 || rubric.digest_sha256 || '').toLowerCase();
      const valid = /^[a-f0-9]{64}$/.test(expected);
      const matched = valid && snapshot.digests.some((item) => item.digest_sha256 === expected && (!rubric.digest_type || item.digest_type === rubric.digest_type));
      return result(requirement, evaluator, matched, !valid, matched ? expected : null, { expected_sha256: valid ? expected : null, digest_type: rubric.digest_type || null });
    }
    const minimum = Number(rubric.minimum ?? rubric.score ?? 80);
    const score = snapshot.human ? Number(snapshot.human.weighted_score) : null;
    return result(requirement, evaluator, score != null && score >= minimum, score == null, score, { minimum });
  });
  const active = new Map(snapshot.activeWaivers.map((waiver) => [waiver.requirement_id || '*', waiver]));
  const decorated = results.map((item) => ({ ...item, waived: !item.passed && Boolean(active.get(item.requirement_id) || active.get('*')) }));
  const passedCount = decorated.filter((item) => item.passed).length;
  const failures = decorated.filter((item) => !item.passed);
  const status = failures.length === 0 ? 'passed' : failures.every((item) => item.waived) ? 'waived' : failures.some((item) => item.blocked && !item.waived) ? 'blocked' : 'completed_with_gaps';
  return { results: decorated, passedCount, score: decorated.length ? Number((passedCount * 100 / decorated.length).toFixed(6)) : 100, status };
}
function result(requirement, evaluator, passed, blocked, actual, expected) { return { requirement_id: requirement.id, requirement_key: requirement.requirement_key, evaluator, passed: Boolean(passed), blocked: Boolean(blocked), actual, expected }; }
function activeWaiversFor(rows, now) { const revoked = new Set(rows.filter((row) => row.action === 'revoke').map((row) => row.revokes_waiver_id)); const current = Date.parse(now); return rows.filter((row) => row.action === 'grant' && !revoked.has(row.id) && (!row.expires_at || Date.parse(row.expires_at) > current)); }
function evaluationView(row) { return { id: row.id, project_id: row.project_id, execution_id: row.execution_id, generation: Number(row.generation), operation_id: row.operation_id, status: row.status, requirement_count: Number(row.requirement_count), passed_count: Number(row.passed_count), score: Number(row.score), requirements_sha256: row.requirements_sha256, evidence_sha256: row.evidence_sha256, rubric_sha256: row.rubric_sha256, execution_input_sha256: row.execution_input_sha256, human_decision_sha256: row.human_decision_sha256 || '', waiver_sha256: row.waiver_sha256 || '', evaluation: parseJson(row.evaluation_json, {}), evaluation_sha256: row.evaluation_sha256, created_at: row.created_at }; }
function waiverView(row) { return { id: row.id, project_id: row.project_id, execution_id: row.execution_id, requirement_id: row.requirement_id || null, action: row.action, revokes_waiver_id: row.revokes_waiver_id || null, reason: row.reason, input_sha256: row.input_sha256, waiver_sha256: row.waiver_sha256, expires_at: row.expires_at || null, revision: 1, created_at: row.created_at, created_by_actor_id: row.created_by_actor_id }; }
function waiverPayload(row) { return { id: row.id, project_id: row.project_id, execution_id: row.execution_id, requirement_id: row.requirement_id || null, action: row.action, revokes_waiver_id: row.revokes_waiver_id || null, waiver_sha256: row.waiver_sha256, expires_at: row.expires_at || null, revision: 1 }; }
function bounded(value, maximum, label) { const text = String(value || '').trim(); if (!text || text.length > maximum) throw new PlatformError('schema_invalid', `${label} is invalid`, {}, 422); return text; }
function integer(value, minimum, maximum, label) { const number = Number(value); if (!Number.isInteger(number) || number < minimum || number > maximum) throw new PlatformError('outcome_requirement_invalid', `${label} is invalid`, {}, 422); return number; }
function parseJson(value, fallback) { try { return JSON.parse(String(value || '')); } catch { return fallback; } }
