import {
  useCallback, useEffect, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent
} from 'react';
import {
  Download, Keyboard, LoaderCircle, RefreshCw, RotateCcw, Send, ShieldCheck,
  Square, Terminal as TerminalIcon, Wifi, WifiOff
} from 'lucide-react';
import { ApiError, apiV2, formatBytes, mutateV2, shortHash } from '../../api';
import type { TerminalCapabilities, TerminalRuntime } from '../../types';
import type { WorkspacePageProps } from '../../workspace';

type TerminalSession = {
  id: string;
  project_id: string;
  workspace_id: string;
  approval_id: string;
  runtime: TerminalRuntime;
  cwd: string;
  status: string;
  cols: number;
  rows: number;
  last_client_sequence: number;
  output_preview: string;
  output_bytes: number;
  output_sha256?: string | null;
  output_truncated: boolean;
  exit_code?: number | null;
  error_code?: string | null;
  revision: number;
  latest_cursor: number;
};

type Approval = {
  id: string;
  action: string;
  request: Record<string, unknown>;
  status: string;
  expires_at: string;
  revision: number;
};

type RepositoryWorkspace = { id: string; status: string; revision: number; relative_path?: string };
type TerminalReceipt = { terminal: TerminalSession };
type TerminalReplay = { events: Array<{ sequence: number; type: string; data?: { chunk?: string } }>; next_cursor: number | string; terminal: boolean };
type SocketMessage = {
  type: string;
  data?: string;
  cursor?: number;
  action?: string;
  session?: TerminalSession;
  error?: { code?: string; message?: string };
};

const ACTIVE_TERMINAL = new Set(['ready', 'running']);

export function TerminalPage({ projectId, selectedProject, navigate, notify }: WorkspacePageProps) {
  const [capabilities, setCapabilities] = useState<TerminalCapabilities | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [workspaces, setWorkspaces] = useState<RepositoryWorkspace[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<TerminalSession | null>(null);
  const [runtime, setRuntime] = useState<TerminalRuntime>('windows_native');
  const [workspaceId, setWorkspaceId] = useState('');
  const [cwd, setCwd] = useState('');
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState('');
  const [frameBusy, setFrameBusy] = useState(false);
  const [connectionNonce, setConnectionNonce] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<TerminalSession | null>(null);
  const cursorRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const viewportRef = useRef<HTMLPreElement | null>(null);

  const applySession = useCallback((session: TerminalSession) => {
    selectedRef.current = session;
    setSelected(session);
    setSessions((rows) => rows.map((row) => row.id === session.id ? session : row));
    cursorRef.current = Math.max(cursorRef.current, Number(session.latest_cursor || 0));
  }, []);

  const load = useCallback(async () => {
    if (!projectId) {
      setCapabilities(null);
      setSessions([]);
      setApprovals([]);
      setWorkspaces([]);
      setSelectedId('');
      return;
    }
    const query = `?project_id=${encodeURIComponent(projectId)}`;
    const [capsResult, terminalResult, approvalResult, workspaceResult] = await Promise.all([
      apiV2<TerminalCapabilities>('/api/v2/terminals/capabilities'),
      apiV2<{ terminals: TerminalSession[] }>(`/api/v2/terminals${query}`),
      apiV2<{ approvals: Approval[] }>(`/api/v2/approvals${query}`),
      apiV2<{ workspaces: RepositoryWorkspace[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/repository-workspaces`)
    ]);
    const caps = capsResult.data;
    const terminalRows = terminalResult.data.terminals || [];
    const workspaceRows = workspaceResult.data.workspaces || [];
    setCapabilities(caps);
    setSessions(terminalRows);
    setApprovals((approvalResult.data.approvals || []).filter((approval) => approval.action === 'terminal.open'));
    setWorkspaces(workspaceRows);
    setRuntime((current) => caps[current]?.available ? current : caps.default_runtime);
    setWorkspaceId((current) => workspaceRows.some((workspace) => workspace.id === current)
      ? current
      : workspaceRows.find((workspace) => ['ready', 'released'].includes(workspace.status))?.id || workspaceRows[0]?.id || '');
    setSelectedId((current) => terminalRows.some((terminal) => terminal.id === current) ? current : terminalRows[0]?.id || '');
  }, [projectId]);

  const loadSelected = useCallback(async () => {
    if (!selectedId) {
      selectedRef.current = null;
      setSelected(null);
      setOutput('');
      cursorRef.current = 0;
      return;
    }
    const result = await apiV2<TerminalSession>(`/api/v2/terminals/${encodeURIComponent(selectedId)}`);
    selectedRef.current = result.data;
    setSelected(result.data);
    setOutput(result.data.output_preview || '');
    cursorRef.current = Number(result.data.latest_cursor || 0);
  }, [selectedId]);

  useEffect(() => {
    void load().catch((error) => notify(error instanceof Error ? error.message : 'Terminal failed to load', 'error'));
  }, [load, notify]);

  useEffect(() => {
    setConnected(false);
    setReconnecting(false);
    void loadSelected().catch((error) => notify(error instanceof Error ? error.message : 'Terminal session failed to load', 'error'));
  }, [loadSelected, notify]);

  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (!selectedId || !ACTIVE_TERMINAL.has(selected?.status || '')) return;
    let disposed = false;
    reconnectAttemptRef.current = 0;

    const connect = () => {
      if (disposed || !ACTIVE_TERMINAL.has(selectedRef.current?.status || '')) return;
      setReconnecting(reconnectAttemptRef.current > 0);
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/api/v2/terminals/${encodeURIComponent(selectedId)}/ws?cursor=${encodeURIComponent(String(cursorRef.current))}`);
      socketRef.current = socket;
      socket.onopen = () => {
        reconnectAttemptRef.current = 0;
        setConnected(true);
        setReconnecting(false);
      };
      socket.onmessage = (event) => {
        let frame: SocketMessage;
        try {
          frame = JSON.parse(String(event.data)) as SocketMessage;
        } catch {
          return;
        }
        if (Number.isInteger(frame.cursor)) cursorRef.current = Math.max(cursorRef.current, Number(frame.cursor));
        if (frame.type === 'output' && typeof frame.data === 'string') setOutput((current) => `${current}${frame.data}`.slice(-120_000));
        if (frame.session) applySession(frame.session);
        if (frame.type === 'ack') setFrameBusy(false);
        if (frame.type === 'error') {
          setFrameBusy(false);
          notify(frame.error?.message || frame.error?.code || 'Terminal frame failed', 'error');
          if (frame.error?.code === 'revision_conflict' || frame.error?.code === 'client_sequence_conflict') void loadSelected();
        }
      };
      socket.onerror = () => setConnected(false);
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        setConnected(false);
        setFrameBusy(false);
        if (disposed || !ACTIVE_TERMINAL.has(selectedRef.current?.status || '')) return;
        setReconnecting(true);
        const delay = Math.min(5000, 250 * (2 ** reconnectAttemptRef.current));
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimerRef.current != null) window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
      setReconnecting(false);
      setFrameBusy(false);
    };
  }, [applySession, connectionNonce, loadSelected, notify, selected?.status, selectedId]);

  const sendFrame = useCallback(async (type: 'input' | 'resize' | 'signal' | 'stop', values: Record<string, unknown> = {}) => {
    const terminal = selectedRef.current;
    if (!terminal || !ACTIVE_TERMINAL.has(terminal.status) || frameBusy) return;
    const clientSequence = terminal.last_client_sequence + 1;
    const frame = {
      type,
      ...values,
      revision: terminal.revision,
      client_sequence: clientSequence,
      idempotency_key: crypto.randomUUID()
    };
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      setFrameBusy(true);
      socket.send(JSON.stringify(frame));
      return;
    }
    if (type === 'input') throw new Error('Terminal is reconnecting');
    setFrameBusy(true);
    try {
      const result = await mutateV2<TerminalReceipt>(`/api/v2/terminals/${encodeURIComponent(terminal.id)}/${type}`, { ...values, client_sequence: clientSequence }, 'POST', terminal.revision);
      applySession(result.data.terminal);
    } finally {
      setFrameBusy(false);
    }
  }, [applySession, frameBusy]);

  const requestApproval = async () => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return notify('Select an available repository workspace.', 'error');
    setBusy('request');
    try {
      await mutateV2('/api/v2/approvals', {
        project_id: projectId,
        action: 'terminal.open',
        request: { workspace_id: workspace.id, runtime, cwd, cols: 120, rows: 32 },
        ttl_seconds: 3600
      }, 'POST', workspace.revision);
      await load();
      notify('Terminal approval requested');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Terminal approval request failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const openTerminal = async (approval: Approval) => {
    const requestedWorkspace = String(approval.request.workspace_id || workspaceId);
    const workspace = workspaces.find((item) => item.id === requestedWorkspace);
    if (!workspace) return notify('The approved repository workspace is unavailable.', 'error');
    setBusy(`open:${approval.id}`);
    try {
      const result = await mutateV2<TerminalReceipt>('/api/v2/terminals', {
        project_id: projectId,
        workspace_id: workspace.id,
        approval_id: approval.id,
        runtime: String(approval.request.runtime || runtime),
        cwd: String(approval.request.cwd || ''),
        cols: Number(approval.request.cols || 120),
        rows: Number(approval.request.rows || 32)
      }, 'POST', workspace.revision);
      setSelectedId(result.data.terminal.id);
      applySession(result.data.terminal);
      setOutput('');
      cursorRef.current = 0;
      await load();
      notify('Terminal opened');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Terminal failed to open', 'error');
    } finally {
      setBusy('');
    }
  };

  const submitCommand = async (event: FormEvent) => {
    event.preventDefault();
    const value = command;
    if (!value.trim()) return;
    try {
      await sendFrame('input', { data: `${value}\r` });
      setCommand('');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Terminal input failed', 'error');
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      await sendFrame('stop');
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'revision_conflict') await loadSelected().catch(() => undefined);
      notify(error instanceof Error ? error.message : 'Terminal stop failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const handleOutputKeyDown = (event: KeyboardEvent<HTMLPreElement>) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void sendFrame('signal', { signal: 'SIGINT' }).catch((error) => notify(error instanceof Error ? error.message : 'SIGINT failed', 'error'));
    }
  };

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || typeof ResizeObserver === 'undefined' || !selected || !ACTIVE_TERMINAL.has(selected.status)) return;
    const observer = new ResizeObserver(() => {
      const terminal = selectedRef.current;
      if (!terminal || frameBusy) return;
      const cols = clamp(element.clientWidth / 8.2, 20, 200);
      const rows = clamp(Math.max(element.clientHeight, 120) / 18, 5, 100);
      if (cols === terminal.cols && rows === terminal.rows) return;
      void sendFrame('resize', { cols, rows }).catch(() => undefined);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [frameBusy, selected, sendFrame]);

  const consumedApprovalIds = useMemo(() => new Set(sessions.map((session) => session.approval_id)), [sessions]);
  const availableApprovals = approvals.filter((approval) => approval.status === 'approved' && !consumedApprovalIds.has(approval.id));
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const activeSession = sessions.find((terminal) => ACTIVE_TERMINAL.has(terminal.status));

  if (!projectId) return <div className="empty-state"><TerminalIcon size={28} /><h2>Select a project to open Terminal</h2><button className="button" onClick={() => navigate('projects')}>Projects</button></div>;

  return (
    <div className="page terminal-page">
      <div className="page-heading">
        <div><p className="eyebrow">Interactive workspace</p><h1>Terminal</h1></div>
        <button className="icon-button" title="Refresh Terminal" aria-label="Refresh Terminal" onClick={() => void load()}><RefreshCw size={17} /></button>
      </div>
      <section className="health-band terminal-capabilities">
        <div><span>Transport</span><strong className="mono">{capabilities?.transport || 'checking'}</strong></div>
        <div><span>Default runtime</span><Status value={capabilities?.default_runtime || 'checking'} /></div>
        <div><span>Linux native</span><Status value={capabilities?.linux_native?.available ? 'available' : 'unavailable'} /></div>
        <div><span>Windows native</span><Status value={capabilities?.windows_native?.available ? 'available' : 'unavailable'} /></div>
      </section>

      <div className="terminal-layout">
        <section className="panel terminal-session-panel">
          <SectionTitle title="Sessions" meta={`${sessions.length} recorded`} />
          <div className="terminal-session-list">
            {sessions.map((session) => <button key={session.id} className={session.id === selectedId ? 'terminal-session-row selected' : 'terminal-session-row'} onClick={() => setSelectedId(session.id)}>
              <span><strong>{session.runtime.replace('_', ' ')}</strong><small className="mono">{shortHash(session.id)}</small></span><Status value={session.status} />
            </button>)}
            {!sessions.length && <div className="list-empty">No terminal sessions</div>}
          </div>
          {activeSession && <div className="terminal-lock-note"><TerminalIcon size={15} /><span>Workspace write lease held by <b className="mono">{shortHash(activeSession.id)}</b></span></div>}
        </section>

        <section className="panel terminal-console-panel">
          <div className="section-title terminal-title">
            <div><h2>{selected ? `${selected.runtime.replace('_', ' ')} shell` : 'Open a managed shell'}</h2><span>{selected ? `${selected.cwd || 'workspace root'} | ${selected.cols}x${selected.rows} | r${selected.revision}` : 'One-time approval is required'}</span></div>
            {selected && <div className="terminal-toolbar-actions">
              <span className={connected ? 'terminal-connection connected' : 'terminal-connection'}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? 'connected' : reconnecting ? 'reconnecting' : selected.status}</span>
              <button className="icon-button" title="Reconnect Terminal" aria-label="Reconnect Terminal" disabled={!ACTIVE_TERMINAL.has(selected.status)} onClick={() => setConnectionNonce((value) => value + 1)}><RotateCcw size={15} /></button>
              <button className="icon-button" title="Send SIGINT" aria-label="Send SIGINT" disabled={!ACTIVE_TERMINAL.has(selected.status) || frameBusy} onClick={() => void sendFrame('signal', { signal: 'SIGINT' })}><Keyboard size={15} /></button>
              <button className="icon-button" title="Stop Terminal" aria-label="Stop Terminal" disabled={!ACTIVE_TERMINAL.has(selected.status) || busy === 'stop' || frameBusy} onClick={() => void stop()}><Square size={15} /></button>
            </div>}
          </div>

          {!selected && <>
            <div className="terminal-open-form">
              <label><span>Runtime</span><select value={runtime} onChange={(event) => setRuntime(event.target.value as TerminalRuntime)}><option value="linux_native" disabled={!capabilities?.linux_native?.available}>Linux native</option><option value="windows_native" disabled={!capabilities?.windows_native?.available}>Windows native</option></select></label>
              <label><span>Workspace</span><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">No workspace</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id} disabled={!['ready', 'released'].includes(workspace.status)}>{workspace.relative_path || shortHash(workspace.id)} | {workspace.status}</option>)}</select></label>
              <label><span>Working directory</span><input className="mono" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="workspace root" /></label>
              <button className="button primary" disabled={!capabilities?.available || busy === 'request' || Boolean(activeSession) || selectedProject?.status === 'archived' || !workspaceId} onClick={() => void requestApproval()}>{busy === 'request' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Request access</button>
            </div>
            <div className="terminal-approval-list">
              <div className="terminal-subheading"><span>Access requests</span><small>{pendingApprovals.length} pending | {availableApprovals.length} ready</small></div>
              {pendingApprovals.map((approval) => <div className="terminal-approval-row" key={approval.id}><div><strong>{String(approval.request.runtime || runtime)}</strong><small className="mono">{shortHash(approval.id)}</small></div><Status value={approval.status} /><button className="button" onClick={() => navigate('approvals')}>Review</button></div>)}
              {availableApprovals.map((approval) => <div className="terminal-approval-row" key={approval.id}><div><strong>{String(approval.request.runtime || runtime)}</strong><small className="mono">{shortHash(approval.id)}</small></div><Status value={approval.status} /><button className="button primary" disabled={busy === `open:${approval.id}` || Boolean(activeSession)} onClick={() => void openTerminal(approval)}>{busy === `open:${approval.id}` ? <LoaderCircle className="spin" size={15} /> : <TerminalIcon size={15} />}Open</button></div>)}
              {!pendingApprovals.length && !availableApprovals.length && <div className="list-empty">Request an approval to begin</div>}
            </div>
          </>}

          {selected && <>
            {selected.status === 'orphaned' && <div className="state-banner error"><span>Terminal process was lost. The workspace lease has been released.</span></div>}
            <pre className="terminal-output" ref={(element) => { outputRef.current = element; viewportRef.current = element; }} tabIndex={0} role="log" aria-label="Terminal output" onKeyDown={handleOutputKeyDown}>{output || 'Waiting for shell output...'}</pre>
            <form className="terminal-input-row" onSubmit={(event) => void submitCommand(event)}>
              <label className="terminal-command-field"><span>Command</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Run a command" autoComplete="off" disabled={!ACTIVE_TERMINAL.has(selected.status)} /></label>
              <button className="button primary" disabled={!command.trim() || !connected || frameBusy || !ACTIVE_TERMINAL.has(selected.status)}>{frameBusy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}Send</button>
            </form>
            <div className="terminal-meta-grid">
              <div><span>Output</span><strong>{formatBytes(selected.output_bytes)}</strong></div>
              <div><span>SHA-256</span><strong className="mono">{shortHash(selected.output_sha256 || '')}</strong></div>
              <div><span>Cursor</span><strong>{Math.max(cursorRef.current, selected.latest_cursor)}</strong></div>
              <div><span>Exit</span><strong>{selected.exit_code ?? 'active'}</strong></div>
            </div>
            {selected.output_truncated && <div className="state-banner conflict"><span>Output reached the bounded terminal limit.</span><Download size={15} /></div>}
          </>}
        </section>
      </div>
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function SectionTitle({ title, meta }: { title: string; meta: string }) {
  return <div className="section-title"><div><h2>{title}</h2><span>{meta}</span></div></div>;
}

function Status({ value }: { value: string }) {
  const tone = ['available', 'ready', 'running', 'approved', 'closed', 'stopped'].includes(value) ? 'positive'
    : ['pending', 'checking'].includes(value) ? 'working'
      : ['failed', 'orphaned', 'unavailable', 'rejected', 'expired'].includes(value) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>;
}
