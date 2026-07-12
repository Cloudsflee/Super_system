import { Check, ClipboardPenLine, ShieldCheck, ShieldX } from 'lucide-react';
import type { UiAction } from '../../api/types';

export function PageActionPreview({ action, busy, onApply }: { action: UiAction; busy: boolean; onApply: (action: UiAction) => void }) {
  const field = String(action.args.field_id || 'field'), value = String(action.args.value ?? '');
  return <article className={`page-action-preview ${action.status}`}>
    <header><ClipboardPenLine size={15} /><div><strong>{action.label}</strong><small>{field}</small></div><span>{statusLabel(action.status)}</span></header>
    <pre>{value || '（空值）'}</pre>
    <footer>
      <span>{action.status === 'ready' ? <><ShieldCheck size={13} />等待人工应用</> : action.status === 'completed' ? <><Check size={13} />已写入当前页面草稿</> : <><ShieldX size={13} />未能写入页面</>}</span>
      {action.status === 'ready' && <button className="button primary" disabled={busy} onClick={() => onApply(action)}><ClipboardPenLine size={14} />应用到页面</button>}
    </footer>
  </article>;
}

function statusLabel(status: string) { return status === 'ready' ? '待应用' : status === 'completed' ? '已应用' : status === 'failed' ? '失败' : status; }
