import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, mutate, request } from '../integration/helpers.mjs';

function mcp(base, token, body, key) {
  return request(base, '/api/v1/mcp', { method: 'POST', key, headers: { 'x-aiws-mcp-token': token }, body });
}

test('R5 Context and MCP enforce project, path, scope, expiry, and redaction boundaries', async () => {
  const env = await fixture();
  try {
    const first = await mutate(env.base, '/api/v1/projects', { name: 'R5 boundary A' }, 'r5-boundary-a');
    const second = await mutate(env.base, '/api/v1/projects', { name: 'R5 boundary B' }, 'r5-boundary-b');
    const traversal = await mutate(env.base, `/api/v1/projects/${first.json.id}/context/sources`, { kind: 'file', path: '../host.txt', title: 'invalid', content: 'no' }, 'r5-context-traversal');
    assert.equal(traversal.response.status, 400);

    const bodyMarker = 'saffron quartz confidential body';
    const source = await mutate(env.base, `/api/v1/projects/${first.json.id}/context/sources`, { kind: 'note', title: 'Boundary signal', content: bodyMarker }, 'r5-boundary-source');
    const projection = await mutate(env.base, `/api/v1/projects/${first.json.id}/context/rebuild`, {}, 'r5-boundary-project');
    const node = projection.json.map.nodes.find((item) => item.source_id === source.json.id);
    assert.ok(node);
    const wrongProjectRead = await request(env.base, `/api/v1/projects/${second.json.id}/context/nodes/${node.id}`);
    assert.equal(wrongProjectRead.response.status, 404);
    const wrongProjectSelection = await mutate(env.base, `/api/v1/projects/${second.json.id}/context/selections`, { node_ids: [node.id] }, 'r5-boundary-selection');
    assert.equal(wrongProjectSelection.response.status, 422);

    const indexFile = path.join(env.home, 'context-index', `${encodeURIComponent(first.json.id)}.json`);
    const indexPayload = fs.readFileSync(indexFile, 'utf8');
    const mapPayload = JSON.stringify(projection.json.map);
    const events = await request(env.base, `/api/v1/projects/${first.json.id}/context/jobs/${projection.json.job.id}/events`);
    const audit = await request(env.base, '/api/v1/audit?limit=200');
    for (const serialized of [indexPayload, mapPayload, JSON.stringify(events.json), JSON.stringify(audit.json)]) {
      assert.equal(serialized.includes(bodyMarker), false);
      assert.equal(serialized.includes(env.home), false);
    }

    const client = await mutate(env.base, '/api/v1/mcp/clients', {
      name: 'R5 boundary client', transport: 'stdio', scope: { project_ids: [first.json.id], tools: ['context.map'] }, ttl_seconds: 3600
    }, 'r5-boundary-client');
    const token = client.json.token;
    const allowed = await mcp(env.base, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context.map', arguments: { project_id: first.json.id } } }, 'r5-boundary-allowed');
    assert.equal(allowed.response.status, 200);
    const denied = await mcp(env.base, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context.map', arguments: { project_id: second.json.id } } }, 'r5-boundary-denied');
    assert.equal(denied.response.status, 403);
    assert.equal(denied.json.error.code, 'mcp_scope_denied');
    await env.app.database.run('UPDATE mcp_clients SET expires_at=? WHERE id=?', ['2020-01-01T00:00:00.000Z', client.json.id]);
    const expired = await mcp(env.base, token, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, 'r5-boundary-expired');
    assert.equal(expired.response.status, 401);
    assert.equal(expired.json.error.code, 'mcp_token_invalid');

    const scopeRequest = await mutate(env.base, '/api/v1/mcp/scopes/requests', {
      project_id: first.json.id, scope: { project_ids: [first.json.id], tools: ['project.get'] }, ttl_seconds: 1800
    }, 'r5-boundary-scope-request');
    const escalated = await mutate(env.base, `/api/v1/mcp/scopes/requests/${scopeRequest.json.id}/grant`, {
      expected_revision: scopeRequest.json.revision, scope: { project_ids: [second.json.id], tools: ['project.get'] }
    }, 'r5-boundary-scope-escalation');
    assert.equal(escalated.response.status, 422);
    assert.equal(escalated.json.error.code, 'mcp_scope_escalation');
    const granted = await mutate(env.base, `/api/v1/mcp/scopes/requests/${scopeRequest.json.id}/grant`, { expected_revision: scopeRequest.json.revision }, 'r5-boundary-scope-grant');
    assert.equal(granted.response.status, 201);
    const publicRows = JSON.stringify(await env.app.domain.listMcpScopes(first.json.id));
    assert.equal(publicRows.includes(granted.json.token), false);
    assert.equal(publicRows.includes(token), false);
  } finally { await env.close(); }
});
