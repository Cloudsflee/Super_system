import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { applyProposalAtomically } from '../proposal-atomic.mjs';
import { maskSecretsDeep, now } from '../../../../packages/shared/index.mjs';
import { applyConfigRevision } from '../config-revision-service.mjs';
import { pushV3Event } from '../assist-v3-events.mjs';
import { cancelPendingTurnApprovals, hasActiveTurn } from '../assist-v3-domain.mjs';

export const approvalV13Routes = [
  makeRoute('GET', '/approvals', listApprovals),
  makeRoute('POST', '/approvals/:type/:id/decision', decideApproval)
];

async function listApprovals({ res, query }) {
  const state = await readState();
  let items = [
    ...state.change_proposals.map((item) => proposalItem(item)),
    ...state.runtime_approvals.map((item) => runtimeItem(item))
  ];
  if (query.project_id) items = items.filter((item) => item.project_id === query.project_id || item.project_id == null);
  if (query.type) items = items.filter((item) => item.type === query.type || item.category === query.type);
  const attention = query.attention_state || query.state;
  if (attention) items = items.filter((item) => item.attention_state === attention);
  if (query.status) items = items.filter((item) => item.status === query.status);
  items.sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
  return send(res, 200, items);
}

async function decideApproval({ res, params, body }) {
  if (!['approve_apply', 'reject', 'defer'].includes(body.decision)) throw new HttpError(400, { error: 'invalid_approval_decision' });
  if (body.decision === 'approve_apply' && ['proposal', 'change_proposal'].includes(params.type)) {
    const snapshot = await readState(), proposal = snapshot.change_proposals.find((item) => item.id === params.id);
    if (proposal?.apply_action?.type === 'config_revision_apply') return send(res, 200, await applyConfigRevision(proposal.id, body));
  }
  const result = await mutate((state) => {
    const actor = owner(state);
    if (['proposal', 'change_proposal'].includes(params.type)) {
      const proposal = state.change_proposals.find((item) => item.id === params.id);
      if (!proposal) throw new HttpError(404, { error: 'proposal_not_found' });
      const repeated = repeatedProposalDecision(proposal, body.decision); if (repeated) return { item: proposalItem(proposal), decision: body.decision, idempotent: true };
      assertExpected(proposal, body);
      if (body.decision === 'defer') {
        if (proposal.status !== 'pending') throw new HttpError(409, { error: 'proposal_not_pending' });
        Object.assign(proposal, { attention_state: 'queued', revision: Number(proposal.revision || 1) + 1, updated_at: now() });
        addTrace(state, 'change_proposal.deferred', tracePayload(proposal, '暂定变更'), actor.id);
        return { item: proposalItem(proposal), decision: 'defer' };
      }
      if (body.decision === 'reject') {
        if (proposal.status === 'rejected') return { item: proposalItem(proposal), decision: 'reject', idempotent: true };
        if (proposal.status !== 'pending') throw new HttpError(409, { error: 'proposal_not_pending' });
        Object.assign(proposal, { status: 'rejected', attention_state: 'resolved', rejected_by_user_id: actor.id, rejection_reason: String(body.reason || '用户拒绝').slice(0, 1000), revision: Number(proposal.revision || 1) + 1, updated_at: now() });
        addTrace(state, 'change_proposal.rejected', tracePayload(proposal, '拒绝变更'), actor.id);
        return { item: proposalItem(proposal), decision: 'reject' };
      }
      const applied = applyProposalAtomically(state, proposal, actor, body);
      addTrace(state, 'change_proposal.applied', { ...tracePayload(proposal, '批准并应用变更'), data: { applied: applied.applied } }, actor.id);
      return { item: proposalItem(proposal), decision: 'approve_apply', applied: applied.applied, idempotent: applied.idempotent };
    }
    if (['runtime', 'runtime_approval'].includes(params.type)) return decideRuntime(state, actor, params.id, body);
    throw new HttpError(400, { error: 'unsupported_approval_type' });
  });
  return send(res, 200, result);
}

function decideRuntime(state, actor, approvalId, body) {
  const approval = state.runtime_approvals.find((item) => item.id === approvalId);
  if (!approval) throw new HttpError(404, { error: 'runtime_approval_not_found' });
  const repeated = repeatedRuntimeDecision(approval, body.decision); if (repeated) return { item: runtimeItem(approval), decision: body.decision, idempotent: true };
  assertExpected(approval, body);
  if (approval.status !== 'pending') throw new HttpError(409, { error: 'runtime_approval_resolved' });
  if (body.decision === 'defer') Object.assign(approval, { attention_state: 'queued' });
  else Object.assign(approval, { status: body.decision === 'approve_apply' ? 'approved' : 'rejected', attention_state: 'resolved', decided_by_user_id: actor.id, decision_reason: String(body.reason || '').slice(0, 1000), decided_at: now() });
  Object.assign(approval, { revision: Number(approval.revision || 1) + 1, updated_at: now() });
  const turn = state.assist_turns.find((item) => item.id === approval.turn_id);
  if (turn && body.decision === 'reject') {
    Object.assign(turn, { status: 'failed', error_code: 'runtime_approval_rejected', waiting_approval_id: null, completed_at: now(), updated_at: now() });
    cancelPendingTurnApprovals(state, turn.id, 'runtime_approval_rejected');
    pushV3Event(state, turn.session_id, turn.id, 'failed', { error: turn.error_code, approval_id: approval.id });
    const session = state.assist_sessions.find((item) => item.id === turn.session_id && item.version === 3);
    if (session && !hasActiveTurn(state, session.id, turn.id)) Object.assign(session, { status: 'idle', updated_at: now() });
  }
  addTrace(state, 'runtime_approval.decided', { project_id: approval.project_id, target_type: 'runtime_approval', target_id: approval.id, summary: `Runtime approval: ${body.decision}` }, actor.id);
  return { item: runtimeItem(approval), decision: body.decision, resume_turn_id: body.decision === 'approve_apply' ? turn?.id || null : null };
}

function assertExpected(item, body) {
  if (body.revision === undefined || !body.target_hash) throw new HttpError(400, { error: 'approval_expectation_required', required: ['revision', 'target_hash'] });
  if (Number(body.revision) !== Number(item.revision || 1)) throw new HttpError(409, { error: 'proposal_stale', reason: 'revision_mismatch', revision: item.revision });
  if (body.target_hash !== item.target_hash) throw new HttpError(409, { error: 'proposal_stale', reason: 'target_hash_mismatch', revision: item.revision });
}
function proposalItem(item) { return { ...item, type: 'proposal', category: item.change_type, source_type: 'change_proposal', source_id: item.id }; }
function runtimeItem(item) {
  const request = maskSecretsDeep(item.request && typeof item.request === 'object' ? item.request : {});
  const type = String(item.approval_type || request.approval_type || 'runtime');
  const detail = request.command ? `命令：${String(request.command).slice(0, 2000)}` : request.path ? `路径：${String(request.path).slice(0, 1000)}` : request.host ? `主机：${String(request.host).slice(0, 300)}` : request.tool ? `工具：${String(request.tool).slice(0, 300)}` : `权限类型：${type.slice(0, 200)}`;
  const title = item.title || (/command/i.test(type) ? 'Codex 请求执行命令' : /file|patch|write/i.test(type) ? 'Codex 请求修改文件' : /network|host/i.test(type) ? 'Codex 请求访问网络' : 'Codex 请求运行时权限');
  return { ...item, request, title, summary: item.summary || detail, type: 'runtime', category: type, source_type: 'runtime_approval', source_id: item.id };
}
function tracePayload(proposal, verb) { return { project_id: proposal.project_id, workspace_id: proposal.workspace_id, node_id: proposal.node_id, target_type: 'change_proposal', target_id: proposal.id, summary: `${verb}：${proposal.title}` }; }
function repeatedProposalDecision(item, decision) { return (decision === 'approve_apply' && item.status === 'applied') || (decision === 'reject' && item.status === 'rejected') || (decision === 'defer' && item.status === 'pending' && item.attention_state === 'queued'); }
function repeatedRuntimeDecision(item, decision) { return (decision === 'approve_apply' && item.status === 'approved') || (decision === 'reject' && item.status === 'rejected') || (decision === 'defer' && item.status === 'pending' && item.attention_state === 'queued'); }
