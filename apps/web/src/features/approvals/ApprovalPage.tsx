import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, ClipboardCheck, LoaderCircle, RefreshCw, RotateCcw, Send, X } from 'lucide-react';
import { ApiError, apiV2, formatTime, mutateV2, shortHash } from '../../api';
import type { WorkspacePageProps } from '../../workspace';

type Approval = {
  id: string;
  project_id: string;
  assist_turn_id?: string | null;
  action: string;
  request: Record<string, unknown>;
  status: string;
  expires_at: string;
  revision: number;
  created_at: string;
};

type UserInput = {
  id: string;
  project_id: string;
  assist_turn_id?: string | null;
  prompt_summary: string;
  input_schema: Record<string, unknown>;
  response?: Record<string, unknown> | null;
  status: string;
  expires_at: string;
  revision: number;
  created_at: string;
};

type Proposal = {
  id: string;
  project_id: string;
  proposal_type: string;
  target_type: string;
  target_id: string;
  target_revision: number;
  payload: Record<string, unknown>;
  payload_hash: string;
  status: string;
  revision: number;
  created_at: string;
};

type ApprovalTab = 'approvals' | 'inputs' | 'proposals';

export function ApprovalPage({ projectId, navigate, notify }: WorkspacePageProps) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [inputs, setInputs] = useState<UserInput[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<ApprovalTab>('approvals');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setApprovals([]);
      setInputs([]);
      setProposals([]);
      return;
    }
    setLoading(true);
    try {
      const query = `?project_id=${encodeURIComponent(projectId)}`;
      const [approvalResult, inputResult, proposalResult] = await Promise.all([
        apiV2<{ approvals: Approval[] }>(`/api/v2/approvals${query}`),
        apiV2<{ inputs: UserInput[] }>(`/api/v2/user-inputs${query}`),
        apiV2<{ proposals: Proposal[] }>(`/api/v2/proposals${query}`)
      ]);
      setApprovals(approvalResult.data.approvals || []);
      setInputs(inputResult.data.inputs || []);
      setProposals(proposalResult.data.proposals || []);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load().catch((error) => notify(error instanceof Error ? error.message : 'Approval Center failed to load', 'error'));
  }, [load, notify]);

  const handleError = async (error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.code === 'revision_conflict') await load().catch(() => undefined);
    notify(error instanceof Error ? error.message : fallback, 'error');
  };

  const decideApproval = async (approval: Approval, decision: 'approved' | 'rejected') => {
    setBusy(approval.id);
    try {
      await mutateV2(`/api/v2/approvals/${encodeURIComponent(approval.id)}/decide`, { decision }, 'POST', approval.revision);
      await load();
      notify(`Approval ${decision}`);
    } catch (error) {
      await handleError(error, 'Approval decision failed');
    } finally {
      setBusy('');
    }
  };

  const answerInput = async (input: UserInput) => {
    const value = answers[input.id]?.trim() || '';
    if (!value) return notify('Enter a response before answering.', 'error');
    setBusy(input.id);
    try {
      await mutateV2(`/api/v2/user-inputs/${encodeURIComponent(input.id)}/answer`, { response: parseResponse(value) }, 'POST', input.revision);
      setAnswers((current) => ({ ...current, [input.id]: '' }));
      await load();
      notify('Input answered');
    } catch (error) {
      await handleError(error, 'Input response failed');
    } finally {
      setBusy('');
    }
  };

  const cancelInput = async (input: UserInput) => {
    setBusy(input.id);
    try {
      await mutateV2(`/api/v2/user-inputs/${encodeURIComponent(input.id)}/cancel`, {}, 'POST', input.revision);
      await load();
      notify('Input cancelled');
    } catch (error) {
      await handleError(error, 'Input cancellation failed');
    } finally {
      setBusy('');
    }
  };

  const mutateProposal = async (proposal: Proposal, action: 'apply' | 'reject' | 'undo') => {
    setBusy(proposal.id);
    try {
      await mutateV2(`/api/v2/proposals/${encodeURIComponent(proposal.id)}/${action}`, {}, 'POST', proposal.revision);
      await load();
      notify(`Proposal ${action === 'apply' ? 'applied' : action === 'reject' ? 'rejected' : 'undone'}`);
    } catch (error) {
      await handleError(error, `Proposal ${action} failed`);
    } finally {
      setBusy('');
    }
  };

  const counts = useMemo(() => ({
    approvals: approvals.filter((item) => item.status === 'pending').length,
    inputs: inputs.filter((item) => item.status === 'pending').length,
    proposals: proposals.filter((item) => item.status === 'pending').length
  }), [approvals, inputs, proposals]);

  if (!projectId) {
    return <div className="empty-state"><ClipboardCheck size={28} /><h2>Select a project to review interactions</h2><button className="button" onClick={() => navigate('projects')}>Projects</button></div>;
  }

  return (
    <div className="page approval-page">
      <div className="page-heading">
        <div><p className="eyebrow">Runtime control</p><h1>Approval Center</h1></div>
        <button className="icon-button" title="Refresh Approval Center" aria-label="Refresh Approval Center" disabled={loading} onClick={() => void load()}>{loading ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button>
      </div>
      <div className="approval-tabs" role="tablist" aria-label="Approval Center views">
        <TabButton value="approvals" current={tab} count={counts.approvals} onSelect={setTab}>Approvals</TabButton>
        <TabButton value="inputs" current={tab} count={counts.inputs} onSelect={setTab}>User inputs</TabButton>
        <TabButton value="proposals" current={tab} count={counts.proposals} onSelect={setTab}>Proposals</TabButton>
      </div>

      {tab === 'approvals' && <section className="panel interaction-panel">
        <SectionTitle title="Runtime approvals" meta={`${approvals.length} requests`} />
        <div className="approval-list">
          {approvals.map((approval) => <article key={approval.id}>
            <div><strong>{approval.action}</strong><span className="mono">{approval.assist_turn_id ? `turn ${shortHash(approval.assist_turn_id)}` : `request ${shortHash(approval.id)}`}</span></div>
            <Status value={approval.status} />
            <small>{formatTime(approval.created_at)}</small>
            <RequestSummary value={approval.request} />
            {approval.status === 'pending' && <div className="approval-actions">
              <button className="button" disabled={busy === approval.id} onClick={() => void decideApproval(approval, 'rejected')}><CircleAlert size={15} />Reject</button>
              <button className="button primary" disabled={busy === approval.id} onClick={() => void decideApproval(approval, 'approved')}>{busy === approval.id ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Approve</button>
            </div>}
          </article>)}
          {!approvals.length && <div className="list-empty">No runtime approvals</div>}
        </div>
      </section>}

      {tab === 'inputs' && <section className="panel interaction-panel">
        <SectionTitle title="User inputs" meta={`${inputs.length} requests`} />
        <div className="approval-list input-request-list">
          {inputs.map((input) => <article key={input.id}>
            <div><strong>{input.prompt_summary}</strong><span className="mono">{input.assist_turn_id ? `turn ${shortHash(input.assist_turn_id)}` : shortHash(input.id)}</span></div>
            <Status value={input.status} />
            <small>{formatTime(input.created_at)}</small>
            {input.status === 'pending' && <div className="input-answer-row">
              <textarea rows={3} value={answers[input.id] || ''} onChange={(event) => setAnswers((current) => ({ ...current, [input.id]: event.target.value }))} placeholder="Response or JSON object" aria-label={`Response for ${input.prompt_summary}`} />
              <div>
                <button className="icon-button" title="Cancel input" aria-label={`Cancel ${input.prompt_summary}`} disabled={busy === input.id} onClick={() => void cancelInput(input)}><X size={15} /></button>
                <button className="button primary" disabled={busy === input.id || !(answers[input.id] || '').trim()} onClick={() => void answerInput(input)}>{busy === input.id ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}Answer</button>
              </div>
            </div>}
          </article>)}
          {!inputs.length && <div className="list-empty">No user input requests</div>}
        </div>
      </section>}

      {tab === 'proposals' && <section className="panel interaction-panel">
        <SectionTitle title="Semantic proposals" meta={`${proposals.length} proposals`} />
        <div className="approval-list proposal-list">
          {proposals.map((proposal) => <article key={proposal.id}>
            <div><strong>{proposal.proposal_type}</strong><span className="mono">{proposal.target_type} {shortHash(proposal.target_id)} at r{proposal.target_revision}</span></div>
            <Status value={proposal.status} />
            <small>{formatTime(proposal.created_at)}</small>
            <RequestSummary value={proposal.payload} />
            <div className="approval-actions">
              {proposal.status === 'pending' && <>
                <button className="button" disabled={busy === proposal.id} onClick={() => void mutateProposal(proposal, 'reject')}><CircleAlert size={15} />Reject</button>
                <button className="button primary" disabled={busy === proposal.id} onClick={() => void mutateProposal(proposal, 'apply')}><Check size={15} />Apply</button>
              </>}
              {proposal.status === 'approved' && <button className="button" disabled={busy === proposal.id} onClick={() => void mutateProposal(proposal, 'undo')}><RotateCcw size={15} />Undo</button>}
            </div>
          </article>)}
          {!proposals.length && <div className="list-empty">No semantic proposals</div>}
        </div>
      </section>}
    </div>
  );
}

function TabButton({ value, current, count, onSelect, children }: { value: ApprovalTab; current: ApprovalTab; count: number; onSelect: (value: ApprovalTab) => void; children: string }) {
  return <button role="tab" aria-selected={current === value} className={current === value ? 'active' : ''} onClick={() => onSelect(value)}><span>{children}</span>{count > 0 && <b>{count}</b>}</button>;
}

function SectionTitle({ title, meta }: { title: string; meta: string }) {
  return <div className="section-title"><div><h2>{title}</h2><span>{meta}</span></div></div>;
}

function RequestSummary({ value }: { value: Record<string, unknown> }) {
  const summary = Object.entries(value).slice(0, 6);
  if (!summary.length) return null;
  return <dl className="interaction-summary">{summary.map(([key, item]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{displayValue(item)}</dd></div>)}</dl>;
}

function displayValue(value: unknown) {
  if (value == null) return 'none';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value).slice(0, 180);
}

function parseResponse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return { value };
  }
}

function Status({ value }: { value: string }) {
  const tone = ['approved', 'answered', 'completed'].includes(value) ? 'positive'
    : value === 'pending' ? 'working'
      : ['rejected', 'expired', 'cancelled', 'failed'].includes(value) ? 'negative' : 'neutral';
  return <span className={`status ${tone}`}><span />{value.replaceAll('_', ' ')}</span>;
}
