export const TASK_EXECUTION_STATUSES = Object.freeze([
  'pending',
  'ready',
  'queued',
  'running',
  'verifying',
  'awaiting_human',
  'completed',
  'failed',
  'cancelled',
  'superseded'
]);

export const TERMINAL_TASK_EXECUTION_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'superseded']);
export const ACTIVE_WORKFLOW_EXECUTION_STATUSES = Object.freeze(['running', 'paused']);
