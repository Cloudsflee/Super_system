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
  if (code === 'revision_conflict' || code === 'idempotency_conflict') return 409;
  if (code === 'not_found') return 404;
  if (code === 'broker_unavailable' || code === 'dependency_unavailable') return 503;
  if (code === 'forbidden') return 403;
  if (code === 'invalid_input' || code === 'idempotency_required' || code === 'invalid_job_spec') return 400;
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
