import assert from 'node:assert/strict';
import { callOperation, callTool, createMcpTestFixture, resultData } from '../v18/mcp-test-helpers.mjs';

const fixture = await createMcpTestFixture('aiws-v18-operations-');
let connection;
try {
  connection = await fixture.connect();
  const created = resultData(
    await callOperation(connection.client, 'aiws.projects.post.projects', {
      body: { title: 'MCP operations', goal: 'Exercise handles' }
    })
  );
  const projectId = created.project.id;

  const turnResult = await callOperation(connection.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: created.assist_session.id },
    body: {
      adapter: 'test',
      content: 'Complete through an MCP handle',
      collaboration_mode: 'default',
      test_response: { delay_ms: 100, message: 'operation complete' }
    }
  });
  assert.equal(turnResult.status, 202);
  assert.equal(turnResult.handle.type, 'operation');
  const turnId = turnResult.handle.id;
  const waited = await callTool(connection.client, 'aiws_operations', {
    action: 'wait',
    operation_id: turnId,
    timeout_ms: 5000,
    poll_ms: 50
  });
  assert.equal(waited.data.operation.terminal, true);
  assert.equal(waited.data.operation.status, 'completed');

  const firstEvents = await callTool(connection.client, 'aiws_operations', {
    action: 'read_events',
    operation_id: turnId,
    limit: 1
  });
  assert.equal(Array.isArray(firstEvents.data.items), true);
  const secondEvents = await callTool(connection.client, 'aiws_operations', {
    action: 'read_events',
    operation_id: turnId,
    cursor: firstEvents.data.cursor,
    limit: 100
  });
  assert.equal(Array.isArray(secondEvents.data.items), true);
  const resource = await connection.client.readResource({ uri: `aiws://operations/${turnId}/events` });
  assert.equal(JSON.parse(resource.contents[0].text).ok, true);

  const delayed = await callOperation(connection.client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: created.assist_session.id },
    body: { adapter: 'test', content: 'Cancel this operation', test_response: { delay_ms: 3000, message: 'too late' } }
  });
  const timeout = await callTool(connection.client, 'aiws_operations', {
    action: 'wait',
    operation_id: delayed.handle.id,
    timeout_ms: 0,
    poll_ms: 50
  });
  assert.equal(timeout.data.timed_out, true);
  const cancelled = await callTool(connection.client, 'aiws_operations', {
    action: 'cancel',
    operation_id: delayed.handle.id,
    reason: 'contract cancellation'
  });
  assert.equal(cancelled.status, 200);
  const cancelledWait = await callTool(connection.client, 'aiws_operations', {
    action: 'wait',
    operation_id: delayed.handle.id,
    timeout_ms: 5000,
    poll_ms: 50
  });
  assert.equal(['stopped', 'interrupted', 'cancelled'].includes(cancelledWait.data.operation.status), true);

  const badCursor = await callTool(
    connection.client,
    'aiws_operations',
    { action: 'read_events', operation_id: turnId, cursor: 'not-a-cursor' },
    { ok: false }
  );
  assert.equal(badCursor.error.error, 'mcp_cursor_invalid');
  console.log('V1.8 MCP operation handle tests passed');
} finally {
  await connection?.close();
  await fixture.close();
}
