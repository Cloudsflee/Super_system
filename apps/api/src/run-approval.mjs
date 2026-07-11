import { HttpError } from './http.mjs';
import { now } from '../../../packages/shared/index.mjs';

export const NODE_RUN_APPROVAL = 'node_run_authorization';
export const GIT_COMMIT_APPROVAL = 'git_commit_authorization';
export const GIT_PUBLISH_APPROVAL = 'git_publish_authorization';

export function requireNodeRunApproval(state, { approvalId, nodeId, runner }) {
  const proposal = state.change_proposals.find((item) => item.id === approvalId);
  if (!proposal) throw new HttpError(409, { error: 'node_run_approval_required' });
  const action = proposal.apply_action || {};
  const approvedRunner = action.runner || proposal.after_json?.runner;
  if (proposal.status !== 'applied' || action.type !== NODE_RUN_APPROVAL) {
    throw new HttpError(409, { error: 'node_run_approval_not_applied', approval_id: proposal.id });
  }
  if (proposal.node_id !== nodeId || action.node_id !== nodeId || approvedRunner !== runner) {
    throw new HttpError(409, { error: 'node_run_approval_scope_mismatch', approval_id: proposal.id });
  }
  if (proposal.consumed_at) throw new HttpError(409, { error: 'node_run_approval_consumed', approval_id: proposal.id });
  return proposal;
}

export function consumeNodeRunApproval(proposal, runId) {
  Object.assign(proposal, { consumed_at: now(), consumed_by_run_id: runId, updated_at: now() });
  return proposal;
}

export function requireGitActionApproval(state, { approvalId, type, run, project, node }) {
  const proposal = state.change_proposals.find((item) => item.id === approvalId);
  if (!proposal) throw new HttpError(409, { error: 'git_action_approval_required', approval_type: type });
  const action = proposal.apply_action || {};
  if (proposal.status !== 'applied' || action.type !== type) throw new HttpError(409, { error: 'git_action_approval_not_applied', approval_id: proposal.id });
  if (proposal.project_id !== project.id || proposal.node_id !== node.id || action.run_id !== run.id) throw new HttpError(409, { error: 'git_action_approval_scope_mismatch', approval_id: proposal.id });
  if (proposal.consumed_at) throw new HttpError(409, { error: 'git_action_approval_consumed', approval_id: proposal.id });
  return proposal;
}

export function consumeGitActionApproval(proposal, operationId) {
  Object.assign(proposal, { consumed_at: now(), consumed_by_operation_id: operationId, updated_at: now() });
  return proposal;
}
