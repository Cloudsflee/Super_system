import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('V3 replays the committed sanitized V2.3 golden without loading historical runtime', () => {
  const fixturePath = path.join(root, 'tests', 'golden', 'v23', 'r0-r1.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.schema_version, 'aiws.v3.v23_golden.v1');
  assert.equal(fixture.source_commit, 'e18dc0b');
  assert.equal(fixture.extraction.mode, 'detached_read_only_worktree');
  assert.equal(fixture.extraction.executed_runtime, false);
  assert.ok(fixture.source_files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.doesNotMatch(JSON.stringify(fixture), /(?:token|password|authorization|cookie)\s*[:=]/i);

  const run = spawnSync(process.execPath, ['scripts/recovery-golden.mjs', 'verify'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, 'passed');
  assert.equal(result.fixture_sha256, fixture.fixture_sha256);
  assert.equal(result.cases, 12);
});
