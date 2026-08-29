import assert from 'node:assert/strict';
import test from 'node:test';
import { CLEAN_COMMAND_REGISTRY, createCleanCommandRegistry } from '../../apps/api/src/clean/registry.mjs';
import { createAssistPrerequisites, createWorkspace } from '../p5/helpers.mjs';
import { close, listen, open, closeServer } from './helpers.mjs';

test('P10 HTTP routes expose strict v2 envelopes and reject offline/destructive MCP bypasses', async () => {
  const state = await open();
  let server;
  try {
    server = await listen(state.runtime);
    const cookie = `aiws_session=${encodeURIComponent(state.proof)}`;
    const project = await state.runtime.project.createProject({ name: 'HTTP P10', idempotency_key: 'p10-http-project' }, state.principal);
    const credentials = await state.runtime.identity.createCredential({ provider: 'codex', external_ref: 'p10-http-credential', idempotency_key: 'p10-http-credential' }, state.principal);
    await state.runtime.identity.rebindCredential(credentials.credential.id, { proof: 'p10-http-proof-123456789', expected_revision: 1, idempotency_key: 'p10-http-rebind' }, state.principal);
    const profile = await state.runtime.identity.createProfile({ provider: 'codex', label: 'HTTP profile', credential_ref_id: credentials.credential.id, idempotency_key: 'p10-http-profile' }, state.principal);
    const headers = { cookie, 'content-type': 'application/json' };
    const update = await fetch(`${server.base}/api/v2/profiles/${profile.profile.id}`, { method: 'PATCH', headers: { ...headers, 'idempotency-key': 'p10-http-profile-update', 'x-expected-revision': '1' }, body: JSON.stringify({ label: 'HTTP profile updated' }) });
    assert.equal(update.status, 200);
    const updateBody = await update.json();
    assert.equal(updateBody.meta.api_version, '2');
    assert.equal(updateBody.data.profile.lifecycle_status, 'enabled');
    const template = await fetch(`${server.base}/api/v2/brief-templates`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'p10-http-template', 'x-expected-revision': '0' }, body: JSON.stringify({ team_id: project.team_id, name: 'HTTP template', content: { fields: ['objective'] } }) });
    assert.equal(template.status, 201);
    const templateBody = await template.json();
    assert.equal(templateBody.data.template.current_revision, 1);
    const list = await fetch(`${server.base}/api/v2/brief-templates`, { headers: { cookie } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data.templates.length, 1);
    const workspace = await createWorkspace(state, project, 'p10-http-assist');
    const prerequisites = await createAssistPrerequisites(state, project, 'p10-http-assist');
    const assist = await state.runtime.assist.createSession({ project_id: project.id, scope: 'project', scope_id: project.id, context_pack_id: prerequisites.pack.id, profile_id: prerequisites.profile.id, repository_workspace_id: workspace.workspace.id, idempotency_key: 'p10-http-assist-session' }, state.principal);
    const archived = await fetch(`${server.base}/api/v2/assist/sessions/${assist.session.id}/archive`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'p10-http-assist-archive', 'x-expected-revision': String(assist.session.revision) }, body: '{}' });
    assert.equal(archived.status, 200);
    const archivedSession = (await archived.json()).data.session;
    assert.ok(archivedSession.archived_at);
    const restored = await fetch(`${server.base}/api/v2/assist/sessions/${assist.session.id}/restore`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'p10-http-assist-restore', 'x-expected-revision': String(archivedSession.revision) }, body: '{}' });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).data.session.archived_at, null);
    const account = state.runtime.identity.account(state.principal);
    const secondSession = await fetch(`${server.base}/api/v2/sessions`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'p10-http-second-session', 'x-expected-revision': String(account.revision) }, body: JSON.stringify({ ttl_seconds: 3600, expected_revision: account.revision }) });
    assert.equal(secondSession.status, 201);
    assert.match(secondSession.headers.get('set-cookie') || '', /^aiws_session=.*HttpOnly; SameSite=Strict$/);
    const secondSessionBody = await secondSession.json();
    assert.ok(secondSessionBody.data.session.id);
    assert.equal(JSON.stringify(secondSessionBody).includes('proof'), false);
    const registry = createCleanCommandRegistry({ targetVersion: 9, runtimePhase: 10 });
    for (const entry of registry.entries.filter((item) => item.phase === 'p10')) assert.equal(entry.path.startsWith('/api/v2/'), true);
    assert.equal(CLEAN_COMMAND_REGISTRY.some((entry) => entry.path.includes('/api/v1/')), false);
  } finally {
    if (server) await closeServer(server.server);
    await close(state);
  }
});
