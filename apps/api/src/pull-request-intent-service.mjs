import { git } from './git-utils.mjs';
import { createInstallationToken, githubGitAuthEnv, githubJson, resolveGithubAppConfig } from './github-service.mjs';
import { HttpError } from './http.mjs';
import { addTrace, mutate, readState } from './state.mjs';
import {
  completePullRequestIntentExecutionInState,
  failPullRequestIntentExecutionInState,
  preparePullRequestIntentExecutionInState,
  reconcilePullRequestIntentSnapshotInState,
  refreshPullRequestIntentBaseInState,
  requireIntent
} from './pull-request-intent-domain.mjs';
import { verifyRepositoryLineHead } from './repository-line-service.mjs';
import { markRepositoryWorkspacesStale, repositoryWorkspaceRoot } from './repository-workspace-service.mjs';
import { runApprovedVerificationCommands } from './task-execution-service.mjs';

const SUCCESS = new Set(['success', 'neutral', 'skipped']);

export async function ensurePullRequestIntentChecks(intentId, actorId, options = {}) {
  const snapshot = await readState(),
    intent = requireIntent(snapshot, intentId);
  const { assertProjectMembership } = await import('./project-governance-v19.mjs');
  assertProjectMembership(snapshot, intent.project_id, actorId, 'approve');
  return mutate(async (state) => {
    const result = await ensurePullRequestIntentChecksInState(state, intentId, options);
    if (result.executed)
      addTrace(
        state,
        'pull_request.intent.local_checks_completed',
        {
          project_id: result.intent.project_id,
          target_type: 'pull_request_intent',
          target_id: result.intent.id,
          summary: `Local delivery-policy checks: ${result.intent.checks_status}`,
          data: {
            repository_sha: result.intent.head_sha,
            checks_status: result.intent.checks_status,
            checks_count: result.checks.length
          }
        },
        actorId
      );
    return result;
  });
}

export async function ensurePullRequestIntentChecksInState(state, intentId, options = {}) {
  const intent = requireIntent(state, intentId);
  if ((intent.checks || []).length) return { intent, checks: intent.checks, executed: false };
  if (['pending', 'failed'].includes(intent.checks_status))
    throw new HttpError(409, {
      error: 'pull_request_remote_checks_not_passed',
      checks_status: intent.checks_status
    });
  const allowedStatuses = options.allowMergedRecovery ? ['draft_open', 'ready', 'merged'] : ['draft_open', 'ready'];
  if (!allowedStatuses.includes(intent.status))
    throw new HttpError(409, { error: 'pull_request_local_checks_status_invalid', status: intent.status });
  const line = state.repository_lines.find((item) => item.id === intent.repository_line_id);
  if (!line) throw new HttpError(409, { error: 'pull_request_local_checks_repository_line_required' });
  const before = await verifyRepositoryLineHead(line, intent.head_sha, { requireClean: true }),
    commands = await runApprovedVerificationCommands(state, intent, line),
    after = await verifyRepositoryLineHead(line, intent.head_sha, { requireClean: true });
  if (before.repository_sha !== after.repository_sha)
    throw new HttpError(409, { error: 'pull_request_local_checks_head_changed' });
  if (!commands.length) throw new HttpError(409, { error: 'pull_request_local_checks_commands_required' });
  const failed = commands.some((item) => item.status !== 'passed' || Number(item.exit_code) !== 0),
    timestamp = new Date().toISOString(),
    checks = commands.map((item, index) => ({
      id: `aiws-policy-${index + 1}-${item.log_sha256.slice(0, 12)}`,
      name: `AIWS Delivery Policy: ${item.command}`,
      status: 'completed',
      conclusion: item.status === 'passed' && Number(item.exit_code) === 0 ? 'success' : 'failure',
      source: 'aiws_delivery_policy',
      repository_sha: intent.head_sha,
      log_sha256: item.log_sha256,
      completed_at: timestamp
    }));
  Object.assign(intent, {
    checks,
    checks_status: failed ? 'failed' : 'passed',
    ...(intent.status === 'merged'
      ? { local_checks_recovered_at: timestamp }
      : {
          reconciliation: {
            status: 'local_delivery_policy',
            action: 'verify_checks',
            repository_sha: intent.head_sha,
            reconciled_at: timestamp
          }
        }),
    updated_at: timestamp
  });
  return { intent, checks, executed: true };
}

export async function executePullRequestIntent(intentId, input, actorId, dependencies = {}) {
  const prepared = await mutate((state) => preparePullRequestIntentExecutionInState(state, intentId, input, actorId));
  const action = String(input.action || '');
  let remoteCompleted = false;
  try {
    const snapshot = await readState(),
      intent = requireIntent(snapshot, intentId);
    const result = isTest(input)
      ? testResult(intent, action, input)
      : await executeRemote(snapshot, intent, prepared.workspace, action, dependencies);
    const completed = await mutate((state) => {
      const value = completePullRequestIntentExecutionInState(state, intentId, action, result, actorId);
      if (action === 'merge_pr' && value.repository_workspace_id)
        markRepositoryWorkspacesStale(state, {
          projectId: value.project_id,
          connectionId: value.connection_id,
          ref: value.base_ref,
          remoteSha: result.merge_commit_sha
        });
      addTrace(
        state,
        action === 'create_pr' ? 'pull_request.intent.created' : 'pull_request.intent.merged',
        {
          project_id: value.project_id,
          target_type: 'pull_request_intent',
          target_id: value.id,
          summary: action === 'create_pr' ? `Draft PR #${value.pr_number} created` : `PR #${value.pr_number} merged`,
          data: { revision: value.revision, snapshot_hash: value.snapshot_hash }
        },
        actorId
      );
      return value;
    });
    remoteCompleted = true;
    if (completed.repository_line_id) {
      const { advanceRepositoryIntegration } = await import('./repository-integration-service.mjs');
      await advanceRepositoryIntegration(completed.id, action, result, actorId);
    }
    return completed;
  } catch (error) {
    if (remoteCompleted) throw error;
    if (
      action === 'create_pr' &&
      error?.payload?.error === 'pull_request_intent_base_changed' &&
      error.payload.refreshable === true &&
      error.payload.actual_base_sha
    ) {
      const refreshed = await mutate((state) => {
        const value = refreshPullRequestIntentBaseInState(state, intentId, error.payload.actual_base_sha);
        addTrace(
          state,
          'pull_request.intent.reconciled',
          {
            project_id: value.intent.project_id,
            target_type: 'pull_request_intent',
            target_id: value.intent.id,
            summary: `Base snapshot refreshed: ${value.previous_base_sha} -> ${value.intent.base_sha}`,
            data: {
              revision: value.intent.revision,
              snapshot_hash: value.intent.snapshot_hash,
              previous_base_sha: value.previous_base_sha,
              actual_base_sha: value.intent.base_sha,
              approval_required: true
            }
          },
          actorId
        );
        return value;
      });
      throw new HttpError(409, {
        error: 'pull_request_intent_base_refreshed',
        previous_base_sha: refreshed.previous_base_sha,
        actual_base_sha: refreshed.intent.base_sha,
        actual_revision: refreshed.intent.revision,
        actual_snapshot_hash: refreshed.intent.snapshot_hash,
        approval_required: true
      });
    }
    const uncertain = !error?.status || Number(error.status) >= 500 || error?.payload?.retryable === true;
    await mutate((state) =>
      failPullRequestIntentExecutionInState(state, intentId, action, error?.payload?.error || error.message, {
        uncertain
      })
    );
    throw error;
  }
}

export async function reconcilePullRequestIntent(intentId, actorId, dependencies = {}, input = {}) {
  const state = await readState(),
    intent = requireIntent(state, intentId);
  const { assertProjectMembership } = await import('./project-governance-v19.mjs');
  assertProjectMembership(state, intent.project_id, actorId, 'write');
  const snapshot = isTest(input)
    ? testReconciliation(intent, input)
    : await readRemoteSnapshot(state, intent, dependencies);
  return mutate((current) => {
    const reconciled = reconcilePullRequestIntentSnapshotInState(current, intentId, snapshot);
    addTrace(
      current,
      'pull_request.intent.reconciled',
      {
        project_id: reconciled.project_id,
        target_type: 'pull_request_intent',
        target_id: reconciled.id,
        summary: `PR intent reconciled: ${reconciled.status}`,
        data: { checks_status: reconciled.checks_status, revision: reconciled.revision }
      },
      actorId
    );
    return reconciled;
  });
}

async function executeRemote(state, intent, workspace, action, dependencies) {
  const context = await remoteContext(state, intent, dependencies);
  await assertRemoteRefs(context, intent, workspace, action === 'create_pr');
  if (action === 'create_pr') return createOrReusePullRequest(context, intent);
  const pull = await readPull(context, intent.pr_number);
  assertPullSnapshot(intent, pull);
  const checks = await readChecks(context, intent.head_sha);
  if (checks.status !== 'passed')
    throw new HttpError(409, {
      error: 'pull_request_checks_not_passed',
      checks_status: checks.status,
      checks: checks.items
    });
  let ready = pull;
  if (pull.draft) ready = await markReady(context, pull);
  if (ready.draft) throw new HttpError(409, { error: 'pull_request_ready_unconfirmed' });
  const merged = await call(
    context,
    `${context.repositoryUrl}/pulls/${intent.pr_number}/merge`,
    {
      method: 'PUT',
      headers: jsonHeaders(context),
      body: JSON.stringify({ sha: intent.head_sha, merge_method: normalizeMergeMethod(context.mergeMethod) })
    },
    'github_pull_request_merge_failed'
  );
  if (!merged?.merged || !/^[a-f0-9]{40,64}$/i.test(String(merged.sha || '')))
    throw new HttpError(409, {
      error: 'github_pull_request_merge_rejected',
      message: String(merged?.message || '').slice(0, 500)
    });
  return { merge_commit_sha: String(merged.sha).toLowerCase(), checks_status: checks.status, checks: checks.items };
}

async function readRemoteSnapshot(state, intent, dependencies) {
  const context = await remoteContext(state, intent, dependencies),
    pull = await readPull(context, intent.pr_number);
  assertPullSnapshot(intent, pull);
  const checks = await readChecks(context, intent.head_sha);
  return { ...pullSnapshot(pull, checks.status), checks: checks.items };
}

async function remoteContext(state, intent, dependencies) {
  const connection = state.repository_connections.find(
    (item) => item.id === intent.connection_id && item.project_id === intent.project_id
  );
  if (!connection || connection.sync_status !== 'ready')
    throw new HttpError(409, { error: 'repository_connection_required' });
  if (connection.permissions?.pull_requests !== true)
    throw new HttpError(403, { error: 'github_pull_request_write_required' });
  if (!connection.installation_id) throw new HttpError(409, { error: 'github_installation_required' });
  const config = resolveGithubAppConfig(state);
  if (!config) throw new HttpError(409, { error: 'github_app_config_required' });
  const access = await (dependencies.createInstallationToken || createInstallationToken)(
      config,
      connection.installation_id
    ),
    permissions = access?.permissions || {};
  if (Object.keys(permissions).length && permissions.pull_requests !== 'write')
    throw new HttpError(403, { error: 'github_pull_request_write_required' });
  if (!access?.token) throw new HttpError(502, { error: 'github_installation_token_missing' });
  return {
    state,
    connection,
    token: access.token,
    permissions,
    request: dependencies.githubJson || githubJson,
    repositoryUrl: `https://api.github.com/repos/${connection.full_name}`,
    mergeMethod: dependencies.mergeMethod || 'squash'
  };
}

async function assertRemoteRefs(context, intent, workspace, allowPushReview) {
  const base = await readRef(context, intent.base_ref);
  if (base !== intent.base_sha)
    throw new HttpError(409, {
      error: 'pull_request_intent_base_changed',
      expected_base_sha: intent.base_sha,
      actual_base_sha: base,
      refreshable: true
    });
  let head = await readRef(context, intent.head_ref, true);
  if (
    head !== intent.head_sha &&
    allowPushReview &&
    (intent.repository_line_id || intent.head_ref.startsWith('aiws/review-'))
  ) {
    const line = intent.repository_line_id
      ? context.state.repository_lines.find((item) => item.id === intent.repository_line_id)
      : null;
    const root = line?.checkout_path || repositoryWorkspaceRoot(context.state, workspace.id).root;
    const remote = line ? context.connection.remote_name || 'origin' : 'origin';
    const pushed = git(
      root,
      ['push', '--set-upstream', remote, `${intent.head_sha}:refs/heads/${intent.head_ref}`],
      120_000,
      githubGitAuthEnv(context.token)
    );
    if (!pushed.ok)
      throw new HttpError(409, { error: 'pull_request_head_push_failed', detail: pushed.stderr || pushed.error });
    head = await readRef(context, intent.head_ref);
  }
  if (!head) throw new HttpError(404, { error: 'pull_request_head_ref_not_found', ref: intent.head_ref });
  if (head !== intent.head_sha)
    throw new HttpError(409, {
      error: 'pull_request_intent_head_changed',
      expected_head_sha: intent.head_sha,
      actual_head_sha: head
    });
}

async function createOrReusePullRequest(context, intent) {
  const owner = context.connection.full_name.split('/')[0];
  const query = new URLSearchParams({
    state: 'open',
    head: `${owner}:${intent.head_ref}`,
    base: intent.base_ref,
    per_page: '100'
  });
  const existing = await call(
    context,
    `${context.repositoryUrl}/pulls?${query}`,
    {},
    'github_pull_request_list_failed'
  );
  let pull = Array.isArray(existing)
    ? existing.find((item) => item.head?.ref === intent.head_ref && item.base?.ref === intent.base_ref)
    : null;
  if (!pull)
    pull = await call(
      context,
      `${context.repositoryUrl}/pulls`,
      {
        method: 'POST',
        headers: jsonHeaders(context),
        body: JSON.stringify({
          title: intent.title,
          head: intent.head_ref,
          base: intent.base_ref,
          body: intent.body || undefined,
          draft: true
        })
      },
      'github_pull_request_create_failed'
    );
  assertPullSnapshot(intent, pull);
  if (pull.state !== 'open') throw new HttpError(409, { error: 'github_pull_request_not_open' });
  const checks = await readChecks(context, intent.head_sha);
  return {
    ...pullSnapshot(pull, checks.status),
    checks: checks.items,
    number: pull.number,
    html_url: pull.html_url,
    node_id: pull.node_id,
    state: 'open',
    draft: pull.draft !== false
  };
}

async function readPull(context, number) {
  if (!Number.isInteger(Number(number)) || Number(number) < 1)
    throw new HttpError(409, { error: 'pull_request_number_required' });
  return call(context, `${context.repositoryUrl}/pulls/${number}`, {}, 'github_pull_request_read_failed');
}
async function readRef(context, ref, optional = false) {
  try {
    const result = await call(
      context,
      `${context.repositoryUrl}/git/ref/heads/${encodeURIComponent(ref)}`,
      {},
      'github_ref_read_failed'
    );
    return String(result?.object?.sha || '').toLowerCase() || null;
  } catch (error) {
    if (optional && error.status === 404) return null;
    throw error;
  }
}
async function readChecks(context, sha) {
  const result = await call(
    context,
    `${context.repositoryUrl}/commits/${sha}/check-runs?per_page=100`,
    {},
    'github_checks_read_failed'
  );
  const items = (result?.check_runs || []).map((item) => ({
    name: item.name,
    status: item.status,
    conclusion: item.conclusion || null
  }));
  const failed = items.some((item) => item.status === 'completed' && !SUCCESS.has(item.conclusion)),
    pending = items.some((item) => item.status !== 'completed');
  return { status: failed ? 'failed' : pending ? 'pending' : 'passed', items };
}
async function markReady(context, pull) {
  if (!pull.node_id) throw new HttpError(502, { error: 'github_pull_request_node_id_missing' });
  const result = await call(
    context,
    'https://api.github.com/graphql',
    {
      method: 'POST',
      headers: jsonHeaders(context),
      body: JSON.stringify({
        query:
          'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft headRefOid}}}',
        variables: { id: pull.node_id }
      })
    },
    'github_pull_request_ready_failed'
  );
  if (result.errors?.length)
    throw new HttpError(409, {
      error: 'github_pull_request_ready_failed',
      messages: result.errors.map((item) => item.message).slice(0, 5)
    });
  const ready = result?.data?.markPullRequestReadyForReview?.pullRequest;
  return { ...pull, draft: Boolean(ready?.isDraft), head: { ...pull.head, sha: ready?.headRefOid || pull.head?.sha } };
}

async function call(context, url, options, errorCode) {
  try {
    return await context.request(url, {
      ...options,
      headers: { authorization: `Bearer ${context.token}`, ...(options.headers || {}) }
    });
  } catch (error) {
    const status = Number(error.status || 0);
    if ([401, 403].includes(status)) throw new HttpError(403, { error: errorCode, github_status: status });
    if (status === 404) throw new HttpError(404, { error: errorCode, github_status: status });
    if ([409, 422].includes(status)) throw new HttpError(409, { error: errorCode, github_status: status });
    throw new HttpError(502, { error: errorCode, github_status: status || null, retryable: true });
  }
}
function assertPullSnapshot(intent, pull) {
  const head = String(pull?.head?.sha || '').toLowerCase();
  if ((pull?.head?.ref && pull.head.ref !== intent.head_ref) || (pull?.base?.ref && pull.base.ref !== intent.base_ref))
    throw new HttpError(409, { error: 'pull_request_ref_mismatch' });
  if (head && head !== intent.head_sha)
    throw new HttpError(409, {
      error: 'pull_request_intent_head_changed',
      expected_head_sha: intent.head_sha,
      actual_head_sha: head
    });
}
function pullSnapshot(pull, checksStatus) {
  return {
    number: pull.number,
    html_url: pull.html_url,
    node_id: pull.node_id,
    state: pull.merged ? 'closed' : pull.state,
    draft: Boolean(pull.draft),
    merged: Boolean(pull.merged),
    merge_commit_sha: pull.merge_commit_sha || null,
    merged_at: pull.merged_at || null,
    head_sha: pull.head?.sha || null,
    base_sha: pull.base?.sha || null,
    checks_status: checksStatus
  };
}
function testResult(intent, action, input) {
  const checks = Array.isArray(input.test_checks) ? input.test_checks : [];
  if (input.test_head_sha && input.test_head_sha !== intent.head_sha)
    throw new HttpError(409, { error: 'pull_request_intent_head_changed', actual_head_sha: input.test_head_sha });
  if (action === 'create_pr' && input.test_actual_base_sha && input.test_actual_base_sha !== intent.base_sha)
    throw new HttpError(409, {
      error: 'pull_request_intent_base_changed',
      expected_base_sha: intent.base_sha,
      actual_base_sha: input.test_actual_base_sha,
      refreshable: true
    });
  if (action === 'create_pr')
    return {
      number: Number(input.test_pr_number || 1),
      html_url: input.test_pr_url || 'https://github.test/pull/1',
      node_id: 'PR_test',
      state: 'open',
      draft: true,
      head_sha: intent.head_sha,
      base_sha: intent.base_sha,
      checks_status: input.test_checks_status || 'pending',
      checks
    };
  if ((input.test_checks_status || intent.checks_status) !== 'passed')
    throw new HttpError(409, { error: 'pull_request_checks_not_passed' });
  return {
    merge_commit_sha: input.test_merge_commit_sha || 'f'.repeat(40),
    checks_status: 'passed',
    checks: checks.length ? checks : intent.checks || []
  };
}
function testReconciliation(intent, input) {
  return {
    number: intent.pr_number || 1,
    html_url: intent.pr_url || 'https://github.test/pull/1',
    node_id: intent.pr_node_id || 'PR_test',
    state: input.test_pr_state || 'open',
    draft: input.test_draft !== false,
    head_sha: input.test_head_sha || intent.head_sha,
    base_sha: input.test_base_sha || intent.base_sha,
    checks_status: input.test_checks_status || 'passed',
    merged: input.test_pr_state === 'merged',
    merge_commit_sha: input.test_merge_commit_sha || null
  };
}
function normalizeMergeMethod(value) {
  const method = String(value || 'squash');
  if (!['merge', 'squash', 'rebase'].includes(method))
    throw new HttpError(400, { error: 'github_merge_method_invalid' });
  return method;
}
function jsonHeaders(context) {
  return { authorization: `Bearer ${context.token}`, 'content-type': 'application/json' };
}
function isTest(input) {
  return process.env.NODE_ENV === 'test' && input.adapter === 'test';
}
