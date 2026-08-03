import type { QualityReviewRun } from '../../api/execution-types';
import type { QualityReviewScores } from './quality-review-view-model';

export function selectedQualityReviewExclusions(included: string[], exclusions: Record<string, string>) {
  const includedIds = new Set(included);
  return Object.entries(exclusions)
    .filter(([assetVersionId, reason]) => !includedIds.has(assetVersionId) && reason.trim())
    .map(([asset_version_id, reason]) => ({ asset_version_id, reason: reason.trim() }));
}

export function scoresForQualityReviewRun(
  previousRunId: string | null,
  run: Pick<QualityReviewRun, 'id' | 'rubric'>,
  current: QualityReviewScores
) {
  const preserve = previousRunId === run.id;
  return Object.fromEntries(
    run.rubric.dimensions
      .filter((item) => item.enabled)
      .map((item) => [item.id, preserve && current[item.id] ? current[item.id] : { score: '', reason: '' }])
  );
}
