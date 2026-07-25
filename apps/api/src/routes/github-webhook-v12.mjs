import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, makeRoute, send } from '../http.mjs';
import { addTrace, mutate, owner, readState } from '../state.mjs';
import { appCredentials, resolveGithubAppConfig } from '../github-service.mjs';
import { id, now } from '../../../../packages/shared/index.mjs';
import { pushV3Event } from '../assist-v3-events.mjs';
import {
  reconcileRepositoryDeletionInState,
  revokeRepositoryInstallationBindingsInState
} from '../repository-lifecycle-v19.mjs';
import { reconcilePullRequestIntentWebhookInState } from '../pull-request-intent-domain.mjs';
import { markRepositoryWorkspacesStale } from '../repository-workspace-service.mjs';
import { reconcileWorkflowExecutionInState } from '../workflow-execution-domain.mjs';

export const githubWebhookV12Routes = [makeRoute('POST', '/github/webhook', webhook)];

async function webhook({ req, res, body }) {
  const delivery = String(req.headers['x-github-delivery'] || '');
  const event = String(req.headers['x-github-event'] || '');
  const signature = String(req.headers['x-hub-signature-256'] || '');
  if (!delivery || !event) throw new HttpError(400, { error: 'github_webhook_headers_required' });
  const state = await readState();
  const config = resolveGithubAppConfig(state);
  const credentials = config ? await appCredentials(config) : null;
  const secret = credentials?.webhookSecret || '';
  if (!verifySignature(req.rawBody || '', signature, secret))
    throw new HttpError(401, { error: 'invalid_webhook_signature' });
  if (state.webhook_deliveries.some((item) => item.delivery_id === delivery))
    return send(res, 202, { accepted: true, duplicate: true });
  const result = await mutate((data) => {
    if (data.webhook_deliveries.some((item) => item.delivery_id === delivery))
      return { accepted: true, duplicate: true, event };
    const actor = owner(data);
    data.webhook_deliveries.push({ delivery_id: delivery, event, received_at: now() });
    applyEvent(data, event, body, delivery);
    addTrace(
      data,
      'github.webhook.received',
      { summary: `GitHub webhook: ${event}`, data: { delivery_id: delivery, action: body.action } },
      actor.id
    );
    return { accepted: true, duplicate: false, event };
  });
  return send(res, 202, result);
}

function applyEvent(state, event, payload, deliveryId = null) {
  const installationId = String(payload.installation?.id || '');
  const installation = state.github_installations.find((item) => String(item.installation_id) === installationId);
  if (event === 'installation' && payload.action === 'deleted' && installation) {
    installation.status = 'removed';
    removeBindings(state, installation.installation_id);
  }
  if (event === 'installation_repositories' && installation) {
    const removed = new Set((payload.repositories_removed || []).map((item) => String(item.id)));
    installation.repositories = (installation.repositories || []).filter((item) => !removed.has(String(item.id)));
    if (removed.size) removeBindings(state, installation.installation_id, removed);
    for (const repo of payload.repositories_added || [])
      if (!installation.repositories.some((item) => String(item.id) === String(repo.id)))
        installation.repositories.push({
          id: String(repo.id),
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
          selected: false,
          permissions: { pull: true, push: false, admin: false }
        });
    installation.updated_at = now();
  }
  if (['pull_request', 'pull_request_review', 'check_run', 'check_suite', 'status', 'push'].includes(event)) {
    reconcilePullRequestIntentWebhookInState(state, event, payload, deliveryId);
    applyRepositoryWorkspaceEvent(state, event, payload);
    applyDeliveryEvent(state, event, payload);
    applyRepositoryLineEvent(state, event, payload);
  }
  if (event === 'repository') {
    const reconciled = reconcileRepositoryDeletionInState(state, payload.repository || {}, {
      deleted: payload.action === 'deleted',
      delivery_id: deliveryId
    });
    for (const intent of reconciled?.intents || [])
      addTrace(state, 'repository.deletion.reconciled', {
        project_id: intent.snapshot?.bindings?.[0]?.project_id || null,
        target_type: 'repository_deletion_intent',
        target_id: intent.id,
        summary:
          payload.action === 'deleted' ? 'Repository 删除已由 webhook 确认' : 'Repository 仍存在，删除 intent 已对账',
        data: { delivery_id: deliveryId, status: intent.status }
      });
  }
}

function applyRepositoryLineEvent(state, event, payload) {
  const connectionIds = new Set(matchingRepositoryConnections(state, payload).map((item) => item.id));
  if (!connectionIds.size) return;
  const branch = String(payload.pull_request?.head?.ref || payload.ref || '').replace(/^refs\/heads\//, ''),
    sha = String(payload.check_run?.head_sha || payload.check_suite?.head_sha || payload.sha || payload.after || '');
  const lines = state.repository_lines.filter(
    (item) =>
      connectionIds.has(item.connection_id) && (branch ? item.branch === branch : sha ? item.head_sha === sha : false)
  );
  for (const line of lines) {
    updateRepositoryLine(line, event, payload);
    line.updated_at = now();
    reconcileWorkflowExecutionInState(state, line.workflow_execution_id);
  }
}

function updateRepositoryLine(line, event, payload) {
  if (event === 'pull_request') updateRepositoryLinePullRequest(line, payload.pull_request);
  if (event === 'pull_request_review' && payload.review?.state) updateRepositoryLineReview(line, payload.review);
  if (event === 'check_run') updateRepositoryLineCheckRun(line, payload.check_run);
  if (event === 'check_suite') updateRepositoryLineCheckSuite(line, payload.check_suite);
}

function updateRepositoryLinePullRequest(line, pullRequest) {
  Object.assign(line, {
    pr_number: pullRequest?.number || line.pr_number,
    pr_url: pullRequest?.html_url || line.pr_url,
    pr_state: pullRequest?.merged ? 'merged' : pullRequest?.state,
    merged_sha: pullRequest?.merged ? pullRequest?.merge_commit_sha || null : line.merged_sha,
    status: pullRequest?.merged ? 'merged' : 'integrating'
  });
}

function updateRepositoryLineReview(line, review) {
  line.reviews = [
    ...(line.reviews || []).filter((item) => item.id !== review.id),
    {
      id: review.id,
      state: review.state,
      user_id: review.user?.id || null,
      submitted_at: review.submitted_at || now()
    }
  ];
}

function updateRepositoryLineCheckRun(line, checkRun) {
  line.checks = [
    ...(line.checks || []).filter((item) => item.id !== checkRun?.id),
    { id: checkRun?.id, name: checkRun?.name, status: checkRun?.status, conclusion: checkRun?.conclusion }
  ];
}

function updateRepositoryLineCheckSuite(line, checkSuite) {
  line.check_suites = [
    ...(line.check_suites || []).filter((item) => item.id !== checkSuite?.id),
    { id: checkSuite?.id, status: checkSuite?.status, conclusion: checkSuite?.conclusion }
  ];
}

function applyRepositoryWorkspaceEvent(state, event, payload) {
  const connections = matchingRepositoryConnections(state, payload);
  if (!connections.length) return;
  if (event === 'push') {
    const ref = String(payload.ref || '').replace(/^refs\/heads\//, '');
    for (const connection of connections)
      markRepositoryWorkspacesStale(state, {
        projectId: connection.project_id,
        connectionId: connection.id,
        ref,
        remoteSha: payload.after || null
      });
  }
  if (event === 'pull_request' && payload.pull_request?.merged) {
    const ref = payload.pull_request.base?.ref || null,
      sha = payload.pull_request.merge_commit_sha || payload.pull_request.base?.sha || null;
    for (const connection of connections)
      markRepositoryWorkspacesStale(state, {
        projectId: connection.project_id,
        connectionId: connection.id,
        ref,
        remoteSha: sha
      });
  }
}

function removeBindings(state, installationId, repositoryIds = null) {
  revokeRepositoryInstallationBindingsInState(state, installationId, repositoryIds);
  // Keep the legacy collection's historical behavior for callers that still
  // treat a missing binding as disconnected, while the V1.9 collections keep
  // an explicit removed record for audit and reconciliation.
  state.repository_bindings = state.repository_bindings.filter(
    (item) =>
      String(item.installation_id) !== String(installationId) ||
      (repositoryIds && !repositoryIds.has(String(item.repository_id)))
  );
}

function applyDeliveryEvent(state, event, payload) {
  const connections = matchingRepositoryConnections(state, payload);
  if (!connections.length) return;
  const connectionIds = new Set(connections.map((item) => item.id));
  const branch = String(payload.pull_request?.head?.ref || payload.ref || '').replace(/^refs\/heads\//, '');
  const sha = String(
    payload.check_run?.head_sha || payload.check_suite?.head_sha || payload.sha || payload.after || ''
  );
  const deliveries = selectWebhookDeliveries(state, connectionIds, payload, branch, sha);
  for (const delivery of deliveries) applyDeliveryWebhook(state, delivery, event, payload);
}

function matchingRepositoryConnections(state, payload) {
  const repositoryId = String(payload.repository?.id || '');
  const fullName = String(payload.repository?.full_name || '');
  return state.repository_connections.filter(
    (item) => (repositoryId && String(item.repository_id) === repositoryId) || (fullName && item.full_name === fullName)
  );
}

function selectWebhookDeliveries(state, connectionIds, payload, branch, sha) {
  let deliveries = state.deliveries.filter((item) => connectionIds.has(item.connection_id));
  if (payload.pull_request?.number) {
    const exact = deliveries.filter((item) => Number(item.pr_number) === Number(payload.pull_request.number));
    if (exact.length) return exact;
    const candidates = deliveries.filter(
      (item) =>
        !item.pr_number && Boolean(branch) && item.branch === branch && !['failed', 'cancelled'].includes(item.status)
    );
    return latestDelivery(candidates);
  }
  if (branch)
    return latestDelivery(
      deliveries.filter((item) => item.branch === branch && !['failed', 'cancelled'].includes(item.status))
    );
  if (sha)
    return latestDelivery(
      deliveries.filter((item) => item.commit_sha === sha && !['failed', 'cancelled'].includes(item.status))
    );
  return deliveries;
}

function applyDeliveryWebhook(state, delivery, event, payload) {
  const update = { event, action: payload.action || null, received_at: now() };
  updateDeliveryFromEvent(delivery, update, event, payload);
  delivery.updated_at = now();
  appendDeliveryWebhookEvent(state, delivery, update);
  updateDeliveryTask(state, delivery, event, payload);
  publishDeliveryWebhook(state, delivery, update);
}

function updateDeliveryFromEvent(delivery, update, event, payload) {
  if (event === 'pull_request') updateDeliveryPullRequest(delivery, update, payload.pull_request);
  else if (event === 'pull_request_review') {
    delivery.review_state = payload.review?.state || payload.action || null;
    update.review_state = delivery.review_state;
  } else if (event === 'check_run') updateDeliveryCheckRun(delivery, update, payload.check_run);
  else if (event === 'check_suite') updateDeliveryCheckSuite(delivery, update, payload.check_suite);
  else if (event === 'status') {
    delivery.commit_status = { state: payload.state, context: payload.context, description: payload.description };
    update.commit_status = delivery.commit_status;
  } else if (event === 'push') {
    delivery.remote_head_sha = payload.after || null;
    update.remote_head_sha = delivery.remote_head_sha;
  }
}

function updateDeliveryPullRequest(delivery, update, pullRequest) {
  Object.assign(delivery, {
    pr_number: pullRequest.number,
    pr_url: pullRequest.html_url || delivery.pr_url,
    pr_state: pullRequest.merged ? 'merged' : pullRequest.state,
    pr_draft: Boolean(pullRequest.draft)
  });
  update.pull_request = {
    number: pullRequest.number,
    state: delivery.pr_state,
    draft: delivery.pr_draft,
    merged: Boolean(pullRequest.merged)
  };
}

function updateDeliveryCheckRun(delivery, update, checkRun) {
  delivery.check_run = { id: checkRun?.id, status: checkRun?.status, conclusion: checkRun?.conclusion };
  update.check_run = delivery.check_run;
}

function updateDeliveryCheckSuite(delivery, update, checkSuite) {
  delivery.check_suite = { id: checkSuite?.id, status: checkSuite?.status, conclusion: checkSuite?.conclusion };
  update.check_suite = delivery.check_suite;
}

function updateDeliveryTask(state, delivery, event, payload) {
  const task = state.workflow_nodes.find((item) => item.id === delivery.task_id);
  if (!task || (task.latest_delivery_id && task.latest_delivery_id !== delivery.id)) return;
  task.delivery_status = deliveryTaskStatus(event, delivery, payload) || task.delivery_status;
  task.updated_at = now();
}

function publishDeliveryWebhook(state, delivery, update) {
  for (const session of state.assist_sessions.filter(
    (item) =>
      item.version === 3 &&
      item.scope_type === 'task' &&
      item.scope_id === delivery.task_id &&
      item.scope_status === 'active'
  ))
    pushV3Event(state, session.id, null, 'delivery_webhook', { delivery_id: delivery.id, ...update });
}

function latestDelivery(items) {
  return items.length ? [items[items.length - 1]] : [];
}

function deliveryTaskStatus(event, delivery, payload) {
  if (event === 'pull_request') return delivery.pr_draft ? 'draft' : delivery.pr_state;
  if (event === 'pull_request_review') return delivery.review_state;
  if (event === 'check_run') return delivery.check_run?.conclusion || delivery.check_run?.status;
  if (event === 'check_suite') return delivery.check_suite?.conclusion || delivery.check_suite?.status;
  if (event === 'status') return delivery.commit_status?.state;
  if (event === 'push') return payload.after ? 'pushed' : null;
  return null;
}

function appendDeliveryWebhookEvent(state, delivery, data) {
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
    type: 'github_webhook',
    data,
    created_at: now()
  });
}

function verifySignature(raw, provided, secret) {
  if (!secret || !provided.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const left = Buffer.from(expected),
    right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
