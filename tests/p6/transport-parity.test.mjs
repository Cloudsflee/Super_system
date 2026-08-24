import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { close, closeServer, listen, open, prepare } from './helpers.mjs';

test('P6 REST, MCP HTTP, stdio and Gateway share Execution schemas and receipts', async () => {
  const state = await open();
  const fixture = await prepare(state, 'transport-parity');
  const network = await listen(state.runtime);
  try {
    const tools = ['execution_list', 'execution_create', 'execution_get'];
    const client = await state.runtime.mcp.createClient({
      name: 'P6 transport client', transport: 'stdio', ttl_seconds: 3600,
      scope: { project_ids: [fixture.project.id], tools },
      idempotency_key: 'p6-transport-client-key'
    }, state.principal);
    const cookie = `aiws_session=${encodeURIComponent(state.proof)}`;
    const restList = await json(`${network.base}/api/v2/projects/${fixture.project.id}/executions`, { headers: { cookie } });
    assert.equal(restList.status, 200);

    const session = {};
    const initialized = await rpc(network.base, client.token, 1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p6-parity', version: '1' }
    }, session);
    assert.equal(initialized.payload.result.protocolVersion, '2025-06-18');
    const mcpList = await rpc(network.base, client.token, 2, 'tools/call', {
      name: 'execution_list', arguments: { project_id: fixture.project.id }
    }, session);
    assert.equal(mcpList.payload.result.command_id, 'execution.list');
    assert.deepEqual(mcpList.payload.result.structuredContent, restList.payload.data);

    const stdio = await stdioRpc(network.base, client.token, [
      { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p6-stdio-parity', version: '1' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'execution_get', arguments: { execution_id: fixture.execution.id } } }
    ]);
    assert.equal(stdio[0].result.protocolVersion, '2025-06-18');
    assert.equal(stdio[1].result.command_id, 'execution.get');
    assert.equal(stdio[1].result.structuredContent.execution.id, fixture.execution.id);

    const gatewayBody = { name: 'execution_get', arguments: { execution_id: fixture.execution.id }, mcp_token: client.token };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'p6-transport-gateway-nonce';
    const gateway = await json(`${network.base}/api/v2/gateway/forward`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-AIWS-Gateway-Id': 'gateway-p6-parity',
        'X-AIWS-Gateway-Timestamp': timestamp,
        'X-AIWS-Gateway-Nonce': nonce,
        'X-AIWS-Gateway-Signature': state.runtime.gateway.sign({ timestamp, nonce, body: gatewayBody })
      },
      body: JSON.stringify(gatewayBody)
    });
    assert.equal(gateway.status, 200);
    assert.equal(gateway.payload.data.result.command_id, 'execution.get');
    assert.equal(gateway.payload.data.result.result.execution.id, fixture.execution.id);

    const project = state.runtime.db.get('SELECT revision FROM projects WHERE id=?', [fixture.project.id]);
    const createInput = {
      project_id: fixture.project.id,
      repository_workspace_id: fixture.workspace.id,
      context_pack_id: fixture.pack.id,
      runner_profile_id: fixture.profile.id,
      tasks: [{ id: 'parity_read', mode: 'read', depends_on: [], input_paths: ['README.md'], output_paths: [], check_ids: [] }],
      expected_revision: Number(project.revision),
      idempotency_key: 'p6-cross-transport-execution'
    };
    const restCreated = await json(`${network.base}/api/v2/projects/${fixture.project.id}/executions`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'Idempotency-Key': createInput.idempotency_key, 'X-Expected-Revision': String(createInput.expected_revision) },
      body: JSON.stringify({
        repository_workspace_id: createInput.repository_workspace_id,
        context_pack_id: createInput.context_pack_id,
        runner_profile_id: createInput.runner_profile_id,
        tasks: createInput.tasks
      })
    });
    assert.equal(restCreated.status, 201);
    const mcpReplay = await rpc(network.base, client.token, 5, 'tools/call', { name: 'execution_create', arguments: createInput }, session);
    assert.equal(mcpReplay.payload.result.structuredContent.replayed, true);
    assert.equal(mcpReplay.payload.result.structuredContent.execution.id, restCreated.payload.data.execution.id);
    assert.equal(mcpReplay.payload.result.structuredContent.operation.operation_id, restCreated.payload.data.operation.operation_id);
  } finally {
    await closeServer(network.server);
    await close(state);
  }
});

async function rpc(base, token, id, method, params, session = {}) {
  const result = await json(`${base}/api/v2/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'X-AIWS-MCP-Token': token, 'MCP-Protocol-Version': '2025-06-18',
      ...(session.id ? { 'MCP-Session-Id': session.id } : {})
    },
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
      cwd: process.cwd(), env: { ...process.env, AIWS_MCP_URL: `${base}/api/v2/mcp`, AIWS_MCP_TOKEN: token },
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
