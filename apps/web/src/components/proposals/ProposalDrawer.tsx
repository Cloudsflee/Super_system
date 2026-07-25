import { Check, GitPullRequest, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, json } from '../../api/client';
import { keys } from '../../api/queries';
import type { ChangeProposal } from '../../api/types';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';
import { changeTypeLabel, displayStatus } from '../common/display-labels';

export function ProposalDrawer({ projectId }: { projectId?: string }) {
  const { proposalId, showProposal, toast } = useUi();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: keys.proposals(projectId), queryFn: () => api<ChangeProposal[]>(`/change-proposals${projectId ? `?project_id=${projectId}` : ''}`), enabled: Boolean(proposalId) });
  const ordered = list.data?.slice().reverse();
  const proposal = proposalId === 'latest' ? ordered?.find((item) => item.status === 'pending') || ordered?.[0] : list.data?.find((item) => item.id === proposalId);
  const decision = useMutation({
    mutationFn: async (action: 'approve' | 'reject' | 'apply') => api<{ proposal?: ChangeProposal; applied?: Record<string, unknown> } | ChangeProposal>(`/change-proposals/${proposal?.id}/${action}`, json('POST', action === 'reject' ? { reason: '用户从审批抽屉拒绝' } : {}, action === 'approve' ? '批准变更提案' : action === 'reject' ? '拒绝变更提案' : '应用变更提案')),
    onSuccess: (result, action) => { queryClient.invalidateQueries({ queryKey: keys.proposals(projectId) }); if (projectId) queryClient.invalidateQueries({ queryKey: keys.project(projectId) }); queryClient.invalidateQueries({ queryKey: keys.setup }); queryClient.invalidateQueries({ queryKey: ['node-workspace'] }); queryClient.invalidateQueries({ queryKey: ['codex-profiles'] }); queryClient.invalidateQueries({ queryKey: ['review'] }); if (action === 'apply' && 'proposal' in result) { window.dispatchEvent(new CustomEvent('aiws:proposal-applied', { detail: result })); if (result.applied?.type === 'node_run_authorization') showProposal(null); } toast('审批状态已更新'); },
    onError: (error) => toast(error.message, 'error')
  });
  return (
    <aside className={`proposal-drawer drawer right ${proposalId ? 'open' : ''}`} aria-hidden={!proposalId} inert={!proposalId}>
      <div className="drawer-head"><div><span className="overline">变更控制</span><h2><GitPullRequest size={18} />变更审批</h2></div><IconButton label="关闭审批" onClick={() => showProposal(null)}><X size={18} /></IconButton></div>
      <div className="proposal-list">
        {ordered?.map((item) => <button key={item.id} className={item.id === proposal?.id ? 'active' : ''} onClick={() => showProposal(item.id)}><span>{changeTypeLabel(item.change_type)}</span><strong>{item.title}</strong><small>{displayStatus(item.status)}</small></button>)}
      </div>
      {proposal ? <div className="proposal-detail"><div className="status-line"><span className={`status ${proposal.status}`}>{displayStatus(proposal.status)}</span><time>{new Date(proposal.created_at).toLocaleString()}</time></div><h3>{proposal.title}</h3><p>{proposal.summary}</p>{proposal.before_json != null && <><h4>变更前</h4><pre>{JSON.stringify(proposal.before_json, null, 2)}</pre></>}<h4>变更后</h4><pre>{JSON.stringify(proposal.after_json, null, 2)}</pre>{proposal.impact?.length ? <><h4>影响范围</h4><ul>{proposal.impact.map((item) => <li key={item}>{item}</li>)}</ul></> : null}{proposal.risks?.length ? <><h4>风险</h4><ul>{proposal.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul></> : null}{proposal.evidence_refs?.length ? <><h4>证据</h4><ul>{proposal.evidence_refs.map((item) => <li key={item}>{item}</li>)}</ul></> : null}<div className="drawer-actions">{proposal.status === 'pending' && <><button className="button secondary" disabled={decision.isPending} onClick={() => decision.mutate('reject')}><X size={16} />拒绝</button><button className="button primary" disabled={decision.isPending} onClick={() => decision.mutate('approve')}><Check size={16} />批准</button></>}{proposal.status === 'approved' && <button className="button primary" disabled={decision.isPending} onClick={() => decision.mutate('apply')}><Check size={16} />应用变更</button>}</div></div> : <div className="quiet-empty"><GitPullRequest size={23} /><p>没有待处理变更</p></div>}
    </aside>
  );
}
