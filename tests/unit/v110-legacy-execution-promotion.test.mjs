import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emptyState } from '../../apps/api/src/state.mjs';
import {
  inspectLegacyExecutionHistory,
  promoteLegacyExecutionHistoryInState
} from '../../apps/api/src/legacy-execution-promotion.mjs';
import { projectManagedPathsInState, purgeProjectInState } from '../../apps/api/src/state-purge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-legacy-promotion-'));
try {
  const state = fixture();
  assert.deepEqual(
    inspectLegacyExecutionHistory(state)
      .map((item) => item.task.id)
      .sort(),
    ['task-code', 'task-research']
  );
  const promoted = await promoteLegacyExecutionHistoryInState(state, {
    timestamp: '2026-07-25T08:00:00.000Z',
    actorId: 'owner',
    casRoot: path.join(root, 'cas'),
    backupDirectory: path.join(root, 'migrations')
  });
  assert.equal(promoted.changed, true);
  assert.equal(fs.existsSync(promoted.backup_path), true);
  assert.equal(state.workflow_executions.length, 1);
  assert.equal(state.workflow_executions[0].status, 'failed');

  const codeAttempts = state.task_executions
    .filter((item) => item.task_id === 'task-code')
    .sort((a, b) => a.attempt - b.attempt);
  assert.equal(codeAttempts.length, 2);
  assert.equal(codeAttempts[0].status, 'superseded');
  assert.equal(codeAttempts[1].status, 'completed');
  assert.equal(codeAttempts[1].output_bindings.length, 1);
  const output = codeAttempts[1].output_bindings[0],
    asset = state.assets.find((item) => item.id === output.asset_id),
    version = state.asset_versions.find((item) => item.id === output.version_id);
  assert.equal(asset.status, 'confirmed');
  assert.equal(asset.task_execution_id, codeAttempts[1].id);
  assert.equal(version.verification_status, 'verified');
  assert.equal(version.repository_sha, 'b'.repeat(40));
  assert.equal(version.manifest.metadata.source, 'legacy_execution_promotion');
  assert.equal(version.manifest.metadata.pull_request_url, 'https://example.test/pull/7');
  assert.ok(
    state.asset_attestations.some(
      (item) => item.asset_version_id === version.id && item.attestor_type === 'trusted_verifier'
    )
  );

  const research = state.task_executions.find((item) => item.task_id === 'task-research');
  assert.equal(research.status, 'failed');
  assert.equal(research.error_code, 'legacy_partial');
  assert.ok(
    state.assets.some(
      (item) =>
        item.task_execution_id === research.id &&
        item.asset_type === 'ExecutionDiagnosticAsset' &&
        item.status === 'confirmed'
    )
  );
  assert.equal(state.workflow_nodes.find((item) => item.id === 'task-code').execution_evidence_status, 'managed');
  assert.equal(
    state.task_executions.some((item) => item.task_id === 'task-never-started'),
    false
  );
  assert.equal(
    (
      await promoteLegacyExecutionHistoryInState(state, {
        casRoot: path.join(root, 'cas'),
        backupDirectory: path.join(root, 'migrations')
      })
    ).changed,
    false
  );

  state.asset_relations.push({
    id: 'relation-1',
    relation_type: 'derived_from',
    source_asset_id: asset.id,
    source_asset_version_id: version.id,
    target_asset_id: asset.id,
    target_asset_version_id: version.id
  });
  state.canonical_repositories[0].remote_state = 'deleted';
  state.projects.push({ id: 'project-2', title: 'Unrelated deleted repository', deleted_at: null });
  state.canonical_repositories.push({
    id: 'canonical-2',
    repository_id: 'repository-2',
    full_name: 'fixture/unrelated',
    remote_state: 'deleted'
  });
  state.project_repository_bindings.push(
    { id: 'binding-2', project_id: 'project-2', canonical_repository_id: 'canonical-2', status: 'removed' },
    { id: 'binding-shared-history', project_id: 'project-2', canonical_repository_id: 'canonical-1', status: 'removed' }
  );
  const managed = projectManagedPathsInState(state, 'project-1');
  assert.ok(managed.cas_blob_paths.length >= 2);
  purgeProjectInState(state, 'project-1');
  for (const key of [
    'workflow_executions',
    'task_executions',
    'assets',
    'asset_versions',
    'asset_attestations',
    'asset_relations',
    'asset_blobs',
    'repository_deletion_intents'
  ])
    assert.equal(state[key].length, 0, `${key} retained project data`);
  assert.deepEqual(
    state.projects.map((item) => item.id),
    ['project-2']
  );
  assert.deepEqual(
    state.canonical_repositories.map((item) => item.id),
    ['canonical-2']
  );
  assert.deepEqual(
    state.project_repository_bindings.map((item) => item.id),
    ['binding-2']
  );
  assert.deepEqual(
    state.github_installations[0].repositories.map((item) => item.id),
    ['repository-2']
  );
  console.log('V1.10 legacy execution promotion and complete project purge tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function fixture() {
  const state = emptyState();
  state.schema_version = 19;
  state.instance_owner_user_id = 'owner';
  state.users.push({ id: 'owner', role: 'owner' });
  state.projects.push({ id: 'project-1', title: 'Legacy delivery', deleted_at: null });
  state.workflows.push({
    id: 'workflow-1',
    project_id: 'project-1',
    planning_quality: 'verified',
    workflow_revision: 4
  });
  state.workflow_nodes.push(
    { id: 'workstream-1', workflow_id: 'workflow-1', role: 'workstream', title: 'Delivery' },
    task('code', 'completed', 'code', 'system_evidence'),
    task('research', 'blocked', 'research', 'human'),
    task('never-started', 'blocked', 'analysis', 'human')
  );
  state.node_contracts.push(
    contract('code', 'CodeChangeAsset', 'system_evidence'),
    contract('research', 'ResearchEvidenceAsset', 'human'),
    contract('never-started', 'DecisionAsset', 'human')
  );
  state.repository_connections.push({ id: 'connection-1', project_id: 'project-1', default_branch: 'main' });
  state.repository_targets.push({
    id: 'target-1',
    project_id: 'project-1',
    workflow_id: 'workflow-1',
    workstream_id: 'workstream-1',
    task_id: 'task-code',
    connection_id: 'connection-1'
  });
  state.canonical_repositories.push({
    id: 'canonical-1',
    repository_id: 'repository-1',
    full_name: 'fixture/repository',
    remote_state: 'active'
  });
  state.github_installations.push({
    id: 'installation-1',
    repositories: [
      { id: 'repository-1', full_name: 'fixture/repository' },
      { id: 'repository-2', full_name: 'fixture/unrelated' }
    ]
  });
  state.project_repository_bindings.push({
    id: 'binding-1',
    project_id: 'project-1',
    canonical_repository_id: 'canonical-1',
    status: 'ready'
  });
  state.repository_deletion_intents.push({
    id: 'delete-1',
    canonical_repository_id: 'canonical-1',
    status: 'executed',
    snapshot: { bindings: [{ project_id: 'project-1' }] }
  });
  state.deliveries.push(
    delivery('delivery-failed', 'failed', 'a'.repeat(40), '2026-07-20T01:00:00.000Z'),
    delivery('delivery-completed', 'completed', 'b'.repeat(40), '2026-07-20T02:00:00.000Z')
  );
  state.submissions.push({
    id: 'submission-1',
    project_id: 'project-1',
    node_id: 'task-code',
    from_scope_id: 'task-code',
    title: 'Accepted delivery',
    summary: 'The production baseline was accepted.',
    status: 'accepted',
    reviewed_by_user_id: 'owner',
    reviewed_at: '2026-07-20T02:01:00.000Z',
    created_at: '2026-07-20T02:00:30.000Z'
  });
  state.node_runs.push({
    id: 'run-partial',
    project_id: 'project-1',
    node_id: 'task-research',
    runner: 'codex_docker',
    status: 'partial',
    summary: 'Runner output was incomplete.',
    created_at: '2026-07-21T01:00:00.000Z',
    completed_at: '2026-07-21T01:01:00.000Z'
  });
  return state;
}
function task(name, status, kind, policy) {
  return {
    id: `task-${name}`,
    workflow_id: 'workflow-1',
    parent_node_id: 'workstream-1',
    workspace_id: `workspace-${name}`,
    role: 'task',
    title: name,
    status,
    task_kind: kind,
    execution_mode: kind === 'research' ? 'assist' : 'codex',
    execution_revision: 1,
    current_contract_id: `contract-${name}`,
    repository_target_ids: name === 'code' ? ['target-1'] : [],
    created_at: '2026-07-19T00:00:00.000Z',
    output_slots: [{ key: `${name}_result`, asset_type: `${kind}Asset`, confirmation_policy: policy }]
  };
}
function contract(name, assetType, confirmationPolicy) {
  return {
    id: `contract-${name}`,
    node_id: `task-${name}`,
    version: 1,
    expected_inputs: [],
    expected_outputs: [
      {
        key: `${name}_result`,
        kind: 'asset',
        required: true,
        asset_type: assetType,
        confirmation_policy: confirmationPolicy,
        acceptance_criteria: [`${name} accepted`]
      }
    ],
    acceptance_criteria: [`${name} accepted`]
  };
}
function delivery(id, status, commitSha, createdAt) {
  return {
    id,
    project_id: 'project-1',
    workflow_id: 'workflow-1',
    workstream_id: 'workstream-1',
    task_id: 'task-code',
    repository_target_id: 'target-1',
    status,
    phase: status,
    branch: 'aiws/legacy-delivery',
    base_sha: '0'.repeat(40),
    commit_sha: status === 'completed' ? commitSha : null,
    pr_number: 7,
    pr_url: 'https://example.test/pull/7',
    pr_state: 'draft',
    created_at: createdAt,
    completed_at: createdAt,
    created_by_user_id: 'owner'
  };
}
