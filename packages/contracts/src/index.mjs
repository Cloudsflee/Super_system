export const PRODUCT_VERSION = '3.0.0';
export const API_PREFIX = '/api/v1';
export const DATABASE_USER_VERSION = 1;
export const DEVELOPMENT_RUNNER_DIGEST = 'sha256:149371d54db3776db9e48515f034e6826d206b7ce0e2da155b90fc6976883044';

export const TASK_STATUSES = Object.freeze([
  'pending', 'ready', 'running', 'awaiting_human', 'completed', 'failed', 'cancelled'
]);

export const EXECUTION_STATUSES = Object.freeze([
  'queued', 'running', 'awaiting_human', 'completed', 'failed', 'cancelled'
]);

export const MODEL_SUGGESTION_STATUSES = Object.freeze(['available', 'unavailable', 'invalid']);

export const SSE_FIELDS = Object.freeze([
  'cursor', 'type', 'execution_id', 'task_id', 'data', 'created_at'
]);

export const COMMAND_NAMES = Object.freeze([
  'project.create', 'project.update', 'brief.create', 'workflow.create',
  'context.source.create', 'context.pack.create', 'asset.create',
  'execution.create', 'execution.start', 'execution.cancel',
  'review.create', 'review.decide', 'delivery.create', 'delivery.merge'
]);

export function errorEnvelope({ code, message, retryable = false, requestId, details = {} }) {
  return { error: { code, message, retryable, request_id: requestId, details } };
}

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}
