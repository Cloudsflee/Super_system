import { normalizeQualityReviewRubric, qualityReviewRubricHash } from './quality-review-rubric.mjs';
import { parseQualityReviewReport, protocolHash } from '../../../packages/execution-protocol/src/index.mjs';
import { canonicalJsonHash, stateRecordIdentity as stateRecordIdentityV22 } from './state-migration-v22.mjs';
import { qualityReviewRunIsCurrent } from './quality-review-freshness.mjs';
import { id } from '../../../packages/shared/index.mjs';

const STATE_SCHEMA_VERSION = 23;
const V23_RUNNER_IMAGE = 'aiws-codex-runner:2.3.0-codex-0.144.0';
const QUALITY_REVIEW_COLLECTIONS = Object.freeze([
  'quality_review_runs',
  'quality_review_reports',
  'quality_review_events'
]);
const QUALITY_REVIEW_APPEND_ONLY_COLLECTIONS = Object.freeze(['quality_review_reports', 'quality_review_events']);
const REVIEW_STATUSES = new Set([
  'queued',
  'preparing',
  'checking',
  'reviewing',
  'awaiting_human',
  'completed',
  'failed',
  'cancelled'
]);
const REVIEW_DECISIONS = new Set(['pass', 'changes_required']);

export function assertQualityReviewAppendOnly(before, after) {
  for (const collection of QUALITY_REVIEW_APPEND_ONLY_COLLECTIONS)
    assertCollectionAppendOnly(before[collection] || [], after[collection] || [], collection);
}

function assertCollectionAppendOnly(before, after, collection) {
  const nextByIdentity = new Map(after.map((item) => [stateRecordIdentity(collection, item), item]));
  for (const item of before) {
    const identity = stateRecordIdentity(collection, item),
      next = nextByIdentity.get(identity);
    if (!next || canonicalJsonHash(next) !== canonicalJsonHash(item))
      throw stateError('quality_review_immutable_record_changed', { collection, identity });
  }
}

export function assertQualityReviewHumanReviewAppendOnly(before, after) {
  const nextById = new Map(
    (after.human_reviews || [])
      .filter((item) => item.target_type === 'quality_review_run')
      .map((item) => [item.id, item])
  );
  for (const item of (before.human_reviews || []).filter((entry) => entry.target_type === 'quality_review_run')) {
    const next = nextById.get(item.id);
    if (!next || canonicalJsonHash(next) !== canonicalJsonHash(item))
      throw stateError('quality_review_human_review_immutable_record_changed', { review_id: item.id });
  }
}

export function assertQualityReviewRunSnapshotImmutability(before, after) {
  const nextById = new Map((after.quality_review_runs || []).map((item) => [item.id, item])),
    immutableFields = [
      'workflow_execution_id',
      'project_id',
      'operation_key',
      'input_snapshot_hash',
      'input_asset_version_ids',
      'asset_version_ids',
      'excluded_assets',
      'out_of_scope_assets',
      'rubric',
      'rubric_hash',
      'workflow_policy_rubric_hash',
      'threshold',
      'reviewer_profile_snapshot',
      'created_by_user_id',
      'created_at'
    ];
  for (const previous of before.quality_review_runs || []) {
    const next = nextById.get(previous.id);
    if (!next) throw stateError('quality_review_run_deleted', { run_id: previous.id });
    for (const field of immutableFields)
      if (canonicalJsonHash(next[field] ?? null) !== canonicalJsonHash(previous[field] ?? null))
        throw stateError('quality_review_run_snapshot_changed', { run_id: previous.id, field });
  }
}

export function qualityReviewRunInputIsCurrent(state, run) {
  const execution = (state.workflow_executions || []).find((item) => item.id === run.workflow_execution_id);
  return qualityReviewRunIsCurrent(state, execution, run);
}

export function markQualityReviewRunsStale(state, timestamp = new Date().toISOString()) {
  let changed = false;
  for (const run of state.quality_review_runs || []) {
    if (run.stale === true || !run.input_snapshot_hash || qualityReviewRunInputIsCurrent(state, run)) continue;
    run.stale = true;
    if (['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human'].includes(run.status)) {
      Object.assign(run, {
        status: 'failed',
        phase: 'failed',
        error_code: 'quality_review_input_stale',
        failure: { code: 'quality_review_input_stale', details: {} },
        retryable: true,
        completed_at: timestamp
      });
      appendStaleFailureEvent(state, run, timestamp);
    }
    run.revision = Math.max(1, Number(run.revision) || 1) + 1;
    run.updated_at = timestamp;
    changed = true;
  }
  return { changed };
}

function appendStaleFailureEvent(state, run, timestamp) {
  const events = state.quality_review_events || (state.quality_review_events = []),
    sequence =
      Math.max(0, ...events.filter((item) => item.run_id === run.id).map((item) => Number(item.sequence) || 0)) + 1;
  events.push({
    id: id('qre'),
    run_id: run.id,
    project_id: run.project_id,
    sequence,
    type: 'failed',
    data: { phase: 'failed', error_code: 'quality_review_input_stale', retryable: true },
    created_at: timestamp
  });
}

export function normalizeQualityReviewDefaults(
  state,
  timestamp = new Date().toISOString(),
  { migrating = false } = {}
) {
  normalizeWorkflowQualityDefaults(state, timestamp);
  normalizeExecutionQualityDefaults(state);
  for (const run of state.quality_review_runs || []) normalizeQualityReviewRun(run, timestamp);
  if (migrating) state.quality_review_migrated_at ||= timestamp;
  return state;
}

function normalizeWorkflowQualityDefaults(state, timestamp) {
  for (const workflow of state.workflows || []) {
    if (workflow.quality_review_policy === undefined) {
      workflow.quality_review_policy = {
        enabled: false,
        mandatory: false,
        strategy: 'legacy_opt_in',
        rubric: null,
        rubric_hash: null
      };
      workflow.updated_at ||= timestamp;
    } else if (workflow.quality_review_policy?.enabled && workflow.quality_review_policy.rubric) {
      workflow.quality_review_policy = {
        ...workflow.quality_review_policy,
        rubric_hash:
          workflow.quality_review_policy.rubric_hash || qualityReviewRubricHash(workflow.quality_review_policy.rubric)
      };
    }
  }
}

function normalizeExecutionQualityDefaults(state) {
  for (const execution of state.workflow_executions || []) {
    execution.quality_review_rubric_hash ??= null;
    execution.quality_review_input_snapshot_hash ??= null;
    execution.quality_review_policy_snapshot ??= null;
  }
}

function normalizeQualityReviewRun(run, timestamp) {
  run.status ||= 'failed';
  run.phase ||= normalizePhase(run.status);
  run.revision = Number.isInteger(run.revision) && run.revision > 0 ? run.revision : 1;
  normalizeRunCollections(run);
  normalizeRunLifecycle(run, timestamp);
}

function normalizeRunCollections(run) {
  run.asset_version_ids = Array.isArray(run.asset_version_ids) ? [...new Set(run.asset_version_ids)] : [];
  run.workflow_policy_rubric_hash ??= run.rubric_hash || null;
  run.excluded_assets = Array.isArray(run.excluded_assets) ? run.excluded_assets : [];
  run.out_of_scope_assets = Array.isArray(run.out_of_scope_assets) ? run.out_of_scope_assets : [];
  run.failure ||= null;
  run.report_id ||= null;
  run.report_sha256 ||= null;
  run.decision_id ||= null;
  run.retryable = run.retryable === true;
  run.stale = run.stale === true;
  run.superseded_by_run_id ??= null;
  run.cancel_requested_at ??= null;
}

function normalizeRunLifecycle(run, timestamp) {
  if (run.status !== 'queued') run.started_at ||= run.created_at || timestamp;
  run.completed_at ??= null;
  run.updated_at ||= run.created_at || timestamp;
}

function normalizePhase(status) {
  return REVIEW_STATUSES.has(status) ? status : 'failed';
}

export function ensureQualityReviewProfiles(state, timestamp = new Date().toISOString()) {
  const source = findReviewerSource(state);
  if (!source) return { changed: false, profile_id: null };
  const profileId = `quality_reviewer_${source.id}`;
  let reviewer = state.codex_profiles.find((item) => item.id === profileId),
    created = false;
  if (!reviewer) {
    reviewer = buildReviewerProfile(source, profileId, timestamp);
    state.codex_profiles.push(reviewer);
    created = true;
  }
  const changed = assignReviewerProfiles(state, reviewer.id, timestamp);
  return { changed: Boolean(created || changed), profile_id: reviewer.id };
}

function findReviewerSource(state) {
  return (
    state.codex_profiles?.find(
      (item) => item.quality_reviewer !== true && item.is_active && item.status === 'validated'
    ) || state.codex_profiles?.find((item) => item.quality_reviewer !== true && item.status === 'validated')
  );
}

function buildReviewerProfile(source, profileId, timestamp) {
  return {
    id: profileId,
    name: 'Quality Reviewer（隔离）',
    kind: 'docker',
    description: '只读、临时评审包专用；不挂载项目仓库，不启用 MCP 或 Web Search。',
    provider: source.provider || null,
    model: source.model || null,
    reasoning: source.reasoning || 'high',
    wire_api: source.wire_api || 'responses',
    timeout_ms: source.timeout_ms || null,
    base_url: source.base_url || null,
    requires_openai_auth: source.requires_openai_auth === true,
    refs: source.refs ? JSON.parse(JSON.stringify(source.refs)) : {},
    config: { image: V23_RUNNER_IMAGE, reviewer: true },
    image: V23_RUNNER_IMAGE,
    mcp_servers: [],
    mounts: [],
    web_search: false,
    status: source.status,
    is_active: false,
    quality_reviewer: true,
    created_by_user_id: source.created_by_user_id || null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function assignReviewerProfiles(state, profileId, timestamp) {
  let changed = false;
  for (const workflow of state.workflows || [])
    if (workflow.quality_review_policy?.enabled && !workflow.quality_review_profile_id) {
      workflow.quality_review_profile_id = profileId;
      workflow.updated_at = timestamp;
      changed = true;
    }
  return changed;
}

export function validateQualityReviewReferences(state) {
  const executions = new Map((state.workflow_executions || []).map((item) => [item.id, item])),
    runs = new Map(state.quality_review_runs.map((item) => [item.id, item])),
    reports = new Map(state.quality_review_reports.map((item) => [item.id, item]));
  for (const run of state.quality_review_runs) validateRunReferences(state, run, executions);
  for (const report of state.quality_review_reports) validateReportReferences(state, report, runs);
  for (const event of state.quality_review_events) validateEventReference(state, event);
  for (const review of state.human_reviews || []) validateHumanReviewReference(state, review, runs, reports);
}

function validateRunReferences(state, run, executions) {
  if (!executions.has(run.workflow_execution_id))
    throw stateError('quality_review_execution_missing', { run_id: run.id });
  validateOptionalHash(run.input_snapshot_hash, 'quality_review_input_hash_invalid', run.id);
  validateOptionalHash(run.rubric_hash, 'quality_review_rubric_hash_invalid', run.id);
  if (run.report_id && !state.quality_review_reports.some((item) => item.id === run.report_id))
    throw stateError('quality_review_report_missing', { run_id: run.id, report_id: run.report_id });
  if (run.decision_id) validateRunDecisionReference(state, run);
}

function validateOptionalHash(value, code, runId) {
  if (value != null && !/^[a-f0-9]{64}$/.test(String(value))) throw stateError(code, { run_id: runId });
}

function validateRunDecisionReference(state, run) {
  const review = (state.human_reviews || []).find((item) => item.id === run.decision_id);
  if (!review || review.target_type !== 'quality_review_run' || review.target_id !== run.id)
    throw stateError('quality_review_decision_missing', { run_id: run.id, decision_id: run.decision_id });
  const matching =
    review.immutable === true &&
    review.report_id === run.report_id &&
    review.report_sha256 === run.report_sha256 &&
    review.input_snapshot_hash === run.input_snapshot_hash &&
    review.rubric_hash === run.rubric_hash &&
    review.decision === run.decision &&
    Number(review.score) === Number(run.score);
  if (!matching)
    throw stateError('quality_review_decision_snapshot_mismatch', { run_id: run.id, decision_id: review.id });
}

function validateReportReferences(state, report, runs) {
  const run = runs.get(report.run_id);
  if (!run) throw stateError('quality_review_report_run_missing', { report_id: report.id });
  if (report.immutable !== true) throw stateError('quality_review_report_not_immutable', { report_id: report.id });
  if (run.report_id !== report.id)
    throw stateError('quality_review_report_reference_mismatch', { report_id: report.id, run_id: run.id });
  if (report.input_snapshot_hash !== run.input_snapshot_hash)
    throw stateError('quality_review_report_input_hash_mismatch', { report_id: report.id });
  if (report.rubric_hash !== run.rubric_hash)
    throw stateError('quality_review_report_rubric_hash_mismatch', { report_id: report.id });
  if (report.report_sha256 !== run.report_sha256)
    throw stateError('quality_review_report_hash_reference_mismatch', { report_id: report.id });
}

function validateEventReference(state, event) {
  if (!state.quality_review_runs.some((item) => item.id === event.run_id))
    throw stateError('quality_review_event_run_missing', { event_id: event.id });
}

function validateHumanReviewReference(state, review, runs, reports) {
  if (review.target_type !== 'quality_review_run') return;
  const run = runs.get(review.target_id);
  if (!run) throw stateError('quality_review_review_run_missing', { review_id: review.id });
  if (review.report_id && !reports.has(review.report_id))
    throw stateError('quality_review_review_report_missing', { review_id: review.id });
  if (review.report_sha256 !== run.report_sha256 || review.input_snapshot_hash !== run.input_snapshot_hash)
    throw stateError('quality_review_review_snapshot_mismatch', { review_id: review.id });
  if (review.rubric_hash !== run.rubric_hash)
    throw stateError('quality_review_review_rubric_mismatch', { review_id: review.id });
  if (review.immutable !== true) throw stateError('quality_review_review_not_immutable', { review_id: review.id });
}

export function validateQualityReviewRecords(state) {
  for (const run of state.quality_review_runs) validateQualityReviewRunRecord(run);
  for (const report of state.quality_review_reports) validateQualityReviewReportRecord(report);
  validateQualityReviewEvents(state);
  validateQualityReviewHumanReviews(state);
}

function validateQualityReviewRunRecord(run) {
  requireIdentifier(run.id, 'run_id');
  requireIdentifier(run.workflow_execution_id, 'workflow_execution_id');
  requireIdentifier(run.project_id, 'project_id');
  if (!REVIEW_STATUSES.has(run.status)) throw stateError('quality_review_status_invalid', { run_id: run.id });
  if (run.phase !== run.status) throw stateError('quality_review_phase_invalid', { run_id: run.id });
  if (!Number.isInteger(run.revision) || run.revision < 1)
    throw stateError('quality_review_revision_invalid', { run_id: run.id });
  requireStringArray(run.input_asset_version_ids, 'input_asset_version_ids', run.id);
  requireStringArray(run.asset_version_ids, 'asset_version_ids', run.id);
  requireStringArray(run.out_of_scope_assets, 'out_of_scope_assets', run.id);
  validateExclusions(run);
  validateRunRubric(run);
  validateReviewerProfileSnapshot(run);
  validateRunReportFields(run);
  validateRunDecisionFields(run);
  validateRunFailureAndTimes(run);
}

function validateExclusions(run) {
  if (!Array.isArray(run.excluded_assets)) throw stateError('quality_review_exclusions_invalid', { run_id: run.id });
  const excluded = new Set();
  for (const item of run.excluded_assets) {
    requireIdentifier(item?.asset_version_id, 'excluded_asset_version_id');
    if (excluded.has(item.asset_version_id))
      throw stateError('quality_review_exclusions_duplicate', { run_id: run.id });
    excluded.add(item.asset_version_id);
    if (typeof item.reason !== 'string' || item.reason.trim().length < 1)
      throw stateError('quality_review_exclusion_reason_invalid', { run_id: run.id });
  }
}

function validateRunRubric(run) {
  let rubric;
  try {
    rubric = normalizeQualityReviewRubric(run.rubric);
  } catch (error) {
    throw stateError('quality_review_rubric_invalid', { run_id: run.id, cause: error.code || error.message });
  }
  requireHash(run.input_snapshot_hash, 'input_snapshot_hash', run.id);
  requireHash(run.rubric_hash, 'rubric_hash', run.id);
  if (run.rubric_hash !== qualityReviewRubricHash(rubric))
    throw stateError('quality_review_rubric_hash_mismatch', { run_id: run.id });
  if (run.workflow_policy_rubric_hash != null)
    requireHash(run.workflow_policy_rubric_hash, 'workflow_policy_rubric_hash', run.id);
  if (Number(run.threshold) !== Number(rubric.threshold))
    throw stateError('quality_review_threshold_mismatch', { run_id: run.id });
}

function validateReviewerProfileSnapshot(run) {
  const snapshot = run.reviewer_profile_snapshot;
  if (snapshot == null) return;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw stateError('quality_review_reviewer_snapshot_invalid', { run_id: run.id });
  requireIdentifier(snapshot.id, 'reviewer_profile_id');
  requireIdentifier(snapshot.provider, 'reviewer_provider');
  requireIdentifier(snapshot.model, 'reviewer_model');
  requireHash(snapshot.runtime_sha256, 'reviewer_runtime_sha256', run.id);
  if (snapshot.kind !== 'docker' || typeof snapshot.image !== 'string' || !snapshot.image)
    throw stateError('quality_review_reviewer_snapshot_invalid', { run_id: run.id });
  if (['refs', 'codex_home', 'config_file'].some((field) => Object.hasOwn(snapshot, field)))
    throw stateError('quality_review_reviewer_snapshot_secret_field', { run_id: run.id });
}

function validateRunReportFields(run) {
  if (run.report_id == null) {
    if (run.report_sha256 != null) throw stateError('quality_review_report_hash_without_report', { run_id: run.id });
    return;
  }
  requireIdentifier(run.report_id, 'report_id');
  requireHash(run.report_sha256, 'report_sha256', run.id);
}

function validateRunDecisionFields(run) {
  if (run.decision == null) {
    if (run.decision_id != null || run.score != null)
      throw stateError('quality_review_decision_fields_incomplete', { run_id: run.id });
    return;
  }
  if (!REVIEW_DECISIONS.has(run.decision)) throw stateError('quality_review_decision_invalid', { run_id: run.id });
  requireIdentifier(run.decision_id, 'decision_id');
  if (!Number.isFinite(Number(run.score)) || Number(run.score) < 0 || Number(run.score) > 100)
    throw stateError('quality_review_score_invalid', { run_id: run.id });
}

function validateRunFailureAndTimes(run) {
  if (run.failure != null && (typeof run.failure !== 'object' || Array.isArray(run.failure)))
    throw stateError('quality_review_failure_invalid', { run_id: run.id });
  for (const field of ['created_at', 'updated_at', 'started_at', 'completed_at'])
    if (run[field] != null && !validTimestamp(run[field]))
      throw stateError('quality_review_timestamp_invalid', { run_id: run.id, field });
}

function validateQualityReviewReportRecord(report) {
  const { report_sha256: reportHash, ...protocolReport } = report;
  requireIdentifier(report.id, 'report_id');
  requireIdentifier(report.run_id, 'run_id');
  requireHash(reportHash, 'report_sha256', report.id);
  let parsed;
  try {
    parsed = parseQualityReviewReport(protocolReport);
  } catch (error) {
    throw stateError('quality_review_report_invalid', { report_id: report.id, cause: error.code || error.message });
  }
  if (protocolHash(parsed) !== reportHash)
    throw stateError('quality_review_report_hash_mismatch', { report_id: report.id });
}

function validateQualityReviewEvents(state) {
  const eventsByRun = new Map();
  for (const event of state.quality_review_events) {
    requireIdentifier(event.id, 'event_id');
    requireIdentifier(event.run_id, 'run_id');
    if (!Number.isInteger(event.sequence) || event.sequence < 1)
      throw stateError('quality_review_event_sequence_invalid', { event_id: event.id });
    if (typeof event.type !== 'string' || !REVIEW_STATUSES.has(event.type))
      throw stateError('quality_review_event_type_invalid', { event_id: event.id });
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data))
      throw stateError('quality_review_event_data_invalid', { event_id: event.id });
    if (event.created_at != null && !validTimestamp(event.created_at))
      throw stateError('quality_review_timestamp_invalid', { event_id: event.id, field: 'created_at' });
    const seen = eventsByRun.get(event.run_id) || new Set();
    if (seen.has(event.sequence)) throw stateError('quality_review_event_sequence_duplicate', { event_id: event.id });
    seen.add(event.sequence);
    eventsByRun.set(event.run_id, seen);
  }
}

function validateQualityReviewHumanReviews(state) {
  for (const review of state.human_reviews || []) {
    if (review.target_type !== 'quality_review_run') continue;
    requireIdentifier(review.id, 'review_id');
    validateDimensionScores(review);
    if (!REVIEW_DECISIONS.has(review.decision))
      throw stateError('quality_review_review_decision_invalid', { review_id: review.id });
    if (!Number.isFinite(Number(review.score)) || Number(review.score) < 0 || Number(review.score) > 100)
      throw stateError('quality_review_review_score_invalid', { review_id: review.id });
  }
}

function validateDimensionScores(review) {
  if (!Array.isArray(review.dimension_scores) || !review.dimension_scores.length)
    throw stateError('quality_review_dimension_scores_invalid', { review_id: review.id });
  const seen = new Set();
  for (const score of review.dimension_scores) {
    requireIdentifier(score?.criterion_id, 'criterion_id');
    if (seen.has(score.criterion_id)) throw stateError('quality_review_dimension_duplicate', { review_id: review.id });
    seen.add(score.criterion_id);
    if (!Number.isInteger(score.score) || score.score < 0 || score.score > 100)
      throw stateError('quality_review_dimension_score_invalid', { review_id: review.id });
    if (typeof score.reason !== 'string' || score.reason.trim().length < 3)
      throw stateError('quality_review_dimension_reason_invalid', { review_id: review.id });
  }
}

export function stateRecordIdentity(collection, record) {
  if (collection === 'quality_review_events') {
    const runId = record?.run_id,
      sequence = record?.sequence;
    if (runId == null || sequence == null) throw stateError('state_record_identity_missing', { collection });
    return JSON.stringify([String(runId), String(sequence)]);
  }
  return stateRecordIdentityV22(collection, record);
}

function requireIdentifier(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500)
    throw stateError('quality_review_identifier_invalid', { field });
}

function requireHash(value, field, identity) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) throw stateError('quality_review_hash_invalid', { field, identity });
}

function requireStringArray(value, field, identity) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()))
    throw stateError('quality_review_array_invalid', { field, identity });
  if (new Set(value).size !== value.length) throw stateError('quality_review_array_duplicate', { field, identity });
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function stateError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}
