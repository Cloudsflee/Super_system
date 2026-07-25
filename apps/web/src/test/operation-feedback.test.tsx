import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, describeOperation, json } from '../api/client';
import { OperationDiagnosticsButton, OperationFeedbackProvider } from '../operations/OperationFeedback';
import {
  beginOperation,
  clearOperations,
  completeOperation,
  diagnosticJson,
  failOperation,
  operationRecords,
  registerOperationRetry
} from '../operations/operation-store';

describe('operation feedback and diagnostics', () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearOperations();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('records a write immediately and completes it with the response request id', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      expect((init?.headers as Headers).get('x-aiws-request-id')).toMatch(/^web_/);
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    });
    const request = api('/unit/write?secret=ignored', json('POST', { api_key: 'sk-never-store-this' }, '保存单元配置'));
    expect(operationRecords()[0]).toMatchObject({
      name: '保存单元配置',
      status: 'running',
      method: 'POST',
      path: '/unit/write'
    });
    resolveFetch(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-aiws-request-id': 'req_server_unit' }
      })
    );
    await request;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(operationRecords()[0]).toMatchObject({ status: 'succeeded', requestId: 'req_server_unit' });
    expect(sessionStorage.getItem('aiws-operation-diagnostics-v1')).not.toContain('sk-never-store-this');
  });

  it('keeps foreground errors visible and exposes safe retry in diagnostics', async () => {
    render(
      <OperationFeedbackProvider>
        <OperationDiagnosticsButton />
      </OperationFeedbackProvider>
    );
    const id = beginOperation({
      descriptor: describeOperation('保存失败示例'),
      method: 'POST',
      path: '/unit/failure?token=hidden',
      requestId: 'req_unit_failure'
    });
    failOperation(id, {
      code: 'unit_failed',
      status: 503,
      requestId: 'req_unit_failure',
      retryable: true,
      message: 'Provider token=secret-value 不可用',
      action: '检查配置后重试。'
    });
    const retry = vi.fn(async () => undefined);
    registerOperationRetry(id, retry);
    expect((await screen.findAllByText('保存失败示例')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText('操作与诊断'));
    fireEvent.click(screen.getAllByText('保存失败示例').at(-1)!);
    expect(screen.getByText('unit_failed')).toBeInTheDocument();
    expect(screen.queryByText(/secret-value/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('returns structured timeout errors and warns that writes may still be running', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const request = api('/unit/slow', json('POST', {}, describeOperation('执行慢操作', { timeoutMs: 20 }))).catch(
      (value) => value as ApiError
    );
    await vi.advanceTimersByTimeAsync(25);
    const error = (await request) as ApiError;
    expect(error).toMatchObject({ code: 'request_timeout', timeout: true, method: 'POST', path: '/unit/slow' });
    expect(error.action).toContain('服务端可能仍在处理');
    expect(operationRecords()[0]).toMatchObject({ status: 'failed', timeout: true });
  });

  it('caps persisted diagnostics at 100 sanitized records', () => {
    for (let index = 0; index < 105; index++) {
      const id = beginOperation({
        descriptor: describeOperation(`操作 ${index}`),
        method: 'POST',
        path: `/items/${index}?api_key=sk-query-secret`
      });
      completeOperation(id);
    }
    expect(operationRecords()).toHaveLength(100);
    const stored = JSON.parse(sessionStorage.getItem('aiws-operation-diagnostics-v1') || '[]');
    expect(stored).toHaveLength(100);
    const output = diagnosticJson();
    expect(output).not.toContain('api_key=');
    expect(output).not.toContain('sk-query-secret');
  });

  it('does not report caller AbortError as a system failure', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const request = api('/unit/read', { signal: controller.signal });
    act(() => controller.abort());
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => expect(operationRecords()).toHaveLength(0));
  });
});
