import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function createMcpTestFixture(
  prefix,
  { operator = {}, approver = null, env = {}, seed = null, nodeArgs = [] } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const ccSwitch = path.join(root, 'cc-switch');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ccSwitch, { recursive: true });

  const previousEnvironment = new Map();
  const fixtureEnvironment = {
    AIWS_HOME: home,
    CC_SWITCH_CONFIG_DIR: ccSwitch,
    NODE_ENV: 'test',
    AIWS_BYPASS_SETUP: '1',
    AIWS_TEST_DISABLE_CONTEXT_PROJECTOR: '1',
    ...env
  };
  for (const [key, value] of Object.entries(fixtureEnvironment)) {
    previousEnvironment.set(key, process.env[key]);
    process.env[key] = String(value);
  }

  const stateApi = await import('../../apps/api/src/state.mjs');
  const clientApi = await import('../../apps/api/src/mcp-client-service.mjs');
  await stateApi.ensureRuntime();
  await seed?.({ root, home, ccSwitch, stateApi, clientApi });
  const owner = (await stateApi.readState()).users.find((item) => item.role === 'owner');
  const operatorCreated = await clientApi.createMcpClient(
    {
      name: 'V1.8 test operator',
      scopes: clientApi.DEFAULT_OPERATOR_SCOPES,
      ttl_seconds: 3600,
      concurrent_limit: 8,
      rate_limit_per_minute: 1200,
      ...operator
    },
    owner?.id || null
  );
  const approverCreated =
    approver === null
      ? null
      : await clientApi.createMcpClient(
          {
            name: 'V1.8 test approver',
            scopes: [
              'system:read',
              'project:read',
              'workflow:read',
              'governance:read',
              'approval:read',
              'approval:decide'
            ],
            ttl_seconds: 3600,
            concurrent_limit: 4,
            rate_limit_per_minute: 600,
            ...approver
          },
          owner?.id || null
        );

  const port = await freePort();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requests.push({
      method: String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase(),
      url: url.href,
      pathname: url.pathname
    });
    return originalFetch(input, init);
  };

  let child = startApiChild();
  let logs = '';
  captureLogs(child);
  const connections = new Set();

  try {
    await waitForHealth(port, child, () => logs);
  } catch (error) {
    await stopChild(child);
    globalThis.fetch = originalFetch;
    restoreEnvironment(previousEnvironment);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    home,
    ccSwitch,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get child() {
      return child;
    },
    operator: operatorCreated,
    approver: approverCreated,
    stateApi,
    clientApi,
    logs: () => logs,
    async connect(created = operatorCreated, name = 'v18-test-client') {
      const client = new Client({ name, version: '1.8.0' }, { capabilities: { resources: { subscribe: true } } });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${created.token}` } }
      });
      await client.connect(transport);
      const connection = {
        client,
        transport,
        async close() {
          connections.delete(connection);
          await transport.terminateSession().catch(() => undefined);
          await client.close().catch(() => undefined);
        }
      };
      connections.add(connection);
      return connection;
    },
    assertMcpOnlyHttp() {
      const unexpected = requests.filter((item) => !['/api/health', '/api/mcp'].includes(item.pathname));
      assert.deepEqual(unexpected, [], `non-MCP HTTP requests detected: ${JSON.stringify(unexpected)}`);
    },
    async stopServer() {
      await stopChild(child);
    },
    async restartServer() {
      for (const connection of [...connections]) await connection.close();
      await stopChild(child);
      child = startApiChild();
      captureLogs(child);
      await waitForHealth(port, child, () => logs);
      return child;
    },
    async close({ remove = true } = {}) {
      for (const connection of [...connections]) await connection.close();
      await stopChild(child);
      globalThis.fetch = originalFetch;
      restoreEnvironment(previousEnvironment);
      if (remove) fs.rmSync(root, { recursive: true, force: true });
    }
  };

  function startApiChild() {
    return spawn(process.execPath, [...nodeArgs, 'apps/api/server.mjs'], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...fixtureEnvironment, AIWS_PORT: String(port) }
    });
  }

  function captureLogs(processHandle) {
    processHandle.stdout.on('data', (chunk) => {
      logs += chunk;
    });
    processHandle.stderr.on('data', (chunk) => {
      logs += chunk;
    });
  }
}

export async function callOperation(client, operationId, args = {}, { ok = true } = {}) {
  return callTool(client, toolForOperation(operationId), { action: operationId, arguments: args }, { ok });
}

export async function callTool(client, name, args, { ok = true } = {}) {
  const response = await client.callTool({ name, arguments: args });
  const result =
    response.structuredContent || JSON.parse(response.content?.find((item) => item.type === 'text')?.text || '{}');
  assert.equal(result.ok, ok, `${name}: ${JSON.stringify(result)}`);
  assert.equal(response.isError === true, !ok, `${name} isError`);
  return result;
}

export function resultData(result) {
  return result.handle?.data ?? result.data;
}

export async function seedHostCodexProfile({ home, stateApi }) {
  const codexHome = path.join(home, 'codex-homes', 'v18-test-host');
  const vault = path.join(home, 'vault');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'v18_test_credential.secret'), 'v18-terminal-secret', 'utf8');
  await stateApi.mutate((state) => {
    for (const profile of state.codex_profiles) profile.is_active = false;
    state.codex_profiles.push({
      id: 'cdx_v18_test_host',
      name: 'V1.8 Test Host',
      kind: 'host',
      provider: 'openai',
      model: 'test-model',
      reasoning: 'medium',
      status: 'validated',
      is_active: true,
      codex_home: codexHome,
      mounts: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    state.integration_statuses = state.integration_statuses.filter((item) => item.key !== 'codex_auth');
    state.integration_statuses.push({
      key: 'codex_auth',
      status: 'authenticated',
      provider: 'openai',
      auth_mode: 'api_key',
      refs: { credential: 'vault:v18_test_credential' },
      updated_at: new Date().toISOString()
    });
  });
}

export async function waitFor(predicate, { timeout = 15_000, interval = 50, message = 'condition timed out' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

function toolForOperation(operationId) {
  const domain = String(operationId).split('.')[1];
  if (!domain) throw new Error(`invalid_operation_id:${operationId}`);
  return `aiws_${domain}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForHealth(port, child, getLogs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`API exited ${child.exitCode}: ${getLogs()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`API startup timed out: ${getLogs()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

function restoreEnvironment(previous) {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
