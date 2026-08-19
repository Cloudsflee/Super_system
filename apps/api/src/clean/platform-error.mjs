export class PlatformError extends Error {
  constructor(code, message, details = {}, status = 409) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.status = status;
    this.retryable = code === 'revision_conflict' || code === 'idempotency_conflict';
    this.details = details;
  }
}
