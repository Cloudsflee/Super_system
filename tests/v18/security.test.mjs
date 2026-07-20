import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v18-security-'));
process.env.AIWS_HOME = path.join(root, 'home');

try {
  const state = await import('../../apps/api/src/state.mjs');
  const clients = await import('../../apps/api/src/mcp-client-service.mjs');
  const upload = await import('../../apps/api/src/mcp-upload-service.mjs');
  const { apiRoutes } = await import('../../apps/api/src/api-routes.mjs');
  const registryApi = await import('../../apps/api/src/api-route-registry.mjs');
  const shared = await import('../../packages/shared/index.mjs');
  await state.ensureRuntime();
  const repoA = path.join(root, 'home', 'workspaces', 'project-sec-a', 'repo'), repoB = path.join(root, 'home', 'workspaces', 'project-sec-b', 'repo');
  fs.mkdirSync(repoA, { recursive: true }); fs.mkdirSync(repoB, { recursive: true });
  await state.mutate((data) => {
    data.projects.push(
      { id: 'project-sec-a', title: 'A', status: 'active', onboarding_state: 'confirmed', managed_workspace_state: 'ready', repo_path: repoA, workspace_root: repoA, settings: {}, lifecycle_operation: null },
      { id: 'project-sec-b', title: 'B', status: 'active', onboarding_state: 'confirmed', managed_workspace_state: 'ready', repo_path: repoB, workspace_root: repoB, settings: {}, lifecycle_operation: null }
    );
  });
  const owner = (await state.readState()).users.find((item) => item.role === 'owner');
  await assert.rejects(() => clients.createMcpClient({ name: 'Bad scope', scopes: ['root:admin'] }), (error) => error.payload?.error === 'mcp_client_scope_invalid');
  const operatorCreated = await clients.createMcpClient({ name: 'Restricted', scopes: ['project:read', 'governance:write', 'files:write'], project_allowlist: ['project-sec-a'], ttl_seconds: 3600 }, owner.id);
  const operator = await clients.authenticateMcpToken(operatorCreated.token);
  assert.equal(shared.maskSecret(operatorCreated.token), '***MASKED_MCP_TOKEN***');
  await assert.rejects(() => upload.beginMcpUpload({ project_id: 'project-sec-b', path: 'x.txt', size_bytes: 0, sha256: createHash('sha256').update('').digest('hex') }, operator), (error) => error.payload?.error === 'mcp_project_access_denied');
  await assert.rejects(() => upload.beginMcpUpload({ project_id: 'project-sec-a', path: '../escape.txt', size_bytes: 0, sha256: createHash('sha256').update('').digest('hex') }, operator), (error) => error.payload?.error === 'mcp_upload_path_invalid');

  const bytes = Buffer.from('secure upload\n'), started = await upload.beginMcpUpload({ project_id: 'project-sec-a', path: 'secure.txt', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, operator);
  await assert.rejects(() => upload.appendMcpUploadChunk({ upload_id: started.id, sequence: 0, data_base64: Buffer.alloc(512 * 1024 + 1).toString('base64') }, operator), (error) => error.payload?.error === 'mcp_upload_chunk_too_large');
  await upload.appendMcpUploadChunk({ upload_id: started.id, sequence: 0, data_base64: bytes.toString('base64') }, operator);
  const committed = await upload.commitMcpUpload({ upload_id: started.id }, operator); assert.equal(committed.change.path, 'secure.txt');
  assert.equal(fs.readFileSync(path.join(repoA, 'secure.txt'), 'utf8'), 'secure upload\n');

  const registry = registryApi.createApiRouteRegistry(apiRoutes), decision = registry.find((item) => item.pattern === '/approvals/:type/:id/decision');
  const denied = await registryApi.executeRegistryOperation(registry, decision.operation_id, { params: { type: 'proposal', id: 'missing' }, body: { decision: 'approve_apply' } }, { client: operator });
  assert.equal(denied.status, 403); assert.equal(denied.error.error, 'mcp_scope_required');
  const projects = await registryApi.executeRegistryOperation(registry, registry.find((item) => item.method === 'GET' && item.pattern === '/projects').operation_id, {}, { client: operator });
  assert.deepEqual(projects.data.map((item) => item.id), ['project-sec-a']);
  const arbitrary = await registryApi.executeRegistryOperation(registry, registry.find((item) => item.pattern === '/health').operation_id, { path: '../../state.json' }, { client: { ...operator, scopes: [...operator.scopes, 'system:read'] } });
  assert.equal(arbitrary.error.error, 'mcp_operation_arguments_unknown');

  await state.mutate((data) => { const item = data.mcp_clients.find((client) => client.id === operator.id); item.expires_at = new Date(Date.now() - 1000).toISOString(); });
  await assert.rejects(() => clients.authenticateMcpToken(operatorCreated.token), (error) => error.payload?.error === 'mcp_client_expired');
  const persisted = JSON.stringify(await state.readState());
  assert.equal(persisted.includes(operatorCreated.token), false); assert.equal(persisted.includes('plain_token'), false);
  console.log('V1.8 MCP security tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
