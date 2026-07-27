import { now } from '../../../packages/shared/index.mjs';

export function legacyPromotedExecution(execution) {
  return execution.evidence?.source === 'legacy_execution_promotion';
}

export function restoreLegacyRetryCompatibility(state, previous, retry) {
  if (!legacyPromotedExecution(previous)) return null;
  retry.retry_input_snapshot_hash = null;
  retry.retry_input_snapshot_hash_version = null;
  const repository = previous.context_snapshot?.repository_snapshot,
    expectedHead = String(repository?.fixed_sha || '');
  if (!repository?.repository_line_id || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHead)) return null;
  const line = state.repository_lines.find(
    (item) =>
      item.id === repository.repository_line_id &&
      item.workflow_execution_id === previous.workflow_execution_id &&
      item.workstream_id === previous.workstream_id
  );
  if (!line || line.head_sha === expectedHead) return null;
  const previousHead = line.head_sha || null;
  Object.assign(line, {
    head_sha: expectedHead,
    checkout_path: null,
    status: 'active',
    error_code: null,
    updated_at: now()
  });
  return { line, previous_head_sha: previousHead, expected_head_sha: expectedHead };
}

export function retryInputExpectation(previous) {
  if (legacyPromotedExecution(previous)) return { hash: null, version: null };
  if (previous.input_snapshot_hash)
    return {
      hash: previous.input_snapshot_hash,
      version: Number(previous.input_snapshot_hash_version || 1)
    };
  if (previous.retry_input_snapshot_hash)
    return {
      hash: previous.retry_input_snapshot_hash,
      version: Number(previous.retry_input_snapshot_hash_version || 1)
    };
  return { hash: null, version: null };
}

export function isLegacyStrandedRetry(state, previous, retry, workflow) {
  return Boolean(
    legacyPromotedExecution(previous) &&
    retry.status === 'running' &&
    String(retry.lease?.holder || '').startsWith('dispatcher:') &&
    workflow?.executor_config?.runner === 'history_promotion' &&
    !state.node_runs.some((item) => item.task_execution_id === retry.id)
  );
}

export function sanitizeLegacyExecutorConfig(workflowExecution) {
  if (workflowExecution?.executor_config?.runner !== 'history_promotion') return;
  const executorConfig = { ...workflowExecution.executor_config };
  delete executorConfig.runner;
  workflowExecution.executor_config = executorConfig;
  workflowExecution.updated_at = now();
}
