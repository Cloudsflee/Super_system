import { AlertTriangle, CheckCircle2, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AssistOperation } from '../../api/types';

export function OperationReceipt({ operation, busy, onConfirm, onUndo }: { operation: AssistOperation; busy: boolean; onConfirm: (approved: boolean) => void; onUndo: (force?: boolean) => void }) {
  const conflict = operation.conflict;
  const [confirmForce, setConfirmForce] = useState(false);
  const status = operation.undone_by ? 'undone' : operation.status;
  useEffect(() => setConfirmForce(false), [operation.id, operation.revision, operation.status]);
  return <article className={`operation-receipt ${status}`}>
    <header>{status === 'committed' || status === 'undone' ? <CheckCircle2 size={14} /> : status === 'conflicted' ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}<span><strong>{operation.tool}</strong><small>{operation.target_id} · {operation.risk}</small></span><i>{status}</i></header>
    {operation.status === 'pending_confirmation' && <footer><button disabled={busy} onClick={() => onConfirm(false)}><X size={13} />拒绝</button><button className="primary" disabled={busy} onClick={() => onConfirm(true)}><ShieldCheck size={13} />确认执行</button></footer>}
    {operation.status === 'committed' && !operation.inverse_of && !operation.undone_by && <footer><button disabled={busy} onClick={() => onUndo(false)}><RotateCcw size={13} />Undo</button></footer>}
    {operation.status === 'pending' && operation.inverse_of && <footer><a className="operation-route-link" href={localRoute(operation.route)}><RotateCcw size={13} />前往页面并撤回</a></footer>}
    {conflict && <div className="operation-conflict"><Value label="before" value={conflict.before} /><Value label="after" value={conflict.after} /><Value label="current" value={conflict.current} />{confirmForce ? <div className="operation-force-confirm" role="alert"><span>当前值已变化，强制撤回会覆盖它。</span><button disabled={busy} onClick={() => setConfirmForce(false)}>取消</button><button className="danger" disabled={busy} onClick={() => { setConfirmForce(false); onUndo(true); }}>确认强制撤回</button></div> : <button className="danger" disabled={busy} onClick={() => setConfirmForce(true)}>强制撤回</button>}</div>}
  </article>;
}
function Value({ label, value }: { label: string; value: unknown }) { return <details><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>; }
function localRoute(value: string) { return /^\/(?!\/)/.test(value) ? value : '/'; }
