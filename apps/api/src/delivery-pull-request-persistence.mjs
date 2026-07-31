import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate } from './state.mjs';

export async function persistPullRequestSnapshot(sourceDelivery, pull, actorId, source, extra = {}) {
  return mutate((state) => persistPullRequestSnapshotInState(state, sourceDelivery, pull, actorId, source, extra));
}

export function pullRequestState(pull) {
  return pull?.merged ? 'merged' : String(pull?.state || 'unknown').toLowerCase();
}

function persistPullRequestSnapshotInState(state, sourceDelivery, pull, actorId, source, extra) {
  const delivery = state.deliveries.find((item) => item.id === sourceDelivery.id);
  assertSnapshotCurrent(delivery, sourceDelivery, pull);
  const snapshot = pullRequestSnapshot(delivery, pull);
  applyPullRequestSnapshot(delivery, pull, actorId, extra, snapshot);
  updateTaskDeliveryStatus(state, delivery, snapshot);
  if (snapshot.changed) recordPullRequestChange(state, delivery, actorId, source, snapshot);
  return { delivery: structuredClone(delivery), changed: snapshot.changed };
}

function assertSnapshotCurrent(delivery, sourceDelivery, pull) {
  if (
    !delivery ||
    Number(delivery.pr_number) !== Number(pull.number) ||
    delivery.commit_sha !== sourceDelivery.commit_sha
  )
    throw new HttpError(409, { error: 'delivery_pull_request_state_changed' });
}

function pullRequestSnapshot(delivery, pull) {
  const stateValue = pullRequestState(pull),
    draft = Boolean(pull.draft),
    remoteHead = pull?.head?.sha || null,
    mergeCommit = pull.merge_commit_sha || delivery.merge_commit_sha || null;
  return {
    stateValue,
    draft,
    remoteHead,
    mergeCommit,
    phase: pullRequestPhase(stateValue, draft),
    changed: pullRequestChanged(delivery, stateValue, draft, remoteHead, mergeCommit)
  };
}

function pullRequestPhase(stateValue, draft) {
  if (stateValue === 'merged') return 'merged';
  if (stateValue === 'closed') return 'pull_request_closed';
  return draft ? 'draft_pr_created' : 'pull_request_ready';
}

function pullRequestChanged(delivery, stateValue, draft, remoteHead, mergeCommit) {
  return (
    delivery.pr_state !== stateValue ||
    Boolean(delivery.pr_draft) !== draft ||
    String(delivery.remote_head_sha || '') !== String(remoteHead || '') ||
    String(delivery.merge_commit_sha || '') !== String(mergeCommit || '')
  );
}

function applyPullRequestSnapshot(delivery, pull, actorId, extra, snapshot) {
  Object.assign(delivery, {
    pr_state: snapshot.stateValue,
    pr_draft: snapshot.draft,
    remote_head_sha: snapshot.remoteHead,
    merge_commit_sha: snapshot.mergeCommit,
    pr_merged_at: pull.merged_at || delivery.pr_merged_at || null,
    phase: snapshot.phase,
    last_pull_request_sync_at: now(),
    updated_at: now()
  });
  if (snapshot.stateValue === 'merged')
    Object.assign(delivery, {
      merged_by_user_id: actorId,
      merge_method: extra.mergeMethod || delivery.merge_method || null
    });
}

function updateTaskDeliveryStatus(state, delivery, snapshot) {
  const task = state.workflow_nodes.find((item) => item.id === delivery.task_id);
  if (!task || (task.latest_delivery_id && task.latest_delivery_id !== delivery.id)) return;
  Object.assign(task, {
    delivery_status: snapshot.draft ? 'draft' : snapshot.stateValue === 'open' ? 'ready' : snapshot.stateValue,
    updated_at: now()
  });
}

function recordPullRequestChange(state, delivery, actorId, source, snapshot) {
  const sequence =
    state.delivery_events
      .filter((item) => item.delivery_id === delivery.id)
      .reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0) + 1;
  state.delivery_events.push({
    id: id('dle'),
    delivery_id: delivery.id,
    project_id: delivery.project_id,
    task_id: delivery.task_id,
    sequence,
    type: 'github_pull_request',
    data: {
      source,
      state: snapshot.stateValue,
      draft: snapshot.draft,
      head_sha: snapshot.remoteHead,
      merge_commit_sha: snapshot.mergeCommit
    },
    created_at: now()
  });
  tracePullRequestChange(state, delivery, actorId, source, snapshot);
}

function tracePullRequestChange(state, delivery, actorId, source, snapshot) {
  addTrace(
    state,
    pullRequestTraceEvent(snapshot),
    {
      project_id: delivery.project_id,
      node_id: delivery.task_id,
      target_id: delivery.id,
      summary: `Pull request #${delivery.pr_number}: ${snapshot.stateValue}`,
      data: { source, merge_commit_sha: snapshot.mergeCommit }
    },
    actorId
  );
}

function pullRequestTraceEvent(snapshot) {
  if (snapshot.stateValue === 'merged') return 'delivery.pull_request.merged';
  if (!snapshot.draft && snapshot.stateValue === 'open') return 'delivery.pull_request.ready';
  return 'integration.synced';
}
