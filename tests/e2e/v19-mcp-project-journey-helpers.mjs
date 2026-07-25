import assert from 'node:assert/strict';
import { callOperation, resultData } from '../v18/mcp-test-helpers.mjs';
import { decide } from './v18-mcp-journey-helpers.mjs';

export async function assertLegacyTaskRunRejected(operator, approver, { projectId, task }) {
  const proposal = resultData(
    await callOperation(operator, 'aiws.governance.post.change-proposals', {
      body: {
        project_id: projectId,
        node_id: task.id,
        change_type: 'node_run_write',
        title: `Authorize ${task.title}`,
        after: { runner: 'codex_docker' },
        apply_action: { type: 'node_run_authorization', node_id: task.id, runner: 'codex_docker' }
      }
    })
  );
  await decide(approver, proposal);
  const rejected = await callOperation(
    operator,
    'aiws.runs.post.nodes.by-id.run.start',
    {
      params: { id: task.id },
      body: {
        adapter: 'test',
        runner: 'codex_docker',
        approval_id: proposal.id,
        test_summary: `${task.title} completed with traceable evidence.`
      }
    },
    { ok: false }
  );
  assert.equal(rejected.error.error, 'workflow_execution_required');
  return rejected.error;
}

export async function createRepositoryWorkspace(
  client,
  { projectId, connectionId, operationKey, makeDefault = false }
) {
  const created = resultData(
    await callOperation(client, 'aiws.github.post.projects.by-id.repository-workspaces', {
      params: { id: projectId },
      body: {
        connection_id: connectionId,
        ref: 'main',
        mode: 'read_write',
        scope: { type: 'project', id: projectId, path_prefixes: ['.'] },
        operation_key: operationKey,
        make_default: makeDefault
      }
    })
  );
  return created.workspace;
}

export async function assertLegacyDeliveryRejected(client, { task, policyId, repositoryWorkspaceId, change }) {
  const rejected = await callOperation(
    client,
    'aiws.github.post.tasks.by-id.deliveries',
    {
      params: { id: task.id },
      body: {
        adapter: 'test',
        policy_id: policyId,
        repository_workspace_id: repositoryWorkspaceId,
        test_changes: [change]
      }
    },
    { ok: false }
  );
  assert.equal(rejected.error.error, 'workflow_execution_required');
  return rejected.error;
}

export function codingHierarchy() {
  const evidenceCriterion = 'Release constraints and repository evidence are traceable.';
  const alphaCriterion = 'The alpha change passes its repository policy tests.';
  const betaCriterion = 'The beta integration passes tests and completes delivery evidence.';
  return [
    {
      id: 'ws-multi-repo-release',
      role: 'workstream',
      title: 'Verified multi-repository release',
      outcome: 'Two independently tested repository changes, each represented by its own approved PR intent.',
      category: 'deliverable',
      boundary: { repositories: ['acme/service-alpha', 'acme/service-beta'], deliverable: 'two-pull-requests' },
      acceptance_criteria: [
        'Both repository policy tests pass.',
        'Each repository change completes the two-approval PR flow.'
      ],
      dependency_ids: [],
      tasks: [
        typedTask(
          'task-release-evidence',
          'Prepare release evidence',
          'Establish constraints and evidence for both repository changes',
          'research',
          'assist',
          ['research_evidence', 'constraint_analysis', 'solution_decision'],
          evidenceCriterion,
          [],
          [{ key: 'project_brief', kind: 'context', required: true, source: 'brief', selector: 'current' }],
          'release_evidence',
          'ResearchEvidenceAsset',
          'human'
        ),
        typedTask(
          'task-alpha-repository',
          'Deliver alpha repository change',
          'Create the tested alpha change',
          'code',
          'codex',
          ['execution'],
          alphaCriterion,
          ['task-release-evidence'],
          dependencyInputs('task-release-evidence'),
          'alpha_change',
          'CodeChangeAsset',
          'system_evidence',
          { mode: 'write', repository: 'acme/service-alpha' }
        ),
        typedTask(
          'task-beta-repository',
          'Accept and deliver beta integration',
          'Create and accept the tested beta integration',
          'integration',
          'codex',
          ['acceptance', 'integration_delivery'],
          betaCriterion,
          ['task-alpha-repository'],
          dependencyInputs('task-alpha-repository'),
          'beta_delivery',
          'DeliveryEvidenceAsset',
          'system_evidence',
          { mode: 'write', repository: 'acme/service-beta' }
        )
      ]
    }
  ];
}

function dependencyInputs(dependencyId) {
  return [
    {
      key: 'upstream_result',
      kind: 'asset_version',
      required: true,
      source: 'dependency',
      selector: 'required_outputs',
      ref_id: dependencyId
    },
    {
      key: 'repository_snapshot',
      kind: 'repository',
      required: true,
      source: 'repository_workspace',
      selector: 'fixed_sha'
    }
  ];
}
function typedTask(
  id,
  title,
  goal,
  taskKind,
  executionMode,
  tags,
  criterion,
  dependencyIds,
  inputSlots,
  outputKey,
  assetType,
  confirmationPolicy,
  repositoryIntent = null
) {
  return {
    id,
    role: 'task',
    title,
    goal,
    task_kind: taskKind,
    execution_mode: executionMode,
    capability_tags: tags,
    acceptance_criteria: [criterion],
    dependency_ids: dependencyIds,
    input_slots: inputSlots,
    output_slots: [
      {
        key: outputKey,
        kind: 'asset',
        required: true,
        asset_type: assetType,
        acceptance_criteria: [criterion],
        confirmation_policy: confirmationPolicy
      }
    ],
    repository_intent: repositoryIntent
  };
}
