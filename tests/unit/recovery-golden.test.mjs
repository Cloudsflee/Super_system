import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('V3 replays the committed sanitized V2.3 golden without loading historical runtime', () => {
  const fixturePath = path.join(root, 'tests', 'golden', 'v23', 'r0-r1.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const r2FixturePath = path.join(root, 'tests', 'golden', 'r2', 'identity-setup.json');
  const r2Fixture = JSON.parse(fs.readFileSync(r2FixturePath, 'utf8'));
  assert.equal(fixture.schema_version, 'aiws.v3.v23_golden.v1');
  assert.equal(fixture.source_commit, 'e18dc0b');
  assert.equal(fixture.extraction.mode, 'detached_read_only_worktree');
  assert.equal(fixture.extraction.executed_runtime, false);
  assert.ok(fixture.source_files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.doesNotMatch(JSON.stringify(fixture), /(?:token|password|authorization|cookie)\s*[:=]/i);
  assert.equal(r2Fixture.schema_version, 'aiws.v3.r2_golden.v1');
  assert.equal(r2Fixture.extraction.mode, 'current_read_only_contracts');
  assert.equal(r2Fixture.extraction.executed_runtime, false);
  assert.equal(r2Fixture.contracts.length, 7);
  assert.deepEqual(r2Fixture.contracts.map((item) => item.id), [
    'codex-device-auth-public-output',
    'codex-discovery-stale-revision',
    'codex-seven-stage-probe',
    'setup-state-machine',
    'github-app-jwt',
    'github-permissions',
    'github-webhook-hmac'
  ]);
  const ready = r2Fixture.contracts.find((item) => item.id === 'setup-state-machine').cases[0].ready;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.complete, true);
  assert.deepEqual(ready.blockers, []);
  const serializedR2 = JSON.stringify(r2Fixture);
  assert.doesNotMatch(serializedR2, /"(?:token|password|authorization|cookie|secret|private_key|auth_bundle)"\s*:/i);
  assert.doesNotMatch(serializedR2, /fixture-secret|BEGIN (?:RSA )?PRIVATE KEY/i);

  const run = spawnSync(process.execPath, ['scripts/recovery-golden.mjs', 'verify'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, 'passed');
  assert.equal(result.fixture_sha256, fixture.fixture_sha256);
  assert.equal(result.cases, 12);
  assert.equal(result.batch_count, 2);
  assert.deepEqual(result.batches.map((item) => item.batch), ['v23-r0-r1', 'r2-identity-setup']);
  assert.equal(result.batches[1].fixture_sha256, r2Fixture.fixture_sha256);
  assert.equal(result.batches[1].contracts, 7);
});
