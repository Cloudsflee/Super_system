import { clone, id, now, slugify } from './utils.mjs';

export const ChangeProposalStatus = Object.freeze({
  Pending: 'pending',
  Approved: 'approved',
  Rejected: 'rejected',
  Applied: 'applied'
});

export function createAgentSession({ projectId, workspaceId = null, scopeType = 'project', scopeId, parentSessionId = null, title = '', actorId }) {
  const created = now();
  return {
    id: id('ags'),
    project_id: projectId,
    workspace_id: workspaceId,
    scope_type: scopeType,
    scope_id: scopeId || projectId,
    parent_session_id: parentSessionId,
    conversation_key: `${scopeType}:${scopeId || projectId}:${id('conv')}`,
    title: title || `${scopeType} Codex Session`,
    status: 'active',
    created_by_user_id: actorId,
    created_at: created,
    updated_at: created
  };
}

export function createSubSubmission({ projectId, workspaceId, nodeId = null, fromSessionId, toSessionId, title, summary, changes = [], evidenceRefs = [], risks = [], actorId }) {
  const created = now();
  return {
    id: id('sub'),
    project_id: projectId,
    workspace_id: workspaceId,
    node_id: nodeId,
    from_session_id: fromSessionId,
    to_session_id: toSessionId,
    title: title || 'Sub Workspace Submission',
    summary: summary || '',
    changes,
    evidence_refs: evidenceRefs,
    risks,
    status: 'submitted',
    created_by_user_id: actorId,
    created_at: created,
    updated_at: created
  };
}

export function createChangeProposal({ projectId, workspaceId = null, nodeId = null, changeType = 'general', title, summary, before = null, after = null, impact = [], risks = [], evidenceRefs = [], applyAction = null, actorId }) {
  const created = now();
  return {
    id: id('cpr'),
    project_id: projectId,
    workspace_id: workspaceId,
    node_id: nodeId,
    change_type: changeType,
    title: title || `变更审批：${changeType}`,
    summary: summary || '',
    before_json: before === undefined ? null : clone(before),
    after_json: after === undefined ? null : clone(after),
    impact,
    risks,
    evidence_refs: evidenceRefs,
    apply_action: applyAction,
    status: ChangeProposalStatus.Pending,
    approved_by_user_id: null,
    rejected_by_user_id: null,
    applied_by_user_id: null,
    created_by_user_id: actorId,
    created_at: created,
    updated_at: created
  };
}

export function approveProposal(proposal, actorId) {
  if (!proposal || proposal.status !== ChangeProposalStatus.Pending) throw new Error('proposal_not_pending');
  Object.assign(proposal, { status: ChangeProposalStatus.Approved, approved_by_user_id: actorId, updated_at: now() });
  return proposal;
}

export function rejectProposal(proposal, actorId, reason = '') {
  if (!proposal || proposal.status !== ChangeProposalStatus.Pending) throw new Error('proposal_not_pending');
  Object.assign(proposal, { status: ChangeProposalStatus.Rejected, rejected_by_user_id: actorId, rejection_reason: reason, updated_at: now() });
  return proposal;
}

export function markProposalApplied(proposal, actorId) {
  if (!proposal || proposal.status !== ChangeProposalStatus.Approved) throw new Error('proposal_not_approved');
  Object.assign(proposal, { status: ChangeProposalStatus.Applied, applied_by_user_id: actorId, applied_at: now(), updated_at: now() });
  return proposal;
}

export function defaultCodexProfiles(actorId = null) {
  const created = now();
  return [
    {
      id: 'profile_mock',
      name: 'MockRunner 安全演示',
      kind: 'mock',
      description: '不调用外部 Codex，适合答辩演示和离线验证。',
      config: { runner: 'mock' },
      status: 'ready',
      is_active: true,
      created_by_user_id: actorId,
      created_at: created,
      updated_at: created
    },
    {
      id: 'profile_codex_docker',
      name: 'Codex Docker 隔离运行',
      kind: 'docker',
      description: '每次 NodeRun 通过 docker run --rm 启动独立 Codex 容器。',
      config: { image: 'aiws-codex-runner:local', dockerfile: 'docker/codex-runner.Dockerfile' },
      status: 'needs_build',
      is_active: false,
      created_by_user_id: actorId,
      created_at: created,
      updated_at: created
    }
  ];
}

export function codexProfileFromCcSwitch(source, actorId = null) {
  const name = source?.name || 'cc-switch';
  const created = now();
  return {
    id: `profile_${slugify(name, 'cc-switch')}`,
    name: `${name} Codex Profile`,
    kind: 'cc_switch',
    description: `由 ${source?.repo || name} 同步评估得到的本地 Codex 配置映射。`,
    config: { source },
    status: source?.status || 'synced',
    is_active: false,
    created_by_user_id: actorId,
    created_at: created,
    updated_at: created
  };
}
