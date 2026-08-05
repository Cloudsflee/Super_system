import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AIWS_VERSION } from '../../packages/shared/src/version.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-mcp-gateway-'));
const home = path.join(root, 'home');
const secret = 'v18-integration-gateway-secret-minimum-32';
const corePort = await freePort(),
  gatewayPort = await freePort();
process.env.AIWS_HOME = home;

const stateApi = await import('../../apps/api/src/state.mjs');
const clientApi = await import('../../apps/api/src/mcp-client-service.mjs');
const { createDraftProjectRecords } = await import('../../apps/api/src/project-lifecycle.mjs');
await stateApi.ensureRuntime();
const owner = (await stateApi.readState()).users[0];
const member = {
  id: 'usr_gateway_member',
  display_name: 'Gateway Member',
  email: 'member@example.test',
  avatar_url: '',
  role: 'member',
  auth_mode: 'test',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};
const secondMember = {
  ...member,
  id: 'usr_gateway_reviewer',
  display_name: 'Gateway Reviewer',
  email: 'reviewer@example.test'
};
const firstProject = createDraftProjectRecords({ title: 'Member project', goal: 'First collaboration scope' }, owner);
const secondProject = createDraftProjectRecords(
  { title: 'Reviewer project', goal: 'Second collaboration scope' },
  owner
);
await stateApi.mutate((state) => {
  state.users.push(member, secondMember);
  for (const created of [firstProject, secondProject]) {
    state.projects.push(created.project);
    state.workspaces.push(created.workspace);
    state.project_intakes.push(created.intake);
    state.project_briefs.push(created.brief);
    state.workflow_drafts.push(created.workflowDraft);
    state.assist_sessions.push(created.session);
  }
});
const previousRemoteMode = process.env.AIWS_MCP_REMOTE_MODE;
process.env.AIWS_MCP_REMOTE_MODE = 'gateway';
let issued, secondIssued;
try {
  issued = await clientApi.createMcpClient(
    {
      name: 'Gateway member Codex',
      subject_user_id: member.id,
      scopes: ['system:read', 'project:read', 'assist:read', 'assist:write'],
      project_allowlist: [firstProject.project.id],
      ttl_seconds: 3600
    },
    owner.id
  );
  secondIssued = await clientApi.createMcpClient(
    {
      name: 'Gateway reviewer Codex',
      subject_user_id: secondMember.id,
      scopes: ['system:read', 'project:read', 'assist:read', 'assist:write'],
      project_allowlist: [secondProject.project.id],
      ttl_seconds: 3600
    },
    owner.id
  );
} finally {
  if (previousRemoteMode === undefined) delete process.env.AIWS_MCP_REMOTE_MODE;
  else process.env.AIWS_MCP_REMOTE_MODE = previousRemoteMode;
}

const core = start(['apps/api/server.mjs'], {
  AIWS_HOME: home,
  AIWS_PORT: String(corePort),
  AIWS_MCP_REMOTE_MODE: 'gateway',
  AIWS_MCP_GATEWAY_SECRET: secret
});
let gateway;
const connections = [];
try {
  await waitForHealth(`http://127.0.0.1:${corePort}/api/health`, core);
  gateway = start(['apps/mcp-gateway/server.mjs'], {
    AIWS_MCP_GATEWAY_HOST: '127.0.0.1',
    AIWS_MCP_GATEWAY_PORT: String(gatewayPort),
    AIWS_MCP_CORE_URL: `http://127.0.0.1:${corePort}/api/mcp`,
    AIWS_MCP_GATEWAY_SECRET: secret
  });
  await waitForHealth(`http://127.0.0.1:${gatewayPort}/health`, gateway);

  const connection = await connect(issued, 'team-member-codex');
  const secondConnection = await connect(secondIssued, 'team-reviewer-codex');
  connections.push(connection, secondConnection);
  const { client } = connection;
  assert.equal(client.getServerVersion().name, 'aiws-mcp-gateway');
  assert.equal(client.getServerVersion().version, AIWS_VERSION);
  assert.ok((await client.listTools()).tools.length >= 15);
  assert.equal(
    (await client.listResources()).resources.some((item) => item.uri === 'aiws://health'),
    true
  );

  const response = await client.callTool({
    name: 'aiws_assist',
    arguments: {
      action: 'aiws.assist.post.assist.v3.sessions',
      arguments: {
        body: {
          project_id: firstProject.project.id,
          scope_type: 'project',
          scope_id: firstProject.project.id,
          title: 'Member-owned MCP session'
        }
      }
    }
  });
  const result = response.structuredContent;
  assert.equal(result.ok, true, JSON.stringify(result));
  const secondResponse = await secondConnection.client.callTool({
    name: 'aiws_assist',
    arguments: {
      action: 'aiws.assist.post.assist.v3.sessions',
      arguments: {
        body: {
          project_id: secondProject.project.id,
          scope_type: 'project',
          scope_id: secondProject.project.id,
          title: 'Reviewer-owned MCP session'
        }
      }
    }
  });
  assert.equal(secondResponse.structuredContent.ok, true, JSON.stringify(secondResponse.structuredContent));
  const denied = await client.callTool({
    name: 'aiws_assist',
    arguments: {
      action: 'aiws.assist.post.assist.v3.sessions',
      arguments: {
        body: {
          project_id: secondProject.project.id,
          scope_type: 'project',
          scope_id: secondProject.project.id,
          title: 'Cross-project session'
        }
      }
    }
  });
  assert.equal(denied.structuredContent.ok, false);
  assert.equal(denied.structuredContent.error.error, 'mcp_project_access_denied');
  const state = await stateApi.readState();
  assert.equal(
    state.assist_sessions.find((item) => item.title === 'Member-owned MCP session').created_by_user_id,
    member.id
  );
  assert.equal(
    state.assist_sessions.find((item) => item.title === 'Reviewer-owned MCP session').created_by_user_id,
    secondMember.id
  );
  assert.equal(
    state.traces.some((item) => item.project_id === firstProject.project.id && item.actor_id === member.id),
    true
  );
  assert.equal(
    state.traces.some((item) => item.project_id === secondProject.project.id && item.actor_id === secondMember.id),
    true
  );
  assert.equal((await clientApi.authenticateMcpToken(issued.token)).subject_user_id, member.id);

  const health = await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json();
  assert.equal(health.version, AIWS_VERSION);
  assert.equal(health.active_sessions, 2);
  const invalidClient = new Client({ name: 'invalid-team-member', version: '1.0.0' }, { capabilities: {} });
  const invalidTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer aiws_mcp_invalid_invalid_invalid_invalid_invalid_invalid' } }
  });
  await assert.rejects(() => invalidClient.connect(invalidTransport));
  await invalidClient.close().catch(() => undefined);
  console.log('V1.8 collaborative MCP Gateway integration tests passed');
} finally {
  for (const connection of connections) {
    await connection.transport.terminateSession().catch(() => undefined);
    await connection.client.close().catch(() => undefined);
  }
  await stop(gateway);
  await stop(core);
  await import('../../apps/api/src/state.mjs').then((state) => state.checkpointAndCloseState()).catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

async function connect(created, name) {
  const client = new Client({ name, version: '1.0.0' }, { capabilities: { resources: { subscribe: true } } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${created.token}` } }
  });
  await client.connect(transport);
  return { client, transport };
}

function start(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  });
  child.logs = '';
  child.stdout.on('data', (chunk) => {
    child.logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    child.logs += chunk;
  });
  return child;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`process exited ${child.exitCode}: ${child.logs}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`health timeout: ${child.logs}`);
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

function freePort() {
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
