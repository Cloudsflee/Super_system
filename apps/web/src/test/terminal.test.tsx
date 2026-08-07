import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPage, type WorkspacePageProps } from '../pages';

const projectId = 'prj_terminal_test';
const approval = {
  id: 'rap_terminal_test', project_id: projectId, action: 'terminal.open', request: { runtime: 'windows_native', cwd: '' },
  decision: 'pending' as 'pending' | 'approved' | 'rejected' | 'expired', expires_at: '2099-01-01T00:00:00.000Z', created_at: '2026-08-07T00:00:00.000Z', decided_at: null as string | null
};
const session = {
  id: 'tty_terminal_test', project_id: projectId, assist_session_id: null, approval_id: approval.id, runtime: 'windows_native', cwd: '',
  status: 'ready', cols: 120, rows: 32, output_preview: '', output_bytes: 0, output_sha256: '', output_truncated: false,
  artifact_asset_id: null, exit_code: null, error_code: null, revision: 1, latest_cursor: 1,
  created_at: '2026-08-07T00:00:00.000Z', updated_at: '2026-08-07T00:00:00.000Z', started_at: null, completed_at: null
};

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: 'status', session: { ...session, status: 'running' } }) } as MessageEvent);
    });
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as { type: string; data?: string };
    if (frame.type === 'input') {
      this.onmessage?.({ data: JSON.stringify({ type: 'output', data: `\r\n${String(frame.data || '').replace(/\r/g, '')}\r\n`, cursor: 2 }) } as MessageEvent);
    }
    this.onmessage?.({ data: JSON.stringify({ type: 'ack', action: frame.type, session: { ...session, status: 'running' } }) } as MessageEvent);
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

const props: WorkspacePageProps = {
  projectId, selectedProject: undefined, selectProject: vi.fn(), refreshProjects: vi.fn(async () => undefined),
  notify: vi.fn(), navigate: vi.fn()
};

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  let currentApproval = { ...approval };
  let currentSession: typeof session | null = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input);
    const method = options?.method || 'GET';
    if (url.includes('/terminals/capabilities')) return new Response(JSON.stringify({
      available: true, transport: 'node-pty+websocket', protocols: ['input', 'resize', 'signal', 'cursor_replay'], default_runtime: 'windows_native', max_preview_chars: 30_000,
      linux_native: { available: false, runtime: 'linux_native', engine: 'forkpty', reason: 'fixture' },
      windows_native: { available: true, runtime: 'windows_native', engine: 'conpty', git_bundle: true }
    }), { status: 200 });
    if (url.endsWith('/api/v1/terminals?project_id=' + projectId)) return new Response(JSON.stringify(currentSession ? [currentSession] : []), { status: 200 });
    if (url.includes('/api/v1/approvals?project_id=')) return new Response(JSON.stringify([currentApproval]), { status: 200 });
    if (url.endsWith('/api/v1/terminals') && method === 'POST') { currentSession = { ...session, status: 'ready' }; return new Response(JSON.stringify(currentSession), { status: 201 }); }
    if (url.includes('/api/v1/terminals/tty_terminal_test') && method === 'GET') return new Response(JSON.stringify(currentSession || session), { status: 200 });
    if (url.includes('/api/v1/projects/' + projectId + '/approvals') && method === 'POST') { currentApproval = { ...currentApproval, decision: 'pending' }; return new Response(JSON.stringify(currentApproval), { status: 201 }); }
    if (url.includes('/api/v1/approvals/rap_terminal_test/decision') && method === 'POST') { currentApproval = { ...currentApproval, decision: 'approved', decided_at: '2026-08-07T00:01:00.000Z' }; return new Response(JSON.stringify(currentApproval), { status: 200 }); }
    if (url.includes('/api/v1/terminals/tty_terminal_test/') && method === 'POST') { if (url.endsWith('/stop') && currentSession) currentSession = { ...currentSession, status: 'stopped' }; return new Response(JSON.stringify(currentSession || session), { status: 200 }); }
    if (url.endsWith('/api/v1/projects')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
});

describe('terminal workspace', () => {
  it('requests approval, opens a session and sends input over the replayable socket', async () => {
    render(<TerminalPage {...props} />);
    await screen.findByRole('heading', { name: 'Terminal' });
    await screen.findByRole('button', { name: 'Request terminal access' });
    fireEvent.click(screen.getByRole('button', { name: 'Request terminal access' }));
    await screen.findByText('pending', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('approved', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    await screen.findByRole('log', { name: 'Terminal output' });
    const command = screen.getByPlaceholderText('Run a command');
    fireEvent.change(command, { target: { value: 'echo fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('log', { name: 'Terminal output' })).toHaveTextContent('echo fixture'));
  });
});
