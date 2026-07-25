import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistOperation, AssistV3Event, Project, TerminalSession } from '../api/types';
import { AssistCenter } from '../features/assist/AssistCenter';
import { ContextMenuProvider } from '../components/common/ContextMenu';
import { DiffReviewPanel } from '../features/assist/DiffReviewPanel';
import { TerminalPanel } from '../features/assist/TerminalPanel';
import { TypedEvent } from '../features/assist/TypedEvent';
import { useUi } from '../state/ui';
import { FakeEventSource, FakeWebSocket } from './fake-transports';
const terminalWrites: string[] = [];
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 32;
    loadAddon() {}
    open() {}
    onData() {}
    attachCustomKeyEventHandler() {}
    write(value: string) {
      terminalWrites.push(value);
    }
    reset() {
      terminalWrites.length = 0;
    }
    dispose() {}
  }
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  }
}));
describe('Assist V3 workbench', () => {
  beforeEach(() => {
    useUi.getState().closeOverlay();
    useUi.setState({ assistOpen: true, assistSurface: 'docked', assistDockWidth: 760, proposalId: null });
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    terminalWrites.length = 0;
  });
  it('uses visible native model/reasoning controls and sends one-shot Plan collaboration mode', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
        if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
        if (url.endsWith('/codex/profiles'))
          return response([
            {
              id: 'profile-1',
              name: 'Host',
              model: 'gpt-codex',
              reasoning: 'high',
              kind: 'host',
              status: 'validated',
              is_active: true
            }
          ]);
        if (url.includes('/assist/v3/models?')) return response(modelCatalog());
        if (url.includes('/assist/v3/configurations')) return response([]);
        if (url.endsWith('/assist/v3/sessions/s1/turns'))
          return response(
            { id: 'turn-new', session_id: 's1', mode: 'plan', collaboration_mode: 'plan', status: 'queued' },
            202
          );
        return response({});
      })
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter project={projectFixture()} scopeType="project" scopeId="p1" commandDock={false} />
      </MemoryRouter>
    );
    expect(await screen.findByText('Thread One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'CLI' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'gpt-codex' }));
    expect(screen.getAllByText('服务商提供的模型')).toHaveLength(2);
    expect(screen.queryByText('gpt-codex model')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /gpt-codex-custom/ }));
    fireEvent.click(screen.getByRole('button', { name: '推理强度' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /最高/ }));
    const plan = screen.getByRole('button', { name: '规划' });
    fireEvent.click(plan);
    expect(plan).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: '智能助手消息' }), { target: { value: 'Implement feature' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(
        calls.some(
          (item) =>
            item.url.endsWith('/sessions/s1/turns') &&
            item.body?.collaboration_mode === 'plan' &&
            !('mode' in (item.body || {})) &&
            item.body?.profile_id === 'profile-1' &&
            item.body?.model === 'gpt-codex-custom' &&
            item.body?.reasoning === 'xhigh'
        )
      ).toBe(true)
    );
    expect(plan).toHaveAttribute('aria-pressed', 'false');
    const turn = calls.find((item) => item.url.endsWith('/sessions/s1/turns'))?.body;
    expect(turn?.view_context).toMatchObject({ route: '/', surface: { fields: expect.any(Array) } });
  });
  it('saves a model and reasoning combination as a switchable Assist configuration', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input),
          body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
        if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
        if (url.endsWith('/codex/profiles'))
          return response([
            {
              id: 'profile-1',
              name: 'Base',
              model: 'gpt-base',
              reasoning: 'high',
              provider: 'openai',
              kind: 'docker',
              status: 'validated',
              is_active: true
            }
          ]);
        if (url.includes('/assist/v3/models?')) return response(modelCatalog('gpt-base'));
        if (url.endsWith('/assist/v3/configurations') && init?.method === 'POST')
          return response(
            {
              id: 'configuration-saved',
              base_profile_id: 'profile-1',
              name: body?.name,
              model: body?.model,
              reasoning: body?.reasoning
            },
            201
          );
        if (url.includes('/assist/v3/configurations')) return response([]);
        return response({});
      })
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter project={projectFixture()} scopeType="project" scopeId="p1" commandDock={false} />
      </MemoryRouter>
    );
    await screen.findByText('Thread One');
    fireEvent.click(await screen.findByRole('button', { name: 'gpt-base' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /gpt-saved/ }));
    fireEvent.click(screen.getByRole('button', { name: '推理强度' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^低 / }));
    fireEvent.click(screen.getByRole('button', { name: 'gpt-saved' }));
    fireEvent.click(screen.getByRole('button', { name: '保存当前配置' }));
    fireEvent.change(screen.getByRole('textbox', { name: '配置名称' }), { target: { value: '快速简报' } });
    fireEvent.click(screen.getByRole('button', { name: '确认保存配置' }));
    await waitFor(() =>
      expect(
        calls.some((item) => item.url.endsWith('/assist/v3/configurations') && item.body?.name === '快速简报')
      ).toBe(true)
    );
    expect(calls.find((item) => item.url.endsWith('/assist/v3/configurations') && item.body)?.body).toEqual({
      base_profile_id: 'profile-1',
      name: '快速简报',
      model: 'gpt-saved',
      reasoning: 'low'
    });
  });
  it('renders a committed semantic operation and requests compensating Undo', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const operation = {
      id: 'operation-1',
      session_id: 's1',
      turn_id: 'turn-1',
      tool: 'aiws_page.set_field',
      target_id: 'brief.goal',
      route: '/',
      surface_revision: 'r1',
      status: 'committed',
      risk: 'low',
      revision: 2,
      forced: false,
      before_value: '原始内容',
      after_value: '交付可验证结果',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
    const turn = {
      id: 'turn-1',
      session_id: 's1',
      project_id: 'p1',
      mode: 'default' as const,
      collaboration_mode: 'default' as const,
      prompt: '填写简报',
      output_text: '字段已通过语义工具提交。',
      status: 'completed',
      profile_id: 'profile-1',
      model: 'gpt-codex',
      reasoning: 'high',
      attachment_ids: [],
      review_status: 'not_applicable',
      operations: [operation],
      user_inputs: [],
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input),
          body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
        if (url.endsWith('/assist/v3/sessions/s1')) return response({ ...sessionDetail(), turns: [turn] });
        if (url.endsWith('/codex/profiles'))
          return response([
            {
              id: 'profile-1',
              name: 'Base',
              model: 'gpt-codex',
              reasoning: 'high',
              kind: 'docker',
              status: 'validated',
              is_active: true
            }
          ]);
        if (url.endsWith('/operations/operation-1/undo'))
          return response({ id: 'inverse-1', inverse_of: 'operation-1', status: 'pending' }, 202);
        return response({});
      })
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter project={projectFixture()} scopeType="project" scopeId="p1" commandDock={false} />
      </MemoryRouter>
    );
    expect(await screen.findByText('已更新页面字段')).toBeInTheDocument();
    expect(screen.queryByText('aiws_page.set_field')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '撤销' }));
    await waitFor(() =>
      expect(
        calls.some((item) => item.url.endsWith('/operations/operation-1/undo') && item.body?.force === false)
      ).toBe(true)
    );
  });

  it('requires a second confirmation and force-undoes a conflict through its original operation', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const inverse = operationFixture({
      id: 'inverse-1',
      status: 'conflicted',
      inverse_of: 'operation-original',
      conflict: { before: 'before', after: 'after', current: 'changed elsewhere' }
    });
    const turn = {
      id: 'turn-1',
      session_id: 's1',
      project_id: 'p1',
      mode: 'default' as const,
      collaboration_mode: 'default' as const,
      prompt: '撤回字段',
      output_text: '',
      status: 'completed',
      profile_id: 'profile-1',
      model: 'gpt-codex',
      reasoning: 'high',
      attachment_ids: [],
      review_status: 'not_applicable',
      operations: [inverse],
      user_inputs: [],
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input),
          body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
        if (url.endsWith('/assist/v3/sessions/s1')) return response({ ...sessionDetail(), turns: [turn] });
        if (url.endsWith('/codex/profiles'))
          return response([
            {
              id: 'profile-1',
              name: 'Base',
              model: 'gpt-codex',
              reasoning: 'high',
              kind: 'docker',
              status: 'validated',
              is_active: true
            }
          ]);
        if (url.includes('/assist/v3/models?')) return response(modelCatalog());
        if (url.includes('/assist/v3/configurations')) return response([]);
        if (url.includes('/assist/v3/operations?')) return response([inverse]);
        if (url.endsWith('/operations/operation-original/undo'))
          return response({ ...inverse, status: 'pending', forced: true }, 202);
        return response({ goal: null });
      })
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter project={projectFixture()} scopeType="project" scopeId="p1" commandDock={false} />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: '强制撤回' }));
    expect(screen.getByRole('alert')).toHaveTextContent('强制撤回会覆盖它');
    expect(calls.some((item) => item.url.endsWith('/operations/operation-original/undo'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认强制撤回' }));
    await waitFor(() =>
      expect(
        calls.some((item) => item.url.endsWith('/operations/operation-original/undo') && item.body?.force === true)
      ).toBe(true)
    );
    expect(calls.some((item) => item.url.endsWith('/operations/inverse-1/undo'))).toBe(false);
  });

  it('does not reclaim a committed operation from replayed historical SSE', async () => {
    const calls: string[] = [],
      operation = operationFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/sessions?')) return response([sessionSummary()]);
        if (url.endsWith('/sessions/s1')) return response(sessionDetail());
        if (url.endsWith('/codex/profiles'))
          return response([
            {
              id: 'profile-1',
              name: 'Base',
              model: 'gpt-codex',
              reasoning: 'high',
              kind: 'docker',
              status: 'validated',
              is_active: true
            }
          ]);
        if (url.includes('/operations?')) return response([operation]);
        return response([]);
      })
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter project={projectFixture()} scopeType="project" scopeId="p1" commandDock={false} />
      </MemoryRouter>
    );
    await screen.findByText('Thread One');
    await waitFor(() => expect(calls.some((item) => item.includes('/operations?'))).toBe(true));
    FakeEventSource.last?.emit('operation', {
      id: 1,
      sequence: 1,
      session_id: 's1',
      turn_id: 'turn-1',
      type: 'operation',
      data: { operation_id: operation.id, claimable: true },
      created_at: new Date(0).toISOString()
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((item) => item.endsWith(`/operations/${operation.id}/claim`))).toBe(false);
  });

  it('resizes the docked surface from its divider and supports keyboard adjustment', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response([]))
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter project={projectFixture()} scopeType="project" scopeId="p1" commandDock={false} />
      </MemoryRouter>
    );
    const divider = screen.getByRole('separator', { name: '调整智能助手宽度' });
    fireEvent.pointerDown(divider, { button: 0, clientX: 700 });
    fireEvent.pointerMove(window, { clientX: 800 });
    fireEvent.pointerUp(window);
    expect(useUi.getState().assistDockWidth).toBe(580);
    expect(divider).toHaveAttribute('aria-valuenow', '580');
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(useUi.getState().assistDockWidth).toBe(556);
    fireEvent.doubleClick(divider);
    expect(useUi.getState().assistDockWidth).toBe(520);
    expect(document.documentElement.style.getPropertyValue('--assist-active-dock-width')).toBe('520px');
  });

  it('combines surface choices into one layout menu and keeps minimize and close visible', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response([]))
    );
    const view = renderWithClient(
        <MemoryRouter>
          <AssistCenter project={projectFixture()} scopeType="project" scopeId="p1" commandDock={false} />
        </MemoryRouter>
      ),
      header = view.container.querySelector('.assist-workbench-head')!;
    expect(header.querySelector('.lucide-bot')).toBeNull();
    expect(header).not.toHaveTextContent('live');
    expect(screen.queryByRole('button', { name: '停靠智能助手' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '最小化智能助手' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭智能助手' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '智能助手布局' }));
    const menu = screen.getByRole('menu', { name: '智能助手布局' });
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(within(menu).getByRole('menuitemradio', { name: '停靠' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '浮动' }));
    expect(useUi.getState().assistSurface).toBe('floating');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('stays quiet while connected and shows a notice only during event-stream reconnection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
        if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
        if (url.endsWith('/codex/profiles')) return response([]);
        return response([]);
      })
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter project={projectFixture()} scopeType="project" scopeId="p1" commandDock={false} />
      </MemoryRouter>
    );
    await screen.findByText('Thread One');
    await waitFor(() => expect(FakeEventSource.last).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('正在重新连接')).not.toBeInTheDocument();
    FakeEventSource.last?.onerror?.();
    expect(await screen.findByText('正在重新连接')).toBeInTheDocument();
    FakeEventSource.last?.onopen?.();
    await waitFor(() => expect(screen.queryByText('正在重新连接')).not.toBeInTheDocument());
  });

  it('explains that a project is required instead of silently failing thread creation', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response([]))
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter commandDock={false} />
      </MemoryRouter>
    );
    expect(screen.getByText('先创建项目')).toBeInTheDocument();
    expect(screen.getByText('智能助手线程必须归属于一个项目。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建线程' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(useUi.getState().assistOpen).toBe(false);
  });

  it('keeps normal chat and one-shot Plan available while making draft code access read-only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/assist/v3/sessions?')) return response([sessionSummary()]);
        if (url.endsWith('/assist/v3/sessions/s1')) return response(sessionDetail());
        if (url.endsWith('/codex/profiles'))
          return response([
            {
              id: 'profile-1',
              name: 'Docker',
              model: 'gpt-codex',
              reasoning: 'high',
              kind: 'docker',
              status: 'validated',
              is_active: true
            }
          ]);
        return response({});
      })
    );
    renderWithClient(
      <MemoryRouter>
        <AssistCenter
          project={{ ...projectFixture(), status: 'draft', managed_workspace_state: 'empty' }}
          scopeType="project"
          scopeId="p1"
          commandDock={false}
        />
      </MemoryRouter>
    );
    expect(await screen.findByText('Thread One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '规划' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'CLI' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('代码工作区只读');
  });

  it('opens runtime approval events in the unified prompt store', () => {
    const event = {
      id: 2,
      sequence: 2,
      session_id: 's1',
      turn_id: 't1',
      type: 'approval',
      data: { approval_id: 'rap-1', approval_type: 'command', command: 'pnpm test' },
      created_at: new Date().toISOString()
    } as AssistV3Event;
    render(<TypedEvent event={event} />);
    fireEvent.click(screen.getByRole('button', { name: '立即审查' }));
    expect(useUi.getState().proposalId).toBe('rap-1');
  });

  it('renders only the official reasoning summary field', () => {
    const event = {
      id: 3,
      sequence: 3,
      session_id: 's1',
      turn_id: 't1',
      type: 'reasoning_summary',
      data: {
        summary: 'Public concise summary',
        internal_reasoning: 'PRIVATE_REASONING_SENTINEL',
        reasoning: 'PRIVATE_REASONING_SENTINEL'
      },
      created_at: new Date().toISOString()
    } as AssistV3Event;
    const view = render(<TypedEvent event={event} />);
    expect(screen.getByText('Public concise summary')).toBeInTheDocument();
    expect(view.container.textContent).not.toContain('PRIVATE_REASONING_SENTINEL');
  });

  it('renders actionable Assist runtime failures', () => {
    const event = {
      id: 4,
      sequence: 4,
      session_id: 's1',
      turn_id: 't1',
      type: 'failed',
      data: { error: 'assist_workspace_unavailable' },
      created_at: new Date().toISOString()
    } as AssistV3Event;
    render(<TypedEvent event={event} />);
    expect(screen.getByText('智能助手工作目录不可用，请重新进入项目后重试。')).toBeInTheDocument();
  });

  it('marks files viewed, comments a line, and applies a fresh Agent review', async () => {
    let viewed = false;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/review/viewed')) {
          viewed = true;
          return response({ viewed: true });
        }
        if (url.endsWith('/review/comments'))
          return response({ id: 'c1', action: 'line_comment', patch: body, created_at: new Date().toISOString() }, 201);
        if (url.endsWith('/review/apply'))
          return response({ turn_id: 't1', worktree: { status: 'applied' }, target_hash: 'hash-1' });
        if (url.endsWith('/review')) return response(reviewFixture(viewed));
        return response({});
      })
    );
    renderWithClient(<DiffReviewPanel target={{ kind: 'turn', id: 't1' }} onBack={vi.fn()} />);
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '标记为已查看' }));
    await screen.findByRole('button', { name: '已查看' });
    fireEvent.click(screen.getByRole('row', { name: /const answer = 42/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '行评论' }), { target: { value: 'Please add a test' } });
    fireEvent.click(screen.getByRole('button', { name: '评论' }));
    await waitFor(() =>
      expect(calls.some((item) => item.url.endsWith('/review/comments') && item.body?.line === 1)).toBe(true)
    );
    fireEvent.click(screen.getByRole('button', { name: '安全应用' }));
    await waitFor(() =>
      expect(calls.some((item) => item.url.endsWith('/review/apply') && item.body?.target_hash === 'hash-1')).toBe(true)
    );
  });

  it('connects xterm to the Terminal WebSocket, sends Ctrl-C, and stops', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ ...terminalFixture(), status: 'stopped' }))
    );
    const changed = vi.fn();
    render(
      <TerminalPanel
        session={terminalFixture()}
        onSession={changed}
        onBack={vi.fn()}
        onReview={vi.fn()}
        onError={vi.fn()}
      />
    );
    await waitFor(() => expect(FakeWebSocket.last).toBeTruthy());
    FakeWebSocket.last?.emit({ type: 'output', data: 'hello', replay: true });
    await waitFor(() => expect(terminalWrites).toEqual(['hello']));
    fireEvent.click(screen.getByRole('button', { name: '中断' }));
    expect(FakeWebSocket.last?.sent.some((item) => JSON.parse(item).signal === 'SIGINT')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '停止会话' }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' })));
  });
});

function renderWithClient(value: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ContextMenuProvider>{value}</ContextMenuProvider>
    </QueryClientProvider>
  );
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function sessionSummary() {
  return {
    id: 's1',
    version: 3,
    project_id: 'p1',
    scope_type: 'project',
    scope_id: 'p1',
    title: 'Thread One',
    status: 'idle',
    lifecycle: 'active',
    pinned: true,
    turn_count: 0,
    last_turn: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
}
function sessionDetail() {
  return { ...sessionSummary(), turns: [], attachments: [], last_event_id: 0 };
}
function projectFixture(): Project {
  return {
    id: 'p1',
    title: 'Project One',
    goal: 'Test',
    status: 'active',
    current_workspace_id: 'w1',
    onboarding_state: 'confirmed',
    managed_workspace_state: 'ready'
  };
}
function reviewFixture(viewed: boolean) {
  return {
    turn_id: 't1',
    status: 'ready',
    worktree: { id: 'w1', project_id: 'p1', kind: 'assist_turn', status: 'review_ready' },
    changed_files: [{ path: 'src/a.ts', status: 'modified', code: ' M' }],
    diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const answer = 41;\n+const answer = 42;\n',
    target_hash: 'hash-1',
    base_commit: 'base',
    head_commit: 'head',
    viewed_files: viewed ? { 'src/a.ts': new Date().toISOString() } : {},
    comments: []
  };
}
function terminalFixture(): TerminalSession {
  return {
    id: 'tty1',
    project_id: 'p1',
    worktree_id: 'w1',
    profile_id: 'profile-1',
    runtime: 'host',
    status: 'ready',
    cols: 120,
    rows: 32,
    output_preview: '',
    output_truncated: false,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
}
function modelCatalog(base = 'gpt-codex') {
  const model = (value: string, isDefault = false) => ({
    id: value,
    model: value,
    displayName: value,
    description: `${value} model`,
    hidden: false,
    isDefault,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort
    }))
  });
  return {
    profile_id: 'profile-1',
    default_model: base,
    source: 'codex_model_list',
    models: [model(base, true), model(base === 'gpt-base' ? 'gpt-saved' : 'gpt-codex-custom')]
  };
}
function operationFixture(overrides: Partial<AssistOperation> = {}): AssistOperation {
  return {
    id: 'operation-1',
    session_id: 's1',
    turn_id: 'turn-1',
    tool: 'aiws_page.set_field',
    target_id: 'brief.goal',
    route: '/',
    surface_revision: 'r1',
    status: 'committed',
    risk: 'low',
    revision: 2,
    forced: false,
    before_value: 'before',
    after_value: 'after',
    conflict: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides
  };
}
