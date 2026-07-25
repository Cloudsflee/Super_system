import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { api, cleanup, makeFixture, sourceSnapshot, startApi } from './v13-test-helpers.mjs';

const fixture = makeFixture('aiws-v14-container-flow-');
const imports = path.join(fixture.root, 'host-projects');
const source = path.join(imports, 'sample');
const docs = path.join(imports, 'docs');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(source, 'README.md'), '# immutable source\n', 'utf8');
fs.writeFileSync(path.join(source, 'app.js'), 'export const value = 14;\n', 'utf8');
fs.writeFileSync(path.join(docs, 'requirements.md'), '# requirements\n', 'utf8');
const before = sourceSnapshot(imports);
const port = await freePort();
let server;

try {
  server = await startApi({
    port,
    home: fixture.home,
    ccSwitch: fixture.ccSwitch,
    env: {
      AIWS_CONTAINERIZED: '1',
      AIWS_DOCKER_DATA_VOLUME: 'volume-secret-sentinel',
      AIWS_DOCKER_INSTANCE: `v14-test-${process.pid}`,
      AIWS_HOST_PROJECTS_ROOT: imports
    }
  });
  const deployment = await api(port, '/system/deployment');
  assert.equal(deployment.mode, 'container');
  assert.equal(deployment.local_only, true);
  assert.deepEqual(deployment.storage, { type: 'docker_volume', ready: true });
  assert.equal(deployment.docker.strategy, 'socket');
  assert.equal(typeof deployment.docker.ready, 'boolean');
  assert.deepEqual(deployment.imports, {
    codex_home: false,
    cc_switch: false,
    projects_root: true,
    project_path_mode: 'relative'
  });
  const deploymentText = JSON.stringify(deployment);
  assert.equal(deploymentText.includes(imports), false);
  assert.equal(deploymentText.includes('volume-secret-sentinel'), false);
  assert.equal(deploymentText.includes('docker.sock'), false);

  const health = await api(port, '/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.deployment.mode, 'container');
  assert.equal(health.db.writable, true);
  const healthText = JSON.stringify(health);
  assert.equal(healthText.includes(fixture.home), false);
  assert.equal(healthText.includes('volume-secret-sentinel'), false);

  const created = await api(port, '/projects', 'POST', { title: 'V1.4 Relative Import' }, 201);
  const projectId = created.project.id;
  await api(port, `/projects/${projectId}/intake`, 'PUT', {
    mode: 'existing',
    answers: { goal: '验证相对导入' },
    code_source: { type: 'local_directory', path: 'sample', path_scope: 'host_import_root' },
    context_sources: [{ type: 'file', label: '需求', path: 'docs/requirements.md', path_scope: 'host_import_root' }]
  });
  await api(port, `/projects/${projectId}/imports`, 'POST', { operation_key: 'v14-relative' }, 201);
  const onboarding = await api(port, `/projects/${projectId}/onboarding`);
  assert.deepEqual(onboarding.intake.code_source, {
    type: 'local_directory',
    name: 'sample',
    path_scope: 'host_import_root'
  });
  assert.equal(onboarding.intake.context_sources[0].path, undefined);
  assert.equal(onboarding.intake.context_sources[0].path_scope, 'host_import_root');
  assert.equal(JSON.stringify(onboarding).includes(imports), false);
  assert.equal(fs.readFileSync(path.join(onboarding.project.repo_path, 'README.md'), 'utf8'), '# immutable source\n');

  const rejected = await api(
    port,
    `/projects/${projectId}/intake`,
    'PUT',
    {
      mode: 'existing',
      code_source: { type: 'local_directory', path: '../sample', path_scope: 'host_import_root' },
      answers: { goal: 'reject' }
    },
    400
  );
  assert.equal(rejected.error, 'host_import_path_traversal');
  assert.deepEqual(sourceSnapshot(imports), before);
  const stateText = fs.readFileSync(path.join(fixture.home, 'data', 'state.json'), 'utf8');
  assert.equal(stateText.includes(imports), false);
  console.log('V1.4 container deployment/import integration tests passed');
} finally {
  await server?.stop();
  cleanup(fixture.root);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
