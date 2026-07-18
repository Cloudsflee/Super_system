import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v19-mcp-registry-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const { apiRoutes } = await import('../../apps/api/src/api-routes.mjs');
  const { createApiRouteRegistry, executeRegistryOperation } = await import('../../apps/api/src/api-route-registry.mjs');
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
    'aiws.admin.post.workflow-migrations.batches.by-id.approve'
  ];
  for (const operationId of expected) assert.ok(byId.has(operationId), operationId);
  assert.equal(byId.get('aiws.workflow.get.projects.by-id.workflow-draft.generations.by-generation-id.events').mapping, 'async_adapter');
  assert.equal(byId.get('aiws.github.get.deliveries.by-id.events').mapping, 'async_adapter');
  assert.deepEqual(byId.get('aiws.workflow.post.tasks.by-id.review').required_scopes, ['workflow:write', 'approval:decide']);
  assert.deepEqual(byId.get('aiws.workflow.post.workstreams.by-id.review').required_scopes, ['workflow:write', 'approval:decide']);
  assert.deepEqual(byId.get('aiws.github.post.workstreams.by-id.delivery-policies').required_scopes, ['github:write', 'approval:decide']);
  assert.deepEqual(byId.get('aiws.admin.post.workflow-migrations.batches.by-id.approve').required_scopes, ['setup:admin']);

  const unknown = await executeRegistryOperation(registry, 'aiws.workflow.post.unregistered-side-effect', {}, { client: { id: 'client', scopes: ['workflow:write'], project_allowlist: [] } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.error.error, 'mcp_operation_not_found');

  console.log('V1.9 MCP route registry unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
