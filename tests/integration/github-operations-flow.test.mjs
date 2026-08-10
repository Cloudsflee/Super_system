import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { fixture, mutate, request, eventually } from './helpers.mjs';

function githubFetch(url, options = {}) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path === '/app/installations') return json([{ id: 67890, account: { login: 'fixture-org' }, permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } }]);
  if (path === '/app') return json({ id: 12345, slug: 'fixture-app' });
  if (path === '/app/installations/67890/access_tokens') return json({ token: 'installation-token-fixture-value', expires_at: new Date(Date.now() + 600000).toISOString() });
  if (path === '/installation/repositories') return json({ total_count: 1, repositories: [{ id: 9001, full_name: 'fixture-org/repository', default_branch: 'main', private: false, permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } }] });
  return json({ message: 'not found' }, 404);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('GitHub App discovery, repository sync, and Probe persist revisions and permissions', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = await fixture({ githubOptions: { apiRoot: 'http://github.fixture', fetch: githubFetch } });
  try {
    const key = await mutate(env.base, '/api/v1/credentials', { kind: 'github_app_private_key', label: 'Operations App key', secret: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, 'github-op-key');
    const webhook = await mutate(env.base, '/api/v1/credentials', { kind: 'github_webhook_secret', label: 'Operations webhook', secret: 'github-op-webhook-secret' }, 'github-op-webhook');
    const app = await mutate(env.base, '/api/v1/github/apps', { label: 'Operations App', app_id: '12345', client_id: 'Iv1.fixture', private_key_ref: key.json.id, webhook_secret_ref: webhook.json.id }, 'github-op-app');
    const discovered = await mutate(env.base, `/api/v1/github/apps/${app.json.id}/installations/discover`, { expected_revision: app.json.revision }, 'github-op-discover');
    assert.equal(discovered.response.status, 202, JSON.stringify(discovered.json));
    const discoveryOperation = await eventually(async () => (await request(env.base, `/api/v1/operations/${discovered.json.operation_id}`)).json, (value) => ['completed', 'failed'].includes(value.status), 4000);
    assert.equal(discoveryOperation.status, 'completed', JSON.stringify(discoveryOperation));
    const installations = await request(env.base, '/api/v1/github/installations');
    const installation = installations.json[0];
    assert.equal(installation.status, 'available');
    assert.equal(installation.permissions.contents, 'write');

    const synced = await mutate(env.base, `/api/v1/github/installations/${installation.id}/repositories/sync`, { expected_revision: installation.revision }, 'github-op-sync');
    assert.equal(synced.response.status, 202, JSON.stringify(synced.json));
    const syncOperation = await eventually(async () => (await request(env.base, `/api/v1/operations/${synced.json.operation_id}`)).json, (value) => ['completed', 'failed'].includes(value.status), 4000);
    assert.equal(syncOperation.status, 'completed', JSON.stringify(syncOperation));
    assert.equal(syncOperation.result.repositories[0].full_name, 'fixture-org/repository');

    const probed = await mutate(env.base, '/api/v1/integrations/github/probe', { app_config_id: app.json.id, expected_revision: (await request(env.base, '/api/v1/github/apps')).json[0].revision }, 'github-op-probe');
    assert.equal(probed.response.status, 202, JSON.stringify(probed.json));
    const probeOperation = await eventually(async () => (await request(env.base, `/api/v1/operations/${probed.json.operation_id}`)).json, (value) => ['completed', 'failed'].includes(value.status), 4000);
    assert.equal(probeOperation.status, 'completed', JSON.stringify(probeOperation));
    assert.equal(probeOperation.result.status, 'available', JSON.stringify(probeOperation.result));
    const apps = await request(env.base, '/api/v1/github/apps');
    assert.equal(apps.json[0].status, 'verified');
  } finally { await env.close(); }
});
