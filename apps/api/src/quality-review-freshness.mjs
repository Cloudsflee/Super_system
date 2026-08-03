import { protocolHash } from '../../../packages/execution-protocol/src/index.mjs';
import { qualityReviewRubricHash } from './quality-review-rubric.mjs';
import { currentQualityReviewAssetVersionIds } from './quality-review-task-scope.mjs';

export function qualityReviewInputHash(execution, assetVersionIds, rubric, exclusions) {
  return protocolHash({
    workflow_execution_id: execution.id,
    workflow_revision: execution.workflow_revision,
    execution_input_hash: execution.input_hash,
    asset_version_ids: [...assetVersionIds].sort(),
    rubric_hash: qualityReviewRubricHash(rubric),
    exclusions: normalizedExclusions(exclusions)
  });
}

export function qualityReviewRunIsCurrent(state, execution, run) {
  if (!execution || !Array.isArray(run.input_asset_version_ids)) return false;
  const current = currentQualityReviewAssetVersionIds(state, execution.id),
    workflow = (state.workflows || []).find((item) => item.id === execution.workflow_id),
    expectedPolicyHash = run.workflow_policy_rubric_hash ?? run.rubric_hash,
    executionPolicyHash =
      execution.quality_review_policy_snapshot?.rubric_hash ??
      execution.quality_review_rubric_hash ??
      workflowQualityReviewPolicyHash(workflow);
  return (
    protocolHash(current) === protocolHash([...run.input_asset_version_ids].sort()) &&
    qualityReviewInputHash(execution, run.input_asset_version_ids, run.rubric, run.excluded_assets || []) ===
      run.input_snapshot_hash &&
    expectedPolicyHash === executionPolicyHash
  );
}

export function workflowQualityReviewPolicyHash(workflow) {
  if (!workflow?.quality_review_policy?.enabled || !workflow.quality_review_policy.rubric) return null;
  return qualityReviewRubricHash(workflow.quality_review_policy.rubric);
}

function normalizedExclusions(exclusions) {
  return (exclusions || [])
    .map((item) => ({ asset_version_id: item.asset_version_id, reason: item.reason }))
    .sort((left, right) => String(left.asset_version_id).localeCompare(String(right.asset_version_id)));
}
