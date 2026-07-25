import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callOperation, callTool, createMcpTestFixture, resultData } from './mcp-test-helpers.mjs';

const fixture = await createMcpTestFixture('aiws-v18-fault-', {
  operator: { rate_limit_per_minute: 1200, concurrent_limit: 8 }
});
let connection;
try {
  connection = await fixture.connect();
  const created = resultData(
    await callOperation(connection.client, 'aiws.projects.post.projects', { body: { title: 'MCP fault recovery' } })
  );
  const turn = await callOperation(connection.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: created.assist_session.id },
    body: { adapter: 'test', content: 'timeout fixture', test_response: { delay_ms: 1000, message: 'late result' } }
  });
  const timed = await callTool(connection.client, 'aiws_operations', {
    action: 'wait',
    operation_id: turn.handle.id,
    timeout_ms: 1,
    poll_ms: 50
  });
  assert.equal(timed.data.timed_out, true);
  await callTool(connection.client, 'aiws_operations', {
    action: 'cancel',
    operation_id: turn.handle.id,
    reason: 'fault test cleanup'
  });

  const createdClient = await fetch(`${fixture.baseUrl}/api/mcp/clients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'one request client',
      scopes: ['system:read'],
      ttl_seconds: 3600,
      concurrent_limit: 1,
      rate_limit_per_minute: 1
    })
  });
  assert.equal(createdClient.status, 201);
  const rateLimited = await createdClient.json();
  const first = new Client({ name: 'rate-limit', version: '1.8.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${rateLimited.token}` } }
  });
  await assert.rejects(() => first.connect(transport), /429|rate|request/i);
  await first.close().catch(() => undefined);

  const persistedId = created.project.id;
  await connection.close();
  connection = null;
  await fixture.stopServer();
  const state = await fixture.stateApi.readState();
  assert.equal(
    state.projects.some((item) => item.id === persistedId),
    true
  );
  assert.equal(state.assist_turns.find((item) => item.id === turn.handle.id)?.status !== 'running', true);
  console.log('V1.8 MCP fault and cleanup tests passed');
} finally {
  await connection?.close();
  await fixture.close();
}
