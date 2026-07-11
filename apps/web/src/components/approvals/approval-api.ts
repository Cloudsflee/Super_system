import { useQuery } from '@tanstack/react-query';
import { api, ApiError, json } from '../../api/client';
import { keys } from '../../api/queries';
import type {
  ApprovalDecision, ApprovalDecisionResult, ApprovalItem, ApprovalItemType, ChangeProposal
} from '../../api/types';

type ApprovalListResponse = ApprovalItem[] | { items: ApprovalItem[] };

export function useApprovals(projectId?: string, enabled = true) {
  return useQuery({
    queryKey: keys.approvals(projectId),
    queryFn: () => fetchApprovals(projectId),
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) => query.state.data?.some((item) => item.attention_state === 'interrupting') ? 2_000 : false
  });
}

export async function fetchApprovals(projectId?: string) {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  try {
    const result = await api<ApprovalListResponse>(`/approvals${query}`);
    return (Array.isArray(result) ? result : result.items || []).map(normalizeApproval);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const proposals = await api<ChangeProposal[]>(`/change-proposals${query}`);
    return proposals.map(proposalApproval);
  }
}

export async function decideApproval(item: ApprovalItem, decision: ApprovalDecision, reason?: string): Promise<ApprovalDecisionResult> {
  try {
    return await api<ApprovalDecisionResult>(`/approvals/${encodeURIComponent(item.type)}/${encodeURIComponent(item.id)}/decision`, json('POST', {
      decision, revision: item.revision, target_hash: item.target_hash, ...(reason ? { reason } : {})
    }));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404 || item.type !== 'change_proposal') throw error;
    return legacyProposalDecision(item, decision, reason);
  }
}

async function legacyProposalDecision(item: ApprovalItem, decision: ApprovalDecision, reason?: string): Promise<ApprovalDecisionResult> {
  if (decision === 'approve_apply') {
    await api<ChangeProposal>(`/change-proposals/${item.id}/approve`, json('POST'));
    const result = await api<{ proposal: ChangeProposal; applied?: Record<string, unknown> }>(`/change-proposals/${item.id}/apply`, json('POST'));
    return { item: proposalApproval(result.proposal), proposal: result.proposal, applied: result.applied };
  }
  if (decision === 'reject') {
    const proposal = await api<ChangeProposal>(`/change-proposals/${item.id}/reject`, json('POST', { reason: reason || '用户拒绝' }));
    return { item: proposalApproval(proposal), proposal };
  }
  try {
    const proposal = await api<ChangeProposal>(`/change-proposals/${item.id}/defer`, json('POST', { revision: item.revision, target_hash: item.target_hash }));
    return { item: proposalApproval(proposal), proposal };
  } catch (error) {
    // V1.2 compatibility: deferral had no persisted route. Keep the item queued locally.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return { item: { ...item, attention_state: 'queued' } };
  }
}

export function proposalApproval(proposal: ChangeProposal): ApprovalItem {
  return {
    id: proposal.id,
    type: 'change_proposal',
    project_id: proposal.project_id,
    node_id: proposal.node_id,
    title: proposal.title,
    summary: proposal.summary,
    status: proposal.status,
    attention_state: proposal.attention_state || (['applied', 'rejected'].includes(proposal.status) ? 'resolved' : 'queued'),
    revision: Number(proposal.revision || 1),
    target_hash: proposal.target_hash || '',
    created_at: proposal.created_at,
    change_type: proposal.change_type,
    before_json: proposal.before_json,
    after_json: proposal.after_json,
    risks: proposal.risks,
    impact: proposal.impact,
    evidence_refs: proposal.evidence_refs
  };
}

function normalizeApproval(value: ApprovalItem): ApprovalItem {
  return {
    ...value,
    type: normalizeType(value.type),
    attention_state: value.attention_state || 'queued',
    revision: Number(value.revision || 1),
    target_hash: value.target_hash || ''
  };
}

function normalizeType(value: string): ApprovalItemType {
  return value === 'runtime_approval' || value === 'runtime' ? 'runtime_approval' : 'change_proposal';
}
