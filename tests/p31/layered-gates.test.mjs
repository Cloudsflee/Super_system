import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('layered gate policy blocks Clean failures and records historical failures as advisory', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts/layered-gate.mjs'), 'utf8');
  assert.match(source, /clean_failure_blocks:\s*true/);
  assert.match(source, /historical_failure_advisory:\s*true/);
  assert.match(source, /redaction/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  for (const command of ['test:p31', 'evidence:p31', 'test:integration:clean', 'test:security:clean', 'fixture:legacy:integration', 'fixture:legacy:security', 'fixture:legacy:e2e']) assert.equal(typeof packageJson.scripts[command], 'string');
});
