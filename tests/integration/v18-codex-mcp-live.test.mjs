import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callOperation, callTool, resultData } from '../v18/mcp-test-helpers.mjs';

if (process.env.RUN_V18_MCP_LIVE_TESTS !== '1') {
  console.log('V1.8 Codex MCP live test blocked; set RUN_V18_MCP_LIVE_TESTS=1');
  process.exit(2);
}

assert.equal(process.env.AIWS_TEST_CODEX_CONFIRM, 'dedicated-read-only');
const baseUrl = normalizedBaseUrl(process.env.AIWS_TEST_LIVE_BASE_URL);
const token = String(process.env.AIWS_TEST_MCP_TOKEN || '');
const projectId = String(process.env.AIWS_TEST_MCP_PROJECT_ID || '');
assert.match(token, /^aiws_mcp_/);
assert.ok(projectId);

const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  requests.push(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname);
  return originalFetch(input, init);
};
const client = new Client({ name: 'v18-codex-live', version: '1.8.0' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseUrl), {
  requestInit: { headers: { authorization: `Bearer ${token}` } }
});
let liveSessionId = null;
let liveTurnId = null;

try {
  await client.connect(transport);
  const before = resultData(
    await callOperation(client, 'aiws.files.get.projects.by-id.files.diff', { params: { id: projectId }, query: {} })
  );
  const session = resultData(
    await callOperation(client, 'aiws.assist.post.assist.v3.sessions', {
      body: { project_id: projectId, scope_type: 'project', scope_id: projectId, title: 'V1.8 live read-only audit' }
    })
  );
  liveSessionId = session.id;
  const turn = await callOperation(client, 'aiws.assist.post.assist.v3.sessions.by-id.turns', {
    params: { id: session.id },
    body: {
      collaboration_mode: 'plan',
      content:
        'Inspect this project through the built-in MCP server. Run no writes. Summarize package structure and the most relevant test command.'
    }
  });
  liveTurnId = turn.handle.id;
  let operation;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    operation = (
      await callTool(client, 'aiws_operations', {
        action: 'wait',
        operation_id: turn.handle.id,
        timeout_ms: 30000,
        poll_ms: 500
      })
    ).data.operation;
    if (operation.terminal) break;
  }
  assert.equal(operation?.status, 'completed');
  const events = await callTool(client, 'aiws_operations', {
    action: 'read_events',
    operation_id: turn.handle.id,
    limit: 500
  });
  assert.equal(events.data.items.length > 0, true);
  const after = resultData(
    await callOperation(client, 'aiws.files.get.projects.by-id.files.diff', { params: { id: projectId }, query: {} })
  );
  assert.equal(after.diff, before.diff, 'read-only live turn must not change the host workspace');
  await callOperation(client, 'aiws.assist.post.assist.v3.sessions.by-id.archive', {
    params: { id: session.id },
    body: {}
  });
  liveSessionId = null;
  liveTurnId = null;
  assert.equal(
    requests.every((pathname) => pathname === '/api/mcp'),
    true
  );
  console.log(`V1.8 real Codex MCP live test passed (project=${projectId}, turn=${turn.handle.id})`);
} finally {
  if (liveTurnId)
    await callOperation(client, 'aiws.assist.post.assist.v3.turns.by-id.stop', {
      params: { id: liveTurnId },
      body: { reason: 'live_test_cleanup' }
    }).catch(() => undefined);
  if (liveSessionId)
    await callOperation(client, 'aiws.assist.post.assist.v3.sessions.by-id.archive', {
      params: { id: liveSessionId },
      body: {}
    }).catch(() => undefined);
  await transport.terminateSession().catch(() => undefined);
  await client.close().catch(() => undefined);
  globalThis.fetch = originalFetch;
}

function normalizedBaseUrl(value) {
  const url = new URL(String(value || ''));
  assert.ok(['http:', 'https:'].includes(url.protocol));
  assert.equal(url.username || url.password, '');
  return url;
}
