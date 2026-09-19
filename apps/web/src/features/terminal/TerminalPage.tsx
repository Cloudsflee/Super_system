import {
  useCallback, useEffect, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent
} from 'react';
import {
  Check, Download, Keyboard, LoaderCircle, RefreshCw, RotateCcw, Send, ShieldCheck,
  Square, Terminal as TerminalIcon, Wifi, WifiOff, X
} from 'lucide-react';
import { ApiError, apiV2, formatBytes, mutateV2, shortHash, useWorkbenchOnline } from '../../api';
import type { TerminalCapabilities, TerminalRuntime } from '../../types';
import type { WorkspacePageProps } from '../../workspace';
import { runtimeLabel, statusLabel } from '../../i18n';

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

export function TerminalPage({ projectId, selectedProject, navigate, notify, terminalLaunch, online: shellOnline = true, openAssist }: WorkspacePageProps) {
  const browserOnline = useWorkbenchOnline();
  const online = browserOnline && shellOnline;
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
    setSelectedId((current) => {
      if (terminalLaunch?.approvalId && !terminalRows.some((terminal) => terminal.approval_id === terminalLaunch.approvalId)) return '';
      return terminalRows.some((terminal) => terminal.id === current) ? current : terminalRows.find((terminal) => terminal.approval_id === terminalLaunch?.approvalId)?.id || terminalRows[0]?.id || '';
    });
  }, [projectId, terminalLaunch?.approvalId]);

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
    void load().catch((error) => notify(error instanceof Error ? error.message : '终端加载失败', 'error'));
  }, [load, notify]);

  useEffect(() => {
    if (!terminalLaunch) return;
    if (terminalLaunch.workspaceId) setWorkspaceId(terminalLaunch.workspaceId);
    if (terminalLaunch.runtime) setRuntime(terminalLaunch.runtime as TerminalRuntime);
    if (terminalLaunch.cwd != null) setCwd(terminalLaunch.cwd);
    if (terminalLaunch.command != null) setCommand(terminalLaunch.command);
  }, [terminalLaunch]);

  useEffect(() => {
    setConnected(false);
    setReconnecting(false);
    void loadSelected().catch((error) => notify(error instanceof Error ? error.message : '终端会话加载失败', 'error'));
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
           notify(frame.error?.message || frame.error?.code || '终端帧处理失败', 'error');
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
    if (!online || !terminal || !ACTIVE_TERMINAL.has(terminal.status) || frameBusy) return;
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
    if (type === 'input') throw new Error('终端正在重新连接');
    setFrameBusy(true);
    try {
      const result = await mutateV2<TerminalReceipt>(`/api/v2/terminals/${encodeURIComponent(terminal.id)}/${type}`, { ...values, client_sequence: clientSequence }, 'POST', terminal.revision);
      applySession(result.data.terminal);
    } finally {
      setFrameBusy(false);
    }
  }, [applySession, frameBusy, online]);

  const requestApproval = async () => {
    if (!online || busy) return;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return notify('请选择可用的代码仓库工作区。', 'error');
    setBusy('request');
    try {
      await mutateV2('/api/v2/approvals', {
        project_id: projectId,
        action: 'terminal.open',
        request: { workspace_id: workspace.id, runtime, cwd, cols: 120, rows: 32, assist_session_id: terminalLaunch?.assistSessionId || null },
        ttl_seconds: 3600
      }, 'POST', workspace.revision);
      await load();
      notify('终端审批请求已提交');
    } catch (error) {
      notify(error instanceof Error ? error.message : '终端审批请求失败', 'error');
    } finally {
      setBusy('');
    }
  };

  const openTerminal = async (approval: Approval) => {
    if (!online || busy || approval.status !== 'approved') return;
    const requestedWorkspace = String(approval.request.workspace_id || '');
    const workspace = workspaces.find((item) => item.id === requestedWorkspace);
    if (!workspace) return notify('已批准的代码仓库工作区不可用。', 'error');
    setBusy(`open:${approval.id}`);
    try {
      if (!['workspace_id', 'runtime', 'cwd', 'cols', 'rows', 'assist_session_id'].every(field => Object.hasOwn(approval.request, field))) throw new Error('审批缺少完整 Terminal 参数，请重新申请。');
      const result = await mutateV2<TerminalReceipt>('/api/v2/terminals', {
        project_id: projectId,
        workspace_id: workspace.id,
        approval_id: approval.id,
        runtime: approval.request.runtime,
        cwd: approval.request.cwd,
        cols: approval.request.cols,
        rows: approval.request.rows,
        assist_session_id: approval.request.assist_session_id
      }, 'POST', workspace.revision);
      setSelectedId(result.data.terminal.id);
      applySession(result.data.terminal);
      setOutput('');
      if (typeof approval.request.command === 'string') setCommand(approval.request.command);
      cursorRef.current = 0;
      await load();
      notify('终端已打开');
    } catch (error) {
      notify(error instanceof Error ? error.message : '终端打开失败', 'error');
    } finally {
      setBusy('');
    }
  };

  const decideApproval = async (approval: Approval, decision: 'approved' | 'rejected') => {
    if (!online || busy) return;
    setBusy(`decide:${approval.id}`);
    try {
      await mutateV2(`/api/v2/approvals/${encodeURIComponent(approval.id)}/decide`, { decision }, 'POST', approval.revision);
      await load(); notify(decision === 'approved' ? 'Terminal 访问已批准' : 'Terminal 访问已拒绝');
    } catch (failure) { notify(failure instanceof Error ? failure.message : 'Terminal 审批失败', 'error'); }
    finally { setBusy(''); }
  };

  const submitCommand = async (event: FormEvent) => {
    event.preventDefault();
    const value = command;
    if (!value.trim()) return;
    try {
      await sendFrame('input', { data: `${value}\r` });
      setCommand('');
    } catch (error) {
      notify(error instanceof Error ? error.message : '终端输入失败', 'error');
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      await sendFrame('stop');
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'revision_conflict') await loadSelected().catch(() => undefined);
      notify(error instanceof Error ? error.message : '终端停止失败', 'error');
    } finally {
      setBusy('');
    }
  };

  const handleOutputKeyDown = (event: KeyboardEvent<HTMLPreElement>) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void sendFrame('signal', { signal: 'SIGINT' }).catch((error) => notify(error instanceof Error ? error.message : 'SIGINT 操作失败', 'error'));
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
  const visibleApprovals = terminalLaunch?.approvalId ? approvals.filter((approval) => approval.id === terminalLaunch.approvalId) : approvals;
  const availableApprovals = visibleApprovals.filter((approval) => approval.status === 'approved' && !consumedApprovalIds.has(approval.id));
  const pendingApprovals = visibleApprovals.filter((approval) => approval.status === 'pending');
  const activeSession = sessions.find((terminal) => ACTIVE_TERMINAL.has(terminal.status));

  if (!projectId) return <div className="empty-state"><TerminalIcon size={28} /><h2>请选择项目以打开终端</h2><button className="button" onClick={() => navigate('projects')}>项目</button></div>;

  return (
    <div className="page terminal-page">
      <div className="page-heading">
        <div><p className="eyebrow">交互式工作区</p><h1>终端</h1></div>
        <button className="icon-button" title="刷新终端" aria-label="刷新终端" onClick={() => void load()}><RefreshCw size={17} /></button>
      </div>
      {!online && <div className="state-banner conflict" role="status">离线：审批和 Terminal 执行已暂停。</div>}
      {terminalLaunch?.assistSessionId && <button className="button" onClick={() => openAssist?.()}><TerminalIcon size={15} />返回 Assist</button>}
      <section className="health-band terminal-capabilities">
        <div><span>传输方式</span><strong className="mono">{capabilities?.transport || '检查中'}</strong></div>
        <div><span>默认运行时</span><Status value={capabilities?.default_runtime || 'checking'} /></div>
        <div><span>Linux 原生</span><Status value={capabilities?.linux_native?.available ? 'available' : 'unavailable'} /></div>
        <div><span>Windows 原生</span><Status value={capabilities?.windows_native?.available ? 'available' : 'unavailable'} /></div>
      </section>

      <div className="terminal-layout">
        <section className="panel terminal-session-panel">
          <SectionTitle title="会话" meta={`${sessions.length} 条记录`} />
          <div className="terminal-session-list">
            {sessions.map((session) => <button key={session.id} className={session.id === selectedId ? 'terminal-session-row selected' : 'terminal-session-row'} onClick={() => setSelectedId(session.id)}>
               <span><strong>{runtimeLabel(session.runtime)}</strong><small className="mono">{shortHash(session.id)}</small></span><Status value={session.status} />
            </button>)}
            {!sessions.length && <div className="list-empty">暂无终端会话</div>}
          </div>
          {activeSession && <div className="terminal-lock-note"><TerminalIcon size={15} /><span>工作区写入租约由 <b className="mono">{shortHash(activeSession.id)}</b> 持有</span></div>}
        </section>

        <section className="panel terminal-console-panel">
          <div className="section-title terminal-title">
            <div><h2>{selected ? `${runtimeLabel(selected.runtime)} Shell` : '打开托管 Shell'}</h2><span>{selected ? `${selected.cwd || '工作区根目录'} | ${selected.cols}x${selected.rows} | r${selected.revision}` : '需要一次性审批'}</span></div>
            {selected && <div className="terminal-toolbar-actions">
              <span className={connected ? 'terminal-connection connected' : 'terminal-connection'}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? '已连接' : reconnecting ? '重新连接中' : statusLabel(selected.status)}</span>
              <button className="icon-button" title="重新连接终端" aria-label="重新连接终端" disabled={!ACTIVE_TERMINAL.has(selected.status)} onClick={() => setConnectionNonce((value) => value + 1)}><RotateCcw size={15} /></button>
              <button className="icon-button" title="发送 SIGINT" aria-label="发送 SIGINT" disabled={!ACTIVE_TERMINAL.has(selected.status) || frameBusy} onClick={() => void sendFrame('signal', { signal: 'SIGINT' })}><Keyboard size={15} /></button>
              <button className="icon-button" title="停止终端" aria-label="停止终端" disabled={!ACTIVE_TERMINAL.has(selected.status) || busy === 'stop' || frameBusy} onClick={() => void stop()}><Square size={15} /></button>
            </div>}
          </div>

          {!selected && <>
            <div className="terminal-open-form">
              <label><span>运行时</span><select value={runtime} onChange={(event) => setRuntime(event.target.value as TerminalRuntime)}><option value="linux_native" disabled={!capabilities?.linux_native?.available}>Linux 原生</option><option value="windows_native" disabled={!capabilities?.windows_native?.available}>Windows 原生</option></select></label>
              <label><span>工作区</span><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">不使用工作区</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id} disabled={!['ready', 'released'].includes(workspace.status)}>{workspace.relative_path || shortHash(workspace.id)} | {statusLabel(workspace.status)}</option>)}</select></label>
              <label><span>工作目录</span><input className="mono" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="工作区根目录" /></label>
              <button className="button primary" disabled={!online || !capabilities?.available || Boolean(busy) || Boolean(activeSession) || selectedProject?.status === 'archived' || !workspaceId} onClick={() => void requestApproval()}>{busy === 'request' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}申请访问</button>
            </div>
            <div className="terminal-approval-list">
              <div className="terminal-subheading"><span>访问请求</span><small>{pendingApprovals.length} 项待处理 | {availableApprovals.length} 项就绪</small></div>
              {pendingApprovals.map((approval) => <div className="terminal-approval-row" key={approval.id}><div><strong>{runtimeLabel(approval.request.runtime || runtime)}</strong><small className="mono">{String(approval.request.command || '打开交互式 Shell')}</small><small>Workspace {String(approval.request.workspace_id || '')} · cwd {String(approval.request.cwd || '.')}</small></div><Status value={approval.status} /><div className="terminal-approval-actions"><button className="button" disabled={!online || Boolean(busy)} onClick={() => void decideApproval(approval, 'rejected')}><X size={14} />拒绝</button><button className="button primary" disabled={!online || Boolean(busy)} onClick={() => void decideApproval(approval, 'approved')}><Check size={14} />批准</button></div></div>)}
              {availableApprovals.map((approval) => <div className="terminal-approval-row" key={approval.id}><div><strong>{runtimeLabel(approval.request.runtime || runtime)}</strong><small className="mono">{String(approval.request.command || shortHash(approval.id))}</small></div><Status value={approval.status} /><button className="button primary" disabled={!online || Boolean(busy) || Boolean(activeSession)} onClick={() => void openTerminal(approval)}>{busy === `open:${approval.id}` ? <LoaderCircle className="spin" size={15} /> : <TerminalIcon size={15} />}打开</button></div>)}
              {!pendingApprovals.length && !availableApprovals.length && <div className="list-empty">请先申请审批</div>}
            </div>
          </>}

          {selected && <>
            {selected.status === 'orphaned' && <div className="state-banner error"><span>终端进程已丢失，工作区租约已释放。</span></div>}
            <pre className="terminal-output" ref={(element) => { outputRef.current = element; viewportRef.current = element; }} tabIndex={0} role="log" aria-label="终端输出" onKeyDown={handleOutputKeyDown}>{output || '等待 Shell 输出……'}</pre>
            <form className="terminal-input-row" onSubmit={(event) => void submitCommand(event)}>
              <label className="terminal-command-field"><span>命令</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入要运行的命令" autoComplete="off" disabled={!ACTIVE_TERMINAL.has(selected.status)} /></label>
              <button className="button primary" disabled={!online || !command.trim() || !connected || frameBusy || !ACTIVE_TERMINAL.has(selected.status)}>{frameBusy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}发送</button>
            </form>
            <div className="terminal-meta-grid">
              <div><span>输出</span><strong>{formatBytes(selected.output_bytes)}</strong></div>
              <div><span>SHA-256</span><strong className="mono">{shortHash(selected.output_sha256 || '')}</strong></div>
              <div><span>游标</span><strong>{Math.max(cursorRef.current, selected.latest_cursor)}</strong></div>
              <div><span>退出码</span><strong>{selected.exit_code ?? '运行中'}</strong></div>
            </div>
            {selected.output_truncated && <div className="state-banner conflict"><span>输出已达到终端限制。</span><Download size={15} /></div>}
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
  return <span className={`status ${tone}`}><span />{['linux_native', 'windows_native', 'host', 'docker', 'windows_bridge'].includes(value) ? runtimeLabel(value) : statusLabel(value)}</span>;
}
