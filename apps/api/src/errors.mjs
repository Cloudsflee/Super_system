export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.status = options.status ?? statusForCode(code);
    this.details = options.details ?? {};
  }
}

export function statusForCode(code) {
  if (code === 'revision_conflict' || code === 'idempotency_conflict' || code === 'expected_revision_required') return code === 'expected_revision_required' ? 400 : 409;
  if (code === 'not_found') return 404;
  if (code === 'broker_unavailable' || code === 'dependency_unavailable') return 503;
  if (code === 'forbidden') return 403;
  if (code === 'invalid_input' || code === 'idempotency_required' || code === 'invalid_job_spec' || code === 'workflow_contract_invalid' || code === 'workflow_depth_invalid' || code === 'workflow_dependency_scope_invalid' || code === 'workflow_graph_cycle' || code === 'workflow_duplicate_output' || code === 'workflow_output_path_conflict') return code.startsWith('workflow_') ? 422 : 400;
  return 500;
}

export function asAppError(error) {
  if (error instanceof AppError) return error;
  return new AppError('internal_error', error?.message || 'Internal error', {
    status: 500,
    details: {}
  });
}

export function assert(condition, code, message, options = {}) {
  if (!condition) throw new AppError(code, message, options);
}
