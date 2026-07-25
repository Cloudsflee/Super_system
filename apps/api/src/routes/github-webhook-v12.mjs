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
  const repositoryId = String(payload.repository?.id || ''),
    fullName = String(payload.repository?.full_name || '');
  const connectionIds = new Set(
    state.repository_connections
      .filter(
        (item) =>
          (repositoryId && String(item.repository_id) === repositoryId) || (fullName && item.full_name === fullName)
      )
      .map((item) => item.id)
  );
  if (!connectionIds.size) return;
  const branch = String(payload.pull_request?.head?.ref || payload.ref || '').replace(/^refs\/heads\//, ''),
    sha = String(payload.check_run?.head_sha || payload.check_suite?.head_sha || payload.sha || payload.after || '');
  const lines = state.repository_lines.filter(
    (item) =>
      connectionIds.has(item.connection_id) && (branch ? item.branch === branch : sha ? item.head_sha === sha : false)
  );
  for (const line of lines) {
    if (event === 'pull_request')
      Object.assign(line, {
        pr_number: payload.pull_request?.number || line.pr_number,
        pr_url: payload.pull_request?.html_url || line.pr_url,
        pr_state: payload.pull_request?.merged ? 'merged' : payload.pull_request?.state,
        merged_sha: payload.pull_request?.merged ? payload.pull_request?.merge_commit_sha || null : line.merged_sha,
        status: payload.pull_request?.merged ? 'merged' : 'integrating'
      });
    if (event === 'pull_request_review' && payload.review?.state)
      line.reviews = [
        ...(line.reviews || []).filter((item) => item.id !== payload.review.id),
        {
          id: payload.review.id,
          state: payload.review.state,
          user_id: payload.review.user?.id || null,
          submitted_at: payload.review.submitted_at || now()
        }
      ];
    if (event === 'check_run')
      line.checks = [
        ...(line.checks || []).filter((item) => item.id !== payload.check_run?.id),
        {
          id: payload.check_run?.id,
          name: payload.check_run?.name,
          status: payload.check_run?.status,
          conclusion: payload.check_run?.conclusion
        }
      ];
    if (event === 'check_suite')
      line.check_suites = [
        ...(line.check_suites || []).filter((item) => item.id !== payload.check_suite?.id),
        {
          id: payload.check_suite?.id,
          status: payload.check_suite?.status,
          conclusion: payload.check_suite?.conclusion
        }
      ];
    line.updated_at = now();
    reconcileWorkflowExecutionInState(state, line.workflow_execution_id);
  }
}

function applyRepositoryWorkspaceEvent(state, event, payload) {
  const repositoryId = String(payload.repository?.id || ''),
    fullName = String(payload.repository?.full_name || '');
  const connections = state.repository_connections.filter(
    (item) => (repositoryId && String(item.repository_id) === repositoryId) || (fullName && item.full_name === fullName)
  );
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
  const repositoryId = String(payload.repository?.id || ''),
    fullName = String(payload.repository?.full_name || '');
  const connections = state.repository_connections.filter(
    (item) => (repositoryId && String(item.repository_id) === repositoryId) || (fullName && item.full_name === fullName)
  );
  if (!connections.length) return;
  const connectionIds = new Set(connections.map((item) => item.id));
  const branch = String(payload.pull_request?.head?.ref || payload.ref || '').replace(/^refs\/heads\//, '');
  const sha = String(
    payload.check_run?.head_sha || payload.check_suite?.head_sha || payload.sha || payload.after || ''
  );
  let deliveries = state.deliveries.filter((item) => connectionIds.has(item.connection_id));
  if (payload.pull_request?.number) {
    const exact = deliveries.filter((item) => Number(item.pr_number) === Number(payload.pull_request.number));
    if (exact.length) deliveries = exact;
    else {
      const candidates = deliveries.filter(
        (item) =>
          !item.pr_number && Boolean(branch) && item.branch === branch && !['failed', 'cancelled'].includes(item.status)
      );
      deliveries = latestDelivery(candidates);
    }
  } else if (branch)
    deliveries = latestDelivery(
      deliveries.filter((item) => item.branch === branch && !['failed', 'cancelled'].includes(item.status))
    );
  else if (sha)
    deliveries = latestDelivery(
      deliveries.filter((item) => item.commit_sha === sha && !['failed', 'cancelled'].includes(item.status))
    );
  for (const delivery of deliveries) {
    const update = { event, action: payload.action || null, received_at: now() };
    if (event === 'pull_request') {
      Object.assign(delivery, {
        pr_number: payload.pull_request.number,
        pr_url: payload.pull_request.html_url || delivery.pr_url,
        pr_state: payload.pull_request.merged ? 'merged' : payload.pull_request.state,
        pr_draft: Boolean(payload.pull_request.draft)
      });
      update.pull_request = {
        number: payload.pull_request.number,
        state: delivery.pr_state,
        draft: delivery.pr_draft,
        merged: Boolean(payload.pull_request.merged)
      };
    } else if (event === 'pull_request_review') {
      delivery.review_state = payload.review?.state || payload.action || null;
      update.review_state = delivery.review_state;
    } else if (event === 'check_run') {
      delivery.check_run = {
        id: payload.check_run?.id,
        status: payload.check_run?.status,
        conclusion: payload.check_run?.conclusion
      };
      update.check_run = delivery.check_run;
    } else if (event === 'check_suite') {
      delivery.check_suite = {
        id: payload.check_suite?.id,
        status: payload.check_suite?.status,
        conclusion: payload.check_suite?.conclusion
      };
      update.check_suite = delivery.check_suite;
    } else if (event === 'status') {
      delivery.commit_status = { state: payload.state, context: payload.context, description: payload.description };
      update.commit_status = delivery.commit_status;
    } else if (event === 'push') {
      delivery.remote_head_sha = payload.after || null;
      update.remote_head_sha = delivery.remote_head_sha;
    }
    delivery.updated_at = now();
    appendDeliveryWebhookEvent(state, delivery, update);
    const task = state.workflow_nodes.find((item) => item.id === delivery.task_id);
    if (task && (!task.latest_delivery_id || task.latest_delivery_id === delivery.id)) {
      task.delivery_status = deliveryTaskStatus(event, delivery, payload) || task.delivery_status;
      task.updated_at = now();
    }
    for (const session of state.assist_sessions.filter(
      (item) =>
        item.version === 3 &&
        item.scope_type === 'task' &&
        item.scope_id === delivery.task_id &&
        item.scope_status === 'active'
    ))
      pushV3Event(state, session.id, null, 'delivery_webhook', { delivery_id: delivery.id, ...update });
  }
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
