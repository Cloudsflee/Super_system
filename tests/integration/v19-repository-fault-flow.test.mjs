import assert from 'node:assert/strict';
import fs from 'node:fs';
import { api, cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v19-repository-faults-'), port = 4915;
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const owner = (await api(port, '/account/me')).user;
  const headers = { 'x-aiws-user-id': owner.id, 'x-aiws-scopes': 'project:create project:read project:write project:share github:read github:write destructive:execute' };
  const stateFile = `${fixture.home}/data/state.json`;
  const pendingProject = await request('/projects', 'POST', { title: 'Pending installation' }, headers, 201);
  const pending = await request(`/projects/${pendingProject.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: 'not-visible', repository_id: 'pending-repo', name: 'pending-repo', operation_key: 'pending-create' }, headers, 202);
  assert.equal(pending.error, 'github_installation_pending');

  await request('/github/app-config/validate', 'POST', { adapter: 'test', app_id: '1901', client_id: 'Iv1.faults', client_secret: 'client', private_key: 'key', webhook_secret: 'hook' }, headers, 200);
  const device = await request('/github/device/start', 'POST', { adapter: 'test' }, headers, 200);
  await request('/github/device/poll', 'POST', { adapter: 'test', request_id: device.request_id }, headers, 200);
  const collaborator = { id: 'repository-collaborator', display_name: 'Repository Collaborator', role: 'member', auth_mode: 'test', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const seeded = JSON.parse(fs.readFileSync(stateFile, 'utf8')); seeded.users.push(collaborator); fs.writeFileSync(stateFile, `${JSON.stringify(seeded, null, 2)}\n`);
  const collaboratorProject = await request('/projects', 'POST', { title: 'Collaborator repository' }, headers, 201);
  const invitation = await request(`/projects/${collaboratorProject.project.id}/invitations`, 'POST', { user_id: collaborator.id, role: 'collaborator' }, headers, 201);
  const collaboratorHeaders = { 'x-aiws-user-id': collaborator.id, 'x-aiws-scopes': 'project:read project:write github:read github:write' };
  await request(`/project-invitations/${invitation.invitation.id}/accept`, 'POST', {}, collaboratorHeaders, 200);
  const collaboratorDevice = await request('/github/device/start', 'POST', { adapter: 'test' }, collaboratorHeaders, 200);
  await request('/github/device/poll', 'POST', { adapter: 'test', request_id: collaboratorDevice.request_id, test_github_user_id: 2, test_github_login: 'repository-collaborator' }, collaboratorHeaders, 200);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).connected_accounts.filter((item) => item.provider === 'github').length, 2);
  await request('/github/installations/discover', 'POST', { adapter: 'test', installation_id: '9001', repositories: [{ id: 'fault-repo', name: 'fault-repo', full_name: 'aiws-owner/fault-repo', private: true, permissions: { pull: true, push: true, admin: false } }] }, headers, 200);
  const denied = await request(`/projects/${pendingProject.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: '9001', repository_id: 'fault-repo', name: 'fault-repo', operation_key: 'admin-denied' }, headers, 403);
  assert.equal(denied.error, 'github_administration_write_required');
  await request(`/projects/${pendingProject.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: '9001', repository_id: 'fault-repo', name: 'fault-repo', operation_key: 'admin-forged', administration_permission: 'write' }, headers, 403, 'github_administration_write_required');

  await request('/github/installations/discover', 'POST', { adapter: 'test', installation_id: '9001', repositories: [{ id: 'fault-repo', name: 'fault-repo', full_name: 'aiws-owner/fault-repo', private: true, permissions: { pull: true, push: true, admin: true } }, { id: 'collaborator-repo', name: 'collaborator-repo', full_name: 'repository-collaborator/collaborator-repo', private: true, permissions: { pull: true, push: true, admin: true } }] }, headers, 200);
  const collaboratorCreated = await request(`/projects/${collaboratorProject.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: '9001', repository_id: 'collaborator-repo', name: 'collaborator-repo', operation_key: 'collaborator-create' }, collaboratorHeaders, 201);
  assert.equal(collaboratorCreated.canonical_repository.creator_user_id, collaborator.id);
  const created = await request(`/projects/${pendingProject.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: '9001', repository_id: 'fault-repo', name: 'fault-repo', operation_key: 'fault-create' }, headers, 201);
  await request(`/projects/${pendingProject.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: '9001', repository_id: 'fault-repo', name: 'fault-repo-copy', operation_key: 'fault-create-different-key' }, headers, 409, 'project_repository_already_bound');
  const permissionChanged = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  permissionChanged.github_installations[0].repositories.find((item) => item.id === 'fault-repo').permissions.admin = false;
  fs.writeFileSync(stateFile, `${JSON.stringify(permissionChanged, null, 2)}\n`);
  const replayed = await request(`/projects/${pendingProject.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: '9001', repository_id: 'fault-repo', name: 'ignored', operation_key: 'fault-create' }, headers, 200);
  assert.equal(replayed.idempotent, true);
  permissionChanged.github_installations[0].repositories.find((item) => item.id === 'fault-repo').permissions.admin = true;
  fs.writeFileSync(stateFile, `${JSON.stringify(permissionChanged, null, 2)}\n`);
  const second = await request('/projects', 'POST', { title: 'Second binding' }, headers, 201);
  const rebound = await request(`/projects/${second.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: '9001', repository_id: 'fault-repo', name: 'fault-repo', operation_key: 'fault-bind-second' }, headers, 201);
  assert.equal(rebound.canonical_repository.id, created.canonical_repository.id);
  assert.notEqual(created.checkout?.remote_name + created.project_repository_binding?.local_checkout_path, rebound.checkout?.remote_name + rebound.project_repository_binding?.local_checkout_path);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const canonicalId = created.canonical_repository.id, intentProject = pendingProject.project.id;
  state.deliveries.push({ id: 'active-delivery', project_id: intentProject, status: 'running', pr_state: null, created_at: new Date().toISOString() });
  state.repository_deletion_intents.push({ id: 'expired-deletion-intent', canonical_repository_id: canonicalId, requested_by_user_id: owner.id, status: 'pending', revision: 1, snapshot: {}, snapshot_hash: 'expired', project_owner_confirmations: [], expires_at: new Date(Date.now() - 1000).toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const expired = await request('/repository-deletion-intents/expired-deletion-intent', 'GET', {}, headers, 200);
  assert.equal(expired.status, 'expired');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).repository_deletion_intents.find((item) => item.id === expired.id).status, 'expired');
  const intent = await request(`/canonical-repositories/${canonicalId}/deletion-intents`, 'POST', { operation_key: 'fault-delete' }, headers, 201);
  await request(`/repository-deletion-intents/${intent.intent.id}/consent`, 'POST', { consent_challenge: intent.intent.consent_challenge }, headers, 200);
  await request(`/repository-deletion-intents/${intent.intent.id}/confirm`, 'POST', { project_id: intentProject }, headers, 200);
  await request(`/repository-deletion-intents/${intent.intent.id}/confirm`, 'POST', { project_id: second.project.id }, headers, 200);
  await request(`/repository-deletion-intents/${intent.intent.id}/execute`, 'POST', { adapter: 'test' }, headers, 409, 'repository_other_project_bindings_active');
  assert.equal((JSON.parse(fs.readFileSync(stateFile, 'utf8'))).repository_deletion_intents.find((item) => item.id === intent.intent.id).status, 'ready');
  console.log('V1.9 Repository pending, Administration preflight, shared canonical, and deletion fault flow passed');
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
