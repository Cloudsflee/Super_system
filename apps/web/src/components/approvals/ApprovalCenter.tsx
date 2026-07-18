import { ArrowLeft, CheckCircle2, Clock3, Filter, GitPullRequest, ShieldAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ApprovalItemType } from '../../api/types';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';
import { useApprovals } from './approval-api';

type AttentionFilter = 'open' | 'interrupting' | 'queued' | 'resolved' | 'all';

export function ApprovalCenter({ projectId }: { projectId?: string }) {
  const ui = useUi();
  const approvals = useApprovals(projectId, ui.approvalCenterOpen);
  const [type, setType] = useState<'all' | ApprovalItemType>('all');
  const [attention, setAttention] = useState<AttentionFilter>('open');
  const rows = useMemo(() => (approvals.data || []).filter((item) => {
    const typeMatches = type === 'all' || item.type === type;
    const attentionMatches = attention === 'all' || (attention === 'open' ? item.attention_state !== 'resolved' : item.attention_state === attention);
    return typeMatches && attentionMatches;
  }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), [approvals.data, type, attention]);
  const selected = rows.find((item) => item.id === ui.approvalSelectionId) || rows[0];
  const explicitSelection = rows.some((item) => item.id === ui.approvalSelectionId);

  return (
    <aside className={`approval-center drawer right ${ui.approvalCenterOpen ? 'open' : ''}${explicitSelection ? ' mobile-detail' : ''}`} aria-hidden={!ui.approvalCenterOpen} inert={!ui.approvalCenterOpen}>
      <div className="drawer-head"><div><span className="overline">APPROVAL CENTER</span><h2><ShieldAlert size={18} />审批中心</h2></div><IconButton label="关闭审批中心" onClick={() => ui.openApprovalCenter(false)}><X size={18} /></IconButton></div>
      <div className="approval-filters"><Filter size={14} /><select aria-label="审批类型" value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="all">全部类型</option><option value="change_proposal">节点与配置变更</option><option value="runtime_approval">Runtime Approval</option></select><select aria-label="关注状态" value={attention} onChange={(event) => setAttention(event.target.value as AttentionFilter)}><option value="open">待处理</option><option value="interrupting">即时</option><option value="queued">已暂定</option><option value="resolved">已解决</option><option value="all">全部状态</option></select></div>
      <div className="approval-center-layout">
        <div className="approval-center-list">
          {rows.map((item) => <button key={`${item.type}:${item.id}`} className={selected?.id === item.id ? 'active' : ''} onClick={() => ui.selectApproval(item.id)}><i>{item.type === 'runtime_approval' ? <ShieldAlert size={15} /> : <GitPullRequest size={15} />}</i><span><strong>{item.title}</strong><small>{item.change_type || item.approval_type || item.type}</small></span><span className={`attention ${item.attention_state}`}>{item.attention_state === 'queued' ? <Clock3 size={12} /> : item.attention_state === 'resolved' ? <CheckCircle2 size={12} /> : <ShieldAlert size={12} />}{item.attention_state}</span></button>)}
          {!rows.length && <div className="quiet-empty"><CheckCircle2 size={23} /><p>{approvals.isLoading ? '正在加载审批项目' : '当前筛选下没有审批项目'}</p></div>}
        </div>
        {selected && <div className="approval-center-detail"><IconButton className="approval-mobile-back" label="返回审批列表" onClick={() => ui.selectApproval(null)}><ArrowLeft size={16} /></IconButton><div className="approval-meta"><span className={`status ${selected.status}`}>{selected.status}</span><span>revision {selected.revision}</span></div><h3>{selected.title}</h3><p>{selected.summary}</p>{selected.impact?.length ? <><h4>影响范围</h4><ul>{selected.impact.map((value) => <li key={value}>{value}</li>)}</ul></> : null}{selected.risks?.length ? <><h4>风险</h4><ul>{selected.risks.map((value) => <li key={value}>{value}</li>)}</ul></> : null}{selected.attention_state !== 'resolved' && <button className="button primary" onClick={() => { ui.openApprovalCenter(false); ui.showProposal(selected.id); }}>打开审批<GitPullRequest size={14} /></button>}</div>}
      </div>
    </aside>
  );
}
