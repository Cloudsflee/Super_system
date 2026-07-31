import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v21-stage-replay-'));
process.env.AIWS_HOME = path.join(root, 'home');
process.env.NODE_ENV = 'test';
process.env.AIWS_TEST_ADAPTERS = '1';
let stateService;

try {
  stateService = await import('../../apps/api/src/state.mjs');
  const { managedProjectRoot, managedRepoPath } = await import('../../apps/api/src/managed-workspace.mjs');
  const { applyWorkflowOutcomeProtocols } = await import('../../apps/api/src/workflow-outcome-definition.mjs');
  const { createWorkflowExecutionInState } = await import('../../apps/api/src/workflow-execution-domain.mjs');
  const { dispatchWorkflowExecution } = await import('../../apps/api/src/workflow-dispatcher.mjs');
  const { replayTaskExecutionStage } = await import('../../apps/api/src/execution-replay-service.mjs');
  const { approveTaskExecution } = await import('../../apps/api/src/task-execution-service.mjs');

  await stateService.ensureRuntime();
  const initial = await stateService.readState(),
    ownerId = initial.instance_owner_user_id,
    repository = managedRepoPath('project-v21-replay');
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# replay fixture\n', 'utf8');
  git(repository, ['add', '.']);
  git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);

  await stateService.mutate((state) =>
    seed(state, ownerId, repository, managedProjectRoot('project-v21-replay'), applyWorkflowOutcomeProtocols)
  );
  const started = await stateService.mutate((state) =>
    createWorkflowExecutionInState(
      state,
      'workflow-v21-replay',
      {
        operation_key: 'verify-only-replay',
        runner: 'codex',
        adapter: 'test',
        test_summary: 'Runner completed once before verifier failure.',
        test_verifier_failure: 'verifier_injected_failure'
      },
      ownerId
    )
  );
  const taskExecutionId = started.task_executions[0].id;
  await dispatchWorkflowExecution(started.workflow_execution.id);

  let state = await stateService.readState(),
    execution = state.task_executions.find((item) => item.id === taskExecutionId),
    stages = state.execution_stage_checkpoints.filter((item) => item.task_execution_id === taskExecutionId);
  assert.equal(execution.status, 'failed');
  assert.equal(execution.current_stage, 'verify', JSON.stringify(execution));
  assert.equal(execution.failure?.code, 'verifier_injected_failure');
  assert.deepEqual(
    stages.map((item) => [item.stage, item.status]),
    [
      ['preflight', 'completed'],
      ['execute', 'completed'],
      ['collect', 'completed'],
      ['verify', 'failed']
    ]
  );
  assert.equal(state.node_runs.filter((item) => item.task_execution_id === taskExecutionId).length, 1);
  assert.equal(
    state.traces.filter((item) => item.event_type === 'runner.invoked' && item.run_id === state.node_runs[0].id).length,
    1
  );

  const replayed = await replayTaskExecutionStage(taskExecutionId, 'verify', ownerId);
  assert.equal(replayed.runner_invocations, 0);
  assert.equal(replayed.checkpoint.stage, 'verify');
  assert.equal(replayed.checkpoint.status, 'completed');
  assert.ok(replayed.checkpoint.replay_of_checkpoint_id);
  assert.equal(replayed.task_execution.status, 'awaiting_human');
  assert.equal(replayed.awaiting_human.length, 1);
  await approveTaskExecution(taskExecutionId, {
    decision: 'approve',
    expectedVersions: replayed.awaiting_human.map((item) => ({
      version_id: item.version_id,
      content_sha256: item.content_sha256
    })),
    actorId: ownerId
  });
  await dispatchWorkflowExecution(started.workflow_execution.id);

  state = await waitForState(stateService, (value) => {
    const workflow = value.workflow_executions.find((item) => item.id === started.workflow_execution.id);
    return workflow?.status === 'completed';
  });
  execution = state.task_executions.find((item) => item.id === taskExecutionId);
  stages = state.execution_stage_checkpoints.filter((item) => item.task_execution_id === taskExecutionId);
  const workflowExecution = state.workflow_executions.find((item) => item.id === started.workflow_execution.id);
  assert.equal(execution.status, 'completed');
  assert.equal(execution.replay_count, 1);
  assert.equal(state.node_runs.filter((item) => item.task_execution_id === taskExecutionId).length, 1);
  assert.equal(state.traces.filter((item) => item.event_type === 'runner.invoked').length, 1);
  assert.equal(stages.filter((item) => item.stage === 'verify').length, 2);
  assert.equal(
    workflowExecution.completion_status,
    'completed',
    JSON.stringify({
      summary: workflowExecution.outcome_summary,
      requirements: state.outcome_requirements.filter((item) => item.workflow_execution_id === workflowExecution.id),
      evaluations: state.outcome_evaluations.filter((item) => item.workflow_execution_id === workflowExecution.id)
    })
  );
  assert.equal(workflowExecution.release_eligible, true);
  assert.equal(workflowExecution.finalization_state, 'completed');

  console.log('V2.1 verifier failure replayed verify only with one Runner invocation and completed finalization');
} finally {
  await stateService?.checkpointAndCloseState().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

function seed(state, ownerId, repository, workspaceRoot, applyWorkflowOutcomeProtocols) {
  const project = {
      id: 'project-v21-replay',
      title: 'Stage replay fixture',
      goal: 'Verify persisted output without rerunning the Runner.',
      status: 'active',
      onboarding_state: 'confirmed',
      managed_workspace_state: 'ready',
      repo_path: repository,
      workspace_root: workspaceRoot,
      current_workspace_id: 'workspace-v21-root',
      lifecycle_operation: null,
      deleted_at: null,
      owner_user_id: ownerId,
      created_by_user_id: ownerId,
      settings: { token_budget: 12_000 }
    },
    workflow = {
      id: 'workflow-v21-replay',
      project_id: project.id,
      workspace_id: project.current_workspace_id,
      title: 'Verify-only replay',
      status: 'active',
      planning_quality: 'verified',
      workflow_revision: 1,
      version: 1
    },
    workstream = {
      id: 'workstream-v21-replay',
      workflow_id: workflow.id,
      workspace_id: 'workspace-v21-workstream',
      role: 'workstream',
      title: 'Delivery',
      status: 'ready',
      dependencies: [],
      order_index: 0
    },
    task = {
      id: 'task-v21-replay',
      workflow_id: workflow.id,
      parent_node_id: workstream.id,
      workspace_id: 'workspace-v21-task',
      role: 'task',
      title: 'Build deterministic artifact',
      task_kind: 'build',
      execution_mode: 'codex',
      execution_revision: 1,
      current_contract_id: 'contract-v21-replay',
      status: 'ready',
      dependencies: [],
      order_index: 1
    },
    contract = {
      id: task.current_contract_id,
      node_id: task.id,
      version: 1,
      node_goal: 'Produce a deterministic build artifact.',
      expected_inputs: [],
      expected_outputs: [
        {
          key: 'build_artifact',
          kind: 'asset',
          required: true,
          asset_type: 'BuildArtifactAsset',
          confirmation_policy: 'human',
          acceptance_criteria: ['artifact is persisted']
        }
      ],
      acceptance_criteria: ['artifact is persisted'],
      allowed_tools: []
    };
  applyWorkflowOutcomeProtocols(workflow, [workstream, task]);
  state.projects.push(project);
  state.project_memberships.push({
    id: 'membership-v21-replay',
    project_id: project.id,
    user_id: ownerId,
    role: 'owner',
    status: 'active'
  });
  state.workspaces.push(
    { id: project.current_workspace_id, project_id: project.id, title: 'Project' },
    { id: workstream.workspace_id, project_id: project.id, workflow_node_id: workstream.id, title: 'Delivery' },
    { id: task.workspace_id, project_id: project.id, workflow_node_id: task.id, title: 'Build task' }
  );
  state.workflows.push(workflow);
  state.workflow_nodes.push(workstream, task);
  state.node_contracts.push(contract);
}

async function waitForState(stateService, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await stateService.readState();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const state = await stateService.readState();
  throw new Error(`state timeout: ${JSON.stringify(state.workflow_executions.at(-1))}`);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}
