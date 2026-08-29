import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ACTIVE_RUNTIME_PHASE,
  ACTIVE_SCHEMA_VERSION,
  ACTIVE_TARGET_VERSION
} from '../../apps/api/server.mjs';
import { parseCorsOrigins } from '../../apps/api/src/clean/config.mjs';
import { createCleanCommandRegistry } from '../../apps/api/src/clean/registry.mjs';
import { validateCleanOwnership } from '../../apps/api/src/clean/ownership.mjs';
import { close, open } from './helpers.mjs';

test('P9 runtime phase is separate from the immutable schema v8 ledger', async () => {
  assert.equal(ACTIVE_RUNTIME_PHASE, 10);
  assert.equal(ACTIVE_SCHEMA_VERSION, 9);
  assert.equal(ACTIVE_TARGET_VERSION, 9);
  const state = await open();
  try {
    assert.equal(state.runtime.runtimePhase, 9);
    assert.equal(state.runtime.p9, true);
    assert.equal(state.runtime.metadata.user_version, 8);
    assert.deepEqual(state.runtime.db.query('SELECT version FROM schema_migrations ORDER BY version').map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(fs.existsSync('apps/api/src/clean/migrations/009-web-offline-release.mjs'), false);
    const tables = state.runtime.db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name);
    assert.equal(validateCleanOwnership({ tables, registry: state.runtime.registry }).valid, true);
  } finally {
    await close(state);
  }
});

test('P9 registry adds one REST/Web Operations query and corrects selection write scope', () => {
  const p8 = createCleanCommandRegistry({ targetVersion: 8 });
  const p9 = createCleanCommandRegistry({ targetVersion: 8, runtimePhase: 9 });
  assert.equal(p8.get('events.project.replay'), null);
  const replay = p9.get('events.project.replay');
  assert.deepEqual({
    phase: replay.phase,
    method: replay.method,
    path: replay.path,
    owner: replay.owner,
    transports: replay.transport_allowlist,
    mcp: replay.mcp.exposed
  }, {
    phase: 'p9',
    method: 'GET',
    path: '/api/v2/events',
    owner: 'Operations',
    transports: ['rest', 'web'],
    mcp: false
  });
  assert.equal(p9.get('context.selection.create').scope, 'context:write');
});

test('P9 exact-origin parser rejects wildcard, null and non-origin URL forms', () => {
  assert.deepEqual(parseCorsOrigins(undefined), ['http://127.0.0.1:5174']);
  assert.deepEqual(parseCorsOrigins('http://127.0.0.1:5174,https://example.test'), ['http://127.0.0.1:5174', 'https://example.test']);
  for (const value of ['*', 'null', 'http://user@127.0.0.1:5174', 'http://127.0.0.1:5174/path', 'http://127.0.0.1:5174/', 'ftp://127.0.0.1:5174']) {
    assert.throws(() => parseCorsOrigins(value), /clean_cors_origin_invalid/, value);
  }
});
