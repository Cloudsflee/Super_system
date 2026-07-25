import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v19-delivery-'));
const repository = path.join(root, 'repository');
process.env.AIWS_HOME = path.join(root, 'aiws-home');
process.env.NODE_ENV = 'test';

try {
  initializeRepository(repository);
  const stateApi = await import('../../apps/api/src/state.mjs');
  const { activateDraftInState, createDraftProjectRecords } = await import('../../apps/api/src/project-lifecycle.mjs');
  const domain = await import('../../apps/api/src/repository-delivery-domain.mjs');
  const deliveryService = await import('../../apps/api/src/delivery-service.mjs');
  await stateApi.ensureRuntime();
  const actor = stateApi.owner(await stateApi.readState());
  let ids;
  await stateApi.mutate((state) => {
    const created = createDraftProjectRecords(
      {
        title: 'Multi-task delivery',
        goal: 'Create two verified changes',
        mode: 'brainstorm',
        answers: { goal: 'Create two verified changes' }
      },
      actor
    );
    state.projects.push(created.project);
    state.workspaces.push(created.workspace);
    state.project_intakes.push(created.intake);
    state.project_briefs.push(created.brief);
    state.workflow_drafts.push(created.workflowDraft);
    state.assist_sessions.push(created.session);
    const activated = activateDraftInState(state, created.project, created.brief, hierarchy(), actor.id);
    const connection = domain.createRepositoryConnectionInState(
      state,
      created.project.id,
      {
        installation_id: 'installation-test',
        repository_id: 'repo-test',
        full_name: 'acme/multi-task',
        default_branch: 'main',
        local_path: repository,
        permissions: { read: true, push: true, pull_requests: true }
      },
      actor.id,
      { allowLocalPath: true }
    ).connection;
    const workstream = activated.nodes.find((item) => item.role === 'workstream');
    const tasks = activated.nodes.filter((item) => item.role === 'task');
    domain.setWorkstreamRepositoryTargetsInState(state, workstream.id, { connection_ids: [connection.id] }, actor.id);
    for (const task of tasks)
      domain.setTaskRepositoryTargetsInState(state, task.id, { write_connection_id: connection.id }, actor.id);
    const policy = domain.approveDeliveryPolicyInState(
      state,
      workstream.id,
      {
        connection_id: connection.id,
        base_ref: 'main',
        path_prefixes: ['src'],
        test_commands: ['node -p process.argv[1] worktrees/task-diagnostics-12345678'],
        automation_permissions: ['codex_run', 'commit', 'push', 'draft_pr']
      },
      actor.id
    );
    ids = {
      project: created.project.id,
      workstream: workstream.id,
      tasks: tasks.map((item) => item.id),
      policy: policy.id
    };
  });

  await stateApi.mutate((state) => {
    state.projects.find((item) => item.id === ids.project).lifecycle_operation = {
      id: 'delivery-lifecycle-test',
      type: 'trash'
    };
  });
  await assert.rejects(
    () => deliveryService.startTaskDelivery(ids.tasks[0], { policy_id: ids.policy, adapter: 'test' }, actor.id),
    error('project_lifecycle_operation_in_progress')
  );
  await stateApi.mutate((state) => {
    state.projects.find((item) => item.id === ids.project).lifecycle_operation = null;
  });
  await stateApi.mutate((state) => {
    state.canonical_repositories.push({
      id: 'canonical-deleting',
      provider: 'github',
      repository_id: 'repo-test',
      full_name: 'acme/multi-task',
      remote_state: 'active'
    });
    state.project_repository_bindings.push({
      id: 'binding-deleting',
      project_id: ids.project,
      canonical_repository_id: 'canonical-deleting',
      status: 'ready'
    });
    state.repository_deletion_intents.push({
      id: 'intent-deleting',
      canonical_repository_id: 'canonical-deleting',
      status: 'executing',
      snapshot: { bindings: [{ project_id: ids.project }] }
    });
  });
  await assert.rejects(
    () => deliveryService.startTaskDelivery(ids.tasks[0], { policy_id: ids.policy, adapter: 'test' }, actor.id),
    error('repository_deletion_in_progress')
  );
  await stateApi.mutate((state) => {
    state.canonical_repositories = state.canonical_repositories.filter((item) => item.id !== 'canonical-deleting');
    state.project_repository_bindings = state.project_repository_bindings.filter(
      (item) => item.id !== 'binding-deleting'
    );
    state.repository_deletion_intents = state.repository_deletion_intents.filter(
      (item) => item.id !== 'intent-deleting'
    );
  });

  const [firstStart, duplicateStart] = await Promise.all([
    deliveryService.startTaskDelivery(
      ids.tasks[0],
      { policy_id: ids.policy, adapter: 'test', test_changes: [{ path: 'src/alpha.txt', content: 'alpha\n' }] },
      actor.id
    ),
    deliveryService.startTaskDelivery(
      ids.tasks[0],
      { policy_id: ids.policy, adapter: 'test', test_changes: [{ path: 'src/ignored.txt', content: 'ignored\n' }] },
      actor.id
    )
  ]);
  assert.equal(duplicateStart.idempotent, true);
  assert.equal(duplicateStart.delivery.id, firstStart.delivery.id);

  const secondStart = await deliveryService.startTaskDelivery(
    ids.tasks[1],
    { policy_id: ids.policy, adapter: 'test', test_changes: [{ path: 'src/beta.txt', content: 'beta\n' }] },
    actor.id
  );
  const [first, second] = await Promise.all([
    waitForDelivery(deliveryService, firstStart.delivery.id),
    waitForDelivery(deliveryService, secondStart.delivery.id)
  ]);
  for (const item of [first, second]) {
    assert.equal(
      item.status,
      'completed',
      JSON.stringify({ phase: item.phase, error_code: item.error_code, error_detail: item.error_detail })
    );
    assert.equal(item.pr_state, 'draft');
    assert.match(item.pr_url, /^https:\/\/github\.com\/acme\/multi-task\/pull\//);
    assert.ok(fs.existsSync(item.worktree_path));
    assert.equal(
      fs.statSync(path.join(item.worktree_path, '.git')).isDirectory(),
      true,
      'Delivery checkout keeps self-contained Git metadata'
    );
    assert.match(
      item.test_results[0].output,
      /worktrees\/task-diagnostics-12345678/,
      'diagnostics do not mistake task paths for API keys'
    );
    assert.match(item.branch, /^aiws\//);
  }
  assert.notEqual(first.worktree_path, second.worktree_path);
  assert.notEqual(first.branch, second.branch);

  const failedStart = await deliveryService.startTaskDelivery(
    ids.tasks[0],
    {
      policy_id: ids.policy,
      adapter: 'test',
      test_failure: true,
      test_changes: [{ path: 'src/alpha.txt', content: 'alpha failing revision\n' }]
    },
    actor.id
  );
  const headBeforeFailure = git(first.worktree_path, ['rev-parse', 'HEAD']);
  const failed = await waitForDelivery(deliveryService, failedStart.delivery.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'delivery_tests_failed');
  assert.equal(
    git(first.worktree_path, ['rev-parse', 'HEAD']),
    headBeforeFailure,
    'failed tests never create a commit'
  );
  assert.match(git(first.worktree_path, ['status', '--porcelain']), /src\/alpha\.txt/);

  const recoveredStart = await deliveryService.retryTaskDelivery(
    failed.id,
    {
      adapter: 'test',
      test_changes: [{ path: 'src/alpha.txt', content: 'alpha recovered revision\n' }]
    },
    actor.id
  );
  const recovered = await waitForDelivery(deliveryService, recoveredStart.delivery.id);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.branch, first.branch);
  assert.equal(recovered.pr_url, first.pr_url);
  assert.notEqual(recovered.commit_sha, first.commit_sha);

  const violationStart = await deliveryService.startTaskDelivery(
    ids.tasks[1],
    {
      policy_id: ids.policy,
      adapter: 'test',
      path_violation: true,
      test_changes: [{ path: 'src/beta.txt', content: 'beta outside attempt\n' }]
    },
    actor.id
  );
  const secondHead = git(second.worktree_path, ['rev-parse', 'HEAD']);
  const violation = await waitForDelivery(deliveryService, violationStart.delivery.id);
  assert.equal(violation.status, 'failed');
  assert.equal(violation.error_code, 'delivery_path_invalid');
  assert.equal(git(second.worktree_path, ['rev-parse', 'HEAD']), secondHead, 'path violations never create a commit');

  await stateApi.mutate((state) => domain.revokeDeliveryPolicyInState(state, ids.policy, actor.id));
  await assert.rejects(
    () => deliveryService.retryTaskDelivery(violation.id, { adapter: 'test' }, actor.id),
    error('delivery_policy_reapproval_required')
  );

  console.log('V1.9 multi-task Delivery integration tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function hierarchy() {
  return [
    {
      id: 'ws-delivery',
      role: 'workstream',
      title: 'Verified multi-task increment',
      outcome: 'Two independently verified repository changes.',
      category: 'deliverable',
      boundary: { repository: 'acme/multi-task' },
      acceptance_criteria: ['Both Draft PR changes pass tests.'],
      dependency_ids: [],
      tasks: [
        {
          id: 'task-alpha',
          role: 'task',
          title: 'Implement alpha',
          goal: 'Implement alpha',
          task_kind: 'code',
          execution_mode: 'codex',
          dependency_ids: []
        },
        {
          id: 'task-beta',
          role: 'task',
          title: 'Implement beta',
          goal: 'Implement beta',
          task_kind: 'code',
          execution_mode: 'codex',
          dependency_ids: []
        }
      ]
    }
  ];
}

function initializeRepository(target) {
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.writeFileSync(path.join(target, 'src', '.gitkeep'), '', 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: target, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: target, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=AIWS Test', '-c', 'user.email=aiws-test@local.invalid', 'commit', '-m', 'initial'],
    { cwd: target, stdio: 'ignore' }
  );
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function waitForDelivery(service, deliveryId) {
  const deadline = Date.now() + 30_000;
  let current;
  do {
    current = await service.getDelivery(deliveryId);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`delivery_timeout:${deliveryId}:${current?.status || 'unknown'}:${current?.phase || 'unknown'}`);
}
function error(expected) {
  return (value) => value?.payload?.error === expected;
}
