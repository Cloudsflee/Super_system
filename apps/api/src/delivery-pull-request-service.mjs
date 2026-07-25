import { HttpError } from './http.mjs';
import { createInstallationToken, githubJson, resolveGithubAppConfig } from './github-service.mjs';
import { assertProjectMembership } from './project-governance-v19.mjs';
import { addTrace, mutate, readState } from './state.mjs';
import { id, now } from '../../../packages/shared/index.mjs';

const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);

export async function readDeliveryPullRequest(deliveryId, actorId, dependencies = {}) {
  const context = await deliveryPullRequestContext(deliveryId, actorId, 'read', dependencies);
  const pull = await fetchPullRequest(context);
  assertPullRequestScope(context.delivery, pull, { requireHeadMatch: false });
  return publicPullRequest(context.delivery, context.connection, pull);
}

export async function reconcileDeliveryPullRequest(deliveryId, actorId, dependencies = {}) {
  const context = await deliveryPullRequestContext(deliveryId, actorId, 'github:write', dependencies);
  const pull = await fetchPullRequest(context);
  assertPullRequestScope(context.delivery, pull, { requireHeadMatch: false });
  const persisted = await persistPullRequestSnapshot(context.delivery, pull, actorId, 'reconcile');
  return {
    ...publicPullRequest(context.delivery, context.connection, pull),
    reconciled: true,
    changed: persisted.changed
  };
}

export async function markDeliveryPullRequestReady(deliveryId, input, actorId, dependencies = {}) {
  const context = await deliveryPullRequestContext(deliveryId, actorId, 'github:write', dependencies);
  const expectedHead = expectedHeadSha(context.delivery, input, { required: false });
  const pull = await fetchPullRequest(context);
  assertPullRequestScope(context.delivery, pull, { expectedHead, requireHeadMatch: true });
  if (pull.merged || pull.state !== 'open')
    throw new HttpError(409, { error: 'github_pull_request_not_open', state: pullState(pull) });
  if (!pull.draft) {
    const persisted = await persistPullRequestSnapshot(context.delivery, pull, actorId, 'ready');
    return {
      ...publicPullRequest(context.delivery, context.connection, pull),
      idempotent: true,
      changed: persisted.changed
    };
  }
  if (!pull.node_id) throw new HttpError(502, { error: 'github_pull_request_node_id_missing' });

  const query =
    'mutation($input:MarkPullRequestReadyForReviewInput!){markPullRequestReadyForReview(input:$input){pullRequest{number isDraft state url headRefOid}}}';
  const response = await githubCall(
    context,
    'https://api.github.com/graphql',
    {
      method: 'POST',
      body: JSON.stringify({ query, variables: { input: { pullRequestId: pull.node_id } } })
    },
    'github_pull_request_ready_failed'
  );
  if (response?.errors?.length)
    throw new HttpError(502, {
      error: 'github_pull_request_ready_failed',
      messages: response.errors
        .map((item) => String(item?.message || ''))
        .filter(Boolean)
        .slice(0, 5)
    });
  const ready = response?.data?.markPullRequestReadyForReview?.pullRequest;
  if (!ready || ready.isDraft || String(ready.headRefOid || '') !== expectedHead) {
    throw new HttpError(502, { error: 'github_pull_request_ready_unconfirmed' });
  }

  const snapshot = { ...pull, draft: false, state: 'open' };
  const persisted = await persistPullRequestSnapshot(context.delivery, snapshot, actorId, 'ready');
  return {
    ...publicPullRequest(context.delivery, context.connection, snapshot),
    idempotent: false,
    changed: persisted.changed
  };
}

export async function mergeDeliveryPullRequest(deliveryId, input, actorId, dependencies = {}) {
  const context = await deliveryPullRequestContext(deliveryId, actorId, 'github:write', dependencies);
  if (Object.keys(context.permissions).length && context.permissions.contents !== 'write')
    throw new HttpError(403, { error: 'github_contents_write_required' });
  const expectedHead = expectedHeadSha(context.delivery, input, { required: true });
  let pull = await fetchPullRequest(context);
  assertPullRequestScope(context.delivery, pull, { expectedHead, requireHeadMatch: true });
  if (pull.merged) {
    const persisted = await persistPullRequestSnapshot(context.delivery, pull, actorId, 'merge');
    return {
      ...publicPullRequest(context.delivery, context.connection, pull),
      idempotent: true,
      changed: persisted.changed
    };
  }
  if (pull.state !== 'open')
    throw new HttpError(409, { error: 'github_pull_request_not_open', state: pullState(pull) });
  if (pull.draft) throw new HttpError(409, { error: 'github_pull_request_ready_required' });

  pull = await waitForMergeability(context, pull);
  assertPullRequestScope(context.delivery, pull, { expectedHead, requireHeadMatch: true });
  if (pull.mergeable !== true || pull.mergeable_state !== 'clean')
    throw new HttpError(409, {
      error: 'github_pull_request_not_mergeable',
      mergeable: pull.mergeable,
      mergeable_state: pull.mergeable_state || 'unknown'
    });

  const mergeMethod = normalizeMergeMethod(input?.merge_method);
  const repository = await githubCall(context, context.repositoryUrl, {}, 'github_repository_read_failed');
  assertMergeMethodAllowed(repository, mergeMethod);
  const checks = await githubCall(
    context,
    `${context.repositoryUrl}/commits/${encodeURIComponent(expectedHead)}/check-runs?per_page=100`,
    {},
    'github_checks_read_required'
  );
  const incompleteChecks = (checks?.check_runs || []).filter(
    (item) => item.status !== 'completed' || !SUCCESSFUL_CHECK_CONCLUSIONS.has(item.conclusion)
  );
  if (incompleteChecks.length)
    throw new HttpError(409, {
      error: 'github_pull_request_checks_incomplete',
      checks: incompleteChecks
        .slice(0, 20)
        .map((item) => ({ name: item.name, status: item.status, conclusion: item.conclusion || null }))
    });

  const body = { sha: expectedHead, merge_method: mergeMethod };
  const title = cleanOptional(input?.commit_title, 256),
    message = cleanOptional(input?.commit_message, 4000);
  if (title) body.commit_title = title;
  if (message) body.commit_message = message;
  const merged = await githubCall(
    context,
    `${context.repositoryUrl}/pulls/${context.pullNumber}/merge`,
    {
      method: 'PUT',
      body: JSON.stringify(body)
    },
    'github_pull_request_merge_failed'
  );
  if (!merged?.merged || !SHA_PATTERN.test(String(merged.sha || '')))
    throw new HttpError(409, {
      error: 'github_pull_request_merge_rejected',
      message: String(merged?.message || 'GitHub rejected the merge.').slice(0, 500)
    });

  let confirmed = null;
  try {
    const remote = await fetchPullRequest(context);
    if (remote.merged && String(remote.merge_commit_sha || '') === String(merged.sha)) confirmed = remote;
  } catch {}
  const snapshot = confirmed || {
    ...pull,
    state: 'closed',
    draft: false,
    merged: true,
    merged_at: now(),
    merge_commit_sha: String(merged.sha)
  };
  const persisted = await persistPullRequestSnapshot(context.delivery, snapshot, actorId, 'merge', { mergeMethod });
  return {
    ...publicPullRequest(context.delivery, context.connection, snapshot),
    idempotent: false,
    changed: persisted.changed,
    merge_method: mergeMethod,
    remote_confirmed: Boolean(confirmed)
  };
}

async function deliveryPullRequestContext(deliveryId, actorId, action, dependencies) {
  const stateReader = dependencies.readState || readState;
  const state = await stateReader();
  const delivery = state.deliveries?.find((item) => item.id === String(deliveryId || ''));
  if (!delivery) throw new HttpError(404, { error: 'delivery_not_found' });
  assertProjectMembership(state, delivery.project_id, actorId, action);
  if (delivery.pull_request_intent_id)
    throw new HttpError(409, {
      error: 'delivery_pull_request_intent_required',
      pull_request_intent_id: delivery.pull_request_intent_id,
      endpoint: `/pull-request-intents/${delivery.pull_request_intent_id}`
    });
  if (delivery.status !== 'completed')
    throw new HttpError(409, { error: 'delivery_not_completed', status: delivery.status });
  const pullNumber = Number(delivery.pr_number);
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1)
    throw new HttpError(409, { error: 'delivery_pull_request_required' });
  const connection = state.repository_connections?.find(
    (item) => item.id === delivery.connection_id && item.project_id === delivery.project_id
  );
  if (!connection || connection.sync_status !== 'ready')
    throw new HttpError(409, { error: 'repository_connection_required' });
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(connection.full_name || '')))
    throw new HttpError(409, { error: 'github_repository_binding_invalid' });
  if (!connection.installation_id) throw new HttpError(409, { error: 'github_installation_required' });
  if (action === 'github:write' && connection.permissions?.pull_requests === false)
    throw new HttpError(403, { error: 'github_pull_request_write_required' });

  const resolveConfig = dependencies.resolveGithubAppConfig || resolveGithubAppConfig;
  const config = resolveConfig(state);
  if (!config) throw new HttpError(409, { error: 'github_app_config_required' });
  const issueToken = dependencies.createInstallationToken || createInstallationToken;
  const access = await issueToken(config, connection.installation_id);
  const permissions = access?.permissions || {};
  if (Object.keys(permissions).length && !['read', 'write'].includes(permissions.pull_requests))
    throw new HttpError(403, { error: 'github_pull_request_read_required' });
  if (action === 'github:write' && Object.keys(permissions).length && permissions.pull_requests !== 'write')
    throw new HttpError(403, { error: 'github_pull_request_write_required' });
  if (!access?.token) throw new HttpError(502, { error: 'github_installation_token_missing' });

  const repositoryUrl = `https://api.github.com/repos/${connection.full_name}`;
  return {
    state,
    delivery,
    connection,
    pullNumber,
    repositoryUrl,
    token: access.token,
    permissions,
    request: dependencies.githubJson || githubJson,
    mergeabilityAttempts: Math.max(1, Math.min(6, Number(dependencies.mergeabilityAttempts || 4))),
    mergeabilityDelayMs: Math.max(0, Math.min(2000, Number(dependencies.mergeabilityDelayMs ?? 500)))
  };
}

async function fetchPullRequest(context) {
  return githubCall(
    context,
    `${context.repositoryUrl}/pulls/${context.pullNumber}`,
    {},
    'github_pull_request_read_failed'
  );
}

async function waitForMergeability(context, initial) {
  let pull = initial;
  for (let attempt = 1; attempt < context.mergeabilityAttempts && pull.mergeable == null; attempt++) {
    if (context.mergeabilityDelayMs) await new Promise((resolve) => setTimeout(resolve, context.mergeabilityDelayMs));
    pull = await fetchPullRequest(context);
  }
  return pull;
}

async function githubCall(context, url, options, errorCode) {
  try {
    return await context.request(url, {
      ...options,
      headers: {
        authorization: `Bearer ${context.token}`,
        'content-type': 'application/json',
        ...(options?.headers || {})
      }
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const status = Number(error?.status || 0);
    if ([401, 403].includes(status)) throw new HttpError(403, { error: errorCode, github_status: status });
    if (status === 404) throw new HttpError(404, { error: errorCode, github_status: status });
    if ([405, 409, 422].includes(status))
      throw new HttpError(409, {
        error: errorCode,
        github_status: status,
        message: String(error?.message || '').slice(0, 500)
      });
    throw new HttpError(502, { error: errorCode, github_status: status || null, retryable: true });
  }
}

function assertPullRequestScope(delivery, pull, { expectedHead = null, requireHeadMatch = true } = {}) {
  if (Number(pull?.number) !== Number(delivery.pr_number))
    throw new HttpError(409, { error: 'github_pull_request_number_mismatch' });
  if (delivery.branch && pull?.head?.ref && pull.head.ref !== delivery.branch)
    throw new HttpError(409, { error: 'github_pull_request_branch_mismatch' });
  if (delivery.base_ref && pull?.base?.ref && pull.base.ref !== delivery.base_ref)
    throw new HttpError(409, { error: 'github_pull_request_base_mismatch' });
  const recorded = String(delivery.commit_sha || '').toLowerCase(),
    actual = String(pull?.head?.sha || '').toLowerCase();
  if (!SHA_PATTERN.test(recorded)) throw new HttpError(409, { error: 'delivery_commit_sha_required' });
  if (requireHeadMatch && actual !== String(expectedHead || recorded).toLowerCase())
    throw new HttpError(409, {
      error: 'github_pull_request_head_changed',
      expected_head_sha: String(expectedHead || recorded).toLowerCase(),
      actual_head_sha: actual || null
    });
}

function expectedHeadSha(delivery, input, { required }) {
  const recorded = String(delivery.commit_sha || '')
    .trim()
    .toLowerCase();
  if (!SHA_PATTERN.test(recorded)) throw new HttpError(409, { error: 'delivery_commit_sha_required' });
  const raw = String(input?.expected_head_sha || '')
    .trim()
    .toLowerCase();
  if (required && !raw) throw new HttpError(400, { error: 'github_expected_head_sha_required' });
  const expected = raw || recorded;
  if (!SHA_PATTERN.test(expected)) throw new HttpError(400, { error: 'github_expected_head_sha_invalid' });
  if (expected !== recorded)
    throw new HttpError(409, {
      error: 'github_delivery_head_mismatch',
      expected_head_sha: expected,
      delivery_head_sha: recorded
    });
  return expected;
}

async function persistPullRequestSnapshot(sourceDelivery, pull, actorId, source, extra = {}) {
  return mutate((state) => {
    const delivery = state.deliveries.find((item) => item.id === sourceDelivery.id);
    if (
      !delivery ||
      Number(delivery.pr_number) !== Number(pull.number) ||
      delivery.commit_sha !== sourceDelivery.commit_sha
    ) {
      throw new HttpError(409, { error: 'delivery_pull_request_state_changed' });
    }
    const stateValue = pullState(pull),
      draft = Boolean(pull.draft),
      remoteHead = pull?.head?.sha || null;
    const mergeCommit = pull.merge_commit_sha || delivery.merge_commit_sha || null;
    const phase =
      stateValue === 'merged'
        ? 'merged'
        : stateValue === 'closed'
          ? 'pull_request_closed'
          : draft
            ? 'draft_pr_created'
            : 'pull_request_ready';
    const changed =
      delivery.pr_state !== stateValue ||
      Boolean(delivery.pr_draft) !== draft ||
      String(delivery.remote_head_sha || '') !== String(remoteHead || '') ||
      String(delivery.merge_commit_sha || '') !== String(mergeCommit || '');
    Object.assign(delivery, {
      pr_state: stateValue,
      pr_draft: draft,
      remote_head_sha: remoteHead,
      merge_commit_sha: mergeCommit,
      pr_merged_at: pull.merged_at || delivery.pr_merged_at || null,
      phase,
      last_pull_request_sync_at: now(),
      updated_at: now()
    });
    if (stateValue === 'merged')
      Object.assign(delivery, {
        merged_by_user_id: actorId,
        merge_method: extra.mergeMethod || delivery.merge_method || null
      });
    const task = state.workflow_nodes.find((item) => item.id === delivery.task_id);
    if (task && (!task.latest_delivery_id || task.latest_delivery_id === delivery.id))
      Object.assign(task, {
        delivery_status: draft ? 'draft' : stateValue === 'open' ? 'ready' : stateValue,
        updated_at: now()
      });
    if (changed) {
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
        data: { source, state: stateValue, draft, head_sha: remoteHead, merge_commit_sha: mergeCommit },
        created_at: now()
      });
      const event =
        stateValue === 'merged'
          ? 'delivery.pull_request.merged'
          : !draft && stateValue === 'open'
            ? 'delivery.pull_request.ready'
            : 'integration.synced';
      addTrace(
        state,
        event,
        {
          project_id: delivery.project_id,
          node_id: delivery.task_id,
          target_id: delivery.id,
          summary: `Pull request #${delivery.pr_number}: ${stateValue}`,
          data: { source, merge_commit_sha: mergeCommit }
        },
        actorId
      );
    }
    return { delivery: structuredClone(delivery), changed };
  });
}

function publicPullRequest(delivery, connection, pull) {
  return {
    delivery_id: delivery.id,
    project_id: delivery.project_id,
    repository: connection.full_name,
    number: Number(pull.number),
    url: pull.html_url || delivery.pr_url || null,
    state: pullState(pull),
    draft: Boolean(pull.draft),
    merged: Boolean(pull.merged),
    mergeable: pull.mergeable ?? null,
    mergeable_state: pull.mergeable_state || null,
    head_ref: pull?.head?.ref || null,
    head_sha: pull?.head?.sha || null,
    base_ref: pull?.base?.ref || null,
    merge_commit_sha: pull.merge_commit_sha || null,
    merged_at: pull.merged_at || null
  };
}

function pullState(pull) {
  return pull?.merged ? 'merged' : String(pull?.state || 'unknown').toLowerCase();
}
function normalizeMergeMethod(value) {
  const method = String(value || 'squash')
    .trim()
    .toLowerCase();
  if (!MERGE_METHODS.has(method))
    throw new HttpError(400, { error: 'github_merge_method_invalid', merge_method: method });
  return method;
}
function assertMergeMethodAllowed(repository, method) {
  const allowed =
    method === 'squash'
      ? repository?.allow_squash_merge
      : method === 'rebase'
        ? repository?.allow_rebase_merge
        : repository?.allow_merge_commit;
  if (allowed !== true) throw new HttpError(409, { error: 'github_merge_method_not_allowed', merge_method: method });
}
function cleanOptional(value, max) {
  const result = String(value || '')
    .replace(/\0/g, '')
    .trim();
  return result ? result.slice(0, max) : null;
}
