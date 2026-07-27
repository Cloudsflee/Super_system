import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiws-v19-rws-'));
process.env.AIWS_HOME = home;
const { git } = await import('../../apps/api/src/git-utils.mjs');
const workspaceService = await import('../../apps/api/src/repository-workspace-service.mjs');
const intentDomain = await import('../../apps/api/src/pull-request-intent-domain.mjs');
const { publishAssistRepositoryReview } = await import('../../apps/api/src/assist-repository-review.mjs');
const { assistReviewSnapshot, createAssistWorktree, removeAssistWorktree } =
  await import('../../apps/api/src/assist-v3-worktree.mjs');

try {
  const mirror = workspaceService
    .managedRepositoryWorkspaceRoot('p1')
    .replace(/[\\/]repository-workspaces$/, path.sep + 'repo');
  const remote = path.join(home, 'remote.git');
  await fsp.mkdir(remote, { recursive: true });
  ok(git(remote, ['init', '--bare']));
  await fsp.mkdir(mirror, { recursive: true });
  ok(git(mirror, ['init', '-b', 'main']));
  await fsp.writeFile(path.join(mirror, 'base.txt'), 'main\n');
  ok(git(mirror, ['add', '.']));
  ok(git(mirror, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']));
  const mainSha = sha(mirror);
  ok(git(mirror, ['checkout', '-b', 'feature']));
  await fsp.writeFile(path.join(mirror, 'feature.txt'), 'feature\n');
  ok(git(mirror, ['add', '.']));
  ok(git(mirror, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'feature']));
  const featureSha = sha(mirror);
  ok(git(mirror, ['checkout', 'main']));
  ok(git(mirror, ['remote', 'add', 'origin', remote]));
  ok(git(mirror, ['push', '--all', 'origin']));

  const state = baseState(mirror);
  const catalog = workspaceService.repositoryBranches(state, 'p1', 'connection-1');
  assert.deepEqual(
    catalog.branches.map((item) => item.name),
    ['main', 'feature']
  );
  assert.throws(() => workspaceService.validateRepositoryRef('../main'), code('repository_ref_invalid'));
  assert.throws(() => workspaceService.validateRepositoryRef('feature.lock'), code('repository_ref_invalid'));

  const first = await workspaceService.createRepositoryWorkspace(
    state,
    'p1',
    {
      connection_id: 'connection-1',
      ref: 'feature',
      expected_sha: featureSha,
      mode: 'read_write',
      operation_key: 'workspace-feature'
    },
    'owner'
  );
  const replay = await workspaceService.createRepositoryWorkspace(
    state,
    'p1',
    {
      connection_id: 'connection-1',
      ref: 'feature',
      expected_sha: featureSha,
      mode: 'read_write',
      operation_key: 'workspace-feature'
    },
    'owner'
  );
  const second = await workspaceService.createRepositoryWorkspace(
    state,
    'p1',
    { connection_id: 'connection-1', ref: 'main', mode: 'read_write' },
    'owner'
  );
  assert.equal(replay.idempotent, true);
  assert.notEqual(first.workspace.managed_path, second.workspace.managed_path);
  assert.equal(
    git(mirror, ['branch', '--show-current']).stdout.trim(),
    'main',
    'canonical mirror branch must not change'
  );
  await fsp.writeFile(path.join(first.workspace.managed_path, 'isolated.txt'), 'only feature workspace\n');
  assert.equal(fs.existsSync(path.join(second.workspace.managed_path, 'isolated.txt')), false);
  assert.equal(workspaceService.inspectRepositoryWorkspace(state, first.workspace.id).dirty, true);
  assert.throws(
    () => workspaceService.ensureRepositoryWorkspaceReviewRef(state, first.workspace.id),
    code('repository_workspace_uncommitted_changes')
  );
  ok(git(first.workspace.managed_path, ['add', '.']));
  ok(
    git(first.workspace.managed_path, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'workspace change'
    ])
  );
  const reviewRef = workspaceService.ensureRepositoryWorkspaceReviewRef(state, first.workspace.id);
  assert.match(reviewRef, /^aiws\/review-/);
  assert.equal(git(mirror, ['branch', '--show-current']).stdout.trim(), 'main');

  const created = intentDomain.createPullRequestIntentInState(
    state,
    'p1',
    { repository_workspace_id: first.workspace.id, base_ref: 'main', operation_key: 'intent-1' },
    'owner'
  );
  assert.equal(created.intent.head_ref, reviewRef);
  assert.equal(created.intent.base_sha, mainSha);
  assert.equal(
    intentDomain.createPullRequestIntentInState(
      state,
      'p1',
      { repository_workspace_id: first.workspace.id, base_ref: 'main', operation_key: 'intent-1' },
      'owner'
    ).idempotent,
    true
  );
  assert.throws(
    () =>
      intentDomain.approvePullRequestIntentInState(
        state,
        created.intent.id,
        { action: 'create_pr', expected_revision: 1 },
        'viewer'
      ),
    code('project_role_forbidden')
  );
  intentDomain.approvePullRequestIntentInState(
    state,
    created.intent.id,
    { action: 'create_pr', expected_revision: 1, expected_snapshot_hash: created.intent.snapshot_hash },
    'owner'
  );
  assert.throws(
    () =>
      intentDomain.approvePullRequestIntentInState(
        state,
        created.intent.id,
        { action: 'create_pr', expected_revision: 1 },
        'owner'
      ),
    code('pull_request_intent_revision_changed')
  );
  intentDomain.preparePullRequestIntentExecutionInState(
    state,
    created.intent.id,
    { action: 'create_pr', expected_revision: 2 },
    'owner'
  );
  const originalSnapshotHash = created.intent.snapshot_hash,
    refreshedBaseSha = 'a'.repeat(40),
    refreshed = intentDomain.refreshPullRequestIntentBaseInState(state, created.intent.id, refreshedBaseSha);
  assert.equal(refreshed.previous_base_sha, mainSha);
  assert.equal(created.intent.status, 'proposed');
  assert.equal(created.intent.revision, 3);
  assert.equal(created.intent.base_sha, refreshedBaseSha);
  assert.notEqual(created.intent.snapshot_hash, originalSnapshotHash);
  assert.throws(
    () =>
      intentDomain.preparePullRequestIntentExecutionInState(
        state,
        created.intent.id,
        { action: 'create_pr', expected_revision: 3, expected_snapshot_hash: created.intent.snapshot_hash },
        'owner'
      ),
    code('pull_request_intent_not_approved')
  );
  intentDomain.approvePullRequestIntentInState(
    state,
    created.intent.id,
    { action: 'create_pr', expected_revision: 3, expected_snapshot_hash: created.intent.snapshot_hash },
    'owner'
  );
  intentDomain.preparePullRequestIntentExecutionInState(
    state,
    created.intent.id,
    { action: 'create_pr', expected_revision: 4, expected_snapshot_hash: created.intent.snapshot_hash },
    'owner'
  );
  intentDomain.completePullRequestIntentExecutionInState(
    state,
    created.intent.id,
    'create_pr',
    {
      number: 7,
      html_url: 'https://github.test/acme/app/pull/7',
      node_id: 'PR_7',
      state: 'open',
      draft: true,
      head_sha: created.intent.head_sha,
      base_sha: refreshedBaseSha,
      checks_status: 'pending'
    },
    'owner'
  );
  intentDomain.reconcilePullRequestIntentSnapshotInState(state, created.intent.id, {
    number: 7,
    state: 'open',
    draft: true,
    head_sha: created.intent.head_sha,
    base_sha: refreshedBaseSha,
    checks_status: 'passed'
  });
  const mergeRevision = created.intent.revision;
  intentDomain.approvePullRequestIntentInState(
    state,
    created.intent.id,
    { action: 'merge_pr', expected_revision: mergeRevision },
    'owner'
  );
  intentDomain.preparePullRequestIntentExecutionInState(
    state,
    created.intent.id,
    { action: 'merge_pr', expected_revision: mergeRevision + 1 },
    'owner'
  );
  intentDomain.completePullRequestIntentExecutionInState(
    state,
    created.intent.id,
    'merge_pr',
    { merge_commit_sha: 'f'.repeat(40) },
    'owner'
  );
  assert.equal(created.intent.status, 'merged');
  assert.deepEqual(
    created.intent.approvals.map((item) => [item.action, item.snapshot_hash]),
    [
      ['create_pr', originalSnapshotHash],
      ['create_pr', created.intent.snapshot_hash],
      ['merge_pr', created.intent.snapshot_hash]
    ]
  );

  const selectedHead = sha(second.workspace.managed_path);
  const assistWorktree = await createAssistWorktree(state.projects[0], { id: 'assist-review-turn' }, second.workspace);
  await fsp.writeFile(path.join(assistWorktree.path, 'assist-review.txt'), 'review branch only\n');
  const assistReview = await assistReviewSnapshot(state.projects[0], assistWorktree);
  const published = await publishAssistRepositoryReview(state, {
    project: state.projects[0],
    batch: { id: 'assist-batch-1' },
    worktree: assistWorktree,
    expectedTargetHash: assistReview.target_hash,
    actorId: 'owner'
  });
  assert.match(published.review_ref, /^aiws\/review-/);
  assert.equal(
    sha(second.workspace.managed_path),
    selectedHead,
    'Assist publish must not rewrite the selected workspace HEAD'
  );
  assert.equal(git(second.workspace.managed_path, ['status', '--porcelain']).stdout.trim(), '');
  assert.equal(git(mirror, ['branch', '--show-current']).stdout.trim(), 'main');
  const remoteReviewSha = git(mirror, ['rev-parse', `refs/remotes/origin/${published.review_ref}`])
    .stdout.trim()
    .toLowerCase();
  assert.equal(remoteReviewSha, published.project_commit);
  const assistIntent = state.pull_request_intents.find((item) => item.id === published.pull_request_intent_id);
  intentDomain.approvePullRequestIntentInState(
    state,
    assistIntent.id,
    { action: 'create_pr', expected_revision: 1 },
    'owner'
  );
  intentDomain.preparePullRequestIntentExecutionInState(
    state,
    assistIntent.id,
    { action: 'create_pr', expected_revision: 2 },
    'owner'
  );
  intentDomain.revokePullRequestIntentInState(state, assistIntent.id, { expected_revision: 2 }, 'owner');
  await removeAssistWorktree(state.projects[0], assistWorktree);

  await workspaceService.removeRepositoryWorkspace(state, second.workspace.id, 'owner');
  assert.equal(fs.existsSync(second.workspace.managed_path), false);
  console.log('V1.9 Repository Workspace isolation and PR intent double-approval tests passed');
} finally {
  await fsp.rm(home, { recursive: true, force: true });
}

function baseState(mirror) {
  const timestamp = new Date().toISOString();
  return {
    projects: [
      {
        id: 'p1',
        owner_user_id: 'owner',
        status: 'active',
        onboarding_state: 'confirmed',
        repo_path: mirror,
        workspace_root: path.dirname(mirror)
      }
    ],
    project_memberships: [
      { id: 'owner-membership', project_id: 'p1', user_id: 'owner', role: 'owner', status: 'active' },
      { id: 'viewer-membership', project_id: 'p1', user_id: 'viewer', role: 'viewer', status: 'active' }
    ],
    repository_connections: [
      {
        id: 'connection-1',
        project_id: 'p1',
        repository_id: '1',
        full_name: 'acme/app',
        default_branch: 'main',
        remote_name: 'origin',
        local_path: mirror,
        sync_status: 'ready',
        installation_id: 'installation-1',
        permissions: { read: true, push: true, pull_requests: true }
      }
    ],
    canonical_repositories: [{ id: 'canonical-1', repository_id: '1', full_name: 'acme/app', default_branch: 'main' }],
    project_repository_bindings: [
      {
        id: 'binding-1',
        project_id: 'p1',
        canonical_repository_id: 'canonical-1',
        local_checkout_path: mirror,
        status: 'ready'
      }
    ],
    repository_workspaces: [],
    pull_request_intents: [],
    users: [{ id: 'owner' }, { id: 'viewer' }],
    traces: [],
    timestamp
  };
}
function sha(repo) {
  return git(repo, ['rev-parse', 'HEAD']).stdout.trim().toLowerCase();
}
function ok(result) {
  assert.equal(result.ok, true, result.stderr || result.error);
}
function code(expected) {
  return (error) => error?.payload?.error === expected;
}
