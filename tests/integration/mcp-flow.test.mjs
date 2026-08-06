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
