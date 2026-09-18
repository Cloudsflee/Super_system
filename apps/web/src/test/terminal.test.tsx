import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPage } from '../features/terminal';
import { AssistPage } from '../features/assist';
import { useState } from 'react';
import type { TerminalLaunchContext, WorkspacePageProps } from '../workspace';
import type { Session } from '../features/assist/types';

const projectId = 'project_terminal_ui';
const session = {
  id: 'terminal_session_ui', project_id: projectId, workspace_id: 'workspace_terminal_ui', approval_id: 'approval_terminal_ui',
  runtime: 'windows_native' as const, cwd: '', status: 'running', cols: 120, rows: 32, last_client_sequence: 0,
  output_preview: 'ready\r\n', output_bytes: 7, output_sha256: 'a'.repeat(64), output_truncated: false,
  exit_code: null, error_code: null, revision: 2, latest_cursor: 4
};

const sockets: FakeWebSocket[] = [];
const sentFrames: Array<Record<string, unknown>> = [];

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: 'status', session, cursor: 4 }) } as MessageEvent);
    });
  }

  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    sentFrames.push(frame);
    const next = { ...session, revision: session.revision + 1, last_client_sequence: Number(frame.client_sequence) };
    if (frame.type === 'input') this.onmessage?.({ data: JSON.stringify({ type: 'output', data: `\r\n${String(frame.data || '').replace(/\r/g, '')}\r\n`, cursor: 5, session: next }) } as MessageEvent);
    this.onmessage?.({ data: JSON.stringify({ type: 'ack', action: frame.type, session: next, cursor: 5 }) } as MessageEvent);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ request_id: 'req_terminal_ui', data, meta: { api_version: 'v2' } }), { status, headers: { 'content-type': 'application/json' } });
const props: WorkspacePageProps = {
  projectId, selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined),
  notify: vi.fn(), navigate: vi.fn(), setupReady: true, refreshSetup: vi.fn(async () => undefined)
};

beforeEach(() => {
  sockets.length = 0;
  sentFrames.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v2/terminals/capabilities')) return envelope({
      available: true, transport: 'node-pty+websocket', protocols: ['input', 'resize', 'signal', 'cursor_replay'], default_runtime: 'windows_native', max_preview_chars: 30_000,
      linux_native: { available: false, runtime: 'linux_native', engine: 'forkpty', reason: 'platform_mismatch' },
      windows_native: { available: true, runtime: 'windows_native', engine: 'conpty', git_bundle: true }
    });
    if (url === `/api/v2/terminals?project_id=${projectId}`) return envelope({ terminals: [session] });
    if (url === `/api/v2/approvals?project_id=${projectId}`) return envelope({ approvals: [] });
    if (url.endsWith(`/api/v2/projects/${projectId}/repository-workspaces`)) return envelope({ workspaces: [{ id: session.workspace_id, status: 'locked', revision: 3 }] });
    if (url.endsWith(`/api/v2/terminals/${session.id}`)) return envelope(session);
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P5 Terminal workspace', () => {
  it('replays from the generic cursor, sends revisioned input and reconnects', async () => {
    render(<TerminalPage {...props} />);
    expect(await screen.findByRole('log', { name: '终端输出' })).toHaveTextContent('ready');
    await screen.findByText('已连接');
    expect(sockets[0]?.url).toContain(`/api/v2/terminals/${session.id}/ws?cursor=4`);

    fireEvent.change(screen.getByPlaceholderText('输入要运行的命令'), { target: { value: 'echo fixture' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sentFrames[0]).toMatchObject({ type: 'input', data: 'echo fixture\r', revision: 2, client_sequence: 1 }));
    expect(screen.getByRole('log', { name: '终端输出' })).toHaveTextContent('echo fixture');

    fireEvent.click(screen.getByRole('button', { name: '重新连接终端' }));
    await waitFor(() => expect(sockets.length).toBe(2));
    expect(sockets[1]?.url).toContain('cursor=5');
  });
});

it('keeps Assist → approval → Terminal → result reference → analysis in the same session', async () => {
  sessionStorage.clear();
  const assistId = 'assist_terminal_flow';
  let assist: Session = { id: assistId, project_id: projectId, scope: 'project', scope_id: projectId, status: 'active', revision: 2, context_pack_id: 'pack_flow', context_pack_hash: 'b'.repeat(64), profile_id: 'profile_flow', turns: [], references: [] };
  let approval = { id: 'approval_terminal_flow', action: 'terminal.open', status: 'pending', revision: 1, expires_at: '2099-01-01T00:00:00Z', request: {} as Record<string, unknown> };
  let requested = false; let opened = false; let completed = false;
  const terminal = { ...session, approval_id: approval.id, assist_session_id: assistId, operation_id: 'operation_terminal_flow', created_at: '2026-09-18T00:00:00Z' };
  const finished = { ...terminal, status: 'closed', exit_code: 0, revision: 5, output_preview: 'PUBLIC_OUTPUT_CANARY', output_sha256: 'c'.repeat(64), completed_at: '2026-09-18T00:00:01Z' };
  const mutations: Array<{ url: string; body: Record<string, unknown>; revision: string | null; key: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input); const method = options?.method || 'GET';
    if (method !== 'GET') {
      const body = JSON.parse(String(options?.body)); const headers = new Headers(options?.headers);
      mutations.push({ url, body, revision: headers.get('X-Expected-Revision'), key: headers.get('Idempotency-Key') });
      if (url.endsWith('/api/v2/approvals')) { requested = true; approval = { ...approval, request: body.request }; return envelope({ approval }, 201); }
      if (url.endsWith('/decide')) { approval = { ...approval, status: body.decision, revision: 2 }; return envelope({ approval }); }
      if (url.endsWith('/api/v2/terminals')) { opened = true; return envelope({ terminal }, 201); }
      if (url.endsWith('/references')) { assist = { ...assist, revision: 3, references: [{ id: 'reference_terminal_flow', reference_type: body.reference_type, reference_id: body.reference_id, reference_hash: body.reference_hash, reference_revision: null, created_at: '' }] }; return envelope({ references: assist.references }, 201); }
      if (url.endsWith('/turns')) return envelope({ operation_id: 'operation_analysis', status: 'succeeded', revision: 1 }, 202);
      throw new Error(`Unexpected mutation ${url}`);
    }
    if (url.endsWith('/api/v2/terminals/capabilities')) return envelope({ available: true, default_runtime: 'windows_native', windows_native: { available: true }, linux_native: { available: false } });
    if (url.includes('/terminals?')) return envelope({ terminals: opened ? [completed ? finished : terminal] : [] });
    if (url.endsWith(`/terminals/${session.id}`)) return envelope(completed ? finished : terminal);
    if (url.includes('/approvals?')) return envelope({ approvals: requested ? [approval] : [] });
    if (url.endsWith('/repository-workspaces')) return envelope({ workspaces: [{ id: session.workspace_id, status: 'ready', revision: 3 }] });
    if (url.endsWith('/context/packs')) return envelope({ packs: [{ id: 'pack_flow', status: 'sealed', pack_hash: 'b'.repeat(64) }] });
    if (url.endsWith('/api/v2/profiles')) return envelope({ profiles: [{ id: 'profile_flow', label: 'Codex fixture', provider: 'codex', status: 'available', revision: 1 }] });
    if (url.includes('/assist/sessions?')) return envelope({ sessions: [assist] });
    if (url.endsWith(`/assist/sessions/${assistId}`)) return envelope(assist);
    if (url.includes('/events?')) return envelope({ events: [], next_cursor: 0 });
    throw new Error(`Unexpected query ${url}`);
  }));
  function Flow() {
    const [launch, setLaunch] = useState<TerminalLaunchContext>();
    const [view, setView] = useState<'assist' | 'terminal'>('assist');
    return view === 'assist' ? <AssistPage {...props} surface="drawer" openTerminal={(context) => { setLaunch(context); setView('terminal'); }} />
      : <TerminalPage {...props} terminalLaunch={launch} openAssist={() => setView('assist')} />;
  }
  render(<Flow />);
  fireEvent.change(await screen.findByLabelText('Terminal 计划命令'), { target: { value: 'echo fixture' } });
  fireEvent.click(screen.getByRole('button', { name: '在 Terminal 执行' }));
  await screen.findByRole('button', { name: '批准' });
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({ revision: '3', body: { action: 'terminal.open', request: { workspace_id: session.workspace_id, assist_session_id: assistId, runtime: 'windows_native', cwd: '', command: 'echo fixture' } } });
  expect(sockets).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '批准' }));
  fireEvent.click(await screen.findByRole('button', { name: '打开' }));
  await screen.findByRole('log', { name: '终端输出' });
  await screen.findByText('已连接');
  expect(mutations[2]).toMatchObject({ revision: '3', body: { approval_id: approval.id, assist_session_id: assistId, workspace_id: session.workspace_id } });
  expect(sentFrames).toHaveLength(0);
  expect(screen.getByPlaceholderText('输入要运行的命令')).toHaveValue('echo fixture');
  completed = true;
  sockets[0].onmessage?.({ data: JSON.stringify({ type: 'status', session: finished, cursor: 6 }) } as MessageEvent);
  fireEvent.click(screen.getByRole('button', { name: '返回 Assist' }));
  await screen.findByText(/退出码 0/);
  fireEvent.click(screen.getByRole('button', { name: '让 Assist 分析结果' }));
  await waitFor(() => expect(mutations).toHaveLength(5));
  expect(mutations[3]).toMatchObject({ revision: '2', body: { reference_type: 'operation', reference_id: terminal.operation_id, reference_hash: finished.output_sha256 } });
  expect(mutations[3].body).not.toHaveProperty('reference_revision');
  expect(mutations[4]).toMatchObject({ revision: '3', body: { references: ['reference_terminal_flow'] } });
  expect(mutations[4].url).toBe(`/api/v2/assist/sessions/${assistId}/turns`);
  expect(String(mutations[4].body.message)).not.toContain('PUBLIC_OUTPUT_CANARY');
  expect(mutations.every((mutation) => mutation.key)).toBe(true);
});
