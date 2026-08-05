import { normalizeQualityReviewRubric, qualityReviewRubricHash } from './quality-review-rubric.mjs';
import { executionQualityReviewPolicyHash, qualityReviewRunIsCurrent } from './quality-review-freshness.mjs';

export function qualityReviewMaterialization(workflow) {
  const rubric = workflow?.quality_review_policy?.enabled
    ? normalizeQualityReviewRubric(workflow.quality_review_policy.rubric)
    : null;
  return { rubric, hash: rubric ? qualityReviewRubricHash(rubric) : null };
}

export function qualityReviewPolicySnapshot(workflow) {
  const materialized = qualityReviewMaterialization(workflow);
  if (!materialized.rubric)
    return {
      enabled: false,
      mandatory: false,
      strategy: 'legacy_opt_in',
      rubric: null,
      rubric_hash: null
    };
  return {
    enabled: true,
    mandatory: true,
    strategy: workflow.quality_review_policy?.strategy || 'v23_default',
    rubric: JSON.parse(JSON.stringify(materialized.rubric)),
    rubric_hash: materialized.hash
  };
}

export function qualityReviewCriterionConfig(criterion) {
  return {
    criterion_id: criterion.id,
    authority_mapping: criterion.authority_mapping,
    ...(criterion.evaluator_config || {})
  };
}

export function isQualityReviewHumanScore(requirement) {
  return requirement.evaluator === 'human_score' && requirement.evaluator_config?.quality_review === true;
}

export function latestQualityReviewDecisions(state, execution, requirement) {
  if (requirement.evaluator_config?.quality_review !== true) return legacyHumanReviews(state, execution);
  const policyHash = executionQualityReviewPolicyHash(execution);
  const runs = (state.quality_review_runs || [])
    .filter((run) => isCurrentCompletedRun(state, execution, run, policyHash))
    .sort((left, right) => completionTime(right).localeCompare(completionTime(left)));
  const byId = new Map((state.human_reviews || []).map((item) => [item.id, item]));
  return runs
    .map((run) => ({ run, review: byId.get(run.decision_id) }))
    .filter(({ run, review }) => isBoundQualityReviewDecision(review, run, execution))
    .map(({ review }) => review);
}

export function qualityReviewHumanScoreEvaluation(state, execution, requirement) {
  const latest = latestQualityReviewDecisions(state, execution, requirement)[0] || null,
    actual = latest && Number.isFinite(Number(latest.score)) ? Number(latest.score) : null,
    minimum = Number(requirement.expected?.min ?? requirement.expected ?? 0),
    passed = actual != null && actual >= minimum;
  return {
    status: passed ? 'satisfied' : 'unsatisfied',
    actual: { score: actual, minimum },
    evidenceRefs: latest ? [`human_review:${latest.id}`, `quality_review_run:${latest.target_id}`] : [],
    reasonCode: passed ? 'human_score_satisfied' : 'human_score_unsatisfied'
  };
}

function legacyHumanReviews(state, execution) {
  return (state.human_reviews || [])
    .filter(
      (item) =>
        item.workflow_execution_id === execution.id &&
        !['assist_turn', 'terminal_session', 'quality_review_run'].includes(item.target_type) &&
        Number.isFinite(Number(item.score))
    )
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
}

function isCurrentCompletedRun(state, execution, run, policyHash) {
  return (
    run.workflow_execution_id === execution.id &&
    run.status === 'completed' &&
    run.decision_id &&
    !run.superseded_by_run_id &&
    (run.workflow_policy_rubric_hash ?? run.rubric_hash) === policyHash &&
    reviewRunInputIsCurrent(state, execution, run)
  );
}

function isBoundQualityReviewDecision(review, run, execution) {
  return Boolean(
    review?.target_type === 'quality_review_run' &&
    review.target_id === run.id &&
    review.workflow_execution_id === execution.id &&
    review.immutable === true &&
    review.report_id === run.report_id &&
    review.report_sha256 === run.report_sha256 &&
    review.input_snapshot_hash === run.input_snapshot_hash &&
    review.rubric_hash === run.rubric_hash &&
    review.decision === run.decision &&
    Number.isFinite(Number(review.score)) &&
    Number(review.score) === Number(run.score) &&
    qualityReviewDecisionMatchesRubric(review, run)
  );
}

function qualityReviewDecisionMatchesRubric(review, run) {
  try {
    const rubric = normalizeQualityReviewRubric(run.rubric),
      dimensions = rubric.dimensions.filter((item) => item.enabled),
      scores = Array.isArray(review.dimension_scores) ? review.dimension_scores : [],
      byId = new Map(scores.map((item) => [item.criterion_id, item]));
    if (scores.length !== dimensions.length) return false;
    if (run.decision !== (Number(run.score) >= Number(run.threshold) ? 'pass' : 'changes_required')) return false;
    if (
      !dimensions.every((dimension) => {
        const score = byId.get(dimension.id);
        return score && Number.isInteger(score.score) && score.score >= 0 && score.score <= 100;
      })
    )
      return false;
    const weighted = dimensions.reduce(
      (sum, dimension) => sum + (byId.get(dimension.id).score * Number(dimension.weight)) / 100,
      0
    );
    return Math.round(weighted * 100) / 100 === Number(review.score);
  } catch {
    return false;
  }
}

function reviewRunInputIsCurrent(state, execution, run) {
  return run.stale !== true && qualityReviewRunIsCurrent(state, execution, run);
}

function completionTime(run) {
  return String(run.completed_at || run.updated_at);
}
