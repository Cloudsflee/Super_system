import { ArrowLeft, Ban, GitCompare, PlugZap, RefreshCw, TerminalSquare } from 'lucide-react';
import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { api, json, websocketUrl } from '../../api/client';
import type { TerminalSession } from '../../api/types';

type Props = {
  session: TerminalSession;
  reviewDisabled?: boolean;
  onSession: (value: TerminalSession) => void;
  onBack: () => void;
  onReview: () => void;
  onError: (message: string) => void;
};

export function TerminalPanel({ session, reviewDisabled, onSession, onBack, onReview, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const terminal = useRef<XtermTerminal | null>(null);
  const fit = useRef<XtermFitAddon | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const ended = useRef(false);
  const attempts = useRef(0);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting' | 'closed'>('connecting');

  useEffect(() => {
    if (!host.current) return;
    let disposed = false,
      observer: ResizeObserver | null = null;
    ended.current = terminalState(session.status);
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(([xterm, addon]) => {
        if (disposed || !host.current) return;
        const term = new xterm.Terminal({
          convertEol: true,
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"Cascadia Code", Consolas, monospace',
          theme: { background: '#171b1d', foreground: '#dce3e6', cursor: '#7bc5ad' },
          scrollback: 10_000
        });
        const fitAddon = new addon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(host.current);
        terminal.current = term;
        fit.current = fitAddon;
        term.onData((data) => send({ type: 'input', data }));
        term.attachCustomKeyEventHandler((event) => {
          if (event.ctrlKey && event.key.toLowerCase() === 'c' && event.type === 'keydown') {
            send({ type: 'signal', signal: 'SIGINT' });
            return false;
          }
          return true;
        });
        observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
        observer?.observe(host.current);
        window.setTimeout(() => {
          resize();
          connect();
        }, 0);
      })
      .catch((error) => onError((error as Error).message));
    return () => {
      disposed = true;
      ended.current = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      observer?.disconnect();
      socket.current?.close();
      terminal.current?.dispose();
      terminal.current = null;
    };
  }, [session.id]);

  function connect() {
    if (ended.current) return;
    if (socket.current) {
      socket.current.onclose = null;
      socket.current.close();
    }
    setConnection(attempts.current ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(websocketUrl(`/assist/v3/terminal-sessions/${session.id}/ws`));
    socket.current = ws;
    ws.onopen = () => {
      attempts.current = 0;
      setConnection('connected');
      resize();
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string; session?: TerminalSession };
      if (message.type === 'output' && message.data) {
        if ((message as { replay?: boolean }).replay) terminal.current?.reset();
        terminal.current?.write(message.data);
      }
      if (message.type === 'status' && message.session) {
        if (terminalState(message.session.status)) {
          ended.current = true;
          setConnection('closed');
        }
        onSession(message.session);
      }
      if (message.type === 'exit' && message.session) {
        ended.current = true;
        setConnection('closed');
        onSession(message.session);
      }
    };
    ws.onerror = () => setConnection('reconnecting');
    ws.onclose = (event) => {
      if (ended.current || (event.code === 1000 && terminalState(session.status))) {
        setConnection('closed');
        return;
      }
      attempts.current += 1;
      if (attempts.current > 6) {
        setConnection('closed');
        onError('终端连接重连失败');
        return;
      }
      reconnectTimer.current = window.setTimeout(connect, Math.min(5_000, 400 * 2 ** attempts.current));
    };
  }
  function send(value: Record<string, unknown>) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value));
  }
  function resize() {
    try {
      fit.current?.fit();
      const term = terminal.current;
      if (term) send({ type: 'resize', cols: term.cols, rows: term.rows });
    } catch {
      /* hidden panel */
    }
  }
  async function stop() {
    try {
      const value = await api<TerminalSession>(
        `/assist/v3/terminal-sessions/${session.id}/stop`,
        json('POST', undefined, '停止终端会话')
      );
      ended.current = true;
      onSession(value);
      socket.current?.close();
      setConnection('closed');
    } catch (error) {
      onError((error as Error).message);
    }
  }
  function reconnect() {
    ended.current = false;
    attempts.current = 0;
    connect();
  }
  const reviewable = terminalState(session.status);
  return (
    <section className="terminal-panel">
      <header>
        <button className="row-icon" aria-label="返回对话" onClick={onBack}>
          <ArrowLeft size={16} />
        </button>
        <TerminalSquare size={17} />
        <div>
          <strong>Codex 命令行</strong>
          <small>
            {runtimeLabel(session.runtime)} · {terminalStatusLabel(session.status)} · 工作树{' '}
            {session.worktree_id.slice(0, 10)}
          </small>
        </div>
        <span className={`terminal-connection ${connection}`}>
          <i />
          {connectionLabel(connection)}
        </span>
        <button className="button secondary" onClick={() => send({ type: 'signal', signal: 'SIGINT' })}>
          中断
        </button>
        <button
          className="row-icon"
          aria-label="重新连接终端"
          disabled={connection === 'connected'}
          onClick={reconnect}
        >
          <RefreshCw size={15} />
        </button>
      </header>
      <div className="xterm-host" ref={host} />
      <footer>
        <span>
          {session.output_truncated
            ? '预览已截断；完整输出已保存为产物。'
            : session.artifact_file_ref_id
              ? `产物 ${session.artifact_file_ref_id}`
              : '终端输出经过凭据脱敏。'}
        </span>
        {!reviewable && (
          <button className="button danger" onClick={stop}>
            <Ban size={14} />
            停止会话
          </button>
        )}
        {reviewable && (
          <button className="button primary" disabled={reviewDisabled} onClick={onReview}>
            <GitCompare size={14} />
            {reviewDisabled ? '命令行变更已回退' : '审查命令行变更'}
          </button>
        )}
        {connection !== 'connected' && !reviewable && (
          <button className="button secondary" onClick={reconnect}>
            <PlugZap size={14} />
            重新连接
          </button>
        )}
      </footer>
    </section>
  );
}

function terminalState(value: string) {
  return ['exited', 'failed', 'stopped', 'interrupted'].includes(value);
}
function connectionLabel(value: string) {
  return (
    (
      { connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', closed: '已关闭' } as Record<
        string,
        string
      >
    )[value] || '连接状态未知'
  );
}
function terminalStatusLabel(value: string) {
  return (
    (
      {
        starting: '正在启动',
        running: '运行中',
        exited: '已退出',
        failed: '失败',
        stopped: '已停止',
        interrupted: '已中断'
      } as Record<string, string>
    )[value] || '状态未知'
  );
}
function runtimeLabel(value: string) {
  return (
    (
      { linux_container: 'Linux 容器', windows_bridge: 'Windows 本机', host_dev: '宿主机开发环境' } as Record<
        string,
        string
      >
    )[value] || '终端环境'
  );
}
