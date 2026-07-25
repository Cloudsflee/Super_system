import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v19-delivery-pr-'));
process.env.AIWS_HOME = path.join(root, 'home');

const headSha = 'a'.repeat(40),
  mergeSha = 'b'.repeat(40);
let remotePull = pullRequest({ draft: true });
let checkRuns = [{ name: 'verify', status: 'completed', conclusion: 'success' }];
let mergeCalls = 0,
  lastMergeBody = null;

try {
  const stateApi = await import('../../apps/api/src/state.mjs');
  const service = await import('../../apps/api/src/delivery-pull-request-service.mjs');
  const { recoverInvalidDeliveryPullRequestClaimsInState } = await import('../../apps/api/src/delivery-recovery.mjs');
  await stateApi.ensureRuntime();
  let ownerId,
    viewerId = 'user-viewer';
  await stateApi.mutate((state) => {
    ownerId = state.instance_owner_user_id;
    state.users.push({ id: viewerId, display_name: 'Viewer', role: 'member', auth_mode: 'test' });
    state.projects.push({
      id: 'project-pr',
      title: 'Delivery PR',
      goal: 'Merge safely',
      owner_user_id: ownerId,
      status: 'active'
    });
    state.project_memberships.push(
      { id: 'membership-owner-pr', project_id: 'project-pr', user_id: ownerId, role: 'owner', status: 'active' },
      { id: 'membership-viewer-pr', project_id: 'project-pr', user_id: viewerId, role: 'viewer', status: 'active' }
    );
    state.workflows.push({
      id: 'workflow-pr',
      project_id: 'project-pr',
      title: 'PR workflow',
      status: 'active',
      version: 1
    });
    state.workflow_nodes.push(
      { id: 'workstream-pr', workflow_id: 'workflow-pr', role: 'workstream', title: 'Release', status: 'completed' },
      {
        id: 'task-pr',
        workflow_id: 'workflow-pr',
        parent_node_id: 'workstream-pr',
        role: 'task',
        title: 'Change',
        status: 'completed',
        latest_delivery_id: 'delivery-pr',
        delivery_status: 'draft_pr_created'
      }
    );
    state.repository_connections.push({
      id: 'connection-pr',
      project_id: 'project-pr',
      provider: 'github',
      installation_id: 'installation-pr',
      repository_id: 'repository-pr',
      full_name: 'acme/delivery-pr',
      default_branch: 'main',
      sync_status: 'ready',
      permissions: { read: true, push: true, pull_requests: true }
    });
    state.deliveries.push({
      id: 'delivery-pr',
      operation_id: 'delivery-pr',
      project_id: 'project-pr',
      workflow_id: 'workflow-pr',
      workstream_id: 'workstream-pr',
      task_id: 'task-pr',
      connection_id: 'connection-pr',
      status: 'completed',
      phase: 'draft_pr_created',
      branch: 'aiws/task-pr',
      base_ref: 'main',
      commit_sha: headSha,
      pr_number: 7,
      pr_url: 'https://github.com/acme/delivery-pr/pull/7',
      pr_state: 'draft',
      created_by_user_id: ownerId
    });
    state.github_app_configs.push({ id: 'github-app-pr', mode: 'byo', status: 'validated' });
    if (state.setup_states[0]) state.setup_states[0].mode = 'byo';
    else state.setup_states.push({ id: 'setup-pr', mode: 'byo', updated_at: new Date().toISOString() });
  });

  const dependencies = {
    mergeabilityAttempts: 1,
    mergeabilityDelayMs: 0,
    createInstallationToken: async () => ({
      token: 'installation-token',
      permissions: { contents: 'write', pull_requests: 'write', checks: 'read' }
    }),
    githubJson: async (url, options = {}) => {
      assert.equal(options.headers.authorization, 'Bearer installation-token');
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(options.body);
        assert.equal(body.variables.input.pullRequestId, 'node-pr-7');
        remotePull = { ...remotePull, draft: false };
        return {
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { number: 7, isDraft: false, state: 'OPEN', url: remotePull.html_url, headRefOid: headSha }
            }
          }
        };
      }
      if (url.endsWith('/pulls/7/merge')) {
        mergeCalls += 1;
        lastMergeBody = JSON.parse(options.body);
        remotePull = {
          ...remotePull,
          state: 'closed',
          draft: false,
          merged: true,
          merged_at: '2026-07-20T02:00:00Z',
          merge_commit_sha: mergeSha
        };
        return { merged: true, message: 'Pull Request successfully merged', sha: mergeSha };
      }
      if (url.endsWith('/pulls/7')) return structuredClone(remotePull);
      if (url.endsWith('/check-runs?per_page=100'))
        return { total_count: checkRuns.length, check_runs: structuredClone(checkRuns) };
      if (url === 'https://api.github.com/repos/acme/delivery-pr')
        return { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false };
      throw new Error(`unexpected_github_request:${url}`);
    }
  };

  const inspected = await service.readDeliveryPullRequest('delivery-pr', ownerId, dependencies);
  assert.equal(inspected.state, 'open');
  assert.equal(inspected.draft, true);
  await assert.rejects(
    () => service.markDeliveryPullRequestReady('delivery-pr', {}, viewerId, dependencies),
    error('project_role_forbidden')
  );

  const ready = await service.markDeliveryPullRequestReady('delivery-pr', {}, ownerId, dependencies);
  assert.equal(ready.draft, false);
  assert.equal(ready.idempotent, false);
  let state = await stateApi.readState();
  assert.equal(delivery(state).phase, 'pull_request_ready');
  assert.equal(delivery(state).pr_state, 'open');
  assert.equal(task(state).delivery_status, 'ready');

  await assert.rejects(
    () => service.mergeDeliveryPullRequest('delivery-pr', {}, ownerId, dependencies),
    error('github_expected_head_sha_required')
  );
  await assert.rejects(
    () =>
      service.mergeDeliveryPullRequest('delivery-pr', { expected_head_sha: headSha }, ownerId, {
        ...dependencies,
        createInstallationToken: async () => ({
          token: 'installation-token',
          permissions: { contents: 'read', pull_requests: 'write', checks: 'read' }
        })
      }),
    error('github_contents_write_required')
  );

  checkRuns = [{ name: 'verify', status: 'completed', conclusion: 'failure' }];
  await assert.rejects(
    () => service.mergeDeliveryPullRequest('delivery-pr', { expected_head_sha: headSha }, ownerId, dependencies),
    error('github_pull_request_checks_incomplete')
  );
  assert.equal(mergeCalls, 0);

  remotePull = { ...remotePull, head: { ...remotePull.head, sha: 'c'.repeat(40) } };
  await assert.rejects(
    () => service.mergeDeliveryPullRequest('delivery-pr', { expected_head_sha: headSha }, ownerId, dependencies),
    error('github_pull_request_head_changed')
  );
  assert.equal(mergeCalls, 0);

  remotePull = { ...remotePull, head: { ...remotePull.head, sha: headSha } };
  checkRuns = [{ name: 'verify', status: 'completed', conclusion: 'success' }];
  const merged = await service.mergeDeliveryPullRequest(
    'delivery-pr',
    {
      expected_head_sha: headSha,
      merge_method: 'squash',
      commit_title: 'Validated delivery (#7)'
    },
    ownerId,
    dependencies
  );
  assert.equal(merged.state, 'merged');
  assert.equal(merged.merge_commit_sha, mergeSha);
  assert.equal(merged.remote_confirmed, true);
  assert.deepEqual(lastMergeBody, { sha: headSha, merge_method: 'squash', commit_title: 'Validated delivery (#7)' });

  state = await stateApi.readState();
  assert.equal(delivery(state).phase, 'merged');
  assert.equal(delivery(state).pr_state, 'merged');
  assert.equal(delivery(state).merge_commit_sha, mergeSha);
  assert.equal(task(state).delivery_status, 'merged');
  assert.deepEqual(
    state.delivery_events.filter((item) => item.delivery_id === 'delivery-pr').map((item) => item.type),
    ['github_pull_request', 'github_pull_request']
  );

  const replayed = await service.mergeDeliveryPullRequest(
    'delivery-pr',
    { expected_head_sha: headSha },
    ownerId,
    dependencies
  );
  assert.equal(replayed.idempotent, true);
  assert.equal(replayed.changed, false);
  assert.equal(mergeCalls, 1);
  const reconciled = await service.reconcileDeliveryPullRequest('delivery-pr', ownerId, dependencies);
  assert.equal(reconciled.state, 'merged');
  assert.equal(reconciled.changed, false);
  state = await stateApi.readState();
  assert.equal(state.delivery_events.filter((item) => item.delivery_id === 'delivery-pr').length, 2);

  const recoveryState = {
    deliveries: [
      {
        id: 'failed-claimed',
        project_id: 'project-pr',
        task_id: 'task-pr',
        status: 'failed',
        commit_sha: null,
        pr_number: 7,
        pr_url: remotePull.html_url,
        pr_state: 'merged',
        pr_draft: false
      },
      {
        id: 'failed-with-commit',
        project_id: 'project-pr',
        task_id: 'task-pr',
        status: 'failed',
        commit_sha: headSha,
        pr_number: 7,
        pr_state: 'merged'
      },
      {
        id: 'completed-claimed',
        project_id: 'project-pr',
        task_id: 'task-pr',
        status: 'completed',
        commit_sha: headSha,
        pr_number: 7,
        pr_state: 'merged'
      }
    ],
    delivery_events: [
      {
        id: 'webhook-claim',
        delivery_id: 'failed-claimed',
        sequence: 1,
        type: 'github_webhook',
        data: { pull_request: { number: 7 } }
      }
    ]
  };
  const recovery = recoverInvalidDeliveryPullRequestClaimsInState(recoveryState, {
    timestamp: '2026-07-20T02:30:00.000Z'
  });
  assert.deepEqual(recovery.delivery_ids, ['failed-claimed']);
  assert.equal(recoveryState.deliveries[0].pr_number, null);
  assert.equal(recoveryState.deliveries[1].pr_number, 7);
  assert.equal(recoveryState.deliveries[2].pr_number, 7);
  assert.equal(recoveryState.delivery_events.at(-1).type, 'github_pull_request_recovered');

  console.log('V1.9 Delivery pull request service unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function pullRequest(extra = {}) {
  return {
    number: 7,
    node_id: 'node-pr-7',
    html_url: 'https://github.com/acme/delivery-pr/pull/7',
    title: 'Validated delivery',
    state: 'open',
    draft: true,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    head: { ref: 'aiws/task-pr', sha: headSha },
    base: { ref: 'main', sha: 'd'.repeat(40) },
    merge_commit_sha: null,
    merged_at: null,
    ...extra
  };
}

function delivery(state) {
  return state.deliveries.find((item) => item.id === 'delivery-pr');
}
function task(state) {
  return state.workflow_nodes.find((item) => item.id === 'task-pr');
}
function error(expected) {
  return (value) => value?.payload?.error === expected;
}
