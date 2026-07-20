import assert from 'node:assert/strict';
import fs from 'node:fs';
import { api, cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v19-governance-');
const port = 4911;
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const account = await api(port, '/account/me');
  const owner = account.user;
  const collaborator = { id: 'v19-collaborator', display_name: 'Collaborator', role: 'member', auth_mode: 'test', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const viewer = { id: 'v19-viewer', display_name: 'Viewer', role: 'member', auth_mode: 'test', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const stateFile = `${fixture.home}/data/state.json`;
  const ownerHeaders = { 'x-aiws-user-id': owner.id, 'x-aiws-scopes': 'project:create project:read project:write project:share github:write' };
  const memberHeaders = { 'x-aiws-user-id': collaborator.id, 'x-aiws-scopes': 'project:create project:read project:write project:share' };
  const viewerHeaders = { 'x-aiws-user-id': viewer.id, 'x-aiws-scopes': 'project:read project:write' };

  await request('/projects', 'POST', { title: 'Unauthenticated' }, {}, 401, 'authentication_required');
  const seeded = JSON.parse(fs.readFileSync(stateFile, 'utf8')); seeded.users.push(collaborator, viewer); fs.writeFileSync(stateFile, `${JSON.stringify(seeded, null, 2)}\n`);
  const created = await request('/projects', 'POST', { title: 'Owner Project', goal: 'ACL' }, ownerHeaders, 201);
  assert.equal(created.project.owner_user_id, owner.id);
  assert.equal(created.membership.role, 'owner');
  await request('/projects', 'POST', { title: 'Spoof', subject_user_id: owner.id }, memberHeaders, 403, 'project_create_owner_required');
  await request('/projects', 'POST', { title: 'No create scope' }, { 'x-aiws-user-id': owner.id, 'x-aiws-scopes': 'project:write' }, 403, 'mcp_scope_required');
  await request(`/projects/${created.project.id}`, 'GET', {}, viewerHeaders, 403, 'project_access_denied');

  const invite = await request(`/projects/${created.project.id}/invitations`, 'POST', { user_id: collaborator.id, role: 'collaborator' }, ownerHeaders, 201);
  await request(`/project-invitations/${invite.invitation.id}/accept`, 'POST', {}, viewerHeaders, 403, 'project_invitation_identity_mismatch');
  const accepted = await request(`/project-invitations/${invite.invitation.id}/accept`, 'POST', {}, memberHeaders, 200);
  assert.equal(accepted.membership.role, 'collaborator');
  await request(`/projects/${created.project.id}/trash`, 'POST', {}, memberHeaders, 403, 'project_role_forbidden');
  await request(`/projects/${created.project.id}`, 'DELETE', {}, memberHeaders, 403, 'project_role_forbidden');
  await request(`/projects/${created.project.id}/restore`, 'POST', {}, memberHeaders, 403, 'project_role_forbidden');
  await request(`/projects/${created.project.id}/purge`, 'POST', { confirm_title: created.project.title }, memberHeaders, 403, 'project_role_forbidden');
  const privateProject = await request('/projects', 'POST', { title: 'Owner private Project' }, ownerHeaders, 201);
  const briefTemplate = await request('/brief-templates', 'POST', { confirmed: true, title: 'Private ACL template', sections: [{ title: 'Scope', content: 'Owner-only target' }] }, ownerHeaders, 201);
  await request(`/brief-templates/${briefTemplate.id}/apply`, 'POST', { project_id: privateProject.project.id, brief_id: privateProject.brief.id }, memberHeaders, 403, 'project_access_denied');
  const aggregateState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  aggregateState.assets.push(resource('asset-visible', created.project.id), resource('asset-private', privateProject.project.id));
  aggregateState.node_runs.push(resource('run-visible', created.project.id), resource('run-private', privateProject.project.id));
  aggregateState.agent_sessions.push(resource('agent-visible', created.project.id), resource('agent-private', privateProject.project.id));
  aggregateState.change_proposals.push({ ...resource('approval-visible', created.project.id), status: 'pending', change_type: 'general' }, { ...resource('approval-private', privateProject.project.id), status: 'pending', change_type: 'general' });
  aggregateState.canonical_repositories.push(canonical('canonical-visible', 'repo-visible'), canonical('canonical-private', 'repo-private'));
  aggregateState.project_repository_bindings.push(binding('binding-visible', created.project.id, 'canonical-visible'), binding('binding-private', privateProject.project.id, 'canonical-private'));
  aggregateState.github_installations.push({ id: 'installation-aggregate', installation_id: 'aggregate', status: 'active', repositories: [{ id: 'repo-visible', full_name: 'aiws/visible' }, { id: 'repo-private', full_name: 'aiws/private' }] });
  const migrationAt = new Date().toISOString();
  aggregateState.workflow_migration_batches.push({ id: 'migration-shared', status: 'completed_with_failures', project_ids: [created.project.id, privateProject.project.id], workflow_ids: ['workflow-visible', 'workflow-private'], approved_by_user_id: owner.id, approved_at: migrationAt, summary: { total: 2, completed: 1, failed: 1 }, created_at: migrationAt, updated_at: migrationAt });
  aggregateState.workflow_migration_jobs.push(
    { id: 'migration-job-visible', batch_id: 'migration-shared', project_id: created.project.id, workflow_id: 'workflow-visible', status: 'completed', attempt: 1, created_at: migrationAt, updated_at: migrationAt },
    { id: 'migration-job-private', batch_id: 'migration-shared', project_id: privateProject.project.id, workflow_id: 'workflow-private', status: 'failed', attempt: 1, created_at: migrationAt, updated_at: migrationAt }
  );
  fs.writeFileSync(stateFile, `${JSON.stringify(aggregateState, null, 2)}\n`);
  const visible = await request('/projects', 'GET', {}, memberHeaders);
  assert.equal(visible.some((item) => item.id === created.project.id), true);
  assert.equal(visible.some((item) => item.id === privateProject.project.id), false);
  assert.deepEqual((await request('/assets', 'GET', {}, memberHeaders)).map((item) => item.id), ['asset-visible']);
  assert.deepEqual((await request('/agent-sessions', 'GET', {}, memberHeaders)).map((item) => item.id), ['agent-visible']);
  assert.deepEqual((await request('/approvals', 'GET', {}, memberHeaders)).map((item) => item.id), ['approval-visible']);
  assert.deepEqual((await request('/github/installations', 'GET', {}, memberHeaders))[0].repositories.map((item) => item.id), ['repo-visible']);
  const migrations = await request('/workflow-migrations', 'GET', {}, memberHeaders);
  assert.deepEqual(migrations.batch.project_ids, [created.project.id]);
  assert.equal(migrations.batch.status, 'completed');
  assert.deepEqual(migrations.batch.summary, { total: 1, completed: 1, failed: 0 });
  assert.deepEqual(migrations.jobs.map((item) => item.id), ['migration-job-visible']);
  await request(`/runs/run-private?project_id=${created.project.id}`, 'GET', {}, memberHeaders, 403, 'project_access_denied');
  await request(`/asset-candidates/asset-private/confirm`, 'POST', { project_id: created.project.id }, memberHeaders, 403, 'project_access_denied');
  await request(`/workspaces/${privateProject.workspace.id}?project_id=${created.project.id}`, 'GET', {}, memberHeaders, 403, 'project_access_denied');
  const shareForbidden = await request(`/projects/${created.project.id}/invitations`, 'POST', { user_id: viewer.id, role: 'viewer' }, memberHeaders, 403, 'project_role_forbidden');
  assert.equal(shareForbidden.error, 'project_role_forbidden');
  const projectsReview = await request('/review', 'GET', {}, memberHeaders);
  assert.equal(projectsReview.projects.every((item) => item.id === created.project.id), true);
  assert.equal(projectsReview.traces.every((item) => item.project_id === created.project.id), true);
  console.log('V1.9 REST Project owner, invitation, role, subject, and aggregate ACL flow passed');
} finally { await server?.stop(); cleanup(fixture.root); }

async function request(route, method, body, headers = {}, expected = 200, error = null) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  if (error) assert.equal(data.error, error);
  return data;
}
function resource(id, projectId) { return { id, project_id: projectId, status: 'active', title: id, summary: id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; }
function canonical(id, repositoryId) { return { id, provider: 'github', repository_id: repositoryId, full_name: `aiws/${repositoryId}`, name: repositoryId, remote_state: 'active', external_import: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; }
function binding(id, projectId, repositoryId) { return { id, project_id: projectId, canonical_repository_id: repositoryId, status: 'ready', local_checkout_path: `${projectId}/repo`, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; }
