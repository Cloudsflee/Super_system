import { Check, Clock3, GitPullRequest, ShieldAlert, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { keys } from '../../api/queries';
import type { ApprovalDecision, ApprovalItem } from '../../api/types';
import { useUi } from '../../state/ui';
import { IconButton } from '../common/IconButton';
import { changeTypeLabel, displayStatus } from '../common/display-labels';
import { decideApproval, useApprovals } from './approval-api';

export function ApprovalPrompt({ projectId }: { projectId?: string }) {
  const controller = useApprovalPromptController(projectId);
  if (!controller.proposalId) return null;
  return (
    <div className="approval-prompt-layer">
      <section className="approval-prompt" role="dialog" aria-modal="false" aria-labelledby="approval-prompt-title">
        {controller.item ? (
          <ApprovalContent
            item={controller.item}
            resolved={controller.resolved}
            pending={controller.pending}
            decisionError={controller.decisionError}
            onDecide={controller.decide}
          />
        ) : (
          <ApprovalLoading
            failed={controller.loadingFailed}
            error={controller.loadingError}
            onRetry={controller.retry}
            onClose={controller.close}
          />
        )}
      </section>
    </div>
  );
}

function useApprovalPromptController(projectId?: string) {
  const { proposalId, showProposal } = useUi();
  const client = useQueryClient();
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const deferWhenReady = useRef(false);
  // Resolve by id across projects so a route/project switch cannot orphan an interrupting prompt.
  const approvals = useApprovals(undefined, Boolean(proposalId));
  const ordered = approvals.data?.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const item =
    proposalId === 'latest'
      ? ordered?.find((candidate) => candidate.attention_state !== 'resolved')
      : ordered?.find((candidate) => candidate.id === proposalId);
  const resolved = item?.attention_state === 'resolved';
  const decision = useMutation({
    mutationFn: ({ value, target }: { value: ApprovalDecision; target: ApprovalItem }) =>
      decideApproval(target, value, value === 'reject' ? '用户从即时审批弹窗拒绝' : undefined),
    onMutate: () => setDecisionError(null),
    onSuccess: async (result, variables) => {
      await invalidateApprovalState(client, projectId, variables.target.project_id);
      if (variables.value === 'approve_apply' && (result.applied || result.proposal)) {
        const proposal =
          result.proposal ||
          (variables.target.type === 'change_proposal' ? { id: result.item?.id || variables.target.id } : undefined);
        window.dispatchEvent(
          new CustomEvent('aiws:proposal-applied', { detail: { proposal, applied: result.applied } })
        );
      }
      showProposal(null);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409 && error.payload.error === 'proposal_stale') {
        setDecisionError('提案已过期或目标工作流已变化，未应用任何修改。');
        await approvals.refetch();
        return;
      }
      setDecisionError(error.message);
    }
  });

  function decide(value: ApprovalDecision) {
    if (item && !resolved && !decision.isPending) decision.mutate({ value, target: item });
  }

  useEffect(() => {
    if (proposalId && resolved) showProposal(null);
  }, [proposalId, resolved, showProposal]);
  useEffect(() => {
    if (!deferWhenReady.current || !item || resolved || decision.isPending) return;
    deferWhenReady.current = false;
    decide('defer');
  }, [item?.id, item?.revision, resolved, decision.isPending]);
  useEffect(() => {
    deferWhenReady.current = false;
  }, [proposalId]);
  useEffect(() => setDecisionError(null), [item?.id]);

  useEffect(() => {
    if (!proposalId) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (item) decide('defer');
      else if (approvals.isError) showProposal(null);
      else deferWhenReady.current = true;
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [proposalId, item?.id, item?.revision, decision.isPending, approvals.isError, showProposal]);
  return {
    proposalId,
    item,
    resolved,
    pending: decision.isPending,
    decisionError,
    decide,
    loadingFailed: approvals.isError,
    loadingError: approvals.error,
    retry: approvals.refetch,
    close: () => showProposal(null)
  };
}

function ApprovalLoading({
  failed,
  error,
  onRetry,
  onClose
}: {
  failed: boolean;
  error: Error | null;
  onRetry: () => unknown;
  onClose: () => void;
}) {
  return (
    <div className="approval-prompt-loading">
      <ShieldAlert size={22} />
      <strong>{failed ? '审批项目加载失败' : '正在加载审批项目'}</strong>
      {failed && (
        <>
          <small>{error?.message}</small>
          <button className="button secondary" onClick={onRetry}>
            重试
          </button>
          <button className="button secondary" onClick={onClose}>
            关闭并稍后处理
          </button>
        </>
      )}
    </div>
  );
}

function ApprovalContent({
  item,
  resolved,
  pending,
  decisionError,
  onDecide
}: {
  item: ApprovalItem;
  resolved: boolean;
  pending: boolean;
  decisionError: string | null;
  onDecide: (value: ApprovalDecision) => void;
}) {
  const disabled = resolved || pending;
  return (
    <>
      <header>
        <div className="approval-kind">
          {item.type === 'runtime_approval' ? <ShieldAlert size={17} /> : <GitPullRequest size={17} />}
          <span>{item.type === 'runtime_approval' ? '运行审批' : '变更提案'}</span>
        </div>
        <IconButton label="暂定并关闭" disabled={disabled} onClick={() => onDecide('defer')}>
          <X size={17} />
        </IconButton>
      </header>
      <ApprovalBody item={item} decisionError={decisionError} />
      <ApprovalActions disabled={disabled} pending={pending} onDecide={onDecide} />
    </>
  );
}

function ApprovalBody({ item, decisionError }: { item: ApprovalItem; decisionError: string | null }) {
  return (
    <div className="approval-prompt-body">
      <div className="approval-meta">
        <span className={`status ${item.status}`}>{displayStatus(item.status)}</span>
        <span>修订版 {item.revision}</span>
        {item.change_type && <span>{changeTypeLabel(item.change_type)}</span>}
      </div>
      <h2 id="approval-prompt-title">{item.title}</h2>
      <p>{item.summary}</p>
      {decisionError && (
        <div className="approval-error" role="alert">
          {decisionError}
        </div>
      )}
      <ApprovalChange item={item} />
      <ApprovalValues className="approval-chip-line" label="影响" values={item.impact} />
      <ApprovalValues className="approval-risks" label="风险" values={item.risks} list />
    </div>
  );
}

function ApprovalChange({ item }: { item: ApprovalItem }) {
  if (item.before_json == null && item.after_json == null) return null;
  return (
    <details>
      <summary>查看变更内容</summary>
      <div className="approval-change">
        <section>
          <strong>变更前</strong>
          <pre>{JSON.stringify(item.before_json ?? null, null, 2)}</pre>
        </section>
        <section>
          <strong>变更后</strong>
          <pre>{JSON.stringify(item.after_json ?? null, null, 2)}</pre>
        </section>
      </div>
    </details>
  );
}

function ApprovalValues({
  className,
  label,
  values,
  list = false
}: {
  className: string;
  label: string;
  values?: string[];
  list?: boolean;
}) {
  if (!values?.length) return null;
  return (
    <div className={className}>
      <strong>{label}</strong>
      {list ? (
        <ul>
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      ) : (
        values.map((value) => <span key={value}>{value}</span>)
      )}
    </div>
  );
}

function ApprovalActions({
  disabled,
  pending,
  onDecide
}: {
  disabled: boolean;
  pending: boolean;
  onDecide: (value: ApprovalDecision) => void;
}) {
  return (
    <footer>
      <button className="button secondary" disabled={disabled} onClick={() => onDecide('defer')}>
        <Clock3 size={15} />
        暂定
      </button>
      <button className="button danger" disabled={disabled} onClick={() => onDecide('reject')}>
        <X size={15} />
        拒绝
      </button>
      <button className="button primary" disabled={disabled} onClick={() => onDecide('approve_apply')}>
        <Check size={15} />
        {pending ? '正在处理' : '批准并应用'}
      </button>
    </footer>
  );
}

export async function invalidateApprovalState(
  client: ReturnType<typeof useQueryClient>,
  ...projectIds: Array<string | undefined>
) {
  const ids = [...new Set(projectIds.filter((value): value is string => Boolean(value)))];
  await Promise.all([
    client.invalidateQueries({ queryKey: keys.approvals() }),
    ...ids.flatMap((projectId) => [
      client.invalidateQueries({ queryKey: keys.approvals(projectId) }),
      client.invalidateQueries({ queryKey: keys.proposals(projectId) }),
      client.invalidateQueries({ queryKey: keys.project(projectId) })
    ]),
    client.invalidateQueries({ queryKey: keys.setup }),
    client.invalidateQueries({ queryKey: ['node-workspace'] }),
    client.invalidateQueries({ queryKey: ['codex-profiles'] }),
    client.invalidateQueries({ queryKey: ['review'] })
  ]);
}
