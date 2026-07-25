import assert from 'node:assert/strict';
import { callOperation, createMcpTestFixture, resultData } from '../v18/mcp-test-helpers.mjs';

let fixture;
try {
  fixture = await createMcpTestFixture('aiws-v19-migration-acl-', {
    operator: { scopes: ['setup:read', 'setup:admin'], project_allowlist: ['project-visible'] },
    seed: async ({ stateApi }) =>
      stateApi.mutate((state) => {
        const owner = state.users.find((item) => item.id === state.instance_owner_user_id),
          at = new Date().toISOString();
        state.projects.push(project('project-visible', owner.id, at), project('project-private', owner.id, at));
        state.workflow_migration_batches.push({
          id: 'batch-shared',
          status: 'pending_approval',
          project_ids: ['project-visible', 'project-private'],
          workflow_ids: ['workflow-visible', 'workflow-private'],
          approved_by_user_id: null,
          approved_at: null,
          created_at: at,
          updated_at: at
        });
        state.workflow_migration_jobs.push(
          job('job-visible', 'project-visible', 'workflow-visible', at),
          job('job-private', 'project-private', 'workflow-private', at)
        );
      })
  });
  const connection = await fixture.connect();
  const migration = resultData(await callOperation(connection.client, 'aiws.admin.get.workflow-migrations'));
  assert.deepEqual(migration.batch.project_ids, ['project-visible']);
  assert.deepEqual(migration.batch.workflow_ids, ['workflow-visible']);
  assert.deepEqual(
    migration.jobs.map((item) => item.id),
    ['job-visible']
  );
  const denied = await callOperation(
    connection.client,
    'aiws.admin.post.workflow-migrations.batches.by-id.approve',
    { params: { id: 'batch-shared' }, body: { adapter: 'test' } },
    { ok: false }
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.error.error, 'mcp_project_access_denied');
  await connection.close();
  console.log('V1.9 workflow migration membership and MCP allowlist ACL flow passed');
} finally {
  await fixture?.close();
}

function project(id, ownerId, at) {
  return {
    id,
    title: id,
    goal: id,
    owner_user_id: ownerId,
    created_by_user_id: ownerId,
    status: 'active',
    onboarding_state: 'confirmed',
    deleted_at: null,
    settings: {},
    created_at: at,
    updated_at: at
  };
}
function job(id, projectId, workflowId, at) {
  return {
    id,
    batch_id: 'batch-shared',
    project_id: projectId,
    workflow_id: workflowId,
    status: 'pending',
    attempt: 0,
    snapshot: null,
    before_hash: null,
    candidate: null,
    error_code: null,
    created_at: at,
    updated_at: at
  };
}
