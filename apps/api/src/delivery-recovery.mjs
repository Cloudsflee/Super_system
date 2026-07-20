import { id, now } from '../../../packages/shared/index.mjs';

const COMMIT_SHA = /^[a-f0-9]{40,64}$/i;

export function recoverInvalidDeliveryPullRequestClaimsInState(state, { timestamp = now() } = {}) {
  const recovered = [];
  for (const delivery of state.deliveries || []) {
    if (!['failed', 'cancelled'].includes(delivery.status) || COMMIT_SHA.test(String(delivery.commit_sha || ''))) continue;
    const webhookClaim = (state.delivery_events || []).some((event) => event.delivery_id === delivery.id
      && event.type === 'github_webhook' && event.data?.pull_request?.number);
    if (!webhookClaim || !delivery.pr_number) continue;
    const previous = { pr_number: delivery.pr_number, pr_url: delivery.pr_url || null, pr_state: delivery.pr_state || null };
    Object.assign(delivery, {
      pr_number: null, pr_url: null, pr_state: null, pr_draft: null, remote_head_sha: null,
      merge_commit_sha: null, pr_merged_at: null, merged_by_user_id: null, merge_method: null,
      last_pull_request_sync_at: null, updated_at: timestamp
    });
    const sequence = (state.delivery_events || []).filter((item) => item.delivery_id === delivery.id).reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1;
    state.delivery_events.push({
      id: id('dle'), delivery_id: delivery.id, project_id: delivery.project_id, task_id: delivery.task_id,
      sequence, type: 'github_pull_request_recovered', data: { reason: 'failed_delivery_without_commit', previous }, created_at: timestamp
    });
    recovered.push(delivery.id);
  }
  return { changed: recovered.length > 0, delivery_ids: recovered };
}
