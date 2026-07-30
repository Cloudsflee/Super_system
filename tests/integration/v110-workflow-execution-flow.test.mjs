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
  const { readCasBlob } = await import('../../apps/api/src/asset-cas.mjs');
  const { createWorkflowExecutionInState } = await import('../../apps/api/src/workflow-execution-domain.mjs');
  const { applyWorkflowOutcomeProtocols } = await import('../../apps/api/src/workflow-outcome-definition.mjs');
  const { provisionWorkflowRepositoryLines } = await import('../../apps/api/src/repository-line-service.mjs');
  const { dispatchWorkflowExecution } = await import('../../apps/api/src/workflow-dispatcher.mjs');
  const { approveTaskExecution, submitTaskExecutionOutputs } =
    await import('../../apps/api/src/task-execution-service.mjs');
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
  await stateService.mutate((state) => {
    seed(state, repository, baseSha, ownerId);
    applyWorkflowOutcomeProtocols(
      state.workflows.find((item) => item.id === 'workflow-1'),
      state.workflow_nodes.filter((item) => item.workflow_id === 'workflow-1')
    );
  });

  const started = await stateService.mutate((state) =>
    createWorkflowExecutionInState(
      state,
      'workflow-1',
      {
        operation_key: 'v110-full-flow',
        runner: 'history_promotion',
        adapter: 'test',
        test_summary: 'deterministic test adapter',
        test_changes: [{ path: 'src/verified-change.txt', content: 'verified repository change\n' }],
        test_use_required_inputs: true,
        test_use_required_context: true,
        repositories: [
          { workstream_id: 'workstream-1', connection_id: 'connection-1', base_ref: 'main', base_sha: baseSha },
          { workstream_id: 'workstream-2', connection_id: 'connection-1', base_ref: 'main', base_sha: baseSha }
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
  const mergedSha = line.head_sha;
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
  const originalIntentSnapshotHash = intent.snapshot_hash,
    refreshedBaseSha = 'b'.repeat(40);
  await assert.rejects(
    executePullRequestIntent(
      intent.id,
      {
        action: 'create_pr',
        expected_revision: intent.revision,
        expected_snapshot_hash: intent.snapshot_hash,
        adapter: 'test',
        test_actual_base_sha: refreshedBaseSha
      },
      ownerId
    ),
    (error) =>
      error?.payload?.error === 'pull_request_intent_base_refreshed' && error.payload.approval_required === true
  );
  state = await stateService.readState();
  intent = state.pull_request_intents.find((item) => item.id === intent.id);
  assert.equal(intent.status, 'proposed');
  assert.equal(intent.base_sha, refreshedBaseSha);
  assert.notEqual(intent.snapshot_hash, originalIntentSnapshotHash);
  assert.equal(intent.approvals.length, 1);
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
  await stateService.mutate((current) => {
    const currentIntent = current.pull_request_intents.find((item) => item.id === intent.id);
    currentIntent.checks = [
      {
        name: 'AIWS Delivery Policy: fixture',
        status: 'completed',
        conclusion: 'success',
        source: 'aiws_delivery_policy',
        repository_sha: currentIntent.head_sha,
        log_sha256: 'a'.repeat(64)
      }
    ];
  });
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
      test_merge_commit_sha: mergedSha
    },
    ownerId
  );

  await dispatchWorkflowExecution(started.workflow_execution.id);
  state = await stateService.readState();
  assert.equal(currentExecution(state, 'task-integrate').status, 'completed');
  assert.equal(state.repository_lines.find((item) => item.id === line.id).status, 'merged');
  const mergedIntent = state.pull_request_intents.find((item) => item.id === intent.id);
  assert.equal(mergedIntent.approvals.length, 3);
  assert.equal(mergedIntent.checks[0].source, 'aiws_delivery_policy');
  assert.equal(currentExecution(state, 'task-integrate').evidence.pull_request.checks.length, 1);
  const outcome = state.assets.find(
    (item) => item.node_id === 'workstream-1' && item.asset_type === 'WorkstreamOutcomeAsset'
  );
  assert.equal(outcome.status, 'confirmed');
  const outcomeVersion = state.asset_versions.find((item) => item.id === outcome.current_version_id);
  const integration = currentExecution(state, 'task-integrate'),
    integrationBinding = integration.output_bindings.find((item) => item.key === 'integration_evidence'),
    internalBinding = integration.output_bindings.find((item) => item.key === 'internal_audit'),
    integrationVersion = state.asset_versions.find((item) => item.id === integrationBinding.version_id);
  const consume = currentExecution(state, 'task-consume-outcome'),
    dependentLine = state.repository_lines.find((item) => item.workstream_id === 'workstream-2');
  assert.equal(
    consume.status,
    'awaiting_human',
    JSON.stringify({ error_code: consume.error_code, readiness: consume.readiness, dependent_line: dependentLine })
  );
  const outcomeInput = consume.context_snapshot.inputs.find((item) => item.key === 'accepted_delivery');
  assert.equal(dependentLine.head_sha, mergedSha);
  assert.equal(dependentLine.dependency_base_sha, mergedSha);
  assert.equal(consume.context_snapshot.repository_snapshot.fixed_sha, mergedSha);
  assert.equal(outcomeInput.resolved_from.workflow_execution_id, started.workflow_execution.id);
  assert.deepEqual(
    outcomeInput.asset_versions.map((item) => item.version_id),
    [integrationVersion.id]
  );
  assert.deepEqual(outcomeInput.resolved_from.selected_output_keys, ['integration_evidence']);
  assert.equal(outcomeInput.resolved_from.selected_outputs[0].producer_task_id, 'task-integrate');
  assert.equal(outcomeInput.resolved_from.outcome_version_id, outcomeVersion.id);
  assert.equal(outcomeInput.asset_versions[0].handoff_manifest.output.version_id, integrationVersion.id);
  assert.equal(
    outcomeInput.asset_versions[0].handoff_manifest.manifest_sha256,
    integrationBinding.handoff_manifest_sha256
  );
  assert.equal(internalBinding.handoff, false);
  assert.equal(integrationVersion.repository_sha, mergedSha);
  assert.equal(outcomeVersion.repository_sha, mergedSha);
  const outcomePayload = JSON.parse(
    (await readCasBlob(outcomeVersion.blob_refs.find((item) => item.role === 'payload').sha256, { state })).toString(
      'utf8'
    )
  );
  assert.deepEqual(
    outcomePayload.handoff_output_bindings.map((item) => item.version_id),
    [integrationVersion.id]
  );
  assert.deepEqual(
    outcomePayload.terminal_output_bindings.map((item) => item.version_id).sort(),
    [integrationBinding.version_id, internalBinding.version_id].sort()
  );
  const terminalVersionIds = ['task-research', 'task-code', 'task-test', 'task-integrate']
    .flatMap((taskId) => currentExecution(state, taskId).output_bindings.map((binding) => binding.version_id))
    .sort();
  const outcomeSources = state.asset_relations
    .filter((item) => item.target_asset_version_id === outcomeVersion.id && item.relation_type === 'evidenced_by')
    .map((item) => item.source_asset_version_id)
    .sort();
  assert.deepEqual(outcomeSources, terminalVersionIds);
  const consumed = outcomeInput.asset_versions.map((item) => item.version_id);
  await submitTaskExecutionOutputs(consume.id, {
    manual: true,
    actorId: ownerId,
    outputs: [
      {
        output_key: 'accepted_outcome',
        asset_type: 'DecisionAsset',
        title: 'Accepted upstream outcome',
        summary: 'The exact upstream delivery was consumed.',
        payload: {
          payload_kind: 'text',
          media_type: 'text/plain; charset=utf-8',
          content: 'Accepted.'
        },
        evidence_refs: [`asset-version:${integrationVersion.id}`],
        consumed_input_versions: consumed
      }
    ]
  });
  await dispatchWorkflowExecution(started.workflow_execution.id);
  state = await stateService.readState();
  const completedConsume = currentExecution(state, 'task-consume-outcome'),
    acceptedBinding = completedConsume.output_bindings.find((item) => item.key === 'accepted_outcome'),
    acceptedVersion = state.asset_versions.find((item) => item.id === acceptedBinding.version_id),
    acceptedSources = state.asset_relations
      .filter((item) => item.target_asset_version_id === acceptedVersion.id)
      .map((item) => item.source_asset_version_id);
  assert.equal(completedConsume.status, 'completed');
  assert.deepEqual(completedConsume.consumed_inputs, [integrationVersion.id]);
  assert.deepEqual(acceptedVersion.provenance.consumed_inputs, [integrationVersion.id]);
  assert.equal(
    acceptedVersion.provenance.context_selection_id,
    completedConsume.context_snapshot.system_context.context_selection_id
  );
  assert.deepEqual(acceptedSources, [integrationVersion.id]);
  assert.equal(acceptedSources.includes(outcomeVersion.id), false);
  assert.equal(state.workflow_executions.find((item) => item.id === started.workflow_execution.id).status, 'completed');
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
    {
      id: 'workspace-workstream-consumer',
      project_id: 'project-1',
      workflow_node_id: 'workstream-2',
      title: 'Consumer'
    },
    {
      id: 'workspace-consume-outcome',
      project_id: 'project-1',
      workflow_node_id: 'task-consume-outcome',
      title: 'Consume outcome'
    },
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
    task('integrate', 'integration', ['task-test'], 4),
    {
      id: 'workstream-2',
      workflow_id: 'workflow-1',
      workspace_id: 'workspace-workstream-consumer',
      role: 'workstream',
      title: 'Consume verified delivery',
      dependencies: [{ node_id: 'workstream-1', type: 'finish_to_start' }],
      order_index: 5
    },
    {
      id: 'task-consume-outcome',
      workflow_id: 'workflow-1',
      parent_node_id: 'workstream-2',
      workspace_id: 'workspace-consume-outcome',
      role: 'task',
      title: 'Consume outcome',
      task_kind: 'manual',
      execution_mode: 'manual',
      execution_revision: 1,
      current_contract_id: 'contract-consume-outcome',
      dependencies: [],
      order_index: 6
    }
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
    ),
    {
      id: 'contract-consume-outcome',
      node_id: 'task-consume-outcome',
      version: 1,
      node_goal: 'Consume the exact accepted upstream delivery.',
      expected_inputs: [
        {
          key: 'accepted_delivery',
          kind: 'asset_version',
          required: true,
          source: 'workstream_dependency',
          ref_id: 'workstream-1',
          selector: 'required_outputs',
          version_id: null
        }
      ],
      expected_outputs: [output('accepted_outcome', 'DecisionAsset', 'human')],
      acceptance_criteria: ['accepted_outcome accepted'],
      allowed_tools: ['assist']
    }
  );
  const integrationContract = state.node_contracts.find((item) => item.id === 'contract-integrate');
  integrationContract.expected_outputs.push({
    ...output('internal_audit', 'IntegrationEvidenceAsset', 'system_evidence'),
    required: false,
    handoff: false
  });
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
