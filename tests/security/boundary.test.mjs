import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateJobSpec } from '../../apps/runner-broker/src/job-spec.mjs';

const root = process.cwd();

test('app container has no Docker control plane and broker is the only socket holder', () => {
  const compose = fs.readFileSync(path.join(root, 'compose.yml'), 'utf8');
  const app = compose.slice(compose.indexOf('  app:'), compose.indexOf('  runner-broker:'));
  const broker = compose.slice(compose.indexOf('  runner-broker:'));
  assert.doesNotMatch(app, /docker\.sock|docker-cli/);
  assert.match(app, /read_only: true/);
  assert.match(broker, /docker\.sock/);
  assert.doesNotMatch(broker, /ports:/);
  assert.match(app, /aiws\.owner: aiws-v3/);
  assert.match(broker, /aiws\.owner: aiws-v3/);
  assert.match(compose, /aiws-data-v3/);
  assert.doesNotMatch(compose, /4320/);
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
