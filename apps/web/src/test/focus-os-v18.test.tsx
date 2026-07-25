import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../api/types';
import { AssistCenter } from '../features/assist/AssistCenter';
import { useUi } from '../state/ui';

describe('V1.8 Focus OS state', () => {
  beforeEach(resetUi);
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('persists focus mode, keeps transient context out of storage, and clamps legacy dock widths', async () => {
    localStorage.setItem(
      'aiws-v13-ui',
      JSON.stringify({
        version: 18,
        state: { focusMode: false, assistDockWidth: 760, assistSurface: 'docked', assistRestoreSurface: 'docked' }
      })
    );
    await useUi.persist.rehydrate();
    expect(useUi.getState().focusMode).toBe(false);
    expect(useUi.getState().assistDockWidth).toBe(680);
    expect(useUi.getState().workflowTaskDensity).toBe('comfortable');
    useUi.getState().inspect('node-1');
    useUi.getState().setFocusMode(true);
    useUi.getState().setCommandDockExpanded(true);
    const saved = JSON.parse(localStorage.getItem('aiws-v13-ui') || '{}').state;
    expect(saved.focusMode).toBe(true);
    expect(saved.commandDockExpanded).toBe(true);
    expect(saved).not.toHaveProperty('contextLane');
    expect(saved).not.toHaveProperty('inspectorMode');
    useUi.getState().setAssistDockWidth(100);
    expect(useUi.getState().assistDockWidth).toBe(420);
  });

  it('persists workflow density globally and normalizes invalid legacy values', async () => {
    useUi.getState().setWorkflowTaskDensity('detailed');
    expect(JSON.parse(localStorage.getItem('aiws-v13-ui') || '{}').state.workflowTaskDensity).toBe('detailed');
    localStorage.setItem('aiws-v13-ui', JSON.stringify({ version: 19, state: { workflowTaskDensity: 'oversized' } }));
    await useUi.persist.rehydrate();
    expect(useUi.getState().workflowTaskDensity).toBe('comfortable');
  });

  it('expands only the last explicit context while retaining the other as a peek', () => {
    useUi.getState().inspect('node-1');
    expect(useUi.getState()).toMatchObject({
      contextLane: 'inspector',
      inspectorNodeId: 'node-1',
      inspectorMode: 'expanded'
    });
    useUi.getState().setAssist(true);
    expect(useUi.getState()).toMatchObject({
      contextLane: 'assist',
      assistOpen: true,
      inspectorNodeId: 'node-1',
      inspectorMode: 'peek'
    });
    useUi.getState().inspect('node-1');
    expect(useUi.getState()).toMatchObject({
      contextLane: 'inspector',
      assistOpen: true,
      inspectorNodeId: 'node-1',
      inspectorMode: 'expanded'
    });
    useUi.getState().setAssistSurface('minimized');
    expect(useUi.getState()).toMatchObject({ assistOpen: false, contextLane: 'inspector', inspectorNodeId: 'node-1' });
    useUi.getState().inspect(null);
    expect(useUi.getState()).toMatchObject({ contextLane: null, inspectorNodeId: null, contextNodeId: null });
  });
});

describe('V1.8 shared AssistCenter', () => {
  beforeEach(() => {
    resetUi();
    CountingEventSource.created = 0;
    CountingEventSource.closed = 0;
    vi.stubGlobal('EventSource', CountingEventSource);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the bottom AI drawer collapsed until explicitly expanded', async () => {
    vi.stubGlobal('fetch', fixtureFetch([], { sessions: [session('s1', 'Thread One')] }));
    renderCenter();
    const expand = await screen.findByRole('button', { name: '展开智能助手输入' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: '智能助手消息' })).not.toBeInTheDocument();
    await expandCommandDock();
    expect(useUi.getState().commandDockExpanded).toBe(true);
    expect(screen.getByRole('button', { name: '收起智能助手输入' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '收起智能助手输入' }));
    expect(useUi.getState().commandDockExpanded).toBe(false);
    expect(screen.queryByRole('textbox', { name: '智能助手消息' })).not.toBeInTheDocument();
  });

  it('uses an existing thread and keeps one EventSource when the Dock expands', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', fixtureFetch(calls, { sessions: [session('s1', 'Thread One')] }));
    renderCenter();
    await expandCommandDock();
    await screen.findByRole('button', { name: 'gpt-codex' });
    const input = screen.getByRole('textbox', { name: '智能助手消息' });
    await waitFor(() => expect(CountingEventSource.created).toBe(1));
    fireEvent.change(input, { target: { value: 'Continue this thread' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('region', { name: 'Codex 智能助手' }, { timeout: 5_000 })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/assist/v3/sessions/s1/turns'))).toBe(true));
    expect(calls.find((call) => call.url.endsWith('/assist/v3/sessions/s1/turns'))?.body).toMatchObject({
      content: 'Continue this thread',
      collaboration_mode: 'default'
    });
    expect(CountingEventSource.created).toBe(1);
  });

  it('creates a scoped thread and submits the same one-shot Plan turn', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', fixtureFetch(calls, { sessions: [] }));
    renderCenter();
    await expandCommandDock();
    fireEvent.change(await screen.findByRole('textbox', { name: '智能助手消息' }), {
      target: { value: 'Plan the next milestone' }
    });
    fireEvent.click(screen.getByRole('button', { name: '规划' }));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/assist/v3/sessions/new-session/turns'))).toBe(true)
    );
    const createIndex = calls.findIndex((call) => call.url.endsWith('/assist/v3/sessions') && call.method === 'POST');
    const turnIndex = calls.findIndex((call) => call.url.endsWith('/assist/v3/sessions/new-session/turns'));
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(turnIndex).toBeGreaterThan(createIndex);
    expect(calls[createIndex].body).toMatchObject({ project_id: 'p1', scope_type: 'project', scope_id: 'p1' });
    expect(calls[turnIndex].body).toMatchObject({ content: 'Plan the next milestone', collaboration_mode: 'plan' });
    await waitFor(() => expect(screen.getByRole('button', { name: '规划' })).toHaveAttribute('aria-pressed', 'false'));
  });

  it('keeps prompt and Plan state when a Dock request fails', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', fixtureFetch(calls, { sessions: [session('s1', 'Thread One')], failTurn: true }));
    renderCenter();
    await expandCommandDock();
    await screen.findByRole('button', { name: 'gpt-codex' });
    const input = screen.getByRole('textbox', { name: '智能助手消息' });
    fireEvent.change(input, { target: { value: 'Keep this prompt' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '规划' }));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByDisplayValue('Keep this prompt')).toBeInTheDocument();
    await waitFor(() =>
      expect(useUi.getState().toasts.some((toast) => toast.tone === 'error' && toast.message === 'turn failed')).toBe(
        true
      )
    );
    expect(screen.getByRole('button', { name: '规划' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('resets project-scoped drafts and closes the previous project EventSource', async () => {
    const calls: Call[] = [],
      baseFetch = fixtureFetch(calls, { sessions: [session('s1', 'Thread One')] });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('/assist/v3/sessions?') && String(input).includes('project_id=p2')
          ? response([])
          : baseFetch(input, init)
      )
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const shell = (value: Project) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AssistCenter project={value} scopeType="project" scopeId={value.id} commandDock />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(shell(project()));
    await expandCommandDock();
    const input = await screen.findByRole('textbox', { name: '智能助手消息' });
    fireEvent.change(input, { target: { value: 'Project A draft' } });
    await waitFor(() => expect(CountingEventSource.created).toBe(1));
    view.rerender(shell({ ...project(), id: 'p2', title: 'Project Two' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '智能助手消息' })).toHaveValue(''));
    expect(CountingEventSource.closed).toBe(1);
  });

  it('uses the Assist Peek without duplicating the Command Dock', async () => {
    vi.stubGlobal('fetch', fixtureFetch([], { sessions: [session('s1', 'Thread One')] }));
    useUi.getState().inspect('node-1');
    useUi.getState().setAssist(true);
    useUi.getState().inspect('node-1');
    renderCenter();
    expect(await screen.findByRole('button', { name: /智能助手/ })).toHaveClass('assist-peek');
    expect(screen.queryByRole('complementary', { name: '智能助手命令栏' })).not.toBeInTheDocument();
  });
});

type Call = { url: string; method: string; body?: Record<string, unknown> };
type FetchOptions = { sessions: ReturnType<typeof session>[]; failTurn?: boolean };

function fixtureFetch(calls: Call[], options: FetchOptions) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input),
      method = init?.method || 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === 'POST' && url.endsWith('/assist/v3/sessions'))
      return response(session('new-session', 'New thread'), 201);
    if (method === 'POST' && /\/assist\/v3\/sessions\/[^/]+\/turns$/.test(url))
      return options.failTurn
        ? response({ message: 'turn failed' }, 500)
        : response(
            { id: 'turn-new', session_id: url.includes('new-session') ? 'new-session' : 's1', status: 'queued' },
            202
          );
    if (url.includes('/assist/v3/sessions?')) return response(options.sessions);
    if (url.endsWith('/assist/v3/sessions/s1'))
      return response({ ...session('s1', 'Thread One'), turns: [], attachments: [], last_event_id: 0 });
    if (url.endsWith('/assist/v3/sessions/new-session'))
      return response({ ...session('new-session', 'New thread'), turns: [], attachments: [], last_event_id: 0 });
    if (url.endsWith('/codex/profiles'))
      return response([
        {
          id: 'profile-1',
          name: 'Codex',
          model: 'gpt-codex',
          reasoning: 'high',
          kind: 'docker',
          status: 'validated',
          is_active: true
        }
      ]);
    if (url.includes('/assist/v3/models?'))
      return response({
        profile_id: 'profile-1',
        default_model: 'gpt-codex',
        source: 'test',
        models: [
          {
            id: 'gpt-codex',
            model: 'gpt-codex',
            displayName: 'gpt-codex',
            description: 'test',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'high' }]
          }
        ]
      });
    if (url.includes('/assist/v3/configurations')) return response([]);
    if (url.includes('/assist/v3/operations?')) return response([]);
    if (url.endsWith('/goal')) return response({ goal: null });
    if (url.includes('/terminal-sessions?')) return response([]);
    if (url.endsWith('/terminal-capabilities')) return response({ runtimes: [] });
    return response([]);
  });
}

function renderCenter() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/p1/workflow']}>
        <AssistCenter project={project()} scopeType="project" scopeId="p1" commandDock />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function expandCommandDock() {
  fireEvent.click(await screen.findByRole('button', { name: '展开智能助手输入' }));
  return screen.findByRole('textbox', { name: '智能助手消息' });
}

function resetUi() {
  localStorage.clear();
  useUi.setState({
    navOpen: false,
    assistOpen: false,
    assistSurface: 'docked',
    assistRestoreSurface: 'docked',
    assistDockWidth: 520,
    commandDockExpanded: false,
    focusMode: true,
    workflowTaskDensity: 'comfortable',
    contextLane: null,
    inspectorMode: 'expanded',
    inspectorNodeId: null,
    contextNodeId: null,
    proposalId: null,
    approvalCenterOpen: false,
    approvalSelectionId: null,
    toasts: []
  });
}
function project(): Project {
  return {
    id: 'p1',
    title: 'Project One',
    goal: 'Ship',
    status: 'active',
    onboarding_state: 'confirmed',
    current_workspace_id: 'w1',
    managed_workspace_state: 'ready'
  };
}
function session(id: string, title: string) {
  return {
    id,
    version: 3,
    project_id: 'p1',
    scope_type: 'project' as const,
    scope_id: 'p1',
    title,
    status: 'idle',
    lifecycle: 'active',
    pinned: false,
    turn_count: 0,
    last_turn: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
}
function response(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  );
}

class CountingEventSource {
  static created = 0;
  static closed = 0;
  onopen?: () => void;
  onerror?: () => void;
  constructor(_url: string) {
    CountingEventSource.created += 1;
  }
  addEventListener() {}
  close() {
    CountingEventSource.closed += 1;
  }
}
