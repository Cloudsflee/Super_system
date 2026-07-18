import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-codex-mcp-'));
process.env.AIWS_HOME = path.join(root, 'home');
process.env.AIWS_INTERNAL_MCP_URL = 'http://127.0.0.1:4999/api/mcp';

try {
  const state = await import('../../apps/api/src/state.mjs');
  const clients = await import('../../apps/api/src/mcp-client-service.mjs');
  const runtime = await import('../../apps/api/src/codex-mcp-runtime.mjs');
  const codex = await import('../../apps/api/src/codex-service.mjs');
  const appServer = await import('../../apps/api/src/codex-app-server.mjs');
  const shared = await import('../../packages/shared/index.mjs');
  await state.ensureRuntime();
  const workspace = path.join(root, 'workspace'), codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(codexHome, { recursive: true });
  await state.mutate((data) => {
    data.projects.push({ id: 'project-codex-mcp', title: 'Codex MCP', status: 'active', repo_path: workspace, workspace_root: workspace, settings: {}, lifecycle_operation: null });
    data.codex_profiles.push({ id: 'profile-conflict', name: 'Conflict', provider: 'openai', model: 'gpt-test', reasoning: 'high', kind: 'host', status: 'disabled', mcp_servers: [{ name: 'aiws-built-in', command: 'node', args: ['external.mjs'] }] });
  });
  await state.ensureRuntime();
  assert.equal((await state.readState()).codex_profiles.find((item) => item.id === 'profile-conflict').mcp_servers[0].name, 'aiws-built-in-external');

  const profile = { id: 'profile-host', kind: 'host', codex_home: codexHome, model: 'gpt-test', reasoning: 'high', timeout_ms: 120000 };
  const access = await runtime.issueCodexMcpAccess('project-codex-mcp', profile, { ttlSeconds: 600 });
  assert.match(access.env.AIWS_MCP_TOKEN, /^aiws_mcp_/);
  assert.equal(access.configArgs.join(' ').includes(access.env.AIWS_MCP_TOKEN), false);
  assert.equal(access.configArgs.join(' ').includes('bearer_token_env_var'), true);
  const stored = (await state.readState()).mcp_clients.find((item) => item.id === access.client_id);
  for (const forbidden of ['approval:decide', 'setup:admin', 'mcp:admin', 'destructive:execute', 'github:write']) assert.equal(stored.scopes.includes(forbidden), false);

  const hostInvocation = appServer.appServerInvocation(profile, workspace, 'read-only', '', [], access);
  assert.equal(hostInvocation.env.AIWS_MCP_TOKEN, access.env.AIWS_MCP_TOKEN);
  assert.equal(hostInvocation.args.join(' ').includes(access.env.AIWS_MCP_TOKEN), false);
  assert.equal(hostInvocation.args.join(' ').includes('mcp_servers.aiws-built-in.url'), true);

  const dockerProfile = { ...profile, id: 'profile-docker', kind: 'docker', image: 'aiws-codex-runner:1.8.0-codex-0.144.0' };
  const dockerAccess = await runtime.issueCodexMcpAccess('project-codex-mcp', dockerProfile, { ttlSeconds: 600 });
  const dockerInvocation = appServer.appServerInvocation(dockerProfile, workspace, 'read-only', '', [], dockerAccess);
  assert.equal(dockerInvocation.args.includes('AIWS_MCP_TOKEN'), true);
  assert.equal(dockerInvocation.args.join(' ').includes(dockerAccess.env.AIWS_MCP_TOKEN), false);
  assert.equal(shared.maskSecret(dockerAccess.env.AIWS_MCP_TOKEN), '***MASKED_MCP_TOKEN***');

  const validationState = await state.readState();
  const validated = codex.validateProfileInput(validationState, { name: 'Reserved', provider: 'openai', model: 'gpt-test', reasoning: 'high', timeout_ms: 120000, mounts: [], mcp_servers: [{ name: 'aiws-built-in', command: 'node', args: ['external.mjs'] }] });
  assert.equal(validated.errors.includes('mcp_reserved_name_conflict:aiws-built-in'), true);

  await access.release(); await dockerAccess.release();
  await assert.rejects(() => clients.authenticateMcpToken(access.env.AIWS_MCP_TOKEN), (error) => error.payload?.error === 'mcp_client_revoked');
  console.log('V1.8 Codex MCP injection unit tests passed');
} finally {
  delete process.env.AIWS_INTERNAL_MCP_URL;
  fs.rmSync(root, { recursive: true, force: true });
}
