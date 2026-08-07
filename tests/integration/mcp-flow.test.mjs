import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, mutate, request } from './helpers.mjs';

async function mcp(base, body, key) {
  return request(base, '/api/v1/mcp', {
    method: 'POST',
    key,
    body
  });
}

test('MCP tools use the same command registry as REST', async () => {
  const env = await fixture();
  try {
    const listed = await mcp(env.base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 'mcp-tools-list');
    assert.equal(listed.response.status, 200);
    assert.ok(listed.json.result.tools.some((tool) => tool.name === 'project.create'));
    const createCall = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'project.create', arguments: { name: 'MCP project', description: 'same registry' } } };
    const created = await mcp(env.base, createCall, 'mcp-project');
    assert.equal(created.response.status, 200);
    const structured = created.json.result.structuredContent;
    assert.match(structured.id, /^prj_/);
    const replay = await mcp(env.base, createCall, 'mcp-project');
    assert.equal(replay.response.status, 200);
    assert.equal(replay.json.result.structuredContent.id, structured.id);
    const conflict = await mcp(env.base, { ...createCall, params: { ...createCall.params, arguments: { name: 'different' } } }, 'mcp-project');
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.json.error.code, 'idempotency_conflict');

    const restGet = await request(env.base, `/api/v1/projects/${structured.id}`);
    const mcpGet = await mcp(env.base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project.get', arguments: { project_id: structured.id } } }, 'mcp-project-get');
    assert.equal(restGet.response.status, 200);
    assert.equal(mcpGet.response.status, 200);
    assert.deepEqual(mcpGet.json.result.structuredContent, restGet.json);

    const rest = await mutate(env.base, '/api/v1/projects', { name: 'REST project', description: 'same registry' }, 'rest-project');
    assert.equal(rest.response.status, 201);
    const restList = await request(env.base, '/api/v1/projects');
    const mcpList = await mcp(env.base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'projects.list', arguments: {} } }, 'mcp-project-list');
    assert.equal(restList.response.status, 200);
    assert.equal(mcpList.response.status, 200);
    assert.deepEqual(
      mcpList.json.result.structuredContent.map((project) => project.id).sort(),
      restList.json.map((project) => project.id).sort()
    );
    const audit = await request(env.base, `/api/v1/audit?limit=100`);
    const createdAudits = audit.json.filter((event) => event.action === 'project.created' && [structured.id, rest.json.id].includes(event.entity_id));
    assert.equal(createdAudits.length, 2);

    const unsupported = await mcp(env.base, { jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} }, 'mcp-unsupported');
    assert.equal(unsupported.response.status, 400);
    assert.equal(unsupported.json.error.code, 'invalid_input');
  } finally { await env.close(); }
});

test('MCP client tokens are hashed, scoped, and revoked', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'MCP scoped project' }, 'mcp-scope-project');
    assert.equal(project.response.status, 201);
    const invalidEndpoint = await mutate(env.base, '/api/v1/mcp/clients', { name: 'bad', transport: 'http', endpoint: 'http://example.test/mcp', scope: {} }, 'mcp-client-bad');
    assert.equal(invalidEndpoint.response.status, 422);
    const created = await mutate(env.base, '/api/v1/mcp/clients', { name: 'Scoped HTTP', transport: 'http', endpoint: 'http://127.0.0.1:9555/mcp', scope: { project_ids: [project.json.id] } }, 'mcp-client-create');
    assert.equal(created.response.status, 201);
    assert.match(created.json.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(created.json.scope.project_ids[0], project.json.id);
    const listed = await request(env.base, '/api/v1/mcp/clients');
    assert.equal(listed.json[0].token_hash, undefined);
    assert.equal(JSON.stringify(listed.json).includes(created.json.token), false);
    const tools = await request(env.base, '/api/v1/mcp/tools');
    assert.equal(tools.response.status, 200);
    assert.ok(tools.json.tools.some((tool) => tool.name === 'project.get'));

    const allowed = await request(env.base, '/api/v1/mcp', {
      method: 'POST', key: 'mcp-scoped-call', headers: { 'x-aiws-mcp-token': created.json.token },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'project.get', arguments: { project_id: project.json.id } } }
    });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.json.result.structuredContent.id, project.json.id);
    const denied = await request(env.base, '/api/v1/mcp', {
      method: 'POST', key: 'mcp-scoped-denied', headers: { 'x-aiws-mcp-token': created.json.token },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'projects.list', arguments: { project_id: 'prj_other' } } }
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.json.error.code, 'mcp_scope_denied');
    const revoked = await mutate(env.base, `/api/v1/mcp/clients/${created.json.id}/revoke`, {}, 'mcp-client-revoke');
    assert.equal(revoked.response.status, 201);
    assert.equal(revoked.json.status, 'revoked');
    const unauthorized = await request(env.base, '/api/v1/mcp', {
      method: 'POST', key: 'mcp-revoked-call', headers: { 'x-aiws-mcp-token': created.json.token },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'projects.list', arguments: {} } }
    });
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.json.error.code, 'mcp_token_invalid');
  } finally { await env.close(); }
});
