import assert from 'node:assert/strict';
import { api, cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';
import fs from 'node:fs';

const fixture = makeFixture('aiws-v19-repository-exchange-'), port = 4913;
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  await api(port, '/setup/mode', 'PUT', { mode: 'byo' });
  await api(port, '/github/app-config/validate', 'POST', { adapter: 'test', app_id: '1900', client_id: 'Iv1.v19', client_secret: 'client', private_key: 'key', webhook_secret: 'hook' });
  const device = await api(port, '/github/device/start', 'POST', { adapter: 'test' });
  await api(port, '/github/device/poll', 'POST', { adapter: 'test', request_id: device.request_id });
  await api(port, '/github/installations/discover', 'POST', { adapter: 'test', installation_id: '9001', repositories: [{ id: '9100', name: 'owned', full_name: 'aiws-owner/owned', private: true, permissions: { pull: true, push: true, admin: true } }] });
  const project = await api(port, '/projects', 'POST', { title: 'Deletion flow' }, 201);
  const created = await api(port, `/projects/${project.project.id}/github/repository`, 'POST', { adapter: 'test', installation_id: '9001', repository_id: '9100', name: 'owned', operation_key: 'create-repository' }, 201);
  const canonicalId = created.canonical_repository.id;
  await api(port, `/projects/${project.project.id}/github/repository`, 'DELETE', {}, 405, 'repository_direct_delete_forbidden');
  const intent = await api(port, `/canonical-repositories/${canonicalId}/deletion-intents`, 'POST', { operation_key: 'delete-repository' }, 201);
  await api(port, `/repository-deletion-intents/${intent.intent.id}/consent`, 'POST', { expected_revision: 1, consent_challenge: intent.intent.consent_challenge });
  await api(port, `/repository-deletion-intents/${intent.intent.id}/confirm`, 'POST', { expected_revision: 1, project_id: project.project.id });
  const deleted = await api(port, `/repository-deletion-intents/${intent.intent.id}/execute`, 'POST', { adapter: 'test' });
  assert.equal(deleted.repository.remote_state, 'deleted');
  await api(port, `/github/repositories/${canonicalId}`, 'DELETE', {}, 405, 'repository_direct_delete_forbidden');
  const state = JSON.parse(fs.readFileSync(`${fixture.home}/data/state.json`, 'utf8'));
  assert.equal(state.repository_deletion_intents.find((item) => item.id === intent.intent.id).status, 'executed');
  console.log('V1.9 repository deletion intent and remote reconciliation flow passed');
} finally { await server?.stop(); cleanup(fixture.root); }
