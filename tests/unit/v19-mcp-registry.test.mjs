import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v19-mcp-registry-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const { apiRoutes } = await import('../../apps/api/src/api-routes.mjs');
  const { createApiRouteRegistry, executeRegistryOperation } = await import('../../apps/api/src/api-route-registry.mjs');
  const { isProjectRoute } = await import('../../apps/api/src/project-governance-v19.mjs');
  const state = await import('../../apps/api/src/state.mjs');
  await state.ensureRuntime();
  const registry = createApiRouteRegistry(apiRoutes), byId = new Map(registry.map((item) => [item.operation_id, item]));
  const expected = [
    'aiws.workflow.get.workflows.by-id.graph',
    'aiws.workflow.post.workflows.by-id.graph-proposals',
    'aiws.workflow.post.projects.by-id.workflow-draft.generations',
    'aiws.workflow.get.projects.by-id.workflow-draft.generations.by-generation-id.events',
    'aiws.github.get.workstreams.by-id.repository-targets',
    'aiws.github.put.tasks.by-id.repository-targets',
    'aiws.github.post.workstreams.by-id.delivery-policies',
    'aiws.github.post.tasks.by-id.deliveries',
    'aiws.github.get.deliveries.by-id.events',
    'aiws.github.get.deliveries.by-id.pull-request',
    'aiws.github.post.deliveries.by-id.pull-request.ready',
    'aiws.github.post.deliveries.by-id.pull-request.merge',
    'aiws.github.post.deliveries.by-id.pull-request.reconcile',
  'aiws.admin.post.workflow-migrations.batches.by-id.approve'
  , 'aiws.projects.post.projects', 'aiws.projects.post.projects.by-id.invitations',
  'aiws.governance.post.projects.by-id.exchange-requests', 'aiws.github.post.repository-deletion-intents.by-id.execute'
  ];
  for (const operationId of expected) assert.ok(byId.has(operationId), operationId);
  assert.equal(byId.get('aiws.workflow.get.projects.by-id.workflow-draft.generations.by-generation-id.events').mapping, 'async_adapter');
  assert.equal(byId.get('aiws.github.get.deliveries.by-id.events').mapping, 'async_adapter');
  assert.deepEqual(byId.get('aiws.workflow.post.tasks.by-id.review').required_scopes, ['workflow:write', 'approval:decide']);
  assert.deepEqual(byId.get('aiws.workflow.post.workstreams.by-id.review').required_scopes, ['workflow:write', 'approval:decide']);
  assert.deepEqual(byId.get('aiws.github.post.workstreams.by-id.delivery-policies').required_scopes, ['github:write', 'approval:decide']);
  assert.deepEqual(byId.get('aiws.github.get.deliveries.by-id.pull-request').required_scopes, ['github:read']);
  assert.deepEqual(byId.get('aiws.github.post.deliveries.by-id.pull-request.merge').required_scopes, ['github:write']);
  assert.equal(byId.get('aiws.github.post.deliveries.by-id.pull-request.merge').risk, 'high');
  assert.deepEqual(byId.get('aiws.admin.post.workflow-migrations.batches.by-id.approve').required_scopes, ['setup:admin']);
  assert.deepEqual(byId.get('aiws.projects.post.projects').required_scopes, ['project:create']);
  assert.deepEqual(byId.get('aiws.projects.post.projects.by-id.invitations').required_scopes, ['project:share']);
  assert.deepEqual(byId.get('aiws.projects.post.projects.by-id.trash').required_scopes, ['project:write', 'destructive:execute']);
  assert.deepEqual(byId.get('aiws.projects.delete.projects.by-id').required_scopes, ['project:write', 'destructive:execute']);
  assert.deepEqual(byId.get('aiws.projects.post.projects.by-id.purge').required_scopes, ['project:write', 'destructive:execute']);
  assert.deepEqual(byId.get('aiws.governance.post.projects.by-id.exchange-requests').required_scopes, ['exchange:write']);
  assert.deepEqual(byId.get('aiws.github.post.repository-deletion-intents.by-id.execute').required_scopes, ['github:write', 'destructive:execute']);
  assert.equal(byId.get('aiws.workflow.post.brief-templates.by-template-id.apply').project_scoped, true);
  for (const operation of registry) assert.equal(operation.project_scoped, isProjectRoute(operation.pattern), `${operation.method} ${operation.pattern} Project scope metadata`);

  const unknown = await executeRegistryOperation(registry, 'aiws.workflow.post.unregistered-side-effect', {}, { client: { id: 'client', scopes: ['workflow:write'], project_allowlist: [] } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.error.error, 'mcp_operation_not_found');

  const subjectlessRead = await executeRegistryOperation(registry, 'aiws.projects.get.projects', {}, { client: { id: 'subjectless', scopes: ['project:read'], project_allowlist: [] } });
  assert.equal(subjectlessRead.ok, false);
  assert.equal(subjectlessRead.status, 403);
  assert.equal(subjectlessRead.error.error, 'mcp_subject_user_required');

  const subjectlessAggregate = await executeRegistryOperation(registry, 'aiws.assets.get.assets', {}, { client: { id: 'subjectless-assets', scopes: ['assets:read'], project_allowlist: [] } });
  assert.equal(subjectlessAggregate.ok, false);
  assert.equal(subjectlessAggregate.status, 403);
  assert.equal(subjectlessAggregate.error.error, 'mcp_subject_user_required');

  console.log('V1.9 MCP route registry unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
