import { AlertTriangle, CheckCircle2, Eye, MapPin, MessageSquareMore, Pencil, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AssistOperation } from '../../api/types';

export function OperationReceipt({ operation, busy, onConfirm, onUndo, onRevise = () => undefined, onContinue = () => undefined }: { operation: AssistOperation; busy: boolean; onConfirm: (approved: boolean) => void; onUndo: (force?: boolean) => void; onRevise?: () => void; onContinue?: () => void }) {
  const conflict = operation.conflict;
  const [confirmForce, setConfirmForce] = useState(false);
  const status = operation.undone_by ? 'undone' : operation.status;
  useEffect(() => setConfirmForce(false), [operation.id, operation.revision, operation.status]);
  return <article className={`operation-receipt ${status}`}>
    <header>{status === 'committed' || status === 'undone' ? <CheckCircle2 size={14} /> : status === 'conflicted' ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}<span><strong>{operation.summary || operationLabel(operation.capability_id, operation.tool)}</strong><small>{operation.target_label || operation.target_id} · {riskLabel(operation.risk)}</small></span><i>{operationStatusLabel(status)}</i></header>
    {operation.status === 'pending_confirmation' && <footer><button disabled={busy} onClick={() => onConfirm(false)}><X size={13} />拒绝</button><button className="primary" disabled={busy} onClick={() => onConfirm(true)}><ShieldCheck size={13} />确认执行</button></footer>}
    {operation.status === 'committed' && <div className="operation-values"><Value label="查看前后值" before={operation.before_value} after={operation.after_value} /></div>}
    {operation.status === 'committed' && !operation.inverse_of && <footer><a className="operation-route-link" href={locatedRoute(operation)}><MapPin size={13} />定位</a><button disabled={busy} onClick={onRevise}><Pencil size={13} />直接编辑</button><button disabled={busy} onClick={onContinue}><MessageSquareMore size={13} />让 Assist 继续修改</button>{!operation.undone_by && <button disabled={busy} onClick={() => onUndo(false)}><RotateCcw size={13} />撤销</button>}</footer>}
    {operation.status === 'pending' && operation.inverse_of && <footer><a className="operation-route-link" href={localRoute(operation.route)}><RotateCcw size={13} />前往页面并撤回</a></footer>}
    {conflict && <div className="operation-conflict"><Value label="before" value={conflict.before} /><Value label="after" value={conflict.after} /><Value label="current" value={conflict.current} />{operation.inverse_of ? confirmForce ? <div className="operation-force-confirm" role="alert"><span>当前值已变化，强制撤回会覆盖它。</span><button disabled={busy} onClick={() => setConfirmForce(false)}>取消</button><button className="danger" disabled={busy} onClick={() => { setConfirmForce(false); onUndo(true); }}>确认强制撤回</button></div> : <button className="danger" disabled={busy} onClick={() => setConfirmForce(true)}>强制撤回</button> : <button disabled={busy} onClick={onRevise}><Pencil size={13} />基于当前值重新编辑</button>}</div>}
  </article>;
}
function Value({ label, value, before, after }: { label: string; value?: unknown; before?: unknown; after?: unknown }) { return <details><summary><Eye size={12} />{label}</summary>{before !== undefined || after !== undefined ? <div className="operation-value-grid"><section><span>修改前</span><pre>{JSON.stringify(before, null, 2)}</pre></section><section><span>修改后</span><pre>{JSON.stringify(after, null, 2)}</pre></section></div> : <pre>{JSON.stringify(value, null, 2)}</pre>}</details>; }
function localRoute(value: string) { return /^\/(?!\/)/.test(value) ? value : '/'; }
function locatedRoute(operation: AssistOperation) { const route = localRoute(operation.locator?.route || operation.route); const target = operation.locator?.target_id || operation.target_id; return target ? `${route}#${encodeURIComponent(target)}` : route; }
function operationLabel(value?: string | null, tool?: string) { const capability = value || (tool?.endsWith('set_field') ? 'surface.field.set' : tool?.endsWith('set_filter') ? 'surface.filter.set' : tool?.endsWith('select_tab') ? 'surface.tab.select' : ''); return ({ 'surface.field.set': '已更新页面字段', 'surface.filter.set': '已更新页面筛选', 'surface.tab.select': '已切换页面视图' } as Record<string, string>)[capability] || '页面操作'; }
function riskLabel(value: string) { return ({ low: '低风险', reversible: '可撤销', high: '需确认', destructive: '删除操作', delete: '删除操作', submit: '提交操作', permission: '权限变更', external: '外部操作' } as Record<string, string>)[value] || '受控操作'; }
function operationStatusLabel(value: string) { return ({ committed: '已执行', undone: '已撤回', conflicted: '冲突', pending_confirmation: '待确认', pending: '待执行', rejected: '已拒绝', failed: '执行失败' } as Record<string, string>)[value] || '处理中'; }
