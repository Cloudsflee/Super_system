import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Copy,
  Filter,
  LoaderCircle,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react';
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode
} from 'react';
import { IconButton } from '../components/common/IconButton';
import {
  clearOperations,
  diagnosticJson,
  dismissOperation,
  operationRecords,
  operationRetry,
  recordSystemFailure,
  subscribeOperations,
  type OperationRecord,
  type OperationStatus
} from './operation-store';

type FeedbackContextValue = { open: boolean; setOpen: (value: boolean) => void; failedCount: number };
const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function OperationFeedbackProvider({ children }: { children: ReactNode }) {
  const records = useSyncExternalStore(subscribeOperations, operationRecords, operationRecords);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const failedCount = records.filter((item) => item.status === 'failed').length;

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const onError = (event: ErrorEvent) => recordSystemFailure('界面运行异常', event.error || event.message);
    const onRejection = (event: PromiseRejectionEvent) =>
      recordSystemFailure('未处理的异步异常', event.reason, '异步处理');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  const value = useMemo(() => ({ open, setOpen, failedCount }), [open, failedCount]);
  return (
    <FeedbackContext.Provider value={value}>
      <RootErrorBoundary>{children}</RootErrorBoundary>
      <OperationNotices records={records} now={Date.now() + tick * 0} onOpen={() => setOpen(true)} />
      <DiagnosticsPanel records={records} open={open} onClose={() => setOpen(false)} />
    </FeedbackContext.Provider>
  );
}

export function useOperationFeedback() {
  const value = useContext(FeedbackContext);
  return value || { open: false, setOpen: () => undefined, failedCount: 0 };
}

export function OperationDiagnosticsButton({ className = '' }: { className?: string }) {
  const feedback = useOperationFeedback();
  return (
    <span className={`operation-entry ${className}`}>
      <IconButton label="操作与诊断" active={feedback.open} onClick={() => feedback.setOpen(!feedback.open)}>
        <Activity size={18} />
      </IconButton>
      {feedback.failedCount > 0 && (
        <span className="operation-badge" aria-label={`${feedback.failedCount} 个失败操作`}>
          {Math.min(feedback.failedCount, 99)}
        </span>
      )}
    </span>
  );
}

function OperationNotices({ records, now, onOpen }: { records: OperationRecord[]; now: number; onOpen: () => void }) {
  const visible = records
    .filter(
      (record) =>
        record.feedback === 'foreground' &&
        (record.status === 'running' ||
          record.status === 'failed' ||
          (record.status === 'succeeded' && now - Date.parse(record.endedAt || '') < 4500))
    )
    .slice(0, 3);
  if (!visible.length) return null;
  return (
    <div className="operation-notices" aria-live="polite">
      {visible.map((record) => (
        <div key={record.id} className={`operation-notice ${record.status}`}>
          {record.status === 'running' ? (
            <LoaderCircle className="spin" size={17} />
          ) : record.status === 'succeeded' ? (
            <CheckCircle2 size={17} />
          ) : (
            <CircleAlert size={17} />
          )}
          <button className="operation-notice-main" onClick={onOpen}>
            <strong>{record.name}</strong>
            <span>{record.status === 'failed' ? record.reason : record.phase}</span>
          </button>
          {record.status === 'failed' && (
            <IconButton label="关闭错误" onClick={() => dismissOperation(record.id)}>
              <X size={14} />
            </IconButton>
          )}
        </div>
      ))}
    </div>
  );
}

function DiagnosticsPanel({
  records,
  open,
  onClose
}: {
  records: OperationRecord[];
  open: boolean;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<'all' | OperationStatus>('all');
  const [copied, setCopied] = useState('');
  const rows = filter === 'all' ? records : records.filter((record) => record.status === filter);
  async function copy(value: string, id: string) {
    await navigator.clipboard.writeText(value);
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? '' : current)), 1800);
  }
  return (
    <>
      {open && <button className="operation-scrim" aria-label="关闭操作与诊断" onClick={onClose} />}
      <aside className={`operation-panel ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
        <header>
          <div>
            <span className="overline">操作记录</span>
            <h2>
              <Activity size={18} />
              操作与诊断
            </h2>
          </div>
          <div>
            <IconButton
              label={copied === 'all' ? '已复制' : '复制全部诊断'}
              onClick={() => copy(diagnosticJson(records), 'all')}
            >
              <Clipboard size={17} />
            </IconButton>
            <IconButton label="清空诊断" disabled={!records.length} onClick={clearOperations}>
              <Trash2 size={17} />
            </IconButton>
            <IconButton label="关闭操作与诊断" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        </header>
        <nav className="operation-filters" aria-label="诊断状态筛选">
          <Filter size={14} />
          {(['all', 'running', 'failed', 'succeeded', 'cancelled'] as const).map((status) => (
            <button key={status} className={filter === status ? 'active' : ''} onClick={() => setFilter(status)}>
              {statusLabel(status)}
            </button>
          ))}
        </nav>
        <div className="operation-list">
          {rows.map((record) => (
            <OperationRow
              key={record.id}
              record={record}
              copied={copied === record.id}
              onCopy={() => copy(diagnosticJson([record]), record.id)}
            />
          ))}
          {!rows.length && (
            <div className="operation-empty">
              <CheckCircle2 size={22} />
              <span>暂无操作记录</span>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function OperationRow({ record, copied, onCopy }: { record: OperationRecord; copied: boolean; onCopy: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const retry = operationRetry(record.id);
  return (
    <article className={`operation-row ${record.status}`}>
      <button className="operation-summary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <StatusIcon status={record.status} />
        <span>
          <strong>{record.name}</strong>
          <small>
            {record.phase} · {duration(record)}
          </small>
        </span>
        <ChevronDown size={15} />
      </button>
      {expanded && (
        <div className="operation-detail">
          {record.reason && (
            <p>
              <b>原因</b>
              <span>{record.reason}</span>
            </p>
          )}
          {record.action && (
            <p>
              <b>建议</b>
              <span>{record.action}</span>
            </p>
          )}
          <dl>
            <div>
              <dt>状态</dt>
              <dd>{statusLabel(record.status)}</dd>
            </div>
            <div>
              <dt>阶段</dt>
              <dd>{record.phase || '-'}</dd>
            </div>
            <div>
              <dt>错误码</dt>
              <dd>{record.errorCode || '-'}</dd>
            </div>
            <div>
              <dt>HTTP</dt>
              <dd>{record.httpStatus ?? '-'}</dd>
            </div>
            <div>
              <dt>请求标识</dt>
              <dd>{record.requestId || '-'}</dd>
            </div>
            <div>
              <dt>请求</dt>
              <dd>
                {record.method} {record.path}
              </dd>
            </div>
          </dl>
          <div className="operation-row-actions">
            <button className="button" onClick={onCopy}>
              <Copy size={14} />
              {copied ? '已复制' : '复制详情'}
            </button>
            {record.retryable && retry && (
              <button className="button" onClick={() => void retry()}>
                <RotateCcw size={14} />
                重试
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function StatusIcon({ status }: { status: OperationStatus }) {
  if (status === 'running') return <LoaderCircle className="spin" size={17} />;
  if (status === 'succeeded') return <CheckCircle2 size={17} />;
  return <CircleAlert size={17} />;
}

function statusLabel(status: 'all' | OperationStatus) {
  return { all: '全部', running: '进行中', failed: '失败', succeeded: '成功', cancelled: '已取消' }[status];
}
function duration(record: OperationRecord) {
  const value = record.durationMs ?? Math.max(0, Date.now() - Date.parse(record.startedAt));
  return value < 1000 ? `${value} 毫秒` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    recordSystemFailure('页面渲染失败', new Error(`${error.message}\n${info.componentStack || ''}`), '页面渲染');
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="operation-fatal">
        <CircleAlert size={28} />
        <h1>页面暂时无法显示</h1>
        <p>错误已写入当前会话的操作诊断。</p>
        <button className="button primary" onClick={() => window.location.reload()}>
          <RotateCcw size={15} />
          重新加载
        </button>
      </main>
    );
  }
}
