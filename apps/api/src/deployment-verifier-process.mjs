import { createHash } from 'node:crypto';

import { HttpError } from './http.mjs';

export async function runRequiredProcess(processRunner, invocation, options, errorCode) {
  try {
    return await processRunner(invocation, options);
  } catch {
    throw unavailableError(errorCode);
  }
}

export function unavailableError(errorCode) {
  const error = new HttpError(503, { error: errorCode, retryable: true });
  error.retryable = true;
  return error;
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
