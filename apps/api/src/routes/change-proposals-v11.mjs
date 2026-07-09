import { makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { applyContractPatch, approveProposal, createChangeProposal, markProposalApplied, now, rejectProposal, validateNodeContract } from '../../../../packages/shared/index.mjs';

export const changeProposalV11Routes = [
  makeRoute('GET', '/change-proposals', listProposals),
  makeRoute('POST', '/change-proposals', createProposalRoute),
  makeRoute('POST', '/change-proposals/:id/approve', approveProposalRoute),
  makeRoute('POST', '/change-proposals/:id/reject', rejectProposalRoute),
  makeRoute('POST', '/change-proposals/:id/apply', applyProposalRoute)
];

async function listProposals({ res, query }) {
  const state = await readState();
  let proposals = state.change_proposals;
  if (query.project_id) proposals = proposals.filter((item) => item.project_id === query.project_id);
  if (query.status) proposals = proposals.filter((item) => item.status === query.status);
  return send(res, 200, proposals);
}

async function createProposalRoute({ res, body }) {
  const result = await mutate((state) => {
    const actor = owner(state);
    const project = state.projects.find((item) => item.id === body.project_id) || state.projects.at(-1);
    const proposal = createChangeProposal({
      projectId: project?.id || body.project_id,
      workspaceId: body.workspace_id || null,
      nodeId: body.node_id || null,
      changeType: body.change_type || 'general',
      title: body.title,
      summary: body.summary,
      before: body.before_json ?? body.before,
      after: body.after_json ?? body.after,
      impact: body.impact || [],
      risks: body.risks || [],
      evidenceRefs: body.evidence_refs || [],
      applyAction: body.apply_action || null,
      actorId: actor.id
    });
    state.change_proposals.push(proposal);
    addTrace(state, 'change_proposal.created', { project_id: proposal.project_id, workspace_id: proposal.workspace_id, node_id: proposal.node_id, target_type: 'change_proposal', target_id: proposal.id, summary: `创建变更审批：${proposal.title}`, data: proposal }, actor.id);
    return proposal;
  });
  return send(res, 201, result);
}

async function approveProposalRoute({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state), proposal = state.change_proposals.find((item) => item.id === params.id);
    if (!proposal) return { error: 'proposal_not_found' };
    try { approveProposal(proposal, actor.id); } catch (error) { return { error: error.message }; }
    addTrace(state, 'change_proposal.approved', { project_id: proposal.project_id, workspace_id: proposal.workspace_id, node_id: proposal.node_id, target_type: 'change_proposal', target_id: proposal.id, summary: `批准变更：${proposal.title}` }, actor.id);
    return proposal;
  });
  return result?.error ? send(res, result.error === 'proposal_not_found' ? 404 : 400, result) : send(res, 200, result);
}

async function rejectProposalRoute({ res, params, body }) {
  const result = await mutate((state) => {
    const actor = owner(state), proposal = state.change_proposals.find((item) => item.id === params.id);
    if (!proposal) return { error: 'proposal_not_found' };
    try { rejectProposal(proposal, actor.id, body.reason || '用户拒绝'); } catch (error) { return { error: error.message }; }
    addTrace(state, 'change_proposal.rejected', { project_id: proposal.project_id, workspace_id: proposal.workspace_id, node_id: proposal.node_id, target_type: 'change_proposal', target_id: proposal.id, summary: `拒绝变更：${proposal.title}`, data: { reason: body.reason || '' } }, actor.id);
    return proposal;
  });
  return result?.error ? send(res, result.error === 'proposal_not_found' ? 404 : 400, result) : send(res, 200, result);
}

async function applyProposalRoute({ res, params }) {
  const result = await mutate((state) => {
    const actor = owner(state), proposal = state.change_proposals.find((item) => item.id === params.id);
    if (!proposal) return { error: 'proposal_not_found' };
    try { markProposalApplied(proposal, actor.id); } catch (error) { return { error: error.message }; }
    const applied = applyAction(state, proposal);
    addTrace(state, 'change_proposal.applied', { project_id: proposal.project_id, workspace_id: proposal.workspace_id, node_id: proposal.node_id, target_type: 'change_proposal', target_id: proposal.id, summary: `应用变更：${proposal.title}`, data: { applied } }, actor.id);
    return { proposal, applied };
  });
  return result?.error ? send(res, result.error === 'proposal_not_found' ? 404 : 400, result) : send(res, 200, result);
}

function applyAction(state, proposal) {
  const action = proposal.apply_action || {};
  if (action.type === 'node_contract_patch' && proposal.node_id) {
    const node = state.workflow_nodes.find((item) => item.id === proposal.node_id);
    const current = state.node_contracts.find((item) => item.id === node?.current_contract_id);
    if (!node || !current) return { type: action.type, skipped: 'node_or_contract_missing' };
    const next = applyContractPatch(current, proposal.after_json || action.patch || {}, proposal.approved_by_user_id || proposal.created_by_user_id);
    Object.assign(next, { status: 'confirmed', confirmed_by: 'human', confirmed_by_user_id: proposal.approved_by_user_id });
    const validation = validateNodeContract(next);
    if (!validation.ok) return { type: action.type, validation };
    current.status = 'superseded';
    state.node_contracts.push(next);
    Object.assign(node, { current_contract_id: next.id, pending_approved_change_id: proposal.id, updated_at: now() });
    return { type: action.type, node_id: proposal.node_id, contract_id: next.id };
  }
  if (action.type === 'codex_profile_apply' && action.profile_id) {
    for (const item of state.codex_profiles) item.is_active = item.id === action.profile_id;
    return { type: action.type, profile_id: action.profile_id };
  }
  return { type: action.type || 'record_only' };
}
