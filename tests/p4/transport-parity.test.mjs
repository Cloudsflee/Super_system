import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { close, closeServer, listen, open, project } from './helpers.mjs';

test('REST, MCP HTTP, stdio and Gateway share command schemas and normalized results', async () => {
  const state = await open();
  const network = await listen(state.runtime);
  try {
    const current = await project(state, 'transport');
    const createdClient = await state.runtime.mcp.createClient({
      name: 'Transport client', transport: 'stdio', ttl_seconds: 3600,
      scope: { project_ids: [current.id], tools: ['context_map', 'context_source_create'] },
      idempotency_key: 'p4-transport-client-key'
    }, state.principal);
    const cookie = `aiws_session=${encodeURIComponent(state.proof)}`;
    const restMap = await json(`${network.base}/api/v2/projects/${current.id}/context/map`, { headers: { cookie } });
    assert.equal(restMap.status, 200);

    const session = {};
    const initialized = await rpc(network.base, createdClient.token, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p4-parity', version: '1' } }, session);
    assert.equal(initialized.payload.result.protocolVersion, '2025-06-18');
    const mcpMap = await rpc(network.base, createdClient.token, 2, 'tools/call', { name: 'context_map', arguments: { project_id: current.id } }, session);
    assert.equal(mcpMap.payload.result.command_id, 'context.map');
    assert.deepEqual(mcpMap.payload.result.structuredContent, restMap.payload.data);

    const stdio = await stdioRpc(network.base, createdClient.token, [
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p4-stdio-parity', version: '1' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'context_map', arguments: { project_id: current.id } } }
    ]);
    assert.equal(stdio[0].result.protocolVersion, '2025-06-18');
    assert.deepEqual(stdio[1].result.tools, (await rpc(network.base, createdClient.token, 5, 'tools/list', {}, session)).payload.result.tools);
    assert.deepEqual(stdio[2].result.structuredContent, restMap.payload.data);

    const gatewayBody = { name: 'context_map', arguments: { project_id: current.id }, mcp_token: createdClient.token };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'p4-transport-gateway-nonce';
    const gateway = await json(`${network.base}/api/v2/gateway/forward`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-AIWS-Gateway-Id': 'gateway-parity',
        'X-AIWS-Gateway-Timestamp': timestamp,
        'X-AIWS-Gateway-Nonce': nonce,
        'X-AIWS-Gateway-Signature': state.runtime.gateway.sign({ timestamp, nonce, body: gatewayBody })
      },
      body: JSON.stringify(gatewayBody)
    });
    assert.equal(gateway.status, 200);
    assert.equal(gateway.payload.data.result.command_id, 'context.map');
    assert.deepEqual(gateway.payload.data.result.result, restMap.payload.data);

    const sourceInput = {
      project_id: current.id, kind: 'note', title: 'Parity source', uri: 'notes/parity', content: 'same receipt',
      expected_revision: 0, idempotency_key: 'p4-cross-transport-source'
    };
    const restCreated = await json(`${network.base}/api/v2/projects/${current.id}/context/sources`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'Idempotency-Key': sourceInput.idempotency_key, 'X-Expected-Revision': '0' },
      body: JSON.stringify({ kind: sourceInput.kind, title: sourceInput.title, uri: sourceInput.uri, content: sourceInput.content })
    });
    assert.equal(restCreated.status, 201);
    const mcpReplay = await rpc(network.base, createdClient.token, 6, 'tools/call', { name: 'context_source_create', arguments: sourceInput }, session);
    assert.equal(mcpReplay.payload.result.structuredContent.replayed, true);
    assert.equal(mcpReplay.payload.result.structuredContent.source.id, restCreated.payload.data.source.id);
    assert.equal(mcpReplay.payload.result.structuredContent.operation.operation_id, restCreated.payload.data.operation.operation_id);

    const inventory = state.runtime.dispatcher.inventory();
    assert.equal(new Set(inventory.map((entry) => entry.command_id)).size, inventory.length);
    assert.equal(state.runtime.dispatcher.tools().every((tool) => inventory.some((entry) => entry.command_id === tool.command_id && entry.exposed)), true);
  } finally {
    await closeServer(network.server);
    await close(state);
  }
});

async function rpc(base, token, id, method, params, session = {}) {
  const result = await json(`${base}/api/v2/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-AIWS-MCP-Token': token, 'MCP-Protocol-Version': '2025-06-18', ...(session.id ? { 'MCP-Session-Id': session.id } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  session.id = result.headers.get('mcp-session-id') || session.id;
  return result;
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { status: response.status, headers: response.headers, payload: await response.json() };
}

function stdioRpc(base, token, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/mcp-stdio.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, AIWS_MCP_URL: `${base}/api/v2/mcp`, AIWS_MCP_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status !== 0) return reject(new Error(`stdio_exit_${status}:${stderr}`));
      try { resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))); }
      catch (error) { reject(error); }
    });
    child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  });
}
