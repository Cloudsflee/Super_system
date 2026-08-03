export function currentQualityReviewTaskExecutions(state, workflowExecutionId) {
  const candidates = (state.task_executions || []).filter((item) => item.workflow_execution_id === workflowExecutionId),
    supersededIds = new Set(candidates.map((item) => item.supersedes_id).filter(Boolean)),
    leaves = candidates.filter((item) => item.status !== 'superseded' && !supersededIds.has(item.id)),
    byTask = new Map();
  for (const item of leaves.sort(compareTaskExecutions)) byTask.set(item.task_id, item);
  return [...byTask.values()];
}

export function currentQualityReviewAssetVersionIds(state, workflowExecutionId) {
  const taskExecutionIds = new Set(
      currentQualityReviewTaskExecutions(state, workflowExecutionId).map((item) => item.id)
    ),
    versions = new Map((state.asset_versions || []).map((item) => [item.id, item]));
  return (state.assets || [])
    .filter((asset) => {
      const version = versions.get(asset.current_version_id);
      return taskExecutionIds.has(asset.task_execution_id) && version?.asset_id === asset.id;
    })
    .map((asset) => asset.current_version_id)
    .sort();
}

function compareTaskExecutions(left, right) {
  return (
    Number(left.attempt || 0) - Number(right.attempt || 0) ||
    String(left.updated_at || left.created_at || '').localeCompare(
      String(right.updated_at || right.created_at || '')
    ) ||
    String(left.id).localeCompare(String(right.id))
  );
}
