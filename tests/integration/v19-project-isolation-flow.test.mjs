import assert from 'node:assert/strict';
import fs from 'node:fs';
import { api, cleanup, makeFixture, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v19-isolation-');
const port = 4912;
let server;
try {
  server = await startApi({ port, home: fixture.home, ccSwitch: fixture.ccSwitch });
  const account = await api(port, '/account/me'),
    owner = account.user;
  const headers = {
    'x-aiws-user-id': owner.id,
    'x-aiws-scopes': 'project:create project:read project:write github:write'
  };
  const first = await request('/projects', 'POST', { title: 'Isolation A' }, headers, 201);
  const second = await request('/projects', 'POST', { title: 'Isolation B' }, headers, 201);
  const stateFile = `${fixture.home}/data/state.json`,
    seeded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  {
    const state = seeded;
    for (const project of state.projects.filter((item) => [first.project.id, second.project.id].includes(item.id))) {
      project.status = 'active';
      project.onboarding_state = 'confirmed';
      project.managed_workspace_state = 'ready';
    }
    state.assets.push({
      id: 'asset-a',
      project_id: first.project.id,
      status: 'confirmed',
      title: 'A',
      summary: 'A',
      evidence_refs: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    state.assets.push({
      id: 'asset-b',
      project_id: second.project.id,
      status: 'confirmed',
      title: 'B',
      summary: 'B',
      evidence_refs: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }
  fs.writeFileSync(stateFile, `${JSON.stringify(seeded, null, 2)}\n`);
  const list = await request(`/assets?project_id=${first.project.id}`, 'GET', {}, headers);
  assert.deepEqual(
    list.map((item) => item.id),
    ['asset-a']
  );
  const review = await request('/review', 'GET', {}, headers);
  assert.equal(
    review.assets.some((item) => item.id === 'asset-b'),
    true,
    'owner may see both projects'
  );
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    paths = state.projects
      .filter((item) => [first.project.id, second.project.id].includes(item.id))
      .map((item) => item.repo_path);
  assert.notEqual(paths[0], paths[1]);
  assert.equal(new Set(paths).size, paths.length);
  console.log('V1.9 managed checkout and aggregate isolation flow passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

async function request(route, method, body, headers = {}, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}
