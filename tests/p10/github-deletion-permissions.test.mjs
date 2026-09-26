import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupCreatedRepository, ensureAppRepositoryAccess } from '../../scripts/v3-clean-p10-github-deletion-probe.mjs';

const repository = { id: '9001', full_name: 'fixture/generated', default_branch: 'main' };
const auth = () => ({ appId: 'fixture-app', installationId: '77', privateKey: Buffer.from('fixture-key') });

test('GitHub deletion permission matrix keeps All repositories App-first and skips PAT binding', async () => {
  let binds = 0;
  const adapter = {
    async listInstallations() { return { installations: [{ id: '77', repository_selection: 'all' }], next_cursor: null }; },
    async listRepositories() { return { repositories: [{ id: 9001, full_name: repository.full_name }], next_cursor: null }; }
  };
  const result = await ensureAppRepositoryAccess({ adapter, auth, repository, installationId: '77', bind: async () => { binds += 1; } });
  assert.equal(result.repository_selection, 'all');
  assert.equal(result.bound, false);
  assert.equal(binds, 0);
});

test('GitHub deletion permission matrix binds only Selected repositories and rechecks App visibility', async () => {
  let binds = 0;
  let visible = false;
  const adapter = {
    async listInstallations() { return { installations: [{ id: '77', repository_selection: 'selected' }], next_cursor: null }; },
    async listRepositories() { return { repositories: visible ? [{ id: 9001, full_name: repository.full_name }] : [], next_cursor: null }; }
  };
  const result = await ensureAppRepositoryAccess({
    adapter,
    auth,
    repository,
    installationId: '77',
    bind: async (installationId, repositoryId) => { assert.equal(installationId, '77'); assert.equal(repositoryId, '9001'); binds += 1; visible = true; }
  });
  assert.equal(result.repository_selection, 'selected');
  assert.equal(result.bound, true);
  assert.equal(binds, 1);
});

test('GitHub deletion permission matrix fails closed for selected but unbound repositories', async () => {
  let binds = 0;
  const adapter = {
    async listInstallations() { return { installations: [{ id: '77', repository_selection: 'selected' }], next_cursor: null }; },
    async listRepositories() { return { repositories: [], next_cursor: null }; }
  };
  await assert.rejects(
    ensureAppRepositoryAccess({ adapter, auth, repository, installationId: '77', bind: async () => { binds += 1; throw Object.assign(new Error('bind_forbidden'), { code: 'github_installation_access_denied' }); } }),
    (error) => error.code === 'github_installation_access_denied'
  );
  assert.equal(binds, 1);
});

test('GitHub deletion permission matrix distinguishes missing installation management from repository absence', async () => {
  const adapter = {
    async listInstallations() { throw Object.assign(new Error('management_forbidden'), { code: 'github_installation_access_denied' }); },
    async listRepositories() { throw new Error('must_not_list_without_installation'); }
  };
  await assert.rejects(
    ensureAppRepositoryAccess({ adapter, auth, repository, installationId: '77', bind: async () => {} }),
    (error) => error.code === 'github_installation_access_denied'
  );
});

test('GitHub deletion probe fails closed when PAT cleanup cannot remove the generated repository', async () => {
  let calls = 0;
  const fetchImpl = async (_url, init = {}) => {
    calls += 1;
    if ((init.method || 'GET') === 'DELETE') return new Response(JSON.stringify({ message: 'temporary failure' }), { status: 500 });
    return new Response(JSON.stringify({ id: 9001, full_name: repository.full_name }), { status: 200 });
  };
  await assert.rejects(
    cleanupCreatedRepository(repository, Buffer.from('fixture-token'), fetchImpl),
    (error) => error.code === 'github_http_500'
  );
  assert.equal(calls, 2);
});
