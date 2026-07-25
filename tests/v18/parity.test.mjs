import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { callOperation, createMcpTestFixture, resultData } from './mcp-test-helpers.mjs';

const fixture = await createMcpTestFixture('aiws-v18-parity-');
let connection;
try {
  connection = await fixture.connect();
  const { apiRoutes } = await import('../../apps/api/src/api-routes.mjs');
  const { createApiRouteRegistry } = await import('../../apps/api/src/api-route-registry.mjs');
  const registry = createApiRouteRegistry(apiRoutes);
  assert.equal(
    registry
      .filter((item) => item.callable)
      .every(
        (item) =>
          item.handler ===
          apiRoutes.find((route) => route.method === item.method && route.pattern === item.pattern)?.handler
      ),
    true
  );

  const httpHealthResponse = await fetch(`${fixture.baseUrl}/api/health`);
  const httpHealth = await httpHealthResponse.json();
  const mcpHealth = resultData(await callOperation(connection.client, 'aiws.system.get.health'));
  for (const key of ['status', 'version', 'schema_version']) assert.deepEqual(mcpHealth[key], httpHealth[key], key);

  const httpCreateResponse = await fetch(`${fixture.baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'HTTP parity project', goal: 'HTTP baseline' })
  });
  const httpCreated = await httpCreateResponse.json();
  const persisted = await fixture.stateApi.readState();
  const persistedClient = persisted.mcp_clients.find((item) => item.id === fixture.operator.client.id);
  assert.ok(persistedClient, 'HTTP mutations retain MCP clients');
  assert.equal(
    persistedClient.token_hash,
    createHash('sha256').update(fixture.operator.token).digest('hex'),
    'HTTP mutations retain the MCP token hash'
  );
  const mcpResult = await callOperation(connection.client, 'aiws.projects.post.projects', {
    body: { title: 'MCP parity project', goal: 'MCP baseline' }
  });
  const mcpCreated = resultData(mcpResult);
  assert.equal(mcpResult.status, httpCreateResponse.status);
  assert.deepEqual(Object.keys(mcpCreated).sort(), Object.keys(httpCreated).sort());
  assert.deepEqual(Object.keys(mcpCreated.project).sort(), Object.keys(httpCreated.project).sort());

  const httpMissingResponse = await fetch(`${fixture.baseUrl}/api/projects/missing`);
  const httpMissing = await httpMissingResponse.json();
  const mcpMissing = await callOperation(
    connection.client,
    'aiws.projects.get.projects.by-id',
    { params: { id: 'missing' } },
    { ok: false }
  );
  assert.equal(mcpMissing.status, httpMissingResponse.status);
  assert.equal(mcpMissing.error.error, httpMissing.error);

  const listed = resultData(await callOperation(connection.client, 'aiws.projects.get.projects'));
  assert.equal(
    listed.some((item) => item.id === httpCreated.project.id),
    true
  );
  assert.equal(
    listed.some((item) => item.id === mcpCreated.project.id),
    true
  );
  console.log('V1.8 HTTP/MCP parity tests passed');
} finally {
  await connection?.close();
  await fixture.close();
}
