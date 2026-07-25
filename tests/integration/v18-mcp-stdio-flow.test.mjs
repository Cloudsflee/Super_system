import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-mcp-stdio-')),
  port = 4689;
const apiProcess = spawn(process.execPath, ['apps/api/server.mjs'], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AIWS_HOME: path.join(root, 'home'), AIWS_PORT: String(port), AIWS_BYPASS_SETUP: '1' }
});
let logs = '';
apiProcess.stdout.on('data', (chunk) => {
  logs += chunk;
});
apiProcess.stderr.on('data', (chunk) => {
  logs += chunk;
});

try {
  await waitForHealth();
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp/clients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'stdio contract', scopes: ['system:read'], ttl_seconds: 3600 })
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)])
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['scripts/mcp-stdio.mjs'],
    cwd: process.cwd(),
    env: { ...environment, AIWS_MCP_URL: `http://127.0.0.1:${port}/api/mcp`, AIWS_MCP_TOKEN: created.token },
    stderr: 'pipe'
  });
  let bridgeErrors = '';
  transport.stderr?.on('data', (chunk) => {
    bridgeErrors += chunk;
  });
  const client = new Client({ name: 'v18-stdio-contract', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 15);
  const result = await client.callTool({
    name: 'aiws_system',
    arguments: { action: 'aiws.system.get.health', arguments: {} }
  });
  assert.equal(result.structuredContent.ok, true);
  assert.ok(
    Number.isInteger(result.structuredContent.data.schema_version) && result.structuredContent.data.schema_version >= 17
  );
  await client.close();
  assert.equal(bridgeErrors.includes(created.token), false);
  console.log('V1.8 stdio MCP bridge contract tests passed');
} finally {
  apiProcess.kill();
  await Promise.race([
    new Promise((resolve) => apiProcess.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (apiProcess.exitCode == null) apiProcess.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
}

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode != null) throw new Error(`server exited ${apiProcess.exitCode}: ${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server startup timed out: ${logs}`);
}
