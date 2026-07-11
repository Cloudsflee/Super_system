import { Check, Clock3, GitPullRequest, ShieldAlert, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError } from '../../api/client';
import { keys } from '../../api/queries';
import type { ApprovalDecision, ApprovalItem } from '../../api/types';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';
import { decideApproval, useApprovals } from './approval-api';

export function ApprovalPrompt({ projectId }: { projectId?: string }) {
  const { proposalId, showProposal, toast } = useUi();
  const client = useQueryClient();
  // Resolve by id across projects so a route/project switch cannot orphan an interrupting prompt.
  const approvals = useApprovals(undefined, Boolean(proposalId));
  const ordered = approvals.data?.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const item = proposalId === 'latest' ? ordered?.find((candidate) => candidate.attention_state !== 'resolved') : ordered?.find((candidate) => candidate.id === proposalId);
  const decision = useMutation({
    mutationFn: ({ value, target }: { value: ApprovalDecision; target: ApprovalItem }) => decideApproval(target, value, value === 'reject' ? '用户从即时审批弹窗拒绝' : undefined),
    onSuccess: async (result, variables) => {
      await invalidateApprovalState(client, projectId);
      if (variables.value === 'approve_apply' && (result.applied || result.proposal)) {
        const proposal = result.proposal || (variables.target.type === 'change_proposal' ? { id: result.item?.id || variables.target.id } : undefined);
        window.dispatchEvent(new CustomEvent('aiws:proposal-applied', { detail: { proposal, applied: result.applied } }));
      }
      showProposal(null);
      toast(variables.value === 'defer' ? '已暂定并移入审批中心' : variables.value === 'reject' ? '变更已拒绝' : '变更已批准并应用');
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409 && error.payload.error === 'proposal_stale') {
        toast('提案已过期，已加载最新 revision，请重新审查', 'error');
        await approvals.refetch();
        return;
      }
      toast(error.message, 'error');
    }
  });

  function decide(value: ApprovalDecision) {
    if (item && !decision.isPending) decision.mutate({ value, target: item });
  }

  useEffect(() => {
    if (!proposalId) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      decide('defer');
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [proposalId, item?.id, item?.revision, decision.isPending]);

  if (!proposalId) return null;
  return (
    <div className="approval-prompt-layer">
      <section className="approval-prompt" role="dialog" aria-modal="false" aria-labelledby="approval-prompt-title">
        {!item ? <div className="approval-prompt-loading">
          <ShieldAlert size={22} />
          <strong>{approvals.isError ? '审批项目加载失败' : '正在加载审批项目'}</strong>
          {approvals.isError && <><small>{approvals.error.message}</small><button className="button secondary" onClick={() => approvals.refetch()}>重试</button></>}
        </div> : <>
          <header><div className="approval-kind">{item.type === 'runtime_approval' ? <ShieldAlert size={17} /> : <GitPullRequest size={17} />}<span>{item.type === 'runtime_approval' ? 'RUNTIME APPROVAL' : 'CHANGE PROPOSAL'}</span></div><IconButton label="暂定并关闭" disabled={decision.isPending} onClick={() => decide('defer')}><X size={17} /></IconButton></header>
          <div className="approval-prompt-body">
            <div className="approval-meta"><span className={`status ${item.status}`}>{item.status}</span><span>revision {item.revision}</span>{item.change_type && <span>{item.change_type}</span>}</div>
            <h2 id="approval-prompt-title">{item.title}</h2>
            <p>{item.summary}</p>
            {(item.before_json != null || item.after_json != null) && <details><summary>查看变更内容</summary><div className="approval-change"><section><strong>变更前</strong><pre>{JSON.stringify(item.before_json ?? null, null, 2)}</pre></section><section><strong>变更后</strong><pre>{JSON.stringify(item.after_json ?? null, null, 2)}</pre></section></div></details>}
            {item.impact?.length ? <div className="approval-chip-line"><strong>影响</strong>{item.impact.map((value) => <span key={value}>{value}</span>)}</div> : null}
            {item.risks?.length ? <div className="approval-risks"><strong>风险</strong><ul>{item.risks.map((value) => <li key={value}>{value}</li>)}</ul></div> : null}
          </div>
          <footer><button className="button secondary" disabled={decision.isPending} onClick={() => decide('defer')}><Clock3 size={15} />暂定</button><button className="button danger" disabled={decision.isPending} onClick={() => decide('reject')}><X size={15} />拒绝</button><button className="button primary" disabled={decision.isPending} onClick={() => decide('approve_apply')}><Check size={15} />{decision.isPending ? '正在处理' : '批准并应用'}</button></footer>
        </>}
      </section>
    </div>
  );
}

export async function invalidateApprovalState(client: ReturnType<typeof useQueryClient>, projectId?: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: keys.approvals() }),
    client.invalidateQueries({ queryKey: keys.approvals(projectId) }),
    client.invalidateQueries({ queryKey: keys.proposals(projectId) }),
    ...(projectId ? [client.invalidateQueries({ queryKey: keys.project(projectId) })] : []),
    client.invalidateQueries({ queryKey: keys.setup }),
    client.invalidateQueries({ queryKey: ['node-workspace'] }),
    client.invalidateQueries({ queryKey: ['codex-profiles'] }),
    client.invalidateQueries({ queryKey: ['review'] })
  ]);
}
