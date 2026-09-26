import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useOperationStatus, waitForOperation, type OperationStatusSnapshot } from '../hooks/useOperationStatus';

type Snapshot = OperationStatusSnapshot & { sequence: number };

function Probe({ fetchStatus }: { fetchStatus: (id: string, signal: AbortSignal) => Promise<Snapshot> }) {
  const [operation, setOperation] = useState<Snapshot>({ id: 'op_probe', status: 'running', sequence: 0 });
  const [updates, setUpdates] = useState(0);
  useOperationStatus(operation, {
    intervalMs: 5,
    fetchStatus,
    onUpdate: (next) => { setOperation(next); setUpdates((value) => value + 1); }
  });
  return <output data-testid="operation-state" data-status={operation.status} data-updates={updates} />;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('serializes operation polls and stops on the terminal response', async () => {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const fetchStatus = vi.fn(async (_id: string, _signal: AbortSignal) => {
    calls += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return { id: 'op_probe', status: calls >= 3 ? 'completed' : 'running', sequence: calls };
  });
  render(<Probe fetchStatus={fetchStatus} />);
  await waitFor(() => expect(screen.getByTestId('operation-state')).toHaveAttribute('data-status', 'completed'), { timeout: 500 });
  expect(peak).toBe(1);
  const completedCalls = fetchStatus.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fetchStatus).toHaveBeenCalledTimes(completedCalls);
});

it('aborts an in-flight request when the watcher unmounts', async () => {
  let signal: AbortSignal | undefined;
  const fetchStatus = vi.fn((_id: string, requestSignal: AbortSignal) => {
    signal = requestSignal;
    return new Promise<Snapshot>((_resolve, reject) => {
      requestSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  });
  const view = render(<Probe fetchStatus={fetchStatus} />);
  await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1));
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

it('shares terminal semantics with imperative operation waits', async () => {
  let calls = 0;
  const result = await waitForOperation({ operation_id: 'op_wait', status: 'queued' }, async (id) => ({
    operation_id: id,
    status: calls++ === 0 ? 'running' : 'succeeded'
  }), { intervalMs: 0 });
  expect(result.status).toBe('succeeded');
  expect(calls).toBe(2);
});
