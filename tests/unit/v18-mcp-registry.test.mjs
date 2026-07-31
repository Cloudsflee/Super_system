import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-mcp-registry-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const { apiRoutes } = await import('../../apps/api/src/api-routes.mjs');
  const { createApiRouteRegistry, executeRegistryOperation } =
    await import('../../apps/api/src/api-route-registry.mjs');
  const { MCP_SCOPES } = await import('../../apps/api/src/mcp-client-service.mjs');
  const state = await import('../../apps/api/src/state.mjs');
  await state.ensureRuntime();
  const registry = createApiRouteRegistry(apiRoutes);
  assert.equal(registry.length >= 254, true);
  assert.ok(registry.filter((item) => item.source_module.includes('v19')).length >= 34);
  assert.equal(new Set(registry.map((item) => item.operation_id)).size, registry.length);
  const mappings = new Set(registry.map((item) => item.mapping));
  for (const mapping of ['async_adapter', 'external_callback', 'resource', 'tool'])
    assert.ok(mappings.has(mapping), `missing baseline mapping ${mapping}`);
  const scopes = new Set(MCP_SCOPES);
  for (const operation of registry) {
    for (const key of [
      'operation_id',
      'domain',
      'input_schema',
      'output_schema',
      'required_scopes',
      'risk',
      'idempotency',
      'mapping',
      'mcp_binding',
      'source_module'
    ])
      assert.notEqual(operation[key], undefined, `${operation.operation_id} ${key}`);
    for (const scope of operation.required_scopes)
      assert.equal(scopes.has(scope), true, `${operation.operation_id} unknown ${scope}`);
  }
  assert.equal(registry.find((item) => item.pattern === '/github/webhook').mapping, 'external_callback');
  const transports = registry.filter((item) => item.pattern === '/mcp');
  assert.equal(transports.length, 3);
  assert.equal(
    transports.every(
      (item) =>
        item.mapping === 'external_callback' &&
        item.callable === false &&
        item.protocol_reason === 'mcp_transport_endpoint'
    ),
    true
  );
  assert.equal(registry.find((item) => item.pattern === '/assist/v3/turns/:id/events').mapping, 'async_adapter');
  const client = { id: 'registry-client', scopes: ['system:read'], project_allowlist: [] };
  const health = await executeRegistryOperation(registry, 'aiws.system.get.health', {}, { client });
  assert.equal(health.ok, true);
  assert.ok(Number.isInteger(health.data.schema_version) && health.data.schema_version >= 17);
  const arbitrary = await executeRegistryOperation(
    registry,
    'aiws.system.get.health',
    { url: '/health', method: 'GET' },
    { client }
  );
  assert.equal(arbitrary.ok, false);
  assert.equal(arbitrary.error.error, 'mcp_operation_arguments_unknown');
  const denied = await executeRegistryOperation(registry, 'aiws.projects.get.projects', {}, { client });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  const recursive = await executeRegistryOperation(
    registry,
    transports.find((item) => item.method === 'POST').operation_id,
    { body: {} },
    { client: { ...client, scopes: [...client.scopes, 'mcp:admin'] } }
  );
  assert.equal(recursive.ok, false);
  assert.equal(recursive.error.error, 'mcp_operation_not_callable');
  const owner = (await state.readState()).users[0];
  await state.mutate((data) => {
    data.projects.push(
      {
        id: 'prj_allowed',
        title: 'Allowed',
        owner_user_id: owner.id,
        created_by_user_id: owner.id,
        status: 'active',
        deleted_at: null
      },
      {
        id: 'prj_denied',
        title: 'Denied',
        owner_user_id: owner.id,
        created_by_user_id: owner.id,
        status: 'active',
        deleted_at: null
      }
    );
    data.context_packs.push(
      { id: 'ctx_allowed', content_json: { project: { id: 'prj_allowed' } } },
      { id: 'ctx_denied', content_json: { project: { id: 'prj_denied' } } }
    );
  });
  const projectClient = {
    id: 'project-client',
    subject_user_id: owner.id,
    scopes: ['runs:read'],
    project_allowlist: ['prj_allowed']
  };
  const allowedContext = await executeRegistryOperation(
    registry,
    'aiws.runs.get.context-packs.by-id',
    { params: { id: 'ctx_allowed' } },
    { client: projectClient }
  );
  assert.equal(allowedContext.ok, true);
  const deniedContext = await executeRegistryOperation(
    registry,
    'aiws.runs.get.context-packs.by-id',
    { params: { id: 'ctx_denied' } },
    { client: projectClient }
  );
  assert.equal(deniedContext.ok, false);
  assert.equal(deniedContext.status, 403);
  console.log('V1.8 MCP registry unit tests passed');
} finally {
  await import('../../apps/api/src/state.mjs').then((state) => state.checkpointAndCloseState()).catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}
