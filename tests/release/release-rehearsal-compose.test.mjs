import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { composeYaml } from '../../scripts/release-rehearsal-compose.mjs';

const base = {
  appImage: 'sha256:app',
  brokerImage: 'sha256:broker',
  runnerImage: 'sha256:runner',
  runnerDigest: 'sha256:digest',
  volume: 'aiws-test-volume',
  port: 54321,
  secretFile: 'C:\\fixture\\broker-secret'
};

function brokerService(compose) {
  return compose.split('\n  runner-broker:\n')[1].split('\nnetworks:\n')[0];
}

test('mock rehearsal broker runs as the runner workspace owner', () => {
  const service = brokerService(composeYaml(base));
  assert.match(service, /\n    user: "10001:10001"\n/);
  assert.match(service, /AIWS_BROKER_EXECUTOR: mock/);
  assert.match(service, /- ALL/);
});

test('docker rehearsal broker retains root socket execution', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-rehearsal-compose-'));
  const codexSecretFile = path.join(directory, 'codex-secret');
  fs.writeFileSync(codexSecretFile, 'fixture-secret');
  try {
    const service = brokerService(composeYaml({ ...base, codexSecretFile, root: directory }));
    assert.doesNotMatch(service, /\n    user:/);
    assert.match(service, /AIWS_BROKER_EXECUTOR: docker/);
    assert.match(service, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
