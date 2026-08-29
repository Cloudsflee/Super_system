import { canonicalJson, opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';
import { ProcessAppServerAdapter } from './app-server-adapter.mjs';
import {
  appendAggregate, assertRevision, createOperation, priorResponse, requestHash,
  requireIdempotency, requirePrincipal, requireRevision, saveResponse, time
} from './p5-domain-helpers.mjs';

const ACTIVE = new Set(['queued', 'preparing', 'checking', 'reviewing']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stale']);

export const DEFAULT_QUALITY_RUBRIC = Object.freeze({
  schema_version: 'quality.rubric.v1',
  dimensions: Object.freeze([
    Object.freeze({ key: 'coverage', label: 'Coverage', enabled: true, weight: 20, description: 'Required scope and assets are covered.' }),
    Object.freeze({ key: 'accuracy', label: 'Accuracy', enabled: true, weight: 20, description: 'Claims and outputs are correct.' }),
    Object.freeze({ key: 'depth', label: 'Depth', enabled: true, weight: 20, description: 'The work has sufficient technical depth.' }),
    Object.freeze({ key: 'consistency', label: 'Consistency', enabled: true, weight: 20, description: 'Artifacts agree across the workflow.' }),
    Object.freeze({ key: 'clarity', label: 'Clarity', enabled: true, weight: 20, description: 'The result is understandable and reviewable.' })
  ]),
  threshold: 80
});

export class CleanQualityService {
  constructor({ db, cas, events, operations, authorization, evidence, vault = null, adviceAdapter = null, clock, bootstrapActorId = 'actor_system_bootstrap' } = {}) {
    if (!db || !cas || !events || !operations || !authorization || !evidence) throw new TypeError('quality_service_dependencies_required');
    this.db = db;
    this.cas = cas;
    this.events = events;
    this.operations = operations;
    this.authorization = authorization;
    this.evidence = evidence;
    this.vault = vault;
    this.adviceAdapter = adviceAdapter;
    this.clock = clock;
    this.bootstrapActorId = bootstrapActorId;
    this.active = new Set();
  }

  list(executionId, input = {}, principal) {
    const execution = this.executionRow(executionId, principal, 'read');
    const rows = this.db.query(`SELECT * FROM quality_review_runs WHERE execution_id=? ${input.status ? 'AND status=?' : ''} ORDER BY created_at DESC,id`, [execution.id, ...(input.status ? [String(input.status)] : [])]);
    return { quality_reviews: rows.map((row) => this.reviewView(row)) };
  }

  policy(workflowId, principal) {
    const workflow = this.db.get('SELECT * FROM workflows WHERE id=?', [String(workflowId || '')]);
    if (!workflow) throw new PlatformError('workflow_not_found', 'workflow not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), 'read', workflow.project_id, { resource: 'quality_policy' });
    const row = this.db.get('SELECT * FROM workflow_quality_policies WHERE workflow_id=? ORDER BY revision DESC LIMIT 1', [workflow.id]);
    return { policy: row ? policyView(row) : defaultPolicyView(workflow) };
  }

  updatePolicy(workflowId, input = {}, principal) {
    const workflow = this.db.get('SELECT * FROM workflows WHERE id=?', [String(workflowId || '')]);
    if (!workflow) throw new PlatformError('workflow_not_found', 'workflow not found', {}, 404);
    this.authorization.assert(requirePrincipal(principal), 'approve', workflow.project_id, { resource: 'quality_policy' });
    const latest = this.db.get('SELECT * FROM workflow_quality_policies WHERE workflow_id=? ORDER BY revision DESC LIMIT 1', [workflow.id]);
    const expected = requireRevision(input.expected_revision, { allowZero: true });
    const actual = Number(latest?.revision || 0);
    if (expected !== actual) throw new PlatformError('revision_conflict', 'Quality policy revision changed', { expected_revision: expected, actual_revision: actual }, 409);
    const rubric = normalizeRubric(input.rubric || DEFAULT_QUALITY_RUBRIC, input.threshold);
    let reviewer = null;
    if (input.reviewer_profile_id) {
      reviewer = this.db.get("SELECT * FROM provider_profiles WHERE id=? AND provider='codex' AND owner_actor_id=?", [String(input.reviewer_profile_id), principal.actorId]);
      if (!reviewer || reviewer.status !== 'available' || reviewer.lifecycle_status === 'disabled') throw new PlatformError('quality_reviewer_unavailable', 'enabled Codex reviewer profile is required', {}, 409);
    }
    const nextRevision = actual + 1;
    const snapshot = { workflow_id: workflow.id, workflow_revision: Number(workflow.revision), rubric, threshold: rubric.threshold, reviewer_profile_id: reviewer?.id || null, reviewer_profile_revision: reviewer ? Number(reviewer.revision) : null };
    const policyHash = sha256Hex(canonicalJson(snapshot));
    const key = requireIdempotency(input.idempotency_key);
    const now = time(this.clock);
    const hash = requestHash({ ...snapshot, expected_revision: expected });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.policy.update', idempotencyKey: key, requestHash: hash, now });
      if (prior) return prior;
      const current = tx.get('SELECT revision FROM workflow_quality_policies WHERE workflow_id=? ORDER BY revision DESC LIMIT 1', [workflow.id]);
      if (Number(current?.revision || 0) !== expected) throw new PlatformError('revision_conflict', 'Quality policy revision changed', { expected_revision: expected, actual_revision: Number(current?.revision || 0) }, 409);
      const id = opaqueId('quality_policy');
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.policy.update', resourceType: 'workflow_quality_policy', resourceId: id, projectId: workflow.project_id, requestHash: hash, status: 'succeeded', now });
      const rubricJson = canonicalJson(rubric);
      tx.run(`INSERT INTO workflow_quality_policies(id,project_id,workflow_id,revision,rubric_json,rubric_sha256,threshold,reviewer_profile_id,reviewer_profile_revision,policy_sha256,created_at,created_by_actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [id, workflow.project_id, workflow.id, nextRevision, rubricJson, sha256Hex(rubricJson), rubric.threshold, reviewer?.id || null, reviewer ? Number(reviewer.revision) : null, policyHash, now, principal.actorId]);
      const row = tx.get('SELECT * FROM workflow_quality_policies WHERE id=?', [id]);
      appendAggregate(this.events, tx, { aggregateType: 'quality_policy', aggregateId: workflow.id, revision: nextRevision, operationId: operation.id, actorId: principal.actorId, projectId: workflow.project_id, type: 'quality_policy.updated', data: { workflow_id: workflow.id, policy_id: id, policy_sha256: policyHash }, payload: policyView(row), now });
      this.operations.linkInTransaction(tx, operation.id, [['workflow', workflow.id], ['workflow_quality_policy', id], ...(reviewer ? [['profile', reviewer.id]] : [])], now);
      const response = { policy: policyView(row), operation: this.operations.summary(operation) };
      saveResponse(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.policy.update', idempotencyKey: key, requestHash: hash, response, operationId: operation.id, now });
      return response;
    });
  }

  async prepare(executionId, input = {}, principal) {
    const execution = this.executionRow(executionId, principal, 'read');
    await this.refreshStale(execution.id, principal.actorId);
    const policy = this.policyForExecution(execution);
    const assets = this.db.query("SELECT a.*,v.id AS version_id,v.content_sha256 FROM assets a JOIN asset_versions v ON v.id=a.current_version_id WHERE a.project_id=? AND a.status='active' ORDER BY a.logical_name,a.id", [execution.project_id]);
    const selections = assets.map((asset) => ({ asset_id: asset.id, asset_version_id: asset.version_id, disposition: 'included', exclusion_reason: '', content_sha256: asset.content_sha256, asset_revision: Number(asset.revision) }));
    const active = this.db.get("SELECT id,status,revision FROM quality_review_runs WHERE execution_id=? AND status IN ('queued','preparing','checking','reviewing','awaiting_human') ORDER BY created_at DESC LIMIT 1", [execution.id]);
    const reviewer = policy.reviewer_profile_id ? this.db.get('SELECT id,status,lifecycle_status,revision FROM provider_profiles WHERE id=?', [policy.reviewer_profile_id]) : null;
    const readiness = {
      ready: selections.length > 0 && !active,
      checks: {
        assets: selections.length > 0 ? 'ready' : 'missing',
        active_review: active ? 'blocked' : 'ready',
        reviewer: reviewer ? (reviewer.status === 'available' && reviewer.lifecycle_status !== 'disabled' ? 'ready' : 'unavailable') : 'optional'
      }
    };
    return { execution_id: execution.id, execution_revision: Number(execution.revision), policy, selections, active_review: active || null, readiness };
  }

  advice(id, principal) {
    const row = this.reviewRow(id, principal, 'read');
    const advice = this.db.get('SELECT * FROM quality_review_advices WHERE quality_review_id=?', [row.id]);
    return { advice: advice ? adviceView(advice) : null };
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
    if (Number(this.db.metadata?.user_version || 0) >= 9) {
      await this.refreshStale(execution.id, principal.actorId);
      const active = this.db.get("SELECT id,status FROM quality_review_runs WHERE execution_id=? AND status IN ('queued','preparing','checking','reviewing','awaiting_human') LIMIT 1", [execution.id]);
      if (active) throw new PlatformError('quality_review_active', 'execution already has an active Quality review', { quality_review_id: active.id, status: active.status }, 409);
      const policy = this.policyForExecution(execution);
      input = {
        ...input,
        rubric: input.rubric || policy.rubric,
        threshold: input.threshold ?? policy.threshold,
        policy,
        asset_ids: input.asset_ids || (input.asset_selections || []).filter((item) => item?.disposition !== 'excluded' && item?.included !== false).map((item) => item.asset_id)
      };
    }
    return this.createReview({ execution, input, principal, commandId: 'quality.start', idempotencyKey: requireIdempotency(input.idempotency_key), attemptNo: 1, retryOf: null, parentOperationId: null });
  }

  async retry(id, input = {}, principal) {
    const row = this.reviewRow(id, principal, 'run');
    const expected = requireRevision(input.expected_revision); assertRevision(row, expected);
    if (!TERMINAL.has(row.status)) throw new PlatformError('state_conflict', 'quality review is not retryable', { status: row.status }, 409);
    if (Number(row.attempt_no) >= 3) throw new PlatformError('quality_retry_exhausted', 'quality retry limit reached', {}, 409);
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [row.execution_id]);
    const retryInput = { ...input, asset_ids: parseJson(row.asset_ids_json, []), rubric: parseJson(row.rubric_json, {}), threshold: Number(row.threshold), policy: Number(this.db.metadata?.user_version || 0) >= 9 ? parseJson(row.policy_snapshot_json, {}) : null };
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
      const supersedes = Number(this.db.metadata?.user_version || 0) >= 9
        ? tx.get("SELECT id FROM quality_review_runs WHERE execution_id=? AND status='completed' AND id<>? AND id NOT IN (SELECT supersedes_quality_review_id FROM quality_review_runs WHERE supersedes_quality_review_id IS NOT NULL) ORDER BY completed_at DESC,id DESC LIMIT 1", [row.execution_id, row.id])
        : null;
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId: 'quality.decision', resourceType: 'human_review', resourceId: reviewId, projectId: row.project_id, requestHash: requestDigest, status: 'succeeded', now });
      tx.run(`INSERT INTO human_reviews(id,quality_review_id,project_id,execution_id,reviewer_actor_id,decision,dimensions_json,dimension_count,weighted_score,reasoning,report_sha256,input_sha256,rubric_sha256,decision_sha256,session_proof_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [reviewId, row.id, row.project_id, row.execution_id, principal.actorId, decision, canonicalJson(dimensions), dimensions.length, score, reasoning, report.report_sha256, row.input_sha256, row.rubric_sha256, decisionHash, session.proof_hash, now]);
      if (Number(this.db.metadata?.user_version || 0) >= 9) {
        tx.run("UPDATE quality_review_runs SET status='completed',human_review_id=?,supersedes_quality_review_id=?,revision=revision+1,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [reviewId, supersedes?.id || null, now, now, principal.actorId, row.id, expected], 1);
      } else {
        tx.run("UPDATE quality_review_runs SET status='completed',human_review_id=?,revision=revision+1,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [reviewId, now, now, principal.actorId, row.id, expected], 1);
      }
      if (supersedes?.id) {
        tx.run("UPDATE quality_review_runs SET superseded_by_quality_review_id=?,revision=revision+1,updated_at=? WHERE id=? AND status='completed' AND superseded_by_quality_review_id IS NULL", [row.id, now, supersedes.id], 1);
        const superseded = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [supersedes.id]);
        this.appendReview(tx, superseded, operation.id, principal.actorId, 'quality_review.superseded', { quality_review_id: superseded.id, superseded_by_quality_review_id: row.id }, now);
      }
      const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]);
      this.appendReview(tx, next, operation.id, principal.actorId, 'quality_review.decided', { quality_review_id: row.id, human_review_id: reviewId, decision, weighted_score: score, decision_sha256: decisionHash, supersedes_quality_review_id: supersedes?.id || null }, now);
      this.operations.linkInTransaction(tx, operation.id, [['quality_review', row.id], ['human_review', reviewId], ...(supersedes?.id ? [['quality_review', supersedes.id]] : [])], now);
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
    const p10 = Number(this.db.metadata?.user_version || 0) >= 9;
    const policy = p10 ? (input.policy && typeof input.policy === 'object' ? input.policy : this.policyForExecution(execution)) : null;
    const reviewer = p10 && policy?.reviewer_profile_id ? this.db.get('SELECT * FROM provider_profiles WHERE id=?', [policy.reviewer_profile_id]) : null;
    const policySnapshot = p10 ? { ...policy, execution_revision: Number(execution.revision) } : null;
    const reviewerSnapshot = reviewer ? { profile_id: reviewer.id, profile_revision: Number(reviewer.revision), config_sha256: reviewer.config_sha256, credential_ref_id: reviewer.credential_ref_id || null } : {};
    const selectionInput = p10 && Array.isArray(input.asset_selections) && input.asset_selections.length
      ? input.asset_selections
      : assetIds.map((asset_id) => ({ asset_id, disposition: 'included', exclusion_reason: '' }));
    const selections = p10 ? selectionInput.map((selection) => {
      const asset = this.db.get('SELECT * FROM assets WHERE id=?', [String(selection?.asset_id || '')]);
      if (!asset || asset.project_id !== execution.project_id || asset.status !== 'active' || !asset.current_version_id) throw new PlatformError('quality_asset_invalid', 'Quality selection asset is unavailable', { asset_id: selection?.asset_id }, 422);
      const version = this.db.get('SELECT * FROM asset_versions WHERE id=?', [asset.current_version_id]);
      const disposition = selection.disposition === 'excluded' || selection.included === false ? 'excluded' : 'included';
      const exclusionReason = disposition === 'excluded' ? bounded(selection.exclusion_reason, 500, 'quality exclusion reason') : '';
      return { asset_id: asset.id, asset_version_id: version.id, disposition, exclusion_reason: exclusionReason, asset_revision: Number(asset.revision), content_sha256: version.content_sha256 };
    }) : [];
    if (p10) {
      const selectedIds = selections.filter((item) => item.disposition === 'included').map((item) => item.asset_id).sort();
      if (JSON.stringify([...assetIds].sort()) !== JSON.stringify(selectedIds)) throw new PlatformError('quality_selection_mismatch', 'included Quality selections must match asset_ids', {}, 422);
    }
    const snapshotJson = canonicalJson(snapshot);
    const rubricJson = canonicalJson(rubric);
    const policyJson = p10 ? canonicalJson(policySnapshot) : '{}';
    const reviewerJson = p10 ? canonicalJson(reviewerSnapshot) : '{}';
    const inputHash = p10 ? sha256Hex(canonicalJson({ execution_revision: Number(execution.revision), assets: snapshot, policy_sha256: sha256Hex(policyJson) })) : sha256Hex(snapshotJson);
    const rubricHash = sha256Hex(rubricJson);
    const now = time(this.clock);
    const reviewId = opaqueId('quality_review');
    const hash = requestHash({ execution_id: execution.id, execution_revision: Number(execution.revision), asset_ids: assetIds, input_sha256: inputHash, rubric_sha256: rubricHash, threshold: rubric.threshold, attempt_no: attemptNo, retry_of: retryOf, fixture: input.fixture || {} });
    return this.db.withTransaction((tx) => {
      const prior = priorResponse(this.operations, tx, { actorId: principal.actorId, commandId, idempotencyKey, requestHash: hash, now });
      if (prior) return prior;
      if (!retryOf) assertRevision(tx.get('SELECT * FROM executions WHERE id=?', [execution.id]), requireRevision(input.expected_revision));
      const operation = createOperation(this.operations, tx, { actorId: principal.actorId, commandId, resourceType: 'quality_review', resourceId: reviewId, projectId: execution.project_id, requestHash: hash, idempotencyKey: `op-${idempotencyKey}`, status: 'queued', now, parentOperationId });
      if (p10) {
        tx.run(`INSERT INTO quality_review_runs(id,project_id,execution_id,operation_id,retry_of_quality_review_id,attempt_no,status,asset_ids_json,asset_count,input_snapshot_json,input_sha256,rubric_json,rubric_sha256,threshold,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id,policy_revision,policy_snapshot_json,policy_sha256,reviewer_profile_id,reviewer_profile_revision,reviewer_snapshot_json,reviewer_snapshot_sha256)
          VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)`, [reviewId, execution.project_id, execution.id, operation.id, retryOf, attemptNo, canonicalJson(assetIds), assetIds.length, snapshotJson, inputHash, rubricJson, rubricHash, rubric.threshold, now, now, principal.actorId, principal.actorId, Number(policy?.revision || 0) || null, policyJson, sha256Hex(policyJson), reviewer?.id || null, reviewer ? Number(reviewer.revision) : null, reviewerJson, sha256Hex(reviewerJson)]);
        for (const selection of selections) {
          const selectionPayload = { quality_review_id: reviewId, ...selection };
          tx.run(`INSERT INTO quality_review_asset_selections(id,quality_review_id,asset_id,asset_version_id,disposition,exclusion_reason,asset_revision,content_sha256,selection_sha256,created_at,created_by_actor_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [opaqueId('quality_selection'), reviewId, selection.asset_id, selection.asset_version_id, selection.disposition, selection.exclusion_reason, selection.asset_revision, selection.content_sha256, sha256Hex(canonicalJson(selectionPayload)), now, principal.actorId]);
        }
      } else {
        tx.run(`INSERT INTO quality_review_runs(id,project_id,execution_id,operation_id,retry_of_quality_review_id,attempt_no,status,asset_ids_json,asset_count,input_snapshot_json,input_sha256,rubric_json,rubric_sha256,threshold,revision,created_at,updated_at,created_by_actor_id,updated_by_actor_id)
          VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,1,?,?,?,?)`, [reviewId, execution.project_id, execution.id, operation.id, retryOf, attemptNo, canonicalJson(assetIds), assetIds.length, snapshotJson, inputHash, rubricJson, rubricHash, rubric.threshold, now, now, principal.actorId, principal.actorId]);
      }
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
      const advisory = Number(this.db.metadata?.user_version || 0) >= 9 ? await this.generateAdvice(row, checked) : null;
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
        if (advisory) {
          const adviceJson = canonicalJson(advisory.advice);
          tx.run(`INSERT INTO quality_review_advices(id,quality_review_id,profile_id,profile_revision,schema_version,status,advice_json,advice_sha256,input_sha256,lease_sha256,error_code,created_at,created_by_actor_id)
            VALUES(?,?,?,?, 'quality.advice.v1',?,?,?,?,?,?,?,?)`, [opaqueId('quality_advice'), current.id, current.reviewer_profile_id || null, current.reviewer_profile_revision || null, advisory.status, adviceJson, sha256Hex(canonicalJson({ quality_review_id: current.id, advice: advisory.advice })), current.input_sha256, advisory.lease_sha256 || '', advisory.error_code || '', now, current.created_by_actor_id]);
        }
        const assetId = opaqueId('asset');
        const inserted = this.evidence.insertPreparedInTransaction(tx, { assetId, projectId: current.project_id, executionId: current.execution_id, logicalName: `quality-report-${current.id}.json`, assetKind: 'quality_report', sourceType: 'quality', sourceRef: current.id, metadata: { quality_review_id: current.id, report_sha256: reportHash }, actorId: current.created_by_actor_id, operationId: current.operation_id, prepared, now });
        this.evidence.appendAsset(tx, inserted.asset, current.operation_id, current.created_by_actor_id, 'asset.captured', { asset_id: inserted.asset.id, version_id: inserted.version.id, quality_review_id: current.id }, now);
        tx.run("UPDATE quality_review_runs SET status='awaiting_human',report_id=?,revision=revision+1,updated_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [reportId, now, current.created_by_actor_id, current.id, current.revision], 1);
        const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [current.id]);
        this.appendReview(tx, next, current.operation_id, current.created_by_actor_id, 'quality_review.awaiting_human', { quality_review_id: current.id, report_id: reportId, report_sha256: reportHash, report_asset_id: assetId, advice_status: advisory?.status || 'unavailable' }, now);
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
    const assetsFresh = parseJson(row.input_snapshot_json, []).every((item) => {
      const asset = this.db.get('SELECT status,current_version_id,revision FROM assets WHERE id=?', [item.asset_id]);
      return asset?.status === 'active' && asset.current_version_id === item.version_id && Number(asset.revision) === Number(item.asset_revision);
    });
    if (!assetsFresh || Number(this.db.metadata?.user_version || 0) < 9) return assetsFresh;
    const execution = this.db.get('SELECT * FROM executions WHERE id=?', [row.execution_id]);
    if (!execution) return false;
    const policy = this.policyForExecution(execution);
    const expectedSnapshot = canonicalJson({ ...policy, execution_revision: Number(execution.revision) });
    return sha256Hex(expectedSnapshot) === row.policy_sha256;
  }

  markStale(row, actorId, reason = 'quality_input_changed') {
    const now = time(this.clock);
    return this.db.withTransaction((tx) => {
      const current = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [row.id]);
      if (!['awaiting_human','completed'].includes(current.status)) return current;
      if (Number(this.db.metadata?.user_version || 0) >= 9) {
        tx.run("UPDATE quality_review_runs SET status='stale',error_code='quality_input_changed',stale_at=?,stale_reason=?,revision=revision+1,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, String(reason).slice(0, 240), now, now, actorId, current.id, current.revision], 1);
      } else {
        tx.run("UPDATE quality_review_runs SET status='stale',error_code='quality_input_changed',revision=revision+1,updated_at=?,completed_at=?,updated_by_actor_id=? WHERE id=? AND revision=?", [now, now, actorId, current.id, current.revision], 1);
      }
      const next = tx.get('SELECT * FROM quality_review_runs WHERE id=?', [current.id]);
      this.appendReview(tx, next, null, actorId, 'quality_review.stale', { quality_review_id: current.id, stale_reason: reason }, now);
      return next;
    });
  }

  async refreshStale(executionId, actorId) {
    if (Number(this.db.metadata?.user_version || 0) < 9) return 0;
    const rows = this.db.query("SELECT * FROM quality_review_runs WHERE execution_id=? AND status IN ('awaiting_human','completed') AND id NOT IN (SELECT supersedes_quality_review_id FROM quality_review_runs WHERE supersedes_quality_review_id IS NOT NULL) ORDER BY created_at,id", [String(executionId)]);
    let changed = 0;
    for (const row of rows) {
      if (!this.inputsFresh(row)) { await this.markStale(row, actorId); changed += 1; }
    }
    return changed;
  }

  policyForExecution(execution) {
    const row = this.db.get('SELECT * FROM workflow_quality_policies WHERE workflow_id=? ORDER BY revision DESC LIMIT 1', [execution.workflow_id]);
    if (row) return policyView(row);
    const workflow = this.db.get('SELECT id,project_id,revision FROM workflows WHERE id=?', [execution.workflow_id]);
    return defaultPolicyView(workflow || { id: execution.workflow_id, project_id: execution.project_id, revision: 0 });
  }

  async generateAdvice(row, checked) {
    const unavailable = (errorCode = 'quality_advice_unavailable') => ({ status: 'unavailable', advice: emptyAdvice(), error_code: errorCode, lease_sha256: '' });
    if (!row.reviewer_profile_id || !this.adviceAdapter || !this.vault) return unavailable();
    const profile = this.db.get("SELECT * FROM provider_profiles WHERE id=? AND provider='codex'", [row.reviewer_profile_id]);
    if (!profile || profile.status !== 'available' || profile.lifecycle_status === 'disabled' || Number(profile.revision) !== Number(row.reviewer_profile_revision)) return unavailable('quality_reviewer_snapshot_changed');
    const credential = this.db.get("SELECT * FROM credential_refs WHERE id=? AND status='active'", [profile.credential_ref_id]);
    if (!credential || !String(credential.external_ref).startsWith('vault:')) return unavailable('quality_reviewer_credential_unavailable');
    let lease = null;
    const leaseHash = sha256Hex(canonicalJson({ credential_ref_id: credential.id, credential_revision: Number(credential.revision), profile_id: profile.id, profile_revision: Number(profile.revision) }));
    try {
      lease = Buffer.from(this.vault.read(credential.external_ref));
      const value = await this.adviceAdapter.advise({
        input: { quality_review_id: row.id, input_sha256: row.input_sha256, rubric: parseJson(row.rubric_json, {}), checks: checked.checks, anchors: checked.anchors },
        profile: { id: profile.id, revision: Number(profile.revision), config: parseJson(profile.config_json, {}) },
        credential: lease
      });
      const advice = normalizeAdvice(value);
      return { status: 'valid', advice, error_code: '', lease_sha256: leaseHash };
    } catch (error) {
      const code = String(error?.code || 'quality_advice_unavailable');
      return { status: code === 'quality_advice_invalid' ? 'invalid' : 'unavailable', advice: emptyAdvice(), error_code: code.slice(0, 120), lease_sha256: leaseHash };
    } finally { lease?.fill(0); }
  }

  async recoverPending() {
    const rows = this.db.query("SELECT * FROM quality_review_runs WHERE status IN ('queued','preparing','checking','reviewing') ORDER BY created_at,id");
    for (const row of rows) this.schedule(row.id);
    return rows.length;
  }

  reviewView(row) {
    const report = row.report_id ? this.db.get('SELECT * FROM quality_review_reports WHERE id=?', [row.report_id]) : null;
    const human = row.human_review_id ? this.db.get('SELECT * FROM human_reviews WHERE id=?', [row.human_review_id]) : null;
    const p10 = Number(this.db.metadata?.user_version || 0) >= 9;
    const selections = p10 ? this.db.query('SELECT * FROM quality_review_asset_selections WHERE quality_review_id=? ORDER BY disposition,asset_id', [row.id]).map(selectionView) : [];
    const advice = p10 ? this.db.get('SELECT * FROM quality_review_advices WHERE quality_review_id=?', [row.id]) : null;
    return { id: row.id, project_id: row.project_id, execution_id: row.execution_id, operation_id: row.operation_id, retry_of_quality_review_id: row.retry_of_quality_review_id || null, attempt_no: Number(row.attempt_no), status: row.status, asset_ids: parseJson(row.asset_ids_json, []), asset_count: Number(row.asset_count), selections, input_sha256: row.input_sha256, rubric: parseJson(row.rubric_json, {}), rubric_sha256: row.rubric_sha256, threshold: Number(row.threshold), policy_revision: row.policy_revision == null ? null : Number(row.policy_revision), policy_sha256: row.policy_sha256 || '', reviewer_profile_id: row.reviewer_profile_id || null, reviewer_profile_revision: row.reviewer_profile_revision == null ? null : Number(row.reviewer_profile_revision), supersedes_quality_review_id: row.supersedes_quality_review_id || null, superseded_by_quality_review_id: row.superseded_by_quality_review_id || null, stale_at: row.stale_at || null, stale_reason: row.stale_reason || '', advice: advice ? adviceView(advice) : null, report_id: row.report_id || null, report_sha256: report?.report_sha256 || '', human_review: human ? humanView(human) : null, error_code: row.error_code || '', revision: Number(row.revision), created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at || null };
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
function reviewPayload(row) { return { id: row.id, project_id: row.project_id, execution_id: row.execution_id, status: row.status, attempt_no: Number(row.attempt_no), input_sha256: row.input_sha256, rubric_sha256: row.rubric_sha256, policy_sha256: row.policy_sha256 || '', report_id: row.report_id || null, human_review_id: row.human_review_id || null, supersedes_quality_review_id: row.supersedes_quality_review_id || null, superseded_by_quality_review_id: row.superseded_by_quality_review_id || null, stale_at: row.stale_at || null, error_code: row.error_code || '', revision: Number(row.revision) }; }
function reportView(row) { return { id: row.id, quality_review_id: row.quality_review_id, schema_version: row.schema_version, input_sha256: row.input_sha256, rubric_sha256: row.rubric_sha256, deterministic_checks: parseJson(row.deterministic_checks_json, []), suggestions: parseJson(row.suggestions_json, []), anchors: parseJson(row.anchors_json, []), anchor_count: Number(row.anchor_count), report_sha256: row.report_sha256, created_at: row.created_at }; }
function humanView(row) { return { id: row.id, quality_review_id: row.quality_review_id, reviewer_actor_id: row.reviewer_actor_id, decision: row.decision, dimensions: parseJson(row.dimensions_json, []), dimension_count: Number(row.dimension_count), weighted_score: Number(row.weighted_score), reasoning: row.reasoning, report_sha256: row.report_sha256, input_sha256: row.input_sha256, rubric_sha256: row.rubric_sha256, decision_sha256: row.decision_sha256, created_at: row.created_at }; }
function qualityOrdinal(value) { return ({ queued: 0, preparing: 1, checking: 2, reviewing: 3 })[value] ?? 99; }
function bounded(value, maximum, label) { const text = String(value || '').trim(); if (!text || text.length > maximum) throw new PlatformError('schema_invalid', `${label} is invalid`, {}, 422); return text; }
function parseJson(value, fallback) { try { return JSON.parse(String(value || '')); } catch { return fallback; } }

function policyView(row) { return { id: row.id, project_id: row.project_id, workflow_id: row.workflow_id, revision: Number(row.revision), rubric: parseJson(row.rubric_json, DEFAULT_QUALITY_RUBRIC), rubric_sha256: row.rubric_sha256, threshold: Number(row.threshold), reviewer_profile_id: row.reviewer_profile_id || null, reviewer_profile_revision: row.reviewer_profile_revision == null ? null : Number(row.reviewer_profile_revision), policy_sha256: row.policy_sha256, created_at: row.created_at }; }
function defaultPolicyView(workflow) { const rubric = structuredClone(DEFAULT_QUALITY_RUBRIC); const snapshot = { workflow_id: workflow.id, workflow_revision: Number(workflow.revision || 0), rubric, threshold: rubric.threshold, reviewer_profile_id: null, reviewer_profile_revision: null }; return { id: null, project_id: workflow.project_id, workflow_id: workflow.id, revision: 0, rubric, rubric_sha256: sha256Hex(canonicalJson(rubric)), threshold: rubric.threshold, reviewer_profile_id: null, reviewer_profile_revision: null, policy_sha256: sha256Hex(canonicalJson(snapshot)), created_at: null }; }
function selectionView(row) { return { id: row.id, quality_review_id: row.quality_review_id, asset_id: row.asset_id, asset_version_id: row.asset_version_id, disposition: row.disposition, exclusion_reason: row.exclusion_reason, asset_revision: Number(row.asset_revision), content_sha256: row.content_sha256, selection_sha256: row.selection_sha256, created_at: row.created_at }; }
function adviceView(row) { return { id: row.id, quality_review_id: row.quality_review_id, profile_id: row.profile_id || null, profile_revision: row.profile_revision == null ? null : Number(row.profile_revision), schema_version: row.schema_version, status: row.status, advice: parseJson(row.advice_json, emptyAdvice()), advice_sha256: row.advice_sha256, input_sha256: row.input_sha256, error_code: row.error_code || '', created_at: row.created_at }; }
function emptyAdvice() { return { schema_version: 'quality.advice.v1', summary: '', dimensions: [], cautions: [] }; }
function normalizeAdvice(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source || source.schema_version !== 'quality.advice.v1' || typeof source.summary !== 'string' || source.summary.length > 4000 || !Array.isArray(source.dimensions) || source.dimensions.length > 20 || !Array.isArray(source.cautions) || source.cautions.length > 50) throw Object.assign(new Error('quality advice schema is invalid'), { code: 'quality_advice_invalid' });
  const dimensions = source.dimensions.map((item) => {
    const keys = Object.keys(item || {}).sort();
    if (keys.some((key) => !['key','rationale','suggested_score'].includes(key)) || typeof item.key !== 'string' || !item.key || item.key.length > 120 || typeof item.rationale !== 'string' || item.rationale.length > 2000) throw Object.assign(new Error('quality advice dimension is invalid'), { code: 'quality_advice_invalid' });
    const score = item.suggested_score == null ? null : Number(item.suggested_score);
    if (score != null && (!Number.isFinite(score) || score < 0 || score > 100)) throw Object.assign(new Error('quality advice score is invalid'), { code: 'quality_advice_invalid' });
    return { key: item.key, rationale: item.rationale, ...(score == null ? {} : { suggested_score: Number(score.toFixed(6)) }) };
  });
  const cautions = source.cautions.map((item) => { const text = String(item); if (!text || text.length > 1000) throw Object.assign(new Error('quality advice caution is invalid'), { code: 'quality_advice_invalid' }); return text; });
  return { schema_version: 'quality.advice.v1', summary: source.summary, dimensions, cautions };
}

export class DeterministicQualityAdviceAdapter {
  constructor({ status = 'valid', advice = null, errorCode = 'quality_advice_unavailable' } = {}) { this.status = status; this.value = advice; this.errorCode = errorCode; this.calls = []; }
  async advise(input) {
    this.calls.push({ profile_id: input.profile?.id || null, input_sha256: input.input?.input_sha256 || '' });
    if (this.status === 'unavailable') throw Object.assign(new Error(this.errorCode), { code: this.errorCode });
    if (this.status === 'invalid') return { invalid: true };
    return this.value || { schema_version: 'quality.advice.v1', summary: 'Review the deterministic checks and score each dimension independently.', dimensions: [], cautions: [] };
  }
}

export class ProcessQualityAdviceAdapter {
  constructor(options = {}) { this.process = options.processAdapter || new ProcessAppServerAdapter(options); }
  async advise({ input, profile, credential } = {}) {
    let threadId = null;
    try {
      const thread = await this.process.startThread({ credential, provider_config: profile?.config || {} });
      threadId = thread.thread_id;
      const turn = await this.process.startTurn({ thread_id: threadId, message: `${canonicalJson({ task: 'quality_advice', output_schema: { schema_version: 'quality.advice.v1', summary: 'string', dimensions: [{ key: 'string', rationale: 'string', suggested_score: 'number optional' }], cautions: ['string'] }, input })}\nReturn only the JSON object.` });
      const assistant = (turn.events || []).filter((event) => event.method === 'item/completed' && event.params?.role === 'assistant').at(-1)?.params?.content;
      if (!assistant) throw Object.assign(new Error('quality advice response is empty'), { code: 'quality_advice_invalid' });
      let value;
      try { value = JSON.parse(String(assistant)); } catch { throw Object.assign(new Error('quality advice response is invalid JSON'), { code: 'quality_advice_invalid' }); }
      return normalizeAdvice(value);
    } finally { await this.process.close(); }
  }
}
