import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, mutate, request } from './helpers.mjs';

test('MCP tools use the same command registry as REST', async () => {
  const env = await fixture();
  try {
    const listed = await request(env.base, '/api/v1/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
    assert.equal(listed.response.status, 200);
    assert.ok(listed.json.result.tools.some((tool) => tool.name === 'project.create'));
    const created = await request(env.base, '/api/v1/mcp', { method: 'POST', key: 'mcp-project', body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'project.create', arguments: { name: 'MCP project' } } } });
    assert.equal(created.response.status, 200);
    const structured = created.json.result.structuredContent;
    assert.match(structured.id, /^prj_/);
    const rest = await mutate(env.base, '/api/v1/projects', { name: 'REST project' }, 'rest-project');
    assert.equal(rest.response.status, 201);
  } finally { await env.close(); }
});
