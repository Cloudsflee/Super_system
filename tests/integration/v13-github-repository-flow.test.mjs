import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v13-github-repository-');
const stateFile = path.join(fixture.home, 'data', 'state.json');
const port = Number(process.env.AIWS_TEST_PORT || 4600);
const sentinels = ['v13-client-secret-sentinel', 'v13-private-key-sentinel', 'v13-webhook-secret-sentinel'];
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  await api(port, '/setup/mode', 'PUT', { mode: 'byo' });
  await api(port, '/github/app-config/validate', 'POST', {
    adapter: 'test',
    app_id: '1300',
    client_id: 'Iv1.v13',
    client_secret: sentinels[0],
    private_key: sentinels[1],
    webhook_secret: sentinels[2]
  });
  const device = await api(port, '/github/device/start', 'POST', { adapter: 'test' });
  await api(port, '/github/device/poll', 'POST', { adapter: 'test', request_id: device.request_id });

  await discover([
    repository('8101', 'private-repo', true, true),
    repository('8102', 'public-repo', true, true),
    repository('8103', 'retry-repo', true, false),
    repository('8104', 'bind-repo', true, true)
  ]);
  const privateDraft = await draft('GitHub private create');
  const created = await api(
    port,
    `/projects/${privateDraft.project.id}/github/repository`,
    'POST',
    {
      adapter: 'test',
      operation_key: 'github-create-private',
      installation_id: '9001',
      repository_id: '8101',
      name: 'private-repo'
    },
    201
  );
  assert.equal(created.repository.private, true);
  assert.equal(created.binding.status, 'ready');
  assert.equal(created.checkout.ready, true);
  assert.equal(created.checkout.remote_name, 'origin');
  assert.equal(fs.existsSync(path.join(fixture.home, 'workspaces', privateDraft.project.id, 'repo', '.git')), true);
  const repeated = await api(port, `/projects/${privateDraft.project.id}/github/repository`, 'POST', {
    adapter: 'test',
    operation_key: 'github-create-private',
    installation_id: '9001',
    repository_id: '8101',
    name: 'ignored-on-retry'
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.operation.id, created.operation.id);
  assert.equal(repeated.binding.id, created.binding.id);

  const publicDraft = await draft('GitHub public create');
  const publicCreated = await api(
    port,
    `/projects/${publicDraft.project.id}/github/repository`,
    'POST',
    {
      adapter: 'test',
      operation_key: 'github-create-public',
      installation_id: '9001',
      repository_id: '8102',
      name: 'public-repo',
      private: false
    },
    201
  );
  assert.equal(publicCreated.repository.private, false);

  const retryDraft = await draft('GitHub access retry');
  const beforeRetry = readState();
  const access = await api(
    port,
    `/projects/${retryDraft.project.id}/github/repository`,
    'POST',
    {
      adapter: 'test',
      operation_key: 'github-create-retry',
      installation_id: '9001',
      repository_id: '8103',
      name: 'retry-repo'
    },
    403,
    'access_required'
  );
  assert.equal(access.action, 'grant_pull_push_access');
  assert.equal(access.operation.status, 'access_required');
  assertPublic(access);
  await discover([
    repository('8101', 'private-repo', true, true),
    repository('8102', 'public-repo', true, true),
    repository('8103', 'retry-repo', true, true),
    repository('8104', 'bind-repo', true, true)
  ]);
  const retried = await api(
    port,
    `/projects/${retryDraft.project.id}/github/repository`,
    'POST',
    {
      adapter: 'test',
      operation_key: 'github-create-retry',
      installation_id: '9001',
      repository_id: '8103',
      name: 'retry-repo'
    },
    201
  );
  assert.equal(retried.operation.attempt, 2);
  assert.equal(retried.binding.status, 'ready');
  const afterRetry = readState();
  assert.equal(afterRetry.projects.length, beforeRetry.projects.length);
  assert.equal(afterRetry.assist_sessions.length, beforeRetry.assist_sessions.length);
  assert.equal(afterRetry.import_jobs.filter((item) => item.operation_key === 'github-create-retry').length, 1);
  assert.equal(afterRetry.repository_bindings.filter((item) => item.project_id === retryDraft.project.id).length, 1);

  await api(port, '/github/installations/9001/repositories', 'PUT', { repository_ids: ['8104'] });
  const bindDraft = await draft('GitHub bind retry');
  const bound = await api(port, `/projects/${bindDraft.project.id}/repository-binding`, 'PUT', {
    adapter: 'test',
    operation_key: 'github-bind-retry',
    installation_id: '9001',
    repository_id: '8104'
  });
  assert.equal(bound.status, 'ready');
  assert.equal(bound.checkout.ready, true);
  const rebound = await api(port, `/projects/${bindDraft.project.id}/repository-binding`, 'PUT', {
    adapter: 'test',
    operation_key: 'github-bind-retry',
    installation_id: '9001',
    repository_id: '8104'
  });
  assert.equal(rebound.idempotent, true);
  assert.equal(rebound.id, bound.id);
  assert.equal(rebound.operation.id, bound.operation.id);
  const bindState = readState();
  assert.equal(bindState.import_jobs.filter((item) => item.operation_key === 'github-bind-retry').length, 1);
  assert.equal(bindState.repository_bindings.filter((item) => item.project_id === bindDraft.project.id).length, 1);

  for (const failure of ['clone', 'head', 'remote']) {
    const failedDraft = await draft(`GitHub ${failure} failure`),
      operationKey = `github-checkout-${failure}`;
    const failed = await api(
      port,
      `/projects/${failedDraft.project.id}/github/repository`,
      'POST',
      {
        adapter: 'test',
        operation_key: operationKey,
        installation_id: '9001',
        repository_id: '8104',
        name: 'bind-repo',
        test_checkout_failure: failure
      },
      409,
      failure === 'clone'
        ? 'repository_clone_failed'
        : failure === 'head'
          ? 'repository_head_verification_failed'
          : 'repository_remote_verification_failed'
    );
    assert.equal(failed.error.includes('repository_'), true);
    let failureState = readState();
    assert.equal(failureState.import_jobs.find((item) => item.operation_key === operationKey).status, 'failed');
    assert.equal(
      failureState.repository_bindings.some((item) => item.project_id === failedDraft.project.id),
      false
    );
    const target = path.join(fixture.home, 'workspaces', failedDraft.project.id, 'repo');
    assert.equal(fs.existsSync(target), false);
    const recoveredCheckout = await api(
      port,
      `/projects/${failedDraft.project.id}/github/repository`,
      'POST',
      {
        adapter: 'test',
        operation_key: operationKey,
        installation_id: '9001',
        repository_id: '8104',
        name: 'bind-repo'
      },
      201
    );
    assert.equal(recoveredCheckout.operation.attempt, 2);
    failureState = readState();
    assert.equal(failureState.import_jobs.filter((item) => item.operation_key === operationKey).length, 1);
    assert.equal(
      failureState.repository_bindings.filter((item) => item.project_id === failedDraft.project.id).length,
      1
    );
  }

  const invisibleDraft = await draft('GitHub installation required');
  const invisible = await api(
    port,
    `/projects/${invisibleDraft.project.id}/github/repository`,
    'POST',
    {
      adapter: 'test',
      operation_key: 'github-create-invisible',
      installation_id: '9001',
      repository_id: '8999',
      name: 'not-installed'
    },
    409,
    'access_required'
  );
  assert.equal(invisible.action, 'install_or_expand_repository_access');
  assert.equal(invisible.installation_url, '/github/installations/start');
  assertPublic(invisible);
  assertNoSecrets(readState());
  console.log('V1.3 GitHub repository state-machine integration tests passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

async function draft(title) {
  const project = await api(port, '/projects', 'POST', { title }, 201);
  await api(port, `/projects/${project.project.id}/intake`, 'PUT', { mode: 'brainstorm', answers: { goal: title } });
  return project;
}
async function discover(repositories) {
  return api(port, '/github/installations/discover', 'POST', {
    adapter: 'test',
    installation_id: '9001',
    repositories
  });
}
function repository(id, name, pull, push) {
  return { id, name, full_name: `aiws-owner/${name}`, private: true, permissions: { pull, push, admin: push } };
}
function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}
function assertPublic(value) {
  const text = assertNoSecrets(value);
  for (const key of ['installation_token', 'clone_credential', 'private_key', 'access_token'])
    assert.equal(text.includes(key), false, key);
}
function assertNoSecrets(value) {
  const text = JSON.stringify(value).toLowerCase();
  for (const sentinel of sentinels) assert.equal(text.includes(sentinel.toLowerCase()), false, sentinel);
  return text;
}
