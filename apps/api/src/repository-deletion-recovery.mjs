import { now } from '../../../packages/shared/index.mjs';

export function recoverInterruptedRepositoryDeletionsInState(state, timestamp = now()) {
  const recovered = [];
  for (const intent of state.repository_deletion_intents || []) {
    if (intent.status !== 'executing') continue;
    Object.assign(intent, {
      status: 'reconciliation_required', execution_interrupted_at: timestamp,
      reconciliation: { status: 'pending', reason: 'service_restarted_during_deletion', requested_at: timestamp }, updated_at: timestamp
    });
    const repository = state.canonical_repositories?.find((item) => item.id === intent.canonical_repository_id);
    if (repository) {
      Object.assign(repository, { remote_state: 'uncertain', updated_at: timestamp });
      for (const mirror of state.github_repositories?.filter((item) => item.canonical_repository_id === repository.id) || []) Object.assign(mirror, { status: 'uncertain', updated_at: timestamp });
    }
    recovered.push(intent);
  }
  return recovered.length;
}
