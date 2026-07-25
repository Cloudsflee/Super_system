import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v110-flow-'));
process.env.AIWS_HOME = path.join(root, 'home');
process.env.NODE_ENV = 'test';
process.env.AIWS_TEST_ADAPTERS = '1';

try {
  const { managedRepoPath } = await import('../../apps/api/src/managed-workspace.mjs');
  const stateService = await import('../../apps/api/src/state.mjs');
  const { createWorkflowExecutionInState } = await import('../../apps/api/src/workflow-execution-domain.mjs');
  const { provisionWorkflowRepositoryLines } = await import('../../apps/api/src/repository-line-service.mjs');
  const { dispatchWorkflowExecution } = await import('../../apps/api/src/workflow-dispatcher.mjs');
  const { approveTaskExecution } = await import('../../apps/api/src/task-execution-service.mjs');
  const { approvePullRequestIntentInState } = await import('../../apps/api/src/pull-request-intent-domain.mjs');
  const { executePullRequestIntent } = await import('../../apps/api/src/pull-request-intent-service.mjs');
  await stateService.ensureRuntime();
  const ownerId = (await stateService.readState()).instance_owner_user_id;
  const repository = managedRepoPath('project-1');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repository, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  git(repository, ['add', '.']);
  git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
  const baseSha = git(repository, ['rev-parse', 'HEAD']);
  await stateService.mutate((state) => seed(state, repository, baseSha, ownerId));

  const started = await stateService.mutate((state) =>
    createWorkflowExecutionInState(
      state,
      'workflow-1',
      {
        operation_key: 'v110-full-flow',
        adapter: 'test',
        test_summary: 'deterministic test adapter',
        test_changes: [{ path: 'src/verified-change.txt', content: 'verified repository change\n' }],
        repositories: [
          { workstream_id: 'workstream-1', connection_id: 'connection-1', base_ref: 'main', base_sha: baseSha }
        ]
      },
      ownerId
    )
  );
  await provisionWorkflowRepositoryLines(started.workflow_execution.id);
  await dispatchWorkflowExecution(started.workflow_execution.id);
  let state = await stateService.readState();
  const research = currentExecution(state, 'task-research');
  assert.equal(research.status, 'awaiting_human');
  const researchAsset = state.assets.find(
    (item) => item.task_execution_id === research.id && item.output_key === 'research_result'
  );
  const researchVersion = state.asset_versions.find((item) => item.id === researchAsset.current_version_id);
  await approveTaskExecution(research.id, {
    decision: 'approve',
    expectedVersions: [{ version_id: researchVersion.id, content_sha256: researchVersion.content_sha256 }],
    actorId: ownerId
  });
  await dispatchWorkflowExecution(started.workflow_execution.id);

  state = await stateService.readState();
  const line = state.repository_lines.find((item) => item.workflow_execution_id === started.workflow_execution.id);
  const code = currentExecution(state, 'task-code'),
    verify = currentExecution(state, 'task-test'),
    integrate = currentExecution(state, 'task-integrate');
  assert.equal(code.status, 'completed');
  assert.equal(verify.status, 'completed');
  assert.equal(integrate.status, 'awaiting_human');
  assert.notEqual(line.head_sha, baseSha);
  assert.equal(git(line.checkout_path, ['status', '--porcelain']), '');
  const repositoryVersion = state.asset_versions.find((item) => item.id === code.output_bindings[0].version_id);
  const testReport = state.asset_versions.find((item) => item.id === verify.output_bindings[0].version_id);
  assert.equal(repositoryVersion.repository_sha, line.head_sha);
  assert.equal(testReport.repository_sha, line.head_sha);
  assert.equal(repositoryVersion.payload_kind, 'git_bundle_diff');
  assert.ok(repositoryVersion.manifest.entries.some((item) => item.path === 'repository.bundle'));
  assert.ok(testReport.manifest.entries.some((item) => item.path === 'test-report.json'));

  let intent = state.pull_request_intents.find((item) => item.id === integrate.integration.pull_request_intent_id);
  await stateService.mutate((current) =>
    approvePullRequestIntentInState(
      current,
      intent.id,
      { action: 'create_pr', expected_revision: intent.revision, expected_snapshot_hash: intent.snapshot_hash },
      ownerId
    )
  );
  state = await stateService.readState();
  intent = state.pull_request_intents.find((item) => item.id === intent.id);
  await executePullRequestIntent(
    intent.id,
    {
      action: 'create_pr',
      expected_revision: intent.revision,
      expected_snapshot_hash: intent.snapshot_hash,
      adapter: 'test',
      test_checks_status: 'passed',
      test_checks: []
    },
    ownerId
  );
  state = await stateService.readState();
  intent = state.pull_request_intents.find((item) => item.id === intent.id);
  await stateService.mutate((current) =>
    approvePullRequestIntentInState(
      current,
      intent.id,
      { action: 'merge_pr', expected_revision: intent.revision, expected_snapshot_hash: intent.snapshot_hash },
      ownerId
    )
  );
  state = await stateService.readState();
  intent = state.pull_request_intents.find((item) => item.id === intent.id);
  await executePullRequestIntent(
    intent.id,
    {
      action: 'merge_pr',
      expected_revision: intent.revision,
      expected_snapshot_hash: intent.snapshot_hash,
      adapter: 'test',
      test_checks_status: 'passed',
      test_checks: [],
      test_merge_commit_sha: 'f'.repeat(40)
    },
    ownerId
  );

  state = await stateService.readState();
  assert.equal(state.workflow_executions.find((item) => item.id === started.workflow_execution.id).status, 'completed');
  assert.equal(currentExecution(state, 'task-integrate').status, 'completed');
  assert.equal(state.repository_lines.find((item) => item.id === line.id).status, 'merged');
  assert.equal(state.pull_request_intents.find((item) => item.id === intent.id).approvals.length, 2);
  const outcome = state.assets.find(
    (item) => item.node_id === 'workstream-1' && item.asset_type === 'WorkstreamOutcomeAsset'
  );
  assert.equal(outcome.status, 'confirmed');
  const outcomeVersion = state.asset_versions.find((item) => item.id === outcome.current_version_id);
  const integration = currentExecution(state, 'task-integrate');
  const integrationVersion = state.asset_versions.find((item) => item.id === integration.output_bindings[0].version_id);
  assert.equal(integrationVersion.repository_sha, 'f'.repeat(40));
  assert.equal(outcomeVersion.repository_sha, 'f'.repeat(40));
  const terminalVersionIds = ['task-research', 'task-code', 'task-test', 'task-integrate']
    .flatMap((taskId) => currentExecution(state, taskId).output_bindings.map((binding) => binding.version_id))
    .sort();
  const outcomeSources = state.asset_relations
    .filter((item) => item.target_asset_version_id === outcomeVersion.id && item.relation_type === 'derived_from')
    .map((item) => item.source_asset_version_id)
    .sort();
  assert.deepEqual(outcomeSources, terminalVersionIds);
  console.log('V1.10 persistent DAG, CAS, same-SHA verification, and PR integration flow passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function seed(state, repository, baseSha, ownerId) {
  state.projects.push({
    id: 'project-1',
    title: 'V1.10 Flow',
    goal: 'Verify the DAG',
    status: 'active',
    onboarding_state: 'confirmed',
    managed_workspace_state: 'ready',
    repo_path: repository,
    workspace_root: path.dirname(repository),
    current_workspace_id: 'workspace-root',
    lifecycle_operation: null,
    deleted_at: null,
    settings: {}
  });
  state.project_memberships.push({
    id: 'membership-1',
    project_id: 'project-1',
    user_id: ownerId,
    role: 'owner',
    status: 'active'
  });
  state.workspaces.push(
    { id: 'workspace-root', project_id: 'project-1', title: 'Project' },
    { id: 'workspace-workstream', project_id: 'project-1', workflow_node_id: 'workstream-1', title: 'Delivery' },
    ...['research', 'code', 'test', 'integrate'].map((name) => ({
      id: `workspace-${name}`,
      project_id: 'project-1',
      workflow_node_id: `task-${name}`,
      title: name
    }))
  );
  state.workflows.push({
    id: 'workflow-1',
    project_id: 'project-1',
    workspace_id: 'workspace-root',
    status: 'active',
    planning_quality: 'verified',
    workflow_revision: 1
  });
  state.workflow_nodes.push(
    {
      id: 'workstream-1',
      workflow_id: 'workflow-1',
      workspace_id: 'workspace-workstream',
      role: 'workstream',
      title: 'Verified delivery',
      dependencies: [],
      order_index: 0
    },
    task('research', 'research', [], 1),
    task('code', 'code', ['task-research'], 2),
    task('test', 'test', ['task-code'], 3),
    task('integrate', 'integration', ['task-test'], 4)
  );
  state.node_contracts.push(
    contract('research', [], output('research_result', 'ResearchEvidenceAsset', 'human')),
    contract(
      'code',
      [input('research', 'task-research', 'research_result')],
      output('repository_version', 'RepositoryVersionAsset', 'system_evidence')
    ),
    contract(
      'test',
      [input('repository', 'task-code', 'repository_version')],
      output('test_report', 'TestReportAsset', 'system_evidence')
    ),
    contract(
      'integrate',
      [input('verification', 'task-test', 'test_report')],
      output('integration_evidence', 'IntegrationEvidenceAsset', 'system_evidence')
    )
  );
  state.repository_connections.push({
    id: 'connection-1',
    project_id: 'project-1',
    provider: 'github',
    repository_id: '1',
    full_name: 'fixture/repository',
    installation_id: '1',
    default_branch: 'main',
    remote_name: 'origin',
    local_path: repository,
    sync_status: 'ready',
    permissions: { read: true, push: true, pull_requests: true }
  });
  state.delivery_policies.push({
    id: 'policy-1',
    project_id: 'project-1',
    workflow_id: 'workflow-1',
    workstream_id: 'workstream-1',
    connection_id: 'connection-1',
    base_ref: 'main',
    path_prefixes: ['.'],
    test_commands: ['node -e "process.exit(0)"'],
    automation_permissions: ['codex_run', 'commit', 'push', 'draft_pr'],
    policy_hash: 'policy',
    status: 'approved',
    approved_by_user_id: ownerId,
    approved_at: new Date().toISOString()
  });
  assert.match(baseSha, /^[a-f0-9]{40}$/);
}

function task(name, kind, dependencies, order) {
  return {
    id: `task-${name}`,
    workflow_id: 'workflow-1',
    parent_node_id: 'workstream-1',
    workspace_id: `workspace-${name}`,
    role: 'task',
    title: name,
    task_kind: kind,
    execution_mode: 'codex',
    execution_revision: 1,
    current_contract_id: `contract-${name}`,
    dependencies: dependencies.map((node_id) => ({ node_id, type: 'finish_to_start' })),
    order_index: order
  };
}
function contract(name, expectedInputs, expectedOutput) {
  return {
    id: `contract-${name}`,
    node_id: `task-${name}`,
    version: 1,
    expected_inputs: expectedInputs,
    expected_outputs: [expectedOutput],
    acceptance_criteria: expectedOutput.acceptance_criteria
  };
}
function input(key, refId, selector) {
  return { key, kind: 'asset_version', required: true, source: 'dependency', ref_id: refId, selector };
}
function output(key, assetType, policy) {
  return {
    key,
    kind: 'asset',
    required: true,
    asset_type: assetType,
    confirmation_policy: policy,
    acceptance_criteria: [`${key} accepted`]
  };
}
function currentExecution(state, taskId) {
  return state.task_executions.filter((item) => item.task_id === taskId).sort((a, b) => b.attempt - a.attempt)[0];
}
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}
