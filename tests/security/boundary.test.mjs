import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateJobSpec } from '../../apps/runner-broker/src/job-spec.mjs';

const root = process.cwd();

test('resolved compose keeps Docker control plane and socket on the broker only', () => {
  const digest = `sha256:${'e'.repeat(64)}`;
  const result = spawnSync('docker', ['compose', '-f', path.join(root, 'compose.yml'), 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AIWS_RUNNER_DIGEST: digest, AIWS_RUNNER_IMAGE: `runner@${digest}` }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(result.stdout);
  const app = config.services?.app;
  const broker = config.services?.['runner-broker'];
  assert.ok(app && broker);
  assert.equal(app.read_only, true);
  assert.deepEqual(app.cap_drop, ['ALL']);
  assert.deepEqual(app.cap_add, ['CHOWN', 'DAC_OVERRIDE']);
  assert.equal(app.ports[0].host_ip, '127.0.0.1');
  assert.equal(app.ports[0].target, 4317);
  assert.equal(app.volumes.some((volume) => String(volume.source).includes('docker.sock')), false);
  assert.equal(JSON.stringify(app).includes('docker-cli'), false);
  assert.equal(broker.volumes.filter((volume) => String(volume.source).includes('docker.sock')).length, 1);
  assert.equal(broker.ports, undefined);
  assert.deepEqual(broker.cap_drop, ['ALL']);
  assert.deepEqual(Object.keys(broker.networks), ['internal']);
  assert.equal(config.volumes['aiws-data-v3'].labels['aiws.owner'], 'aiws-v3');
  assert.equal(JSON.stringify(config).includes('4320'), false);
});

test('production App image has no Docker CLI or host socket', () => {
  if (process.env.AIWS_SECURITY_DEFER_DOCKER === '1') {
    const releaseProbe = fs.readFileSync(path.join(root, 'scripts', 'v3-clean-p10-release-probe.mjs'), 'utf8');
    for (const marker of ['production_image_boundary', 'command -v docker', '/var/run/docker.sock', "import('node-pty')", 'aiws.component']) assert.ok(releaseProbe.includes(marker), marker);
    return;
  }
  const tag = `aiws-security-app:${process.pid}-${Date.now()}`;
  const build = spawnSync('docker', ['build', '--quiet', '--target', 'production', '--tag', tag, root], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600_000
  });
  try {
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const probe = spawnSync('docker', [
      'run', '--rm', '--entrypoint', 'sh', tag, '-c',
      'if command -v docker >/dev/null 2>&1; then exit 42; fi; if [ -e /var/run/docker.sock ]; then exit 43; fi'
    ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    const runtime = spawnSync('docker', [
      'run', '--rm', '--entrypoint', 'node', tag, '-e',
      "Promise.all([import('node-pty'), import('ws')]).then(() => process.exit(0)).catch(() => process.exit(44))"
    ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
    const inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{index .Config.Labels "aiws.component"}}'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    assert.equal(inspect.stdout.trim(), 'app');
  } finally {
    const cleanup = spawnSync('docker', ['image', 'rm', '--force', tag], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
  }
});

test('production build context excludes live secrets and requires a real Runner digest', () => {
  const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'compose.yml'), 'utf8');
  assert.match(dockerignore, /docker\/secrets\/\*/);
  assert.match(compose, /AIWS_RUNNER_DIGEST:\?set AIWS_RUNNER_DIGEST/);
  assert.doesNotMatch(compose, /sha256:0{64}/);
});

test('broker readiness inspects the registered Runner image instead of echoing configuration', () => {
  const broker = fs.readFileSync(path.join(root, 'apps', 'runner-broker', 'server.mjs'), 'utf8');
  assert.match(broker, /docker', \['image', 'inspect'/);
  assert.match(broker, /runner_digest_mismatch/);
});

test('broker spec cannot carry command, host volume, or arbitrary environment', () => {
  const base = { task_id: 'task', execution_id: 'exe_12345678abcdef', project_id: 'prj_12345678abcdef', workspace_subpath: 'projects/prj_12345678abcdef', image_digest: `sha256:${'f'.repeat(64)}`, execution_mode: 'read', resource_profile: 'standard', network_profile: 'none', input_paths: [], output_paths: [], deadline_at: new Date(Date.now() + 60_000).toISOString() };
  for (const field of ['command', 'host_path', 'volumes', 'environment', 'privileged', 'cap_add']) assert.throws(() => validateJobSpec({ ...base, [field]: 'x' }, { runnerDigest: base.image_digest }), /not allowed/);
});
