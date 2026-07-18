import { AlertTriangle, CheckCircle2, Eye, GitPullRequest, MapPin, MessageSquareMore, MoreHorizontal, Pencil, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistOperation } from '../../api/types';
import { useContextMenu, useContextMenuResolver, type ContextMenuAction } from '../../components/common/ContextMenu';
import { IconButton } from '../../components/common/IconButton';
import { useUi } from '../../state/ui';

export function OperationReceipt({ operation, busy, onConfirm, onUndo, onRevise = () => undefined, onContinue = () => undefined }: { operation: AssistOperation; busy: boolean; onConfirm: (approved: boolean) => void; onUndo: (force?: boolean) => void; onRevise?: () => void; onContinue?: () => void }) {
  const conflict = operation.conflict;
  const showProposal = useUi((state) => state.showProposal);
  const menu = useContextMenu(), more = useRef<HTMLButtonElement>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const status = operation.undone_by ? 'undone' : operation.status;
  useEffect(() => setConfirmForce(false), [operation.id, operation.revision, operation.status]);
  const menuActions = useMemo<ContextMenuAction[]>(() => {
    const actions: ContextMenuAction[] = [];
    if (operation.result_kind === 'change_proposal' || operation.status === 'committed') actions.push({ id: `operation.${operation.id}.locate`, label: operation.result_kind === 'change_proposal' ? '定位工作流' : '定位操作', icon: MapPin, onSelect: () => navigateTo(locatedRoute(operation)) });
    if (operation.status === 'committed' && !operation.inverse_of) actions.push(
      { id: `operation.${operation.id}.revise`, label: '直接编辑', icon: Pencil, disabled: busy, onSelect: onRevise },
      { id: `operation.${operation.id}.continue`, label: '让 Assist 继续修改', icon: MessageSquareMore, disabled: busy, onSelect: onContinue },
      ...(!operation.undone_by ? [{ id: `operation.${operation.id}.undo`, label: '撤销', icon: RotateCcw, disabled: busy, onSelect: () => onUndo(false) } satisfies ContextMenuAction] : [])
    );
    return actions;
  }, [busy, onContinue, onRevise, onUndo, operation]);
  useContextMenuResolver(useCallback((context) => context.target.closest<HTMLElement>('[data-operation-receipt]')?.dataset.operationReceipt === operation.id ? menuActions : [], [menuActions, operation.id]));
  function openMenu() { const trigger = more.current; if (!trigger) return; const rect = trigger.getBoundingClientRect(); menu.open(menuActions, { x: rect.right - 8, y: rect.bottom + 5 }, trigger); }
  if (operation.result_kind === 'change_proposal') {
    const proposalStatus = operation.proposal_status || 'pending';
    return <article className={`operation-receipt proposal-${proposalStatus}`} data-operation-receipt={operation.id} tabIndex={0}>
      <header>{proposalStatus === 'applied' ? <CheckCircle2 size={14} /> : ['rejected', 'superseded', 'stale'].includes(proposalStatus) ? <AlertTriangle size={14} /> : <GitPullRequest size={14} />}<span><strong>{operation.summary || `已创建工作流变更提案 · ${operation.target_label || operation.target_id}`}</strong><small>{operation.target_label || operation.target_id}{operation.proposal_destructive ? ' · 包含删除' : ''}</small></span><i>{proposalStatusLabel(proposalStatus)}</i>{menuActions.length > 0 && <IconButton ref={more} label="更多操作" aria-haspopup="menu" onClick={openMenu}><MoreHorizontal size={14} /></IconButton>}</header>
      <footer><a className="operation-route-link" href={locatedRoute(operation)}><MapPin size={13} />定位工作流</a><button disabled={busy || !operation.proposal_id} onClick={() => showProposal(operation.proposal_id || null)}><GitPullRequest size={13} />审查提案</button></footer>
    </article>;
  }
  return <article className={`operation-receipt ${status}`} data-operation-receipt={operation.id} tabIndex={0}>
    <header>{status === 'committed' || status === 'undone' ? <CheckCircle2 size={14} /> : status === 'conflicted' ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}<span><strong>{operation.summary || operationLabel(operation.capability_id, operation.tool)}</strong><small>{operation.target_label || operation.target_id} · {riskLabel(operation.risk)}</small></span><i>{operationStatusLabel(status)}</i>{menuActions.length > 0 && <IconButton ref={more} label="更多操作" aria-haspopup="menu" onClick={openMenu}><MoreHorizontal size={14} /></IconButton>}</header>
    {operation.status === 'pending_confirmation' && <footer><button disabled={busy} onClick={() => onConfirm(false)}><X size={13} />拒绝</button><button className="primary" disabled={busy} onClick={() => onConfirm(true)}><ShieldCheck size={13} />确认执行</button></footer>}
    {operation.status === 'committed' && <div className="operation-values"><Value label="查看前后值" before={operation.before_value} after={operation.after_value} /></div>}
    {operation.status === 'pending' && operation.inverse_of && <footer><a className="operation-route-link" href={localRoute(operation.route)}><RotateCcw size={13} />前往页面并撤回</a></footer>}
    {conflict && <div className="operation-conflict"><Value label="before" value={conflict.before} /><Value label="after" value={conflict.after} /><Value label="current" value={conflict.current} />{operation.inverse_of ? confirmForce ? <div className="operation-force-confirm" role="alert"><span>当前值已变化，强制撤回会覆盖它。</span><button disabled={busy} onClick={() => setConfirmForce(false)}>取消</button><button className="danger" disabled={busy} onClick={() => { setConfirmForce(false); onUndo(true); }}>确认强制撤回</button></div> : <button className="danger" disabled={busy} onClick={() => setConfirmForce(true)}>强制撤回</button> : <button disabled={busy} onClick={onRevise}><Pencil size={13} />基于当前值重新编辑</button>}</div>}
  </article>;
}
function Value({ label, value, before, after }: { label: string; value?: unknown; before?: unknown; after?: unknown }) { return <details><summary><Eye size={12} />{label}</summary>{before !== undefined || after !== undefined ? <div className="operation-value-grid"><section><span>修改前</span><pre>{JSON.stringify(before, null, 2)}</pre></section><section><span>修改后</span><pre>{JSON.stringify(after, null, 2)}</pre></section></div> : <pre>{JSON.stringify(value, null, 2)}</pre>}</details>; }
function localRoute(value: string) { return /^\/(?!\/)/.test(value) ? value : '/'; }
function navigateTo(route: string) { window.history.pushState({}, '', route); window.dispatchEvent(new PopStateEvent('popstate')); }
function locatedRoute(operation: AssistOperation) { const route = localRoute(operation.locator?.route || operation.route); const target = operation.locator?.target_id || operation.target_id; return target ? `${route}#${encodeURIComponent(target)}` : route; }
function operationLabel(value?: string | null, tool?: string) { const capability = value || (tool?.endsWith('set_field') ? 'surface.field.set' : tool?.endsWith('set_filter') ? 'surface.filter.set' : tool?.endsWith('select_tab') ? 'surface.tab.select' : ''); return ({ 'surface.field.set': '已更新页面字段', 'surface.filter.set': '已更新页面筛选', 'surface.tab.select': '已切换页面视图' } as Record<string, string>)[capability] || '页面操作'; }
function riskLabel(value: string) { return ({ low: '低风险', reversible: '可撤销', high: '需确认', destructive: '删除操作', delete: '删除操作', submit: '提交操作', permission: '权限变更', external: '外部操作' } as Record<string, string>)[value] || '受控操作'; }
function operationStatusLabel(value: string) { return ({ committed: '已执行', undone: '已撤回', conflicted: '冲突', pending_confirmation: '待确认', pending: '待执行', rejected: '已拒绝', failed: '执行失败' } as Record<string, string>)[value] || '处理中'; }
function proposalStatusLabel(value: string) { return ({ pending: '待审批', approved: '已批准', applied: '已应用', rejected: '已拒绝', superseded: '已替代', stale: '已过期' } as Record<string, string>)[value] || '提案状态'; }
