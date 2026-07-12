import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistV3Event, Project, TerminalSession } from '../api/types';
import { AssistWorkbench } from '../features/assist/AssistWorkbench';
import { DiffReviewPanel } from '../features/assist/DiffReviewPanel';
import { TerminalPanel } from '../features/assist/TerminalPanel';
import { TypedEvent } from '../features/assist/TypedEvent';
import { useUi } from '../state/ui';
import { useAssistSurface } from '../components/assist/semantic-actions';

const terminalWrites: string[] = [];
vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 120; rows = 32; loadAddon() {} open() {} onData() {} attachCustomKeyEventHandler() {} write(value: string) { terminalWrites.push(value); } reset() { terminalWrites.length = 0; } dispose() {} } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

describe('Assist V3 workbench', () => {
  beforeEach(() => {
    useUi.getState().closeOverlay();
    useUi.setState({ assistOpen: true, assistSurface: 'docked', assistDockWidth: 760, proposalId: null });
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); terminalWrites.length = 0; });

  it('lists threads and creates an Agent turn with the selected profile', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
      if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
      if (url.endsWith('/codex/profiles')) return response([{ id: 'profile-1', name: 'Host', model: 'gpt-codex', reasoning: 'high', kind: 'host', status: 'validated', is_active: true }]);
      if (url.endsWith('/assist/v3/sessions/s1/turns')) return response({ id: 'turn-new', session_id: 's1', mode: 'agent', status: 'queued' }, 202);
      return response({});
    }));
    renderWithClient(<MemoryRouter><AssistWorkbench project={projectFixture()} /></MemoryRouter>);
    expect(await screen.findByText('Thread One')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }));
    fireEvent.change(await screen.findByRole('combobox', { name: '当前模型' }), { target: { value: 'gpt-codex-custom' } });
    fireEvent.click(screen.getByRole('button', { name: 'xhigh' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Assist 消息' }), { target: { value: 'Implement feature' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/sessions/s1/turns') && item.body?.mode === 'agent' && item.body?.profile_id === 'profile-1' && item.body?.model === 'gpt-codex-custom' && item.body?.reasoning === 'xhigh')).toBe(true));
    const turn = calls.find((item) => item.url.endsWith('/sessions/s1/turns'))?.body;
    expect(turn?.view_context).toMatchObject({ route: '/', surface: { fields: expect.any(Array) } });
  });

  it('saves a model and reasoning combination as a switchable Assist configuration', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
      if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
      if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
      if (url.endsWith('/codex/profiles')) return response([{ id: 'profile-1', name: 'Base', model: 'gpt-base', reasoning: 'high', provider: 'openai', kind: 'docker', status: 'validated', is_active: true }]);
      if (url.endsWith('/assist/v3/configurations')) return response({ id: 'profile-saved', name: body?.name, model: body?.model, reasoning: body?.reasoning, provider: 'openai', kind: 'docker', status: 'validated', is_active: false, assist_configuration: true }, 201);
      return response({});
    }));
    renderWithClient(<MemoryRouter><AssistWorkbench project={projectFixture()} /></MemoryRouter>);
    await screen.findByText('Thread One');
    fireEvent.change(await screen.findByRole('combobox', { name: '当前模型' }), { target: { value: 'gpt-saved' } });
    fireEvent.click(screen.getByRole('button', { name: 'low' }));
    fireEvent.click(screen.getByRole('button', { name: '保存当前 Assist 配置' }));
    fireEvent.change(screen.getByRole('textbox', { name: '配置名称' }), { target: { value: '快速简报' } });
    fireEvent.click(screen.getByRole('button', { name: '确认保存配置' }));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/assist/v3/configurations'))).toBe(true));
    expect(calls.find((item) => item.url.endsWith('/assist/v3/configurations'))?.body).toEqual({ base_profile_id: 'profile-1', name: '快速简报', model: 'gpt-saved', reasoning: 'low' });
  });

  it('previews a page edit and changes the registered field only after explicit apply', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const action = { id: 'action-1', session_id: 's1', turn_id: 'turn-1', name: 'fill_field', label: '填写核心目标', status: 'ready', risk: 'reversible' as const, args: { field_id: 'brief.goal', value: '交付可验证结果' } };
    const turn = { id: 'turn-1', session_id: 's1', project_id: 'p1', mode: 'ask' as const, prompt: '填写简报', output_text: '已准备草稿。', status: 'completed', profile_id: 'profile-1', model: 'gpt-codex', reasoning: 'high', attachment_ids: [], review_status: 'no_changes', actions: [action], created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
      if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
      if (url.endsWith('/assist/v3/sessions/s1')) return response({ ...sessionDetail(), turns: [turn] });
      if (url.endsWith('/codex/profiles')) return response([{ id: 'profile-1', name: 'Base', model: 'gpt-codex', reasoning: 'high', kind: 'docker', status: 'validated', is_active: true }]);
      if (url.endsWith('/actions/action-1/result')) return response({ ...action, status: 'completed', result: body?.result });
      return response({});
    }));
    renderWithClient(<MemoryRouter><SurfaceFixture /><AssistWorkbench project={projectFixture()} /></MemoryRouter>);
    await screen.findByText('填写核心目标');
    expect(screen.getByRole('textbox', { name: '简报目标测试字段' })).toHaveValue('原始内容');
    fireEvent.click(screen.getByRole('button', { name: '应用到页面' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '简报目标测试字段' })).toHaveValue('交付可验证结果'));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/actions/action-1/result') && item.body?.ok === true)).toBe(true));
  });

  it('resizes the docked surface from its divider and supports keyboard adjustment', () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([])));
    renderWithClient(<MemoryRouter><AssistWorkbench project={projectFixture()} /></MemoryRouter>);
    const divider = screen.getByRole('separator', { name: '调整 Assist 宽度' });
    fireEvent.pointerDown(divider, { button: 0, clientX: 700 });
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window);
    expect(useUi.getState().assistDockWidth).toBe(860);
    expect(divider).toHaveAttribute('aria-valuenow', '860');
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(useUi.getState().assistDockWidth).toBe(836);
    fireEvent.doubleClick(divider);
    expect(useUi.getState().assistDockWidth).toBe(760);
  });

  it('explains that a project is required instead of silently failing thread creation', () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([])));
    renderWithClient(<MemoryRouter><AssistWorkbench /></MemoryRouter>);
    expect(screen.getByText('先创建项目')).toBeInTheDocument();
    expect(screen.getByText('Assist 线程必须归属于一个项目。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建线程' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(useUi.getState().assistOpen).toBe(false);
  });

  it('keeps Ask and Plan available while disabling write modes for a draft project', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
      if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
      if (url.endsWith('/codex/profiles')) return response([{ id: 'profile-1', name: 'Docker', model: 'gpt-codex', reasoning: 'high', kind: 'docker', status: 'validated', is_active: true }]);
      return response({});
    }));
    renderWithClient(<MemoryRouter><AssistWorkbench project={{ ...projectFixture(), status: 'draft', managed_workspace_state: 'empty' }} /></MemoryRouter>);
    expect(await screen.findByText('Thread One')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Ask' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Plan' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'CLI' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('完成项目简报并激活项目后可用');
  });

  it('opens runtime approval events in the unified prompt store', () => {
    const event = { id: 2, sequence: 2, session_id: 's1', turn_id: 't1', type: 'approval', data: { approval_id: 'rap-1', approval_type: 'command', command: 'pnpm test' }, created_at: new Date().toISOString() } as AssistV3Event;
    render(<TypedEvent event={event} />);
    fireEvent.click(screen.getByRole('button', { name: '立即审查' }));
    expect(useUi.getState().proposalId).toBe('rap-1');
  });

  it('renders only the official reasoning summary field', () => {
    const event = { id: 3, sequence: 3, session_id: 's1', turn_id: 't1', type: 'reasoning_summary', data: { summary: 'Public concise summary', internal_reasoning: 'PRIVATE_REASONING_SENTINEL', reasoning: 'PRIVATE_REASONING_SENTINEL' }, created_at: new Date().toISOString() } as AssistV3Event;
    const view = render(<TypedEvent event={event} />);
    expect(screen.getByText('Public concise summary')).toBeInTheDocument();
    expect(view.container.textContent).not.toContain('PRIVATE_REASONING_SENTINEL');
  });

  it('renders actionable Assist runtime failures', () => {
    const event = { id: 4, sequence: 4, session_id: 's1', turn_id: 't1', type: 'failed', data: { error: 'assist_workspace_unavailable' }, created_at: new Date().toISOString() } as AssistV3Event;
    render(<TypedEvent event={event} />);
    expect(screen.getByText('Assist 工作目录不可用，请重新进入项目后重试。')).toBeInTheDocument();
  });

  it('marks files viewed, comments a line, and applies a fresh Agent review', async () => {
    let viewed = false; const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, body });
      if (url.endsWith('/review/viewed')) { viewed = true; return response({ viewed: true }); }
      if (url.endsWith('/review/comments')) return response({ id: 'c1', action: 'line_comment', patch: body, created_at: new Date().toISOString() }, 201);
      if (url.endsWith('/review/apply')) return response({ turn_id: 't1', worktree: { status: 'applied' }, target_hash: 'hash-1' });
      if (url.endsWith('/review')) return response(reviewFixture(viewed));
      return response({});
    }));
    renderWithClient(<DiffReviewPanel target={{ kind: 'turn', id: 't1' }} onBack={vi.fn()} />);
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark viewed' }));
    await screen.findByRole('button', { name: 'Viewed' });
    fireEvent.click(screen.getByRole('row', { name: /const answer = 42/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '行评论' }), { target: { value: 'Please add a test' } });
    fireEvent.click(screen.getByRole('button', { name: '评论' }));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/review/comments') && item.body?.line === 1)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '安全应用' }));
    await waitFor(() => expect(calls.some((item) => item.url.endsWith('/review/apply') && item.body?.target_hash === 'hash-1')).toBe(true));
  });

  it('connects xterm to the Terminal WebSocket, sends Ctrl-C, and stops', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...terminalFixture(), status: 'stopped' })));
    const changed = vi.fn();
    render(<TerminalPanel session={terminalFixture()} onSession={changed} onBack={vi.fn()} onReview={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(FakeWebSocket.last).toBeTruthy());
    FakeWebSocket.last?.emit({ type: 'output', data: 'hello', replay: true });
    await waitFor(() => expect(terminalWrites).toEqual(['hello']));
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl-C' }));
    expect(FakeWebSocket.last?.sent.some((item) => JSON.parse(item).signal === 'SIGINT')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '停止 Session' }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' })));
  });
});

function renderWithClient(value: ReactNode) { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}>{value}</QueryClientProvider>); }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function sessionSummary() { return { id: 's1', version: 3, project_id: 'p1', scope_type: 'project', scope_id: 'p1', title: 'Thread One', status: 'idle', lifecycle: 'active', pinned: true, turn_count: 0, last_turn: null, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }; }
function sessionDetail() { return { ...sessionSummary(), turns: [], attachments: [], last_event_id: 0 }; }
function projectFixture(): Project { return { id: 'p1', title: 'Project One', goal: 'Test', status: 'active', current_workspace_id: 'w1', onboarding_state: 'confirmed', managed_workspace_state: 'ready' }; }
function reviewFixture(viewed: boolean) { return { turn_id: 't1', status: 'ready', worktree: { id: 'w1', project_id: 'p1', kind: 'assist_turn', status: 'review_ready' }, changed_files: [{ path: 'src/a.ts', status: 'modified', code: ' M' }], diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const answer = 41;\n+const answer = 42;\n', target_hash: 'hash-1', base_commit: 'base', head_commit: 'head', viewed_files: viewed ? { 'src/a.ts': new Date().toISOString() } : {}, comments: [] }; }
function terminalFixture(): TerminalSession { return { id: 'tty1', project_id: 'p1', worktree_id: 'w1', profile_id: 'profile-1', runtime: 'host', status: 'ready', cols: 120, rows: 32, output_preview: '', output_truncated: false, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() }; }
function SurfaceFixture() {
  const [value, setValue] = useState('原始内容');
  useAssistSurface({ id: 'brief-fixture', fields: { 'brief.goal': { label: '核心目标', elementId: 'brief-fixture-goal', set: (next) => setValue(String(next ?? '')) } } });
  return <input id="brief-fixture-goal" aria-label="简报目标测试字段" value={value} onChange={(event) => setValue(event.target.value)} />;
}

class FakeEventSource { onopen?: () => void; onerror?: () => void; constructor(_url: string) { setTimeout(() => this.onopen?.(), 0); } addEventListener() {} close() {} }
class FakeWebSocket {
  static OPEN = 1; static last: FakeWebSocket | null = null; readyState = 1; sent: string[] = []; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: (event: { code: number }) => void; onerror?: () => void;
  constructor(public url: string) { FakeWebSocket.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(value: string) { this.sent.push(value); } close() { this.onclose?.({ code: 1000 }); }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
