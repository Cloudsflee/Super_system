import { Check, Copy, RotateCcw, Square, Terminal, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CodexBuildOperation } from '../../api/types';
import { displayStatus } from '../../components/common/display-labels';

type Props = {
  operation: CodexBuildOperation;
  connection: 'connected' | 'reconnecting';
  busy: boolean;
  onCancel: () => void;
  onCopy: () => void;
  onRetry: () => void;
};

export function CodexBuildProgress({ operation, connection, busy, onCancel, onCopy, onRetry }: Props) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (operation.status !== 'running') return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [operation.status]);
  const elapsed = operation.status === 'running' ? Date.now() - Date.parse(operation.started_at) : operation.elapsed_ms;
  return <div className={`codex-build-progress ${operation.status}`} aria-live="polite">
    <header><div><Terminal size={16} /><span><strong>{operation.phase.label}</strong><small>{formatElapsed(elapsed)} · {operation.image}</small></span></div><span className={`status ${operation.status === 'completed' ? 'ready' : operation.status === 'running' ? 'running' : 'failed'}`}>{displayStatus(operation.status)}</span></header>
    <ol aria-label="构建阶段">{['运行时检查', '准备构建', '构建镜像', '验证镜像', '完成'].map((label, index) => <li key={label} className={index + 1 < operation.phase.index || operation.status === 'completed' ? 'done' : index + 1 === operation.phase.index ? 'active' : ''}><i>{index + 1 < operation.phase.index || operation.status === 'completed' ? <Check size={11} /> : index + 1}</i><span>{label}</span></li>)}</ol>
    {connection === 'reconnecting' && operation.status === 'running' && <div className="codex-build-connection"><WifiOff size={13} />事件流重连中</div>}
    {operation.message && <p className="codex-build-message">{buildText(operation.message)}</p>}
    <pre aria-label="Docker 构建最新日志">{operation.logs.length ? operation.logs.slice(-12).map((item) => item.text).join('\n') : '等待 Docker 构建输出...'}</pre>
    {operation.status === 'failed' && <div className="codex-build-error"><strong>{buildText(operation.message)}</strong>{operation.action && <span>{buildText(operation.action)}</span>}<code>{operation.error_code}</code></div>}
    {operation.status === 'cancelled' && <div className="codex-build-error"><strong>{buildText(operation.message)}</strong></div>}
    <footer>
      <button className="button" onClick={onCopy}><Copy size={14} />复制诊断</button>
      {operation.status === 'running' && <button className="button danger" onClick={onCancel}><Square size={13} />取消</button>}
      {operation.status !== 'running' && operation.status !== 'completed' && <button className="button primary" disabled={busy} onClick={onRetry}><RotateCcw size={14} />重试</button>}
    </footer>
  </div>;
}

export function safeBuildDiagnostics(operation: CodexBuildOperation) {
  const mask = (value: string) => String(value || '').replace(/\b(sk-[a-z0-9_-]{8,})\b/gi, '***MASKED***').replace(/\b(api[_-]?key|token|authorization|password)(\s*[:=]\s*)([^\s]+)/gi, '$1$2***MASKED***');
  return {
    operation_id: operation.operation_id, image: operation.image, status: operation.status, phase: operation.phase,
    started_at: operation.started_at, completed_at: operation.completed_at || null, elapsed_ms: operation.elapsed_ms,
    error_code: operation.error_code || null, message: mask(operation.message || ''), action: mask(operation.action || ''),
    logs: operation.logs.slice(-200).map((item) => ({ at: item.at, stream: item.stream, text: mask(item.text) }))
  };
}

function formatElapsed(value: number) { const seconds = Math.max(0, Math.round(value / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
function buildText(value?: string | null) { return String(value || '').replace(/Docker Build\s*/gi, 'Docker 构建').replace(/Linux containers/gi, 'Linux 容器'); }
