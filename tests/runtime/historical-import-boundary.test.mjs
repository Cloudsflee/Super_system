import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHistoricalRuntime } from '../../fixtures/historical/clean-runtime/factory.mjs';

test('historical factory is explicit and supports migration fixtures', () => {
  assert.throws(() => createHistoricalRuntime({ targetVersion: 9 }), /historical_target_version_required/);
  const source = fs.readFileSync(path.join(process.cwd(), 'apps/api/server.mjs'), 'utf8');
  assert.doesNotMatch(source, /fixtures[\\/]historical/);
});
