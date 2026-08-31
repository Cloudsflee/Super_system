import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPage } from '../features/terminal';
import type { WorkspacePageProps } from '../workspace';

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
