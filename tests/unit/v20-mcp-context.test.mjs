import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v20-mcp-context-'));
process.env.AIWS_HOME = path.join(root, 'home');
process.env.NODE_ENV = 'test';

try {
  const { apiRoutes } = await import('../../apps/api/src/api-routes.mjs');
  const { createApiRouteRegistry, executeRegistryOperation } =
    await import('../../apps/api/src/api-route-registry.mjs');
  const { createAiwsMcpServer } = await import('../../apps/api/src/mcp-server-factory.mjs');
  const stateApi = await import('../../apps/api/src/state.mjs');
  await stateApi.ensureRuntime();
  const state = await stateApi.readState();
  const registry = createApiRouteRegistry(apiRoutes);
  const operations = new Map(registry.map((item) => [item.operation_id, item]));
  const expected = [
    'aiws.context.get.context.v1.map',
    'aiws.context.post.context.v1.search',
    'aiws.context.get.context.v1.nodes.by-id',
    'aiws.context.post.context.v1.selections',
    'aiws.context.get.context.v1.selections.by-id',
    'aiws.context.get.context.v1.policy',
    'aiws.context.put.context.v1.policy',
    'aiws.context.get.context.v1.status',
    'aiws.context.post.context.v1.rebuild'
  ];
  for (const operationId of expected) assert.ok(operations.has(operationId), operationId);
  assert.deepEqual(operations.get('aiws.context.get.context.v1.map').required_scopes, ['context:read']);
  assert.deepEqual(operations.get('aiws.context.post.context.v1.rebuild').required_scopes, ['context:admin']);

  const client = {
    id: 'mcp-context-client',
    subject_user_id: state.instance_owner_user_id,
    scopes: ['context:read', 'context:admin'],
    project_allowlist: []
  };
  const built = createAiwsMcpServer({ registry, client });
  try {
    assert.ok(built.server._registeredTools.aiws_context);
    assert.deepEqual(
      Object.keys(built.server._registeredResourceTemplates)
        .filter((name) => name.startsWith('aiws-context-'))
        .sort(),
      ['aiws-context-map', 'aiws-context-node', 'aiws-context-selection']
    );

    const toolMap = payload(
      await built.server._registeredTools.aiws_context.handler({ action: 'map', depth: 2, limit: 100 })
    );
    assert.equal(toolMap.ok, true);
    assert.equal(toolMap.data.uri, 'aiws://context/map/global');
    const rootNode = toolMap.data.nodes.find((node) => node.id === 'ctx_root_system');

    const toolRead = payload(
      await built.server._registeredTools.aiws_context.handler({ action: 'read', node_id: rootNode.id })
    );
    assert.equal(toolRead.ok, true);
    assert.equal(toolRead.data.node.id, rootNode.id);

    const resource = await built.server._registeredResourceTemplates['aiws-context-map'].readCallback(
      new URL('aiws://context/map/global'),
      { scope: 'global' }
    );
    const resourceMap = JSON.parse(resource.contents[0].text);
    assert.equal(resourceMap.ok, true);
    assert.equal(resourceMap.data.snapshot_hash, toolMap.data.snapshot_hash);

    const selection = await executeRegistryOperation(
      registry,
      'aiws.context.post.context.v1.selections',
      { body: { candidate_node_ids: [rootNode.id], token_budget: 10_000 } },
      { client }
    );
    assert.equal(selection.ok, true);
    const explained = payload(
      await built.server._registeredTools.aiws_context.handler({
        action: 'explain_selection',
        selection_id: selection.data.id
      })
    );
    assert.equal(explained.ok, true);
    assert.equal(explained.data.id, selection.data.id);
  } finally {
    await built.dispose();
  }

  console.log('V2.0 MCP context tool and resource parity tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function payload(result) {
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
}
