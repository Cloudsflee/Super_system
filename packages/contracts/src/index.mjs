export const PRODUCT_VERSION = '3.0.0';
export const API_PREFIX = '/api/v1';
export const DATABASE_USER_VERSION = 2;
export const DEVELOPMENT_RUNNER_DIGEST = 'sha256:149371d54db3776db9e48515f034e6826d206b7ce0e2da155b90fc6976883044';

export const TASK_STATUSES = Object.freeze([
  'pending', 'ready', 'running', 'awaiting_human', 'completed', 'failed', 'cancelled'
]);

export const EXECUTION_STATUSES = Object.freeze([
  'queued', 'running', 'awaiting_human', 'completed', 'failed', 'cancelled'
]);

export const MODEL_SUGGESTION_STATUSES = Object.freeze(['available', 'unavailable', 'invalid']);

export const TERMINAL_STATUSES = Object.freeze([
  'ready', 'running', 'exited', 'failed', 'stopped', 'orphaned'
]);

export const SSE_FIELDS = Object.freeze([
  'cursor', 'type', 'execution_id', 'task_id', 'data', 'created_at'
]);

export const COMMAND_NAMES = Object.freeze([
  'project.create', 'project.update', 'brief.create', 'workflow.create',
  'context.source.create', 'context.pack.create', 'asset.create',
  'execution.create', 'execution.start', 'execution.cancel',
  'execution.evidence.resolve', 'review.create', 'review.decide',
  'delivery.create', 'delivery.merge', 'delivery.retry',
  'account.update', 'setup.complete',
  'credential.create', 'credential.rotate', 'credential.revoke', 'credential.delete',
  'codex_profile.create', 'codex_profile.update', 'codex_profile.activate', 'codex_profile.probe',
  'codex.device_auth.start', 'codex.discovery.start', 'codex.discovery.import', 'codex.probe',
  'session.create', 'session.revoke', 'operation.cancel',
  'github_app.create', 'github_installation.create', 'github.installations.discover',
  'github.repositories.sync', 'github.probe'
  , 'mcp_client.create', 'mcp_client.revoke', 'node_contract.create', 'workflow.generate',
  'outcome_requirement.create', 'outcome.evaluate', 'outcome.waive'
  , 'assist_session.create', 'assist_turn.create', 'assist_session.transition', 'attachment.create'
  , 'context.rebuild', 'context.selection.create'
  , 'quality_review.create'
  , 'terminal.create', 'terminal.input', 'terminal.resize', 'terminal.signal', 'terminal.stop'
]);

export { parseCodexDeviceAuthLine, parseCodexDeviceAuthOutput } from './codex-device-auth.mjs';

export function errorEnvelope({ code, message, retryable = false, requestId, details = {} }) {
  return { error: { code, message, retryable, request_id: requestId, details } };
}

export function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}
