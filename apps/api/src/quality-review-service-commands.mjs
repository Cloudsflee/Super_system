import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { HttpError } from './http.mjs';
import { addTrace } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { evaluateWorkflowOutcomesInState, outcomeSnapshot } from './outcome-service.mjs';
import { normalizeQualityReviewRubric, qualityReviewRubricHash } from './quality-review-rubric.mjs';
import {
  appendQualityReviewEvent,
  bumpQualityReviewRevision,
  clean,
  qualityReviewInputHash,
  qualityReviewRunInputIsCurrent,
  requireQualityReview,
  reviewerReadiness
} from './quality-review-service-state.mjs';
import { requireWorkflowExecution } from './workflow-execution-domain.mjs';
import { markQualityReviewRunsStale } from './state-migration-v23.mjs';
import { executionQualityReviewPolicyHash } from './quality-review-freshness.mjs';

const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human']);

export function createQualityReviewRun(state, execution, preparation, input = {}, actorId = null) {
  markQualityReviewRunsStale(state, now());
  const workflow = state.workflows.find((item) => item.id === execution.workflow_id),
    operationKey = clean(input.operation_key || input.idempotency_key, 128) || null,
    same = findIdempotentRun(state, execution.id, operationKey);
  if (same) return { run: same, idempotent: true };
  assertNoActiveRun(state, execution.id);
  const launch = normalizeLaunchInput(preparation, input),
    run = buildQueuedRun(state, workflow, execution, preparation, launch, operationKey, actorId);
  state.quality_review_runs.push(run);
  appendQualityReviewEvent(state, run, 'queued', { phase: 'queued' });
  addTrace(
    state,
    'quality_review.queued',
    {
      project_id: execution.project_id,
      target_type: 'quality_review_run',
      target_id: run.id,
      summary: 'Quality Review 已排队。'
    },
    actorId
  );
  return { run, idempotent: false };
}

function findIdempotentRun(state, executionId, operationKey) {
  if (!operationKey) return null;
  return state.quality_review_runs.find(
    (item) => item.workflow_execution_id === executionId && item.operation_key === operationKey
  );
}

function assertNoActiveRun(state, executionId) {
  const active = state.quality_review_runs.find(
    (item) => item.workflow_execution_id === executionId && ACTIVE_STATUSES.has(item.status) && item.stale !== true
  );
  if (active) throw new HttpError(409, { error: 'quality_review_active', quality_review_run_id: active.id });
}

function normalizeLaunchInput(preparation, input) {
  const rubric = normalizeQualityReviewRubric(input.rubric || preparation.default_rubric),
    exclusions = normalizeExclusions(input.excluded_assets, preparation.assets, preparation.out_of_scope_assets),
    allCandidates = [...preparation.assets, ...preparation.out_of_scope_assets],
    inScopeIds = new Set(preparation.assets.map((item) => item.asset_version_id)),
    allIds = allCandidates.map((item) => item.asset_version_id).sort(),
    excludedIds = new Set(exclusions.map((item) => item.asset_version_id)),
    includedIds = Array.isArray(input.included_asset_version_ids)
      ? [...new Set(input.included_asset_version_ids.map(String))]
      : preparation.default_included_asset_version_ids.filter((item) => !excludedIds.has(item));
  assertLaunchSelection(rubric, preparation, allIds, inScopeIds, includedIds, excludedIds);
  return { rubric, exclusions, allIds, includedIds };
}

function buildQueuedRun(state, workflow, execution, preparation, launch, operationKey, actorId) {
  const { rubric, exclusions, allIds, includedIds } = launch,
    inputSnapshotHash = qualityReviewInputHash(execution, allIds, rubric, exclusions),
    createdAt = now(),
    run = {
      id: id('qrr'),
      workflow_execution_id: execution.id,
      project_id: execution.project_id,
      operation_key: operationKey,
      status: 'queued',
      phase: 'queued',
      revision: 1,
      input_snapshot_hash: inputSnapshotHash,
      input_asset_version_ids: allIds,
      asset_version_ids: [...includedIds].sort(),
      excluded_assets: exclusions,
      out_of_scope_assets: preparation.out_of_scope_assets.map((item) => item.asset_version_id),
      rubric: structuredClone(rubric),
      rubric_hash: qualityReviewRubricHash(rubric),
      workflow_policy_rubric_hash: executionQualityReviewPolicyHash(execution) ?? preparation.rubric_hash,
      threshold: rubric.threshold,
      reviewer_profile_snapshot: preparation.reviewer_readiness?.profile || reviewerReadiness(state, workflow).profile,
      report_id: null,
      report_sha256: null,
      decision_id: null,
      decision: null,
      score: null,
      failure: null,
      error_code: null,
      retryable: false,
      stale: false,
      superseded_by_run_id: null,
      cancel_requested_at: null,
      created_by_user_id: actorId,
      created_at: createdAt,
      started_at: null,
      completed_at: null,
      updated_at: createdAt
    };
  return run;
}

function assertLaunchSelection(rubric, preparation, allIds, inScopeIds, includedIds, excludedIds) {
  assertRubricFields(rubric, preparation.default_rubric);
  const selectionConflicts = includedIds.filter((item) => excludedIds.has(item));
  if (selectionConflicts.length)
    throw new HttpError(400, {
      error: 'quality_review_asset_selection_conflict',
      asset_version_ids: selectionConflicts
    });
  for (const assetVersionId of includedIds) {
    if (!allIds.includes(assetVersionId))
      throw new HttpError(400, { error: 'quality_review_asset_not_selectable', asset_version_id: assetVersionId });
    if (!inScopeIds.has(assetVersionId))
      throw new HttpError(409, {
        error: 'quality_review_out_of_scope_asset_cannot_be_included',
        asset_version_id: assetVersionId
      });
  }
  for (const candidate of preparation.assets)
    if (!includedIds.includes(candidate.asset_version_id) && !excludedIds.has(candidate.asset_version_id))
      throw new HttpError(400, {
        error: 'quality_review_exclusion_reason_required',
        asset_version_id: candidate.asset_version_id
      });
  const requiredExcluded = preparation.assets.filter(
    (candidate) => candidate.required && !includedIds.includes(candidate.asset_version_id)
  );
  if (requiredExcluded.length)
    throw new HttpError(409, {
      error: 'quality_review_required_asset_excluded',
      asset_version_ids: requiredExcluded.map((item) => item.asset_version_id)
    });
  if (includedIds.length > 16)
    throw new HttpError(413, { error: 'quality_review_asset_count_exceeded', max_assets: 16 });
  if (rubric.threshold !== preparation.threshold)
    throw new HttpError(409, {
      error: 'quality_review_threshold_read_only',
      expected: preparation.threshold,
      actual: rubric.threshold
    });
}

function assertRubricFields(rubric, policyRubric) {
  if (
    rubric.schema_version !== policyRubric.schema_version ||
    rubric.version !== policyRubric.version ||
    rubric.enabled !== policyRubric.enabled ||
    rubric.mandatory !== policyRubric.mandatory
  )
    throw new HttpError(409, { error: 'quality_review_rubric_policy_fields_read_only' });
  const expected = policyRubric.dimensions.map((item) => item.id).sort(),
    actual = rubric.dimensions.map((item) => item.id).sort();
  if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index]))
    throw new HttpError(409, { error: 'quality_review_rubric_dimensions_read_only' });
}

export function decideQualityReviewInState(state, runId, input = {}, actorId = null) {
  const run = requireQualityReview(state, runId),
    execution = requireWorkflowExecution(state, run.workflow_execution_id);
  if (run.status !== 'awaiting_human')
    throw new HttpError(409, { error: 'quality_review_not_awaiting_human', status: run.status });
  assertDecisionFreshness(run, input);
  if (run.stale || !qualityReviewRunInputIsCurrent(state, execution, run))
    throw new HttpError(409, { error: 'quality_review_stale' });
  const report = state.quality_review_reports.find((item) => item.id === run.report_id),
    rubric = normalizeQualityReviewRubric(run.rubric),
    scores = normalizeDecisionScores(input, rubric),
    score = weightedScore(scores, rubric),
    decision = score >= rubric.threshold ? 'pass' : 'changes_required',
    review = buildHumanReview(run, execution, report, scores, score, decision, input, actorId),
    createdAt = now();
  state.human_reviews.push(review);
  completeRun(run, review, score, decision, createdAt);
  supersedePriorRun(state, run, execution.id, createdAt);
  execution.quality_review_input_snapshot_hash = run.input_snapshot_hash;
  execution.quality_review_rubric_hash = run.rubric_hash;
  appendQualityReviewEvent(state, run, 'completed', { phase: 'completed', decision, score });
  evaluateWorkflowOutcomesInState(state, execution.id, { timestamp: createdAt });
  addTrace(
    state,
    'quality_review.decided',
    {
      project_id: execution.project_id,
      target_type: 'quality_review_run',
      target_id: run.id,
      summary: `Quality Review 人工裁决：${decision}`,
      data: { score, decision, report_sha256: run.report_sha256 }
    },
    actorId
  );
  return { run, review, outcomes: outcomeSnapshot(state, execution.id) };
}

function assertDecisionFreshness(run, input) {
  if (run.report_sha256 !== String(input.expected_report_sha256 || ''))
    throw new HttpError(409, { error: 'quality_review_report_stale', expected_report_sha256: run.report_sha256 });
  if (run.input_snapshot_hash !== String(input.expected_input_snapshot_hash || ''))
    throw new HttpError(409, {
      error: 'quality_review_input_stale',
      expected_input_snapshot_hash: run.input_snapshot_hash
    });
}

function buildHumanReview(run, execution, report, scores, score, decision, input, actorId) {
  const reason = clean(input.reason || input.summary, 10_000);
  if (reason.length < 3) throw new HttpError(400, { error: 'quality_review_decision_reason_required' });
  return {
    id: id('hrv'),
    target_type: 'quality_review_run',
    target_id: run.id,
    action: 'decision',
    reviewer_id: actorId,
    workflow_execution_id: execution.id,
    project_id: execution.project_id,
    report_id: report?.id || null,
    report_sha256: run.report_sha256,
    input_snapshot_hash: run.input_snapshot_hash,
    rubric_hash: run.rubric_hash,
    dimension_scores: scores,
    score,
    decision,
    status: decision === 'pass' ? 'approved' : 'changes_required',
    reason,
    immutable: true,
    created_at: now()
  };
}

function completeRun(run, review, score, decision, timestamp) {
  Object.assign(run, {
    status: 'completed',
    phase: 'completed',
    decision_id: review.id,
    decision,
    score,
    completed_at: timestamp,
    updated_at: timestamp,
    retryable: false
  });
  bumpQualityReviewRevision(run);
}

function supersedePriorRun(state, run, executionId, timestamp) {
  const priorCompleted = state.quality_review_runs
    .filter(
      (item) =>
        item.id !== run.id &&
        item.workflow_execution_id === executionId &&
        item.status === 'completed' &&
        item.decision_id
    )
    .sort((left, right) =>
      String(right.completed_at || right.updated_at).localeCompare(String(left.completed_at || left.updated_at))
    )[0];
  if (!priorCompleted) return;
  priorCompleted.superseded_by_run_id = run.id;
  priorCompleted.updated_at = timestamp;
  bumpQualityReviewRevision(priorCompleted);
}

function normalizeExclusions(input, inScope, outOfScope) {
  const known = new Set([...inScope, ...outOfScope].map((item) => item.asset_version_id)),
    seen = new Set();
  return (Array.isArray(input) ? input : []).map((item) => {
    const assetVersionId = String(item?.asset_version_id || item?.version_id || ''),
      reason = clean(item?.reason, 2000);
    if (!known.has(assetVersionId))
      throw new HttpError(400, { error: 'quality_review_asset_not_selectable', asset_version_id: assetVersionId });
    if (seen.has(assetVersionId))
      throw new HttpError(400, { error: 'quality_review_duplicate_exclusion', asset_version_id: assetVersionId });
    if (!reason)
      throw new HttpError(400, { error: 'quality_review_exclusion_reason_required', asset_version_id: assetVersionId });
    seen.add(assetVersionId);
    return { asset_version_id: assetVersionId, reason };
  });
}

function normalizeDecisionScores(input, rubric) {
  const raw = Array.isArray(input.dimension_scores)
    ? input.dimension_scores
    : Object.entries(input.dimension_scores || input.scores || {}).map(([criterion_id, value]) =>
        typeof value === 'object' ? { criterion_id, ...value } : { criterion_id, score: value }
      );
  const byId = new Map(raw.map((item) => [String(item.criterion_id || item.id), item])),
    dimensions = rubric.dimensions.filter((item) => item.enabled);
  if (raw.length !== dimensions.length)
    throw new HttpError(400, { error: 'quality_review_dimension_scores_incomplete' });
  return dimensions.map((dimension) => normalizeDimensionScore(byId.get(dimension.id), dimension));
}

function normalizeDimensionScore(item, dimension) {
  const score = Number(item?.score),
    reason = clean(item?.reason || item?.rationale, 4000);
  if (!item || !Number.isInteger(score) || score < 0 || score > 100)
    throw new HttpError(400, { error: 'quality_review_dimension_score_invalid', criterion_id: dimension.id });
  if (reason.length < 3)
    throw new HttpError(400, { error: 'quality_review_dimension_reason_required', criterion_id: dimension.id });
  return { criterion_id: dimension.id, score, reason };
}

function weightedScore(scores, rubric) {
  const total = scores.reduce((sum, item) => {
    const dimension = rubric.dimensions.find((candidate) => candidate.id === item.criterion_id);
    return sum + (item.score * Number(dimension?.weight || 0)) / 100;
  }, 0);
  return Math.round(total * 100) / 100;
}
