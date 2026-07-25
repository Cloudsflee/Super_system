import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfirmedProject, repositorySnapshot } from './v13-test-helpers.mjs';

const port = Number(process.env.AIWS_TEST_PORT || 4584);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v12-files-'));
const repo = path.join(home, 'repo');
const outside = path.join(home, 'outside');
fs.mkdirSync(repo);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(repo, 'README.md'), '# Initial\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
run('git', ['init'], repo);
run('git', ['config', 'user.email', 'files@example.test'], repo);
run('git', ['config', 'user.name', 'Files Fixture'], repo);
run('git', ['add', '.'], repo);
run('git', ['commit', '-m', 'init'], repo);
const sourceBefore = repositorySnapshot(repo);
const child = spawn(process.execPath, ['apps/api/server.mjs'], {
  env: { ...process.env, AIWS_PORT: String(port), AIWS_HOME: home, NODE_ENV: 'test', AIWS_BYPASS_SETUP: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

await waitForServer();
try {
  const created = await createConfirmedProject({
    baseUrl: `http://127.0.0.1:${port}`,
    title: 'File Fixture',
    source: repo,
    workflowNodes: [{ type: 'execution', title: 'File Node' }]
  });
  const managedRepo = created.managedRepo;
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(managedRepo, 'linked-file.txt'), 'file');
  fs.symlinkSync(outside, path.join(managedRepo, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');
  const node = (await api(`/projects/${created.project.id}`)).nodes[0];

  const listing = await api(`/projects/${created.project.id}/files`);
  assert.ok(listing.entries.some((item) => item.name === 'README.md'));
  assert.equal(
    (await api(`/projects/${created.project.id}/files/content?path=README.md`)).content.replaceAll('\r\n', '\n'),
    '# Initial\n'
  );
  const saved = await api(`/projects/${created.project.id}/files/content`, 'PUT', {
    node_id: node.id,
    path: 'README.md',
    content: '# Updated\n'
  });
  assert.equal(saved.source, 'owner_editor');
  assert.equal(saved.path, 'README.md');
  assert.notEqual(saved.before_sha256, saved.after_sha256);
  const diff = await api(`/projects/${created.project.id}/files/diff`);
  assert.match(diff.diff, /Updated/);
  const workspace = await api(`/nodes/${node.id}/workspace`);
  assert.ok(workspace.traces.some((item) => item.event_type === 'file.saved' && item.target_id === saved.id));

  await api(
    `/projects/${created.project.id}/files/content?path=..%2Foutside.txt`,
    'GET',
    undefined,
    403,
    'path_outside_repository'
  );
  await api(
    `/projects/${created.project.id}/files/content?path=linked-file.txt`,
    'GET',
    undefined,
    403,
    'symlink_outside_repository'
  );
  await api(
    `/projects/${created.project.id}/files/content`,
    'PUT',
    { path: 'linked-file.txt', content: 'escaped' },
    403,
    'symlink_outside_repository'
  );
  await api(
    `/projects/${created.project.id}/files?path=linked-dir`,
    'GET',
    undefined,
    403,
    'symlink_outside_repository'
  );
  await api(
    `/projects/${created.project.id}/files/content`,
    'PUT',
    { path: 'linked-dir/new.txt', content: 'escaped' },
    403,
    'symlink_outside_repository'
  );
  await api(
    `/projects/${created.project.id}/files/diff?path=linked-file.txt`,
    'GET',
    undefined,
    403,
    'symlink_outside_repository'
  );
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# Initial\n');
  assert.deepEqual(repositorySnapshot(repo), sourceBefore);
  console.log('v1.2 file boundary integration tests passed');
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.rmSync(home, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function api(route, method = 'GET', body, status = 200, error) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`);
  if (error) assert.equal(data.error, error);
  return data;
}
async function waitForServer() {
  for (let index = 0; index < 100; index++) {
    try {
      if ((await api('/health')).status === 'ok') return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('server did not start');
}
