import { approveProposal, markProposalApplied, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { proposalTargetHash } from './proposal-target.mjs';
import { applyAction } from './routes/change-proposals.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';

export function applyProposalAtomically(state, proposal, actor, expected = {}) {
  if (!proposal) throw new HttpError(404, { error: 'proposal_not_found' });
  if (proposal.project_id) assertProjectLifecycleIdle(state.projects.find((item) => item.id === proposal.project_id));
  if (proposal.status === 'applied') return { proposal, applied: proposal.applied_result || null, idempotent: true };
  if (proposal.status !== 'pending' && proposal.status !== 'approved') throw new HttpError(409, { error: 'proposal_not_pending' });
  if (expected.revision === undefined || !expected.target_hash) throw new HttpError(400, { error: 'approval_expectation_required', required: ['revision', 'target_hash'] });
  if (Number(expected.revision) !== Number(proposal.revision || 1)) throw new HttpError(409, { error: 'proposal_stale', reason: 'revision_mismatch', revision: proposal.revision });
  if (expected.target_hash !== proposal.target_hash) throw new HttpError(409, { error: 'proposal_stale', reason: 'client_target_hash_mismatch', revision: proposal.revision });
  const currentHash = proposalTargetHash(state, proposal);
  if (proposal.target_hash_mode === 'state' && proposal.target_hash && currentHash !== proposal.target_hash) throw new HttpError(409, { error: 'proposal_stale', reason: 'target_changed', revision: proposal.revision, target_hash: currentHash });
  if (proposal.status === 'pending') approveProposal(proposal, actor.id);
  const applied = applyAction(state, proposal);
  if (applied?.skipped) throw new HttpError(409, { error: 'proposal_apply_failed', detail: applied });
  if (applied?.validation && !applied.validation.ok) throw new HttpError(409, { error: 'proposal_apply_validation_failed', detail: applied.validation });
  markProposalApplied(proposal, actor.id);
  Object.assign(proposal, { attention_state: 'resolved', revision: Number(proposal.revision || 1) + 1, applied_result: applied, updated_at: now() });
  return { proposal, applied, idempotent: false };
}
