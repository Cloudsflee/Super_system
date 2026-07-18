import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-mcp-http-')), port = 4688;
const child = spawn(process.execPath, ['apps/api/server.mjs'], {
  cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AIWS_HOME: path.join(root, 'home'), AIWS_PORT: String(port), AIWS_BYPASS_SETUP: '1', AIWS_PUBLIC_MCP_URL: 'https://mcp.team.example/mcp' }
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; });

try {
  await waitForHealth();
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/clients`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Contract operator', scopes: ['system:read', 'project:read'], ttl_seconds: 3600 })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json(); assert.match(created.token, /^aiws_mcp_/);
  assert.equal(created.configuration.streamable_http.url, 'https://mcp.team.example/mcp');
  assert.match(created.configuration.codex_toml, /https:\/\/mcp\.team\.example\/mcp/);

  const client = new Client({ name: 'v18-contract', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${created.token}` } } });
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'aiws-built-in');
  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 15); assert.equal(tools.tools.some((item) => item.name === 'aiws_execute'), true);
  const health = await client.callTool({ name: 'aiws_system', arguments: { action: 'aiws.system.get.health', arguments: {} } });
  assert.equal(health.structuredContent.ok, true); assert.ok(Number.isInteger(health.structuredContent.data.schema_version) && health.structuredContent.data.schema_version >= 17);
  const searched = await client.callTool({ name: 'aiws_capabilities', arguments: { action: 'search', query: 'health', limit: 5 } });
  assert.equal(searched.structuredContent.ok, true); assert.equal(searched.structuredContent.data.items.some((item) => item.operation_id === 'aiws.system.get.health'), true);
  const resources = await client.listResources();
  const templates = await client.listResourceTemplates();
  assert.equal(resources.resources.some((item) => item.uri === 'aiws://health'), true);
  assert.ok(templates.resourceTemplates.length > 0);
  assert.equal(templates.resourceTemplates.some((item) => item.uriTemplate === 'aiws://operations/{id}/events'), true);
  const read = await client.readResource({ uri: 'aiws://health' });
  assert.equal(JSON.parse(read.contents[0].text).ok, true);
  const invalidExecute = await client.callTool({ name: 'aiws_execute', arguments: { operation_id: 'aiws.system.get.health', arguments: {}, url: '/health' } });
  assert.equal(invalidExecute.isError, true);
  await transport.terminateSession();
  await client.close();

  const revoked = await fetch(`http://127.0.0.1:${port}/api/mcp/clients/${created.client.id}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  const rejectedClient = new Client({ name: 'v18-revoked', version: '1.0.0' }, { capabilities: {} });
  const rejectedTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${created.token}` } } });
  await assert.rejects(() => rejectedClient.connect(rejectedTransport));
  await rejectedClient.close().catch(() => undefined);
  console.log('V1.8 Streamable HTTP MCP contract tests passed');
} finally {
  child.kill(); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode == null) child.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${logs}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server startup timed out: ${logs}`);
}
