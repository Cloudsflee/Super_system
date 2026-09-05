import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fixture, mutate, request } from './helpers.mjs';

function mcp(base, body, key, headers = {}) {
  return request(base, '/api/v1/mcp', { method: 'POST', key, headers, body });
}

function runBridge(base, token, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/mcp-stdio.mjs'], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, AIWS_MCP_URL: `${base}/api/v1/mcp`, AIWS_MCP_TOKEN: token }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => status === 0 ? resolve(stdout) : reject(new Error(`stdio_bridge_failed:${status}:${stderr}`)));
    child.stdin.end(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  });
}

test('R5 MCP Streamable HTTP and stdio bridge return equivalent tool schemas and structured reads', async () => {
  const env = await fixture();
  try {
    const project = await mutate(env.base, '/api/v1/projects', { name: 'R5 MCP transport' }, 'r5-mcp-project');
    const client = await mutate(env.base, '/api/v1/mcp/clients', {
      name: 'R5 stdio fixture', transport: 'stdio', scope: { project_ids: [project.json.id], tools: ['project.get'] }, ttl_seconds: 3600
    }, 'r5-mcp-client');
    assert.equal(client.response.status, 201);
    const token = client.json.token;
    const initialized = await mcp(env.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, 'r5-mcp-init');
    assert.equal(initialized.response.headers.get('mcp-protocol-version'), '2025-06-18');
    const listed = await mcp(env.base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'r5-mcp-list', { 'x-aiws-mcp-token': token });
    assert.deepEqual(listed.json.result.tools.map((tool) => tool.name), ['project.get']);
    const call = await mcp(env.base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project.get', arguments: { project_id: project.json.id } } }, 'r5-mcp-http-call', { 'x-aiws-mcp-token': token });
    assert.equal(call.response.status, 200);

    const lines = [
      { jsonrpc: '2.0', id: 11, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'r5-integration', version: '1' } } },
      { jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'project.get', arguments: { project_id: project.json.id } } }
    ];
    const bridgeOutput = await runBridge(env.base, token, lines);
    const responses = bridgeOutput.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(responses.length, 3);
    assert.equal(responses[0].result.protocolVersion, '2025-06-18');
    assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), listed.json.result.tools.map((tool) => tool.name));
    assert.deepEqual(responses[2].result.structuredContent, call.json.result.structuredContent);
    const clientRows = await request(env.base, '/api/v1/mcp/clients');
    assert.equal(JSON.stringify(clientRows.json).includes(token), false);
    assert.equal(JSON.stringify(clientRows.json).includes('token_hash'), false);
  } finally { await env.close(); }
});
