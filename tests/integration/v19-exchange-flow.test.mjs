import assert from 'node:assert/strict';
import fs from 'node:fs';
import { api, cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v19-exchange-flow-'), port = 4914;
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const owner = (await api(port, '/account/me')).user;
  const headers = { 'x-aiws-user-id': owner.id, 'x-aiws-scopes': 'project:create project:read project:write exchange:read exchange:write' };
  const source = await request('/projects', 'POST', { title: 'Exchange source', operation_key: 'exchange-source' }, headers, 201);
  const target = await request('/projects', 'POST', { title: 'Exchange target', operation_key: 'exchange-target' }, headers, 201);
  await request(`/projects/${source.project.id}/exchange-requests`, 'POST', { source_project_id: target.project.id, target_project_id: source.project.id }, headers, 409, 'exchange_source_project_mismatch');
  const stateFile = `${fixture.home}/data/state.json`;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const targetOwner = { id: 'exchange-target-owner', display_name: 'Exchange Target Owner', role: 'member', auth_mode: 'test', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  state.users.push(targetOwner);
  state.projects.find((item) => item.id === target.project.id).owner_user_id = targetOwner.id;
  Object.assign(state.project_memberships.find((item) => item.project_id === target.project.id && item.user_id === owner.id), { role: 'collaborator', status: 'revoked', revoked_at: new Date().toISOString() });
  state.project_memberships.push({ id: 'exchange-target-owner-membership', project_id: target.project.id, user_id: targetOwner.id, role: 'owner', status: 'active', source: 'test', accepted_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  state.assets.push({ id: 'exchange-asset', project_id: source.project.id, status: 'confirmed', title: 'Accepted finding', summary: 'A sanitized finding', body: 'No local path', evidence_refs: ['evidence:brief'], current_version_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const targetHeaders = { 'x-aiws-user-id': targetOwner.id, 'x-aiws-scopes': 'project:read project:write exchange:read exchange:write' };

  const created = await request(`/projects/${source.project.id}/exchange-requests`, 'POST', {
    target_project_id: target.project.id, root_scope: { type: 'project', id: source.project.id }, allowed_depth: 0,
    items: [{ type: 'asset', id: 'exchange-asset' }], token_budget: 4000, operation_key: 'exchange-rest-1'
  }, headers, 201);
  assert.equal(created.request.status, 'pending_approval');
  const targetView = await request(`/exchange-requests/${created.request.id}`, 'GET', {}, targetHeaders, 200);
  assert.equal(targetView.request.snapshot.content_withheld_until_context_pack, true);
  assert.equal(JSON.stringify(targetView).includes('A sanitized finding'), false);
  const sourceApproved = await request(`/exchange-requests/${created.request.id}/approve`, 'POST', { side: 'source', expected_revision: 1 }, headers, 200);
  assert.equal(sourceApproved.grant, null);
  const targetApproved = await request(`/exchange-requests/${created.request.id}/approve`, 'POST', { side: 'target', expected_revision: 1 }, targetHeaders, 200);
  assert.equal(targetApproved.request.status, 'approved');
  assert.ok(targetApproved.grant?.id);
  const pack = await request(`/exchange-grants/${targetApproved.grant.id}/context-packs`, 'POST', { target_scope: { type: 'project', id: target.project.id } }, targetHeaders, 201);
  assert.equal(pack.context_pack.content_json.precedence, 'target_local_first');
  assert.equal(pack.context_pack.content_json.external_context.items[0].id, 'exchange-asset');
  assert.equal(JSON.stringify(pack).includes('repo_path'), false);
  await request(`/exchange-requests/${created.request.id}/revoke`, 'POST', { reason: 'test revoke' }, headers, 200);
  await request(`/exchange-grants/${targetApproved.grant.id}/context-packs`, 'POST', {}, headers, 409, 'exchange_grant_inactive');

  const expiring = await request(`/projects/${source.project.id}/exchange-requests`, 'POST', {
    target_project_id: target.project.id, root_scope: { type: 'project', id: source.project.id }, allowed_depth: 0,
    items: [{ type: 'evidence_summary', summary: 'short evidence' }], operation_key: 'exchange-expiring'
  }, headers, 201);
  const expiredState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  expiredState.exchange_requests.find((item) => item.id === expiring.request.id).expires_at = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(stateFile, `${JSON.stringify(expiredState, null, 2)}\n`);
  await request(`/exchange-requests/${expiring.request.id}/approve`, 'POST', { side: 'source' }, headers, 410, 'exchange_request_expired');
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.exchange_requests.find((item) => item.id === expiring.request.id).status, 'expired');

  process.env.AIWS_HOME = fixture.home;
  const { apiRoutes } = await import('../../apps/api/src/api-routes.mjs');
  const { createApiRouteRegistry, executeRegistryOperation } = await import('../../apps/api/src/api-route-registry.mjs');
  const registry = createApiRouteRegistry(apiRoutes), client = { id: 'exchange-mcp-client', subject_user_id: owner.id, scopes: headers['x-aiws-scopes'].split(' '), project_allowlist: [source.project.id, target.project.id] };
  const mcp = await executeRegistryOperation(registry, 'aiws.governance.get.projects.by-id.exchange-requests', { params: { id: source.project.id } }, { client });
  assert.equal(mcp.ok, true);
  assert.equal(mcp.data.project_id, source.project.id);
  console.log('V1.9 REST/MCP Exchange request, Context Pack, revoke, and expiry flow passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

async function request(route, method, body, headers, expected = 200, error = null) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  if (error) assert.equal(data.error, error);
  return data;
}
