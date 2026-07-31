import { ArrowLeft, Ban, GitCompare, PlugZap, RefreshCw, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TerminalSession } from '../../api/types';
import { isTerminalSessionEnded, TerminalRuntime, type TerminalConnectionState } from './TerminalRuntime';

type Props = {
  session: TerminalSession;
  reviewDisabled?: boolean;
  onSession: (value: TerminalSession) => void;
  onBack: () => void;
  onReview: () => void;
  onError: (message: string) => void;
};

export function TerminalPanel({ session, reviewDisabled, onSession, onBack, onReview, onError }: Props) {
  const runtime = useTerminalRuntime(session, onSession, onError),
    reviewable = isTerminalSessionEnded(session.status);
  return (
    <TerminalPanelView
      session={session}
      reviewDisabled={reviewDisabled}
      reviewable={reviewable}
      connection={runtime.connection}
      host={runtime.host}
      onBack={onBack}
      onReview={onReview}
      onInterrupt={() => runtime.send({ type: 'signal', signal: 'SIGINT' })}
      onReconnect={runtime.reconnect}
      onStop={runtime.stop}
    />
  );
}

function useTerminalRuntime(
  session: TerminalSession,
  onSession: (value: TerminalSession) => void,
  onError: (message: string) => void
) {
  const host = useRef<HTMLDivElement>(null),
    runtime = useRef<TerminalRuntime | null>(null),
    [connection, setConnection] = useState<TerminalConnectionState>('connecting');
  useEffect(() => {
    if (!host.current) return;
    const current = new TerminalRuntime(host.current, session, { onSession, onError, onConnection: setConnection });
    runtime.current = current;
    void current.start();
    return () => {
      current.dispose();
      if (runtime.current === current) runtime.current = null;
    };
  }, [session.id]);
  useEffect(() => {
    runtime.current?.update(session, { onSession, onError, onConnection: setConnection });
  }, [session, onSession, onError]);
  return {
    host,
    connection,
    send: (value: Record<string, unknown>) => runtime.current?.send(value),
    reconnect: () => runtime.current?.reconnect(),
    stop: () => void runtime.current?.stop()
  };
}

function TerminalPanelView({
  session,
  reviewDisabled,
  reviewable,
  connection,
  host,
  onBack,
  onReview,
  onInterrupt,
  onReconnect,
  onStop
}: Pick<Props, 'session' | 'reviewDisabled' | 'onBack' | 'onReview'> & {
  reviewable: boolean;
  connection: TerminalConnectionState;
  host: RefObject<HTMLDivElement | null>;
  onInterrupt: () => void;
  onReconnect: () => void;
  onStop: () => void;
}) {
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
        <button className="button secondary" onClick={onInterrupt}>
          中断
        </button>
        <button
          className="row-icon"
          aria-label="重新连接终端"
          disabled={connection === 'connected'}
          onClick={onReconnect}
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
          <button className="button danger" onClick={onStop}>
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
          <button className="button secondary" onClick={onReconnect}>
            <PlugZap size={14} />
            重新连接
          </button>
        )}
      </footer>
    </section>
  );
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
