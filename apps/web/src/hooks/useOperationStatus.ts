import { useEffect, useRef, useState } from 'react';

/**
 * Operation statuses that no longer need a watcher.  Providers may return
 * either `canceled` or the API's canonical `cancelled`, so both spellings
 * are accepted at the shared boundary.
 */
export const OPERATION_TERMINAL_STATUSES = new Set([
  'completed', 'succeeded', 'success', 'failed', 'cancelled', 'canceled',
  'rejected', 'expired', 'interrupted', 'aborted', 'done', 'reconciled',
  'rolled_back'
]);

export type OperationStatusSnapshot = {
  id?: string;
  operation_id?: string;
  status: string;
  [key: string]: unknown;
};

export type UseOperationStatusOptions<T extends OperationStatusSnapshot> = {
  enabled?: boolean;
  /** Resource identifier used by the status endpoint when it differs from operation_id. */
  operationId?: string;
  intervalMs?: number;
  terminalStatuses?: ReadonlySet<string>;
  fetchStatus: (operationId: string, signal: AbortSignal) => Promise<T>;
  onUpdate?: (operation: T) => void;
  onTerminal?: (operation: T) => void;
  onError?: (error: unknown) => void;
};

export type WaitForOperationOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  terminalStatuses?: ReadonlySet<string>;
};

/** Imperative companion for mutations that must await an operation before continuing. */
export async function waitForOperation<T extends OperationStatusSnapshot>(
  initial: T,
  fetchStatus: (operationId: string, signal: AbortSignal) => Promise<T>,
  options: WaitForOperationOptions = {}
): Promise<T> {
  const intervalMs = options.intervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const terminalStatuses = options.terminalStatuses || OPERATION_TERMINAL_STATUSES;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  }
  const operationId = String(initial.operation_id || initial.id || '');
  if (!operationId) throw new Error('operation_id_missing');
  const started = Date.now();
  let current = initial;
  try {
    while (!terminalStatuses.has(String(current.status || ''))) {
      if (controller.signal.aborted) throw new DOMException('Operation wait aborted', 'AbortError');
      if (Date.now() - started >= timeoutMs) throw new Error('operation_wait_timeout');
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Operation wait aborted', 'AbortError')); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, intervalMs));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      if (controller.signal.aborted) throw new DOMException('Operation wait aborted', 'AbortError');
      current = await fetchStatus(operationId, controller.signal);
    }
    return current;
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Watch one generic operation with one in-flight request at a time.
 *
 * A recursive timeout is used instead of setInterval so slow requests cannot
 * overlap. The AbortController and disposed guard prevent an unmounted page
 * from receiving a late response, while retaining retries for transient API
 * failures. The caller owns the operation value; this hook only coordinates
 * fetching and callbacks.
 */
export function useOperationStatus<T extends OperationStatusSnapshot>(
  operation: T | null | undefined,
  options: UseOperationStatusOptions<T>
) {
  const {
    enabled = true,
    operationId: configuredOperationId,
    intervalMs = 1000,
    terminalStatuses = OPERATION_TERMINAL_STATUSES,
    fetchStatus,
    onUpdate,
    onTerminal,
    onError
  } = options;
  const callbacks = useRef({ fetchStatus, onUpdate, onTerminal, onError });
  callbacks.current = { fetchStatus, onUpdate, onTerminal, onError };
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const operationId = String(configuredOperationId || operation?.operation_id || operation?.id || '');

  useEffect(() => {
    if (!enabled || !operationId || terminalStatuses.has(String(operation?.status || ''))) {
      setPolling(false);
      return undefined;
    }
    const controller = new AbortController();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const schedule = () => {
      if (!disposed && !controller.signal.aborted) timer = setTimeout(() => void poll(), Math.max(0, intervalMs));
    };
    const poll = async () => {
      if (disposed || controller.signal.aborted || inFlight) return;
      inFlight = true;
      setPolling(true);
      try {
        const next = await callbacks.current.fetchStatus(operationId, controller.signal);
        if (disposed || controller.signal.aborted) return;
        setError(null);
        callbacks.current.onUpdate?.(next);
        if (terminalStatuses.has(String(next.status || ''))) {
          setPolling(false);
          callbacks.current.onTerminal?.(next);
          return;
        }
        schedule();
      } catch (failure) {
        if (disposed || controller.signal.aborted) return;
        setError(failure);
        callbacks.current.onError?.(failure);
        schedule();
      } finally {
        inFlight = false;
      }
    };

    void poll();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // Deliberately key the watcher by operation identity. A status update from
    // onUpdate must not tear down and immediately duplicate the current poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, operationId, configuredOperationId, terminalStatuses]);

  return { polling, error };
}
