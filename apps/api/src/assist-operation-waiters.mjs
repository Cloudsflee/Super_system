import { HttpError } from './http.mjs';
import { readState } from './state.mjs';
import { publicOperation, toolSuccess } from './assist-operation-metadata.mjs';

const approvalWaiters = new Map();
const operationWaiters = new Map();

export function settleOperationApproval(operationId, approved) {
  for (const waiter of [...(approvalWaiters.get(operationId) || [])])
    approved ? waiter.resolve(true) : waiter.reject(new HttpError(409, { error: 'assist_operation_denied' }));
}

export function settleOperationResult(operationId, operation) {
  for (const waiter of [...(operationWaiters.get(operationId) || [])])
    settleResultState(operation, waiter.resolve, waiter.reject);
}

export function waitForOperationApproval(operationId, signal) {
  return registerWaiter(approvalWaiters, operationId, signal, async (resolve, reject) => {
    const operation = await currentOperation(operationId);
    if (operation.status === 'pending_confirmation') return;
    if (['pending', 'claimed', 'committed'].includes(operation.status)) resolve(true);
    else reject(operationError(operation, 'assist_operation_not_awaiting_confirmation'));
  });
}

export function waitForOperationResult(operationId, signal, expire, timeoutMs) {
  return registerWaiter(
    operationWaiters,
    operationId,
    signal,
    async (resolve, reject, waiter) => {
      const operation = await currentOperation(operationId);
      if (settleResultState(operation, resolve, reject)) return;
      const timeout = async () => {
        try {
          const latest = await currentOperation(operationId);
          if (settleResultState(latest, resolve, reject)) return;
          const extension = latest.status === 'claimed' ? Date.parse(latest.claim_expires_at) - Date.now() : 0;
          if (extension > 0) {
            waiter.timeout = setTimeout(timeout, extension);
            return;
          }
          await expire(operationId, 'browser_claim_timeout');
          reject(new HttpError(504, { error: 'assist_operation_timeout' }));
        } catch (error) {
          reject(error);
        }
      };
      waiter.timeout = setTimeout(timeout, timeoutMs);
    },
    () => {
      void expire(operationId, 'turn_aborted');
    }
  );
}

function registerWaiter(registry, operationId, signal, reconcile, onAbort) {
  return new Promise((resolve, reject) => {
    const waiters = registry.get(operationId) || new Set();
    const waiter = {
      timeout: null,
      resolve: (value) => finish(null, value),
      reject: (error) => finish(error)
    };
    const cleanup = () => {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      signal?.removeEventListener('abort', abort);
      waiters.delete(waiter);
      if (!waiters.size) registry.delete(operationId);
    };
    const finish = (error, value) => {
      cleanup();
      error ? reject(error) : resolve(value);
    };
    const abort = () => {
      onAbort?.();
      finish(new HttpError(409, { error: 'assist_operation_cancelled' }));
    };
    waiters.add(waiter);
    registry.set(operationId, waiters);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else void reconcile(waiter.resolve, waiter.reject, waiter).catch(waiter.reject);
  });
}

async function currentOperation(operationId) {
  const state = await readState(),
    operation = state.assist_operations.find((item) => item.id === operationId);
  if (!operation) throw new HttpError(404, { error: 'assist_operation_not_found' });
  return operation;
}

function settleResultState(operation, resolve, reject) {
  if (['committed', 'undone'].includes(operation.status)) {
    resolve(toolSuccess(operation));
    return true;
  }
  if (operation.status === 'conflicted') {
    reject(new HttpError(409, { error: 'assist_operation_undo_conflict', operation: publicOperation(operation) }));
    return true;
  }
  if (operation.status === 'failed') {
    reject(operationError(operation, 'assist_operation_failed'));
    return true;
  }
  return false;
}

function operationError(operation, fallback) {
  const code =
    operation.failure_code === 'user_denied' ? 'assist_operation_denied' : operation.failure_code || fallback;
  return new HttpError(409, { error: code, status: operation.status });
}
