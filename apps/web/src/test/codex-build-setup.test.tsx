import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSetup } from '../features/setup/CodexSetup';
import type { CodexBuildOperation } from '../api/types';
import { clearOperations } from '../operations/operation-store';

describe('Codex async build setup', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    sessionStorage.clear(); clearOperations();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('shows live phases and logs, reconnects, cancels, copies diagnostics, and retries', async () => {
    let buildStarts = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith('/codex/docker/builds/active')) return response({ operation: null });
      if (url.endsWith('/codex/docker/build') && init?.method === 'POST') {
        buildStarts += 1; const operation = buildSnapshot(`build-${buildStarts}`);
        return response({ operation_id: operation.operation_id, events_url: `/codex/docker/builds/${operation.operation_id}/events`, cancel_url: `/codex/docker/builds/${operation.operation_id}/cancel`, operation }, 202);
      }
      if (/\/codex\/docker\/builds\/[^/]+\/cancel$/.test(url)) return response({ status: 'running' }, 202);
      return response({});
    }));
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<CodexSetup state={codexState()} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: '检测并构建' }));

    expect(await screen.findByLabelText('Docker Build 最新日志')).toBeInTheDocument();
    const source = await waitForSource();
    source.open();
    source.emit('phase', { key: 'building', label: '构建镜像', index: 3, total: 5, message: 'Docker Build 正在运行' });
    source.emit('log', { at: new Date().toISOString(), stream: 'stdout', text: 'step 4 token=***MASKED***' });
    expect(await screen.findByText('Docker Build 正在运行')).toBeInTheDocument();
    expect(screen.getByLabelText('Docker Build 最新日志')).toHaveTextContent('token=***MASKED***');
    source.fail();
    expect(await screen.findByText('事件流重连中')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制诊断' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
    expect(String(vi.mocked(navigator.clipboard.writeText).mock.calls[0][0])).not.toContain('secret');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/build-1/cancel') && item.init?.method === 'POST')).toBe(true));
    source.emit('cancelled', { ...buildSnapshot('build-1'), status: 'cancelled', completed_at: new Date().toISOString(), error_code: 'docker_build_cancelled', message: 'Codex 镜像构建已取消', action: '可以重新开始构建。', retryable: true });
    expect((await screen.findAllByText('Codex 镜像构建已取消')).length).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(buildStarts).toBe(2));
  });

  it('reattaches to an active build after refresh and completes it', async () => {
    const active = { ...buildSnapshot('restored-build'), phase: { key: 'building', label: '构建镜像', index: 3, total: 5 }, logs: [{ at: new Date().toISOString(), stream: 'stdout', text: 'restored log' }] };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/codex/docker/builds/active') ? response({ operation: active }) : response({})));
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<CodexSetup state={codexState()} onChange={onChange} />);

    expect(await screen.findByLabelText('Docker Build 最新日志')).toHaveTextContent('restored log');
    const source = await waitForSource();
    expect(source.url).toContain('/restored-build/events');
    source.emit('completed', { ...active, status: 'completed', phase: { key: 'completed', label: '完成', index: 5, total: 5 }, completed_at: new Date().toISOString(), message: 'Codex 隔离镜像已构建并验证' });
    expect(await screen.findByText('Codex 隔离镜像已构建并验证')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledOnce();
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(event: Event) => void>>();
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListener) { const rows = this.listeners.get(type) || []; rows.push(listener); this.listeners.set(type, rows); }
  close() { /* Test transport is memory-only. */ }
  open() { this.onopen?.(); }
  fail() { this.onerror?.(); }
  emit(type: string, data: unknown) { const event = new MessageEvent(type, { data: JSON.stringify(data) }); for (const listener of this.listeners.get(type) || []) listener(event); }
}

function buildSnapshot(id: string): CodexBuildOperation {
  return { operation_id: id, image: 'aiws-codex-runner:test', status: 'running', phase: { key: 'runtime_check', label: '运行时检查', index: 1, total: 5 }, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null, elapsed_ms: 0, message: '正在检查 Docker', retryable: false, latest_log: '', logs: [] };
}
function codexState() { return { ready: false, status: 'runtime_required', detail: '等待 Docker', checks: { docker_ready: false, authenticated: false, profile_valid: false, probe_ok: false } }; }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
async function waitForSource() { await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0)); return FakeEventSource.instances.at(-1)!; }
