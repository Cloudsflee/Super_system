import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { cleanup, makeFixture, api, startApi } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_V19_WEBHOOK_PORT || process.env.AIWS_TEST_PORT || 4597);
const fixture = makeFixture('aiws-v19-webhook-');
const webhookSecret = 'v19-delivery-webhook-secret';
let server;
let stateApi;

try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  await api(port, '/setup/mode', 'PUT', { mode: 'byo' });
  await api(port, '/github/app-config/validate', 'POST', {
    adapter: 'test',
    app_id: '1900',
    client_id: 'Iv1.v19',
    client_secret: 'v19-client',
    private_key: 'v19-private',
    webhook_secret: webhookSecret
  });
  await server.stop();
  server = null;

  process.env.AIWS_HOME = fixture.home;
  process.env.NODE_ENV = 'test';
  stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();
  await stateApi.mutate(seedDeliveryState);

  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const repository = { id: 7001, full_name: 'acme/webhook-target' };
  const pullRequest = {
    number: 42,
    html_url: 'https://github.com/acme/webhook-target/pull/42',
    state: 'open',
    draft: true,
    merged: false,
    head: { ref: 'aiws/task-match', sha: 'sha-match' }
  };

  const opened = await webhook('v19-pr-opened', 'pull_request', {
    action: 'opened',
    repository,
    pull_request: pullRequest
  });
  assert.equal(opened.duplicate, false);
  let state = await stateApi.readState();
  assert.equal(delivery(state, 'delivery-match').pr_number, 42);
  assert.equal(task(state, 'task-match').delivery_status, 'draft');
  assert.equal(
    delivery(state, 'delivery-failed-same-branch').pr_number,
    null,
    'a failed Delivery on the same stable branch is not claimed by the PR'
  );
  assert.equal(
    delivery(state, 'delivery-other-branch').pr_number,
    null,
    'an unbound Delivery on another branch is not claimed by the PR'
  );

  const duplicate = await webhook('v19-pr-opened', 'pull_request', {
    action: 'opened',
    repository,
    pull_request: pullRequest
  });
  assert.equal(duplicate.duplicate, true);

  await webhook('v19-pr-review', 'pull_request_review', {
    action: 'submitted',
    repository,
    pull_request: pullRequest,
    review: { id: 501, state: 'approved' }
  });
  await webhook('v19-check-run', 'check_run', {
    action: 'completed',
    repository,
    check_run: { id: 601, head_sha: 'sha-match', status: 'completed', conclusion: 'success' }
  });
  await webhook('v19-check-suite', 'check_suite', {
    action: 'completed',
    repository,
    check_suite: { id: 701, head_sha: 'sha-match', status: 'completed', conclusion: 'success' }
  });
  await webhook('v19-status', 'status', {
    repository,
    sha: 'sha-match',
    state: 'success',
    context: 'ci/test',
    description: 'All checks passed'
  });
  await webhook('v19-push', 'push', {
    repository,
    ref: 'refs/heads/aiws/task-match',
    before: 'sha-match',
    after: 'sha-remote'
  });
  await webhook('v19-unmatched-pr', 'pull_request', {
    action: 'opened',
    repository,
    pull_request: { ...pullRequest, number: 77, head: { ref: 'aiws/not-a-delivery', sha: 'sha-missing' } }
  });

  state = await stateApi.readState();
  const matched = delivery(state, 'delivery-match');
  assert.deepEqual(
    {
      pr_number: matched.pr_number,
      pr_state: matched.pr_state,
      pr_draft: matched.pr_draft,
      review_state: matched.review_state,
      check_run: matched.check_run,
      check_suite: matched.check_suite,
      commit_status: matched.commit_status,
      remote_head_sha: matched.remote_head_sha
    },
    {
      pr_number: 42,
      pr_state: 'open',
      pr_draft: true,
      review_state: 'approved',
      check_run: { id: 601, status: 'completed', conclusion: 'success' },
      check_suite: { id: 701, status: 'completed', conclusion: 'success' },
      commit_status: { state: 'success', context: 'ci/test', description: 'All checks passed' },
      remote_head_sha: 'sha-remote'
    }
  );
  assert.equal(task(state, 'task-match').delivery_status, 'pushed');
  assert.equal(task(state, 'task-other').delivery_status, 'pending');
  assert.equal(task(state, 'task-other-repository').delivery_status, 'pending');

  const events = state.delivery_events.filter((item) => item.delivery_id === matched.id);
  assert.deepEqual(
    events.map((item) => item.sequence),
    [1, 2, 3, 4, 5, 6]
  );
  assert.deepEqual(
    events.map((item) => item.data.event),
    ['pull_request', 'pull_request_review', 'check_run', 'check_suite', 'status', 'push']
  );
  assert.equal(
    state.delivery_events.some((item) => item.delivery_id !== matched.id),
    false
  );
  assert.equal(state.webhook_deliveries.length, 7, 'the duplicate transport delivery is persisted only once');

  const scopedEvents = state.assist_events.filter((item) => item.session_id === 'assist-task-match');
  assert.deepEqual(
    scopedEvents.map((item) => item.type),
    Array(6).fill('delivery_webhook')
  );
  assert.ok(scopedEvents.every((item) => item.data.delivery_id === matched.id));
  assert.equal(
    state.assist_events.some((item) => item.session_id === 'assist-task-other'),
    false
  );

  console.log('V1.9 GitHub Delivery webhook integration tests passed');
} finally {
  await server?.stop();
  await stateApi?.checkpointAndCloseState().catch(() => undefined);
  cleanup(fixture.root);
}

async function webhook(deliveryId, event, body) {
  const payload = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`;
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-github-event': event,
      'x-hub-signature-256': signature
    },
    body: payload
  });
  const data = await response.json();
  assert.equal(response.status, 202, `${event}: ${JSON.stringify(data)}`);
  return data;
}

function seedDeliveryState(state) {
  state.projects.push({
    id: 'project-webhook',
    title: 'Webhook project',
    goal: 'Track delivery',
    current_workspace_id: 'workspace-root',
    status: 'active'
  });
  state.workflows.push({
    id: 'workflow-webhook',
    project_id: 'project-webhook',
    workspace_id: 'workspace-root',
    title: 'Webhook workflow',
    status: 'active',
    version: 1,
    workflow_revision: 1,
    hierarchy_mode: 'two_level'
  });
  state.workflow_nodes.push(
    {
      id: 'workstream-webhook',
      workflow_id: 'workflow-webhook',
      role: 'workstream',
      title: 'Accepted release',
      outcome: 'Accepted release',
      category: 'deliverable',
      boundary: { repository: 'acme/webhook-target' },
      acceptance_criteria: ['Checks pass'],
      plan_revision: 1,
      dependencies: [],
      status: 'ready'
    },
    taskRecord('task-match'),
    taskRecord('task-other'),
    taskRecord('task-other-repository')
  );
  state.repository_connections.push(
    {
      id: 'connection-match',
      project_id: 'project-webhook',
      installation_id: '9001',
      repository_id: '7001',
      full_name: 'acme/webhook-target',
      default_branch: 'main',
      sync_status: 'ready'
    },
    {
      id: 'connection-other',
      project_id: 'project-webhook',
      installation_id: '9001',
      repository_id: '8001',
      full_name: 'acme/other-target',
      default_branch: 'main',
      sync_status: 'ready'
    }
  );
  state.deliveries.push(
    deliveryRecord('delivery-match', 'task-match', 'connection-match', 'aiws/task-match', 'sha-match'),
    {
      ...deliveryRecord('delivery-failed-same-branch', 'task-match', 'connection-match', 'aiws/task-match', null),
      status: 'failed',
      phase: 'failed'
    },
    deliveryRecord('delivery-other-branch', 'task-other', 'connection-match', 'aiws/task-other', 'sha-other'),
    deliveryRecord(
      'delivery-other-repository',
      'task-other-repository',
      'connection-other',
      'aiws/task-match',
      'sha-match'
    )
  );
  state.assist_sessions.push(
    {
      id: 'assist-task-match',
      version: 3,
      project_id: 'project-webhook',
      scope_type: 'task',
      scope_id: 'task-match',
      scope_status: 'active',
      read_only: false
    },
    {
      id: 'assist-task-other',
      version: 3,
      project_id: 'project-webhook',
      scope_type: 'task',
      scope_id: 'task-other',
      scope_status: 'active',
      read_only: false
    }
  );
}

function taskRecord(id) {
  return {
    id,
    workflow_id: 'workflow-webhook',
    role: 'task',
    parent_node_id: 'workstream-webhook',
    title: id,
    goal: id,
    task_kind: 'code',
    execution_mode: 'codex',
    dependencies: [],
    status: 'ready',
    delivery_status: 'pending'
  };
}

function deliveryRecord(id, taskId, connectionId, branch, commitSha) {
  return {
    id,
    project_id: 'project-webhook',
    workstream_id: 'workstream-webhook',
    task_id: taskId,
    connection_id: connectionId,
    branch,
    commit_sha: commitSha,
    pr_number: null,
    status: 'completed'
  };
}

function delivery(state, id) {
  return state.deliveries.find((item) => item.id === id);
}
function task(state, id) {
  return state.workflow_nodes.find((item) => item.id === id);
}
