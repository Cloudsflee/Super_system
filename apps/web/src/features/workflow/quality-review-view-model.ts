import type {
  QualityReviewDimension,
  QualityReviewPrepare,
  QualityReviewRubric,
  QualityReviewRun,
  QualityReviewSnapshot
} from '../../api/execution-types';

export type QualityReviewScore = { score: string; reason: string };
export type QualityReviewScores = Record<string, QualityReviewScore>;

export function buildQualityReviewModel({
  preparation,
  snapshot,
  rubric,
  scores,
  canApprove
}: {
  preparation?: QualityReviewPrepare;
  snapshot?: QualityReviewSnapshot;
  rubric: QualityReviewRubric | null;
  scores: QualityReviewScores;
  canApprove: boolean;
}) {
  const run = reviewRun(snapshot, preparation);
  const report = reviewReport(snapshot, run);
  const selectedRubric = selectedReviewRubric(rubric, preparation);
  const scoringRubric = run?.rubric || selectedRubric;
  const enabledDimensions = scoringRubric?.dimensions.filter((item) => item.enabled) || [];
  const status = run?.status || 'not_started';
  const awaitingHuman = status === 'awaiting_human' && run?.stale !== true;
  return {
    run,
    report,
    selectedRubric,
    scoringRubric,
    enabledDimensions,
    status,
    awaitingHuman,
    active: run?.stale !== true && isActiveStatus(status),
    ready: reviewerReady(preparation),
    weightTotal: enabledWeight(selectedRubric),
    scoreTotal: weightedQualityScore(enabledDimensions, scores),
    canSubmitDecision: canSubmitDecision(canApprove, awaitingHuman, run, scores, enabledDimensions),
    threshold: run?.threshold ?? preparation?.threshold ?? 80
  };
}

function reviewRun(snapshot?: QualityReviewSnapshot, preparation?: QualityReviewPrepare) {
  return snapshot?.run || preparation?.current_run || null;
}

function reviewReport(snapshot: QualityReviewSnapshot | undefined, run: QualityReviewRun | null) {
  return snapshot?.report || run?.report || null;
}

function selectedReviewRubric(rubric: QualityReviewRubric | null, preparation?: QualityReviewPrepare) {
  return rubric || preparation?.default_rubric || null;
}

function isActiveStatus(status: string) {
  return ['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human'].includes(status);
}

function reviewerReady(preparation?: QualityReviewPrepare) {
  return preparation?.reviewer_readiness.ready !== false;
}

function canSubmitDecision(
  canApprove: boolean,
  awaitingHuman: boolean,
  run: QualityReviewRun | null,
  scores: QualityReviewScores,
  dimensions: QualityReviewDimension[]
) {
  return canApprove && awaitingHuman && run?.stale !== true && hasValidDecision(run, scores, dimensions);
}

function enabledWeight(rubric: QualityReviewRubric | null) {
  return (
    rubric?.dimensions.filter((item) => item.enabled).reduce((sum, item) => sum + Number(item.weight || 0), 0) || 0
  );
}

function hasValidDecision(
  run: QualityReviewRun | null,
  scores: QualityReviewScores,
  dimensions: QualityReviewDimension[]
) {
  if (!run?.report_sha256 || !run.input_snapshot_hash) return false;
  return dimensions.every((dimension) => {
    const value = scores[dimension.id];
    return Boolean(
      value &&
      /^\d+$/.test(value.score) &&
      Number(value.score) >= 0 &&
      Number(value.score) <= 100 &&
      value.reason.trim().length >= 3
    );
  });
}

export function weightedQualityScore(dimensions: QualityReviewDimension[], scores: QualityReviewScores) {
  return (
    Math.round(
      dimensions.reduce(
        (sum, dimension) => sum + ((Number(scores[dimension.id]?.score) || 0) * Number(dimension.weight || 0)) / 100,
        0
      ) * 100
    ) / 100
  );
}
