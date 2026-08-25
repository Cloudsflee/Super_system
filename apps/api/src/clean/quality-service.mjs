import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import {
  appendAggregate, assertRevision, createOperation, priorResponse, requestHash,
  requireIdempotency, requirePrincipal, requireRevision, saveResponse, time
} from './p5-domain-helpers.mjs';

const ACTIVE = new Set(['queued', 'preparing', 'checking', 'reviewing']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stale']);

export class CleanQualityService {
  constructor({ db, cas, events, operations, authorization, evidence, clock, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db || !cas || !events || !operations || !authorization || !evidence) throw new TypeError('quality_service_dependencies_required');
    this.db = db;
    this.cas = cas;
    this.events = events;
    this.operations = operations;
    this.authorization = authorization;
    this.evidence = evidence;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.active = new Set();
  }

  list(executionId, input = {}, principal) {
    const execution = this.executionRow(executionId, principal, 'read');
    const rows = this.db.query(`SELECT * FROM quality_review_runs WHERE execution_id=? ${input.status ? 'AND status=?' : ''} ORDER BY created_at DESC,id`, [execution.id, ...(input.status ? [String(input.status)] : [])]);
    return { quality_reviews: rows.map((row) => this.reviewView(row)) };
  }

  get(id, principal) { return { quality_review: this.reviewView(this.reviewRow(id, principal, 'read')) }; }

  eventsFor(id, input = {}, principal) {
    const row = this.reviewRow(id, principal, 'read');
    return this.events.replay({ actorId: principal.actorId, projectId: row.project_id, aggregateType: 'quality_review', aggregateId: row.id, cursor: input.cursor || 0, limit: input.limit || 500 });
  }

  report(id, principal) {
    const row = this.reviewRow(id, principal, 'read');
    if (!row.report_id) throw new PlatformError('quality_report_not_ready', 'quality report is not ready', {}, 404);
    return { report: reportView(this.db.get('SELECT * FROM quality_review_reports WHERE id=?', [row.report_id])) };
  }

  async start(executionId, input = {}, principal) {
    const execution = this.executionRow(executionId, principal, 'run');
    const expected = requireRevision(input.expected_revision); assertRevision(execution, expected);
    return this.createReview({ execution, input, principal, commandId: 'quality.start', idempotencyKey: requireIdempotency(input.idempotency_key), attemptNo: 1, retryOf: null, parentOperationId: null });
  }

  async retry(id, input = {}, principal) {
    const row = this.reviewRow(id, principal, 'run');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    if (!TERMINAL.has(row.status)) throw new PlatformError('state_conflict', 'quality review is not retryable', { status: row.status }, 409);
    if (Number(row.attempt_no) >= 3) throw new PlatformError('quality_retry_exhausted', 'quality retry limit reached', {}, 409);
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [row.execution_id]);
    const retryInput = { ...input, asset_ids: parseJson(row.asset_ids_json, []), rubric: parseJson(row.rubric_json, {}), threshold: Number(row.threshold) };
    return this.createReview({ execution, input: retryInput, principal, commandId: 'quality.retry', idempotencyKey: requireIdempotency(input.idempotency_key), attemptNo: Number(row.attempt_no) + 1, retryOf: row.id, parentOperationId: row.operation_id });
  }

  cancel(id, input = {}, principal) {
    const row = this.reviewRow(id, principal, 'run');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    if (TERMINAL.has(row.status)) throw new PlatformError('state_conflict', 'quality review is terminal', { status: row.status }, 409);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ quality_review_id: row.id, expected_revision: expected, reason: String(input.reason || '') });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.cancel', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]); assertRevision(current, expected);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.cancel', resourceType: 'quality_review', resourceId: row.id, projectId: row.project_id, requestHash: hash, status: 'succeeded', now });
      tx.run("UPDATE quality_review_runs SET status='cancelled',error_code='quality_cancelled',revision=revision+1,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, now, principal.actorId, row.id, expected], 1);
      const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]);
      this.appendReview(tx, next, operation.id, principal.actorId, 'quality_review.cancelled', { quality_review_id: row.id }, now);
      const response = { quality_review: this.reviewView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.cancel', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, status: 200, now });
      return response;
    });
  }

  decision(id, input = {}, principal) {
    const row = this.reviewRow(id, principal, 'approve');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    if (row.status !== 'awaiting_human' || !row.report_id) throw new PlatformError('state_conflict', 'quality review is not awaiting a human decision', { status: row.status }, 409);
    if (!this.inputsFresh(row)) {
      this.markStale(row, principal.actorId);
      throw new PlatformError('quality_stale', 'quality review inputs changed', {}, 409);
    }
    const report = this.db.get('SELECT * FROM quality_review_reports WHERE id=?', [row.report_id]);
    for (const [supplied, actual, name] of [[input.report_sha256, report.report_sha256, 'report'], [input.input_sha256, row.input_sha256, 'input'], [input.rubric_sha256, row.rubric_sha256, 'rubric']]) {
      if (String(supplied || '').toLowerCase() !== actual) throw new PlatformError('quality_hash_conflict', `${name} hash changed`, {}, 409);
    }
    const rubric = parseJson(row.rubric_json, {});
    const dimensions = normalizeDecisionDimensions(input.dimensions, rubric.dimensions);
    const score = weightedScore(dimensions, rubric.dimensions);
    const reasoning = bounded(input.reasoning, 4000, 'quality decision reasoning');
    const decision = String(input.decision || '');
    if (!['approved', 'rejected'].includes(decision)) throw new PlatformError('quality_decision_invalid', 'quality decision is invalid', {}, 422);
    const session = principal.sessionId ? this.db.get('SELECT proof_hash,revoked_at,expires_at,deleted_at FROM sessions WHERE id=?', [String(principal.sessionId)]) : null;
    if (!session || session.revoked_at || session.deleted_at || Date.parse(session.expires_at) <= Date.now()) throw new PlatformError('session_proof_required', 'active session proof is required for a quality decision', {}, 401);
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const decisionPayload = { quality_review_id: row.id, reviewer_actor_id: principal.actorId, decision, dimensions, weighted_score: score, reasoning, report_sha256: report.report_sha256, input_sha256: row.input_sha256, rubric_sha256: row.rubric_sha256 };
    const decisionHash = sha256Hex(canonicalJson(decisionPayload));
    const requestDigest = requestHash({ ...decisionPayload, expected_revision: expected });
    const reviewId = opaqueId('human_review');
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.decision', idempotencyKey: key, requestHash: requestDigest, now });
      if (prior) return prior;
      const current = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]); assertRevision(current, expected);
      if (current.status !== 'awaiting_human') throw new PlatformError('state_conflict', 'quality review status changed', { status: current.status }, 409);
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.decision', resourceType: 'human_review', resourceId: reviewId, projectId: row.project_id, requestHash: requestDigest, status: 'succeeded', now });
      tx.run(`INSERT INTO human_reviews(id,quality_review_id,project_id,execution_id,reviewer_actor_id,decision,dimensions_json,dimension_count,weighted_score,reasoning,report_sha256,input_sha256,rubric_sha256,decision_sha256,session_proof_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [reviewId, row.id, row.project_id, row.execution_id, principal.actorId, decision, canonicalJson(dimensions), dimensions.length, score, reasoning, report.report_sha256, row.input_sha256, row.rubric_sha256, decisionHash, session.proof_hash, now]);
      tx.run("UPDATE quality_review_runs SET status='completed',human_review_id=?,revision=revision+1,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [reviewId, now, now, principal.actorId, row.id, expected], 1);
      const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]);
      this.appendReview(tx, next, operation.id, principal.actorId, 'quality_review.decided', { quality_review_id: row.id, human_review_id: reviewId, decision, weighted_score: score, decision_sha256: decisionHash }, now);
      this.operations.linkInTransaction(tx, operation.id, [['quality_review', row.id], ['human_review', reviewId]], now);
      const response = { quality_review: this.reviewView(next), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.decision', idempotencyKey: key, requestHash: requestDigest, response, operationId: operation.id, status: 200, now });
      return response;
    });
  }

  createReview({ execution, input, principal, commandId, idempotencyKey, attemptNo, retryOf, parentOperationId }) {
    const rubric = normalizeRubric(input.rubric, input.threshold);
    const assetIds = [...new Set((input.asset_ids || []).map(String))];
    if (!assetIds.length || assetIds.length > 16) throw new PlatformError('quality_asset_limit', 'quality review requires between 1 and 16 assets', {}, 422);
    const snapshot = assetIds.map((id) => {
      const asset = this.db.get('SELECT * FROM assets WHERE id=?', [id]);
      if (!asset || asset.project_id !== execution.project_id || asset.status !== 'active' || !asset.current_version_id) throw new PlatformError('quality_asset_invalid', 'quality review asset is unavailable', { asset_id: id }, 422);
      const version = this.db.get('SELECT * FROM asset_versions WHERE id=?', [asset.current_version_id]);
      return { asset_id: asset.id, asset_revision: Number(asset.revision), version_id: version.id, content_sha256: version.content_sha256, metadata_sha256: version.metadata_sha256 };
    });
    const snapshotJson = canonicalJson(snapshot);
    const rubricJson = canonicalJson(rubric);
    const inputHash = sha256Hex(snapshotJson);
    const rubricHash = sha256Hex(rubricJson);
    const now = time(this.clock);
    const reviewId = opaqueId('quality_review');
    const hash = requestHash({ execution_id: execution.id, execution_revision: Number(execution.revision), asset_ids: assetIds, input_sha256: inputHash, rubric_sha256: rubricHash, threshold: rubric.threshold, attempt_no: attemptNo, retry_of: retryOf, fixture: input.fixture || {} });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey, requestHash: hash, now });
      if (prior) return prior;
      if (!retryOf) assertRevision(tx.get('SELECT * FROM executions WHERE id=?', [execution.id]), requireRevision(input.expected_revision));
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'quality_review', resourceId: reviewId, projectId: execution.project_id, requestHash: hash, idempotencyKey: `op-${idempotencyKey}`, status: 'queued', now, parentOperationId });
      tx.run(`INSERT INTO quality_review_runs(id,project_id,execution_id,operation_id,retry_of_quality_review_id,attempt_no,status,asset_ids_json,asset_count,input_snapshot_json,input_sha256,rubric_json,rubric_sha256,threshold,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
        VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,1,?,?,?,?)`, [reviewId, execution.project_id, execution.id, operation.id, retryOf, attemptNo, canonicalJson(assetIds), assetIds.length, snapshotJson, inputHash, rubricJson, rubricHash, rubric.threshold, now, now, principal.actorId, principal.actorId]);
      const row = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [reviewId]);
      this.appendReview(tx, row, operation.id, principal.actorId, retryOf ? 'quality_review.retry_queued' : 'quality_review.queued', { quality_review_id: reviewId, asset_count: assetIds.length, attempt_no: attemptNo }, now);
      this.operations.linkInTransaction(tx, operation.id, [['quality_review', reviewId], ['execution', execution.id], ...assetIds.map((id) => ['asset', id])], now);
      const response = { quality_review: this.reviewView(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey, requestHash: hash, response, operationId: operation.id, status: 202, now });
      tx.afterCommit(() => this.schedule(reviewId, input.fixture || {}));
      return response;
    });
  }

  schedule(id, fixture = {}) {
    if (this.active.has(String(id))) return;
    this.active.add(String(id));
    queueMicrotask(() => this.execute(id, fixture).catch(() => undefined).finally(() => this.active.delete(String(id))));
  }

  async execute(id, fixture = {}) {
    let row = this.db.get('SELECT * FROM quality_review_runs WHERE id=?', [String(id)]);
    if (!row || !ACTIVE.has(row.status)) return row;
    let operation = this.operations.get(row.operation_id);
    if (['accepted', 'queued', 'paused'].includes(operation.status)) operation = await this.operations.start(operation.id, { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id });
    try {
      if (fixture.error_code) throw new PlatformError(String(fixture.error_code), 'quality checker fixture failed', {}, 422);
      for (const status of ['preparing', 'checking', 'reviewing']) {
        row = this.db.get('SELECT * FROM quality_review_runs WHERE id=?', [id]);
        if (!ACTIVE.has(row.status)) return row;
        if (qualityOrdinal(row.status) < qualityOrdinal(status)) row = await this.transition(row, status, `quality_review.${status}`);
      }
      const checked = this.buildReport(row);
      const reportId = opaqueId('quality_report');
      const reportPayload = { schema_version: 'quality.report.v1', quality_review_id: row.id, input_sha256: row.input_sha256, rubric_sha256: row.rubric_sha256, deterministic_checks: checked.checks, suggestions: checked.suggestions, anchors: checked.anchors };
      const reportHash = sha256Hex(canonicalJson(reportPayload));
      const prepared = this.evidence.prepareContent(Buffer.from(canonicalJson({ ...reportPayload, report_sha256: reportHash }), 'utf8'), 'application/json', { kind: 'quality.report', quality_review_id: row.id });
      const now = time(this.clock);
      return this.db.withTransaction((tx) => {
        const current = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]);
        if (!ACTIVE.has(current.status)) return current;
        tx.run(`INSERT INTO quality_review_reports(id,quality_review_id,schema_version,input_sha256,rubric_sha256,deterministic_checks_json,suggestions_json,anchors_json,anchor_count,report_sha256,created_at,created_by_actor_id)
          VALUES(?,?,'quality.report.v1',?,?,?,?,?,?,?,?,?)`, [reportId, current.id, current.input_sha256, current.rubric_sha256, canonicalJson(checked.checks), canonicalJson(checked.suggestions), canonicalJson(checked.anchors), checked.anchors.length, reportHash, now, current.created_by_actor_id]);
        const assetId = opaqueId('asset');
        const inserted = this.evidence.insertPreparedInTransaction(tx, { assetId, projectId: current.project_id, executionId: current.execution_id, logicalName: `quality-report-${current.id}.json`, assetKind: 'quality_report', sourceType: 'quality', sourceRef: current.id, metadata: { quality_review_id: current.id, report_sha256: reportHash }, actorId: current.created_by_actor_id, operationId: current.operation_id, prepared, now });
        this.evidence.appendAsset(tx, inserted.asset, current.operation_id, current.created_by_actor_id, 'asset.captured', { asset_id: inserted.asset.id, version_id: inserted.version.id, quality_review_id: current.id }, now);
        tx.run("UPDATE quality_review_runs SET status='awaiting_human',report_id=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [reportId, now, current.created_by_actor_id, current.id, current.revision], 1);
        const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [current.id]);
        this.appendReview(tx, next, current.operation_id, current.created_by_actor_id, 'quality_review.awaiting_human', { quality_review_id: current.id, report_id: reportId, report_sha256: reportHash, report_asset_id: assetId }, now);
        this.operations.linkInTransaction(tx, current.operation_id, [['quality_review_report', reportId], ['asset', assetId]], now);
        const op = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]);
        if (op && !['succeeded', 'failed', 'cancelled', 'expired'].includes(op.status)) this.operations.transitionInTransaction(tx, op.id, 'succeeded', { expectedRevision: op.revision, actorId: op.actor_id, projectId: op.project_id, result: { quality_review_id: current.id, report_sha256: reportHash } }, now);
        return next;
      });
    } catch (error) {
      return this.fail(row, String(error?.code || 'quality_failed'));
    }
  }

  transition(row, status, eventType) {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]);
      if (!ACTIVE.has(current.status)) return current;
      tx.run('UPDATE quality_review_runs SET status=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?', [status, now, current.created_by_actor_id, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [current.id]);
      this.appendReview(tx, next, current.operation_id, current.created_by_actor_id, eventType, { quality_review_id: current.id }, now);
      return next;
    });
  }

  fail(row, code) {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]);
      if (!current || TERMINAL.has(current.status) || current.status === 'awaiting_human') return current;
      tx.run("UPDATE quality_review_runs SET status='failed',error_code=?,revision=revision+1,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [String(code).slice(0, 120), now, now, current.created_by_actor_id, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [current.id]);
      this.appendReview(tx, next, current.operation_id, current.created_by_actor_id, 'quality_review.failed', { quality_review_id: current.id, error_code: code }, now);
      const operation = tx.get('SELECT * FROM operations WHERE id=?', [current.operation_id]);
      if (operation && !['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.status)) this.operations.transitionInTransaction(tx, operation.id, 'failed', { expectedRevision: operation.revision, actorId: operation.actor_id, projectId: operation.project_id, errorCode: String(code).slice(0, 100) }, now);
      return next;
    });
  }

  buildReport(row) {
    const snapshot = parseJson(row.input_snapshot_json, []);
    const checks = [];
    const suggestions = [];
    const anchors = [];
    for (const item of snapshot) {
      const asset = this.db.get('SELECT * FROM assets WHERE id=?', [item.asset_id]);
      const version = this.db.get('SELECT * FROM asset_versions WHERE id=?', [item.version_id]);
      const blob = version ? this.db.get('SELECT * FROM asset_blobs WHERE id=?', [version.blob_id]) : null;
      let verified = false;
      if (blob) {
        const bytes = this.cas.read(blob.cas_sha256);
        verified = sha256Hex(bytes) === item.content_sha256 && bytes.byteLength === Number(blob.byte_length);
      }
      const result = { asset_id: item.asset_id, version_id: item.version_id, content_sha256: item.content_sha256, active: asset?.status === 'active', current: asset?.current_version_id === item.version_id, cas_verified: verified };
      checks.push(result);
      if (!result.active || !result.current || !result.cas_verified) suggestions.push({ code: 'asset_requires_review', asset_id: item.asset_id, authoritative: false });
      anchors.push({ asset_id: item.asset_id, version_id: item.version_id, kind: 'asset', offset: 0, length: Math.min(Number(blob?.byte_length || 0), 240000), content_sha256: item.content_sha256 });
    }
    return { checks, suggestions, anchors: anchors.slice(0, 500) };
  }

  inputsFresh(row) {
    return parseJson(row.input_snapshot_json, []).every((item) => {
      const asset = this.db.get('SELECT status,current_version_id,revision FROM assets WHERE id=?', [item.asset_id]);
      return asset?.status === 'active' && asset.current_version_id === item.version_id && Number(asset.revision) === Number(item.asset_revision);
    });
  }

  markStale(row, actorId) {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]);
      if (current.status !== 'awaiting_human') return current;
      tx.run("UPDATE quality_review_runs SET status='stale',error_code='quality_input_changed',revision=revision+1,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, now, actorId, current.id, current.revision], 1);
      const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [current.id]);
      this.appendReview(tx, next, null, actorId, 'quality_review.stale', { quality_review_id: current.id }, now);
      return next;
    });
  }

  async recoverPending() {
    const rows = this.db.query("SELECT * FROM quality_review_runs WHERE status IN ('queued','preparing','checking','reviewing') ORDER BY created_at,id");
    for (const row of rows) this.schedule(row.id);
    return rows.length;
  }

  reviewView(row) {
    const report = row.report_id ? this.db.get('SELECT * FROM quality_review_reports WHERE id=?', [row.report_id]) : null;
    const human = row.human_review_id ? this.db.get('SELECT * FROM human_reviews WHERE id=?', [row.human_review_id]) : null;
    return { id: row.id, project_id: row.project_id, execution_id: row.execution_id, operation_id: row.operation_id, retry_of_quality_review_id: row.retry_of_quality_review_id || null, attempt_no: Number(row.attempt_no), status: row.status, asset_ids: parseJson(row.asset_ids_json, []), asset_count: Number(row.asset_count), input_sha256: row.input_sha256, rubric: parseJson(row.rubric_json, {}), rubric_sha256: row.rubric_sha256, threshold: Number(row.threshold), report_id: row.report_id || null, report_sha256: report?.report_sha256 || '', human_review: human ? humanView(human) : null, error_code: row.error_code || '', revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at || null };
  }

  reviewRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM quality_review_runs WHERE id=?', [String(id || '')]);
    if (!row) throw new PlatformError('quality_review_not_found', 'quality review not found', {}, 404);
    requirePrincipal(principal);
    this.authorization.assert(principal, action, row.project_id, { resource: 'quality' });
    return row;
  }

  executionRow(id, principal, action) {
    const row = this.db.get('SELECT * FROM executions WHERE id=?', [String(id || '')]);
    if (!row) throw new PlatformError('execution_not_found', 'execution not found', {}, 404);
    requirePrincipal(principal);
    this.authorization.assert(principal, action, row.project_id, { resource: 'quality' });
    return row;
  }

  appendReview(tx, row, operationId, actorId, type, data, now) {
    const event = appendAggregate(this.events, tx, { aggregateType: 'quality_review', aggregateId: row.id, revision: Number(row.revision), operationId, actorId, projectId: row.project_id, type, data, payload: reviewPayload(row), now });
    tx.run('INSERT INTO quality_review_events(id,quality_review_id,generic_event_id,generic_sequence,event_type,created_at) VALUES(?,?,?,?,?,?)', [opaqueId('quality_event'), row.id, event.id, event.sequence, type, now]);
    return event;
  }
}

function normalizeRubric(value, thresholdValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.dimensions)) throw new PlatformError('quality_rubric_invalid', 'quality rubric dimensions are required', {}, 422);
  if (value.dimensions.length < 1 || value.dimensions.length > 20) throw new PlatformError('quality_rubric_invalid', 'quality rubric must contain 1 to 20 dimensions', {}, 422);
  const seen = new Set();
  const dimensions = value.dimensions.map((item) => {
    const key = bounded(item?.key, 120, 'quality dimension key');
    if (seen.has(key)) throw new PlatformError('quality_rubric_invalid', 'quality dimension keys must be unique', {}, 422);
    seen.add(key);
    const enabled = item.enabled !== false;
    const weight = Number(item.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100 || (enabled && weight <= 0)) throw new PlatformError('quality_rubric_invalid', 'quality dimension weight is invalid', {}, 422);
    return { key, label: String(item.label || key).slice(0, 160), enabled, weight: Number(weight.toFixed(6)), description: String(item.description || '').slice(0, 1000) };
  });
  const total = dimensions.filter((item) => item.enabled).reduce((sum, item) => sum + item.weight, 0);
  if (Math.abs(total - 100) > 0.000001) throw new PlatformError('quality_rubric_invalid', 'enabled quality dimension weights must total 100', { weight_total: total }, 422);
  const threshold = Number(thresholdValue ?? value.threshold ?? 80);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new PlatformError('quality_rubric_invalid', 'quality threshold is invalid', {}, 422);
  return { schema_version: 'quality.rubric.v1', dimensions, threshold: Number(threshold.toFixed(6)) };
}
function normalizeDecisionDimensions(values, rubricDimensions) { if (!Array.isArray(values)) throw new PlatformError('quality_decision_invalid', 'quality dimension scores are required', {}, 422); const enabled = rubricDimensions.filter((item) => item.enabled); const byKey = new Map(values.map((item) => [String(item?.key || ''), item])); if (byKey.size !== values.length || values.length !== enabled.length || enabled.some((item) => !byKey.has(item.key))) throw new PlatformError('quality_decision_invalid', 'quality decision must score every enabled dimension exactly once', {}, 422); return enabled.map((item) => { const value = byKey.get(item.key); const score = Number(value.score); if (!Number.isFinite(score) || score < 0 || score > 100) throw new PlatformError('quality_decision_invalid', 'quality dimension score is invalid', { dimension: item.key }, 422); return { key: item.key, score: Number(score.toFixed(6)), reasoning: bounded(value.reasoning, 2000, 'quality dimension reasoning') }; }); }
function weightedScore(values, rubric) { const scores = new Map(values.map((item) => [item.key, item.score])); return Number((rubric.filter((item) => item.enabled).reduce((total, item) => total + scores.get(item.key) * item.weight / 100, 0)).toFixed(6)); }
function reviewPayload(row) { return { id: row.id, project_id: row.project_id, execution_id: row.execution_id, status: row.status, attempt_no: Number(row.attempt_no), input_sha256: row.input_sha256, rubric_sha256: row.rubric_sha256, report_id: row.report_id || null, human_review_id: row.human_review_id || null, error_code: row.error_code || '', revision: Number(row.revision) }; }
function reportView(row) { return { id: row.id, quality_review_id: row.quality_review_id, schema_version: row.schema_version, input_sha256: row.input_sha256, rubric_sha256: row.rubric_sha256, deterministic_checks: parseJson(row.deterministic_checks_json, []), suggestions: parseJson(row.suggestions_json, []), anchors: parseJson(row.anchors_json, []), anchor_count: Number(row.anchor_count), report_sha256: row.report_sha256, created_at: row.created_at }; }
function humanView(row) { return { id: row.id, quality_review_id: row.quality_review_id, reviewer_actor_id: row.reviewer_actor_id, decision: row.decision, dimensions: parseJson(row.dimensions_json, []), dimension_count: Number(row.dimension_count), weighted_score: Number(row.weighted_score), reasoning: row.reasoning, report_sha256: row.report_sha256, input_sha256: row.input_sha256, rubric_sha256: row.rubric_sha256, decision_sha256: row.decision_sha256, created_at: row.created_at }; }
function qualityOrdinal(value) { return ({ queued: 0, preparing: 1, checking: 2, reviewing: 3 })[value] ?? 99; }
function bounded(value, maximum, label) { const text = String(value || '').trim(); if (!text || text.length > maximum) throw new PlatformError('schema_invalid', `${label} is invalid`, {}, 422); return text; }
function parseJson(value, fallback) { try { return JSON.parse(String(value || '')); } catch { return fallback; } }
