import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-v22-state-'));
process.env.AIWS_HOME = root;
process.env.NODE_ENV = 'test';

const stateApi = await import(`../../apps/api/src/state.mjs?v22-state=${Date.now()}`),
  vault = await import('../../apps/api/src/vault.mjs'),
  migration = await import('../../apps/api/src/state-migration-v22.mjs'),
  runtime = await import('../../apps/api/src/state-runtime-v22.mjs');
try {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const legacyStateFile = path.join(root, 'data', 'state.json');
  fs.writeFileSync(legacyStateFile, JSON.stringify({ schema_version: 21, committed: true }));
  fs.writeFileSync(`${legacyStateFile}.tmp`, JSON.stringify({ schema_version: 21, committed: false }));
  await runtime.recoverManagedStateTemp();
  assert.equal(fs.existsSync(`${legacyStateFile}.tmp`), false);
  assert.equal(JSON.parse(fs.readFileSync(legacyStateFile, 'utf8')).committed, true);
  fs.writeFileSync(`${legacyStateFile}.tmp`, '{"schema_version":21');
  await runtime.recoverManagedStateTemp();
  assert.equal(fs.existsSync(`${legacyStateFile}.tmp`), false);
  assert.equal(JSON.parse(fs.readFileSync(legacyStateFile, 'utf8')).committed, true);
  fs.rmSync(legacyStateFile);

  await stateApi.ensureRuntime();
  const initial = await stateApi.readStateSnapshot();
  assert.equal(initial.schema_version, 22);
  assert.equal(Object.values(initial).filter(Array.isArray).length, 96);
  assert.equal(fs.existsSync(path.join(root, 'data', 'state-v22.sqlite')), true);
  const sentinel = JSON.parse(fs.readFileSync(path.join(root, 'data', 'state.json'), 'utf8'));
  assert.equal(migration.isState22Sentinel(sentinel), true);

  const idleRevision = stateApi.stateRevision();
  await stateApi.mutate(() => undefined);
  assert.equal(stateApi.stateRevision(), idleRevision);

  await stateApi.mutate((state) => state.integration_statuses.push({ key: 'v22-roundtrip', status: 'ready' }));
  assert.equal((await stateApi.readState()).integration_statuses.at(-1).key, 'v22-roundtrip');
  const committedRevision = stateApi.stateRevision();
  await assert.rejects(
    () =>
      stateApi.mutate((state) => {
        state.projects.push({ id: 'rolled-back-project' });
        throw Object.assign(new Error('rollback-fixture'), { code: 'rollback_fixture' });
      }),
    (error) => error.code === 'rollback_fixture'
  );
  assert.equal(stateApi.stateRevision(), committedRevision);
  assert.equal(
    (await stateApi.readState()).projects.some((item) => item.id === 'rolled-back-project'),
    false
  );

  const secret = 'V22_SECRET_SENTINEL_6f35cb4a9131';
  vault.rememberSecret('v22-test', secret);
  await stateApi.mutate((state) => state.traces.push({ id: 'trace-v22-secret', summary: secret }));
  assert.equal(
    (await stateApi.readState()).traces.find((item) => item.id === 'trace-v22-secret').summary,
    '***MASKED***'
  );
  await stateApi.checkpointAndCloseState();
  for (const suffix of ['', '-wal']) {
    const file = path.join(root, 'data', `state-v22.sqlite${suffix}`);
    if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(Buffer.from(secret)), false);
  }

  await stateApi.ensureRuntime();
  assert.equal(
    (await stateApi.readState()).integration_statuses.some((item) => item.key === 'v22-roundtrip'),
    true
  );
  assert.equal((await stateApi.statePersistenceStatus()).integrity, 'ok');
  assert.throws(
    () => migration.validateCollectionIdentities('webhook_deliveries', [{ id: 'legacy-only' }]),
    (error) => error.code === 'state_record_identity_missing'
  );
  assert.throws(
    () =>
      migration.validateCollectionIdentities('webhook_deliveries', [
        { delivery_id: 'duplicate' },
        { delivery_id: 'duplicate' }
      ]),
    (error) => error.code === 'state_record_identity_duplicate'
  );
  assert.doesNotThrow(() =>
    migration.validateCollectionIdentities('integration_statuses', [
      { key: 'codex_probe', profile_id: 'profile-a' },
      { key: 'codex_probe', profile_id: 'profile-b' }
    ])
  );
  assert.throws(
    () =>
      migration.validateCollectionIdentities('integration_statuses', [
        { key: 'codex_probe', profile_id: 'profile-a' },
        { key: 'codex_probe', profile_id: 'profile-a' }
      ]),
    (error) => error.code === 'state_record_identity_duplicate'
  );
  assert.doesNotThrow(() =>
    migration.validateCollectionIdentities('assist_events', [
      { id: 1, session_id: 'session-a', sequence: 1 },
      { id: 1, session_id: 'session-b', sequence: 1 }
    ])
  );
  assert.throws(
    () =>
      migration.validateCollectionIdentities('assist_events', [
        { id: 1, session_id: 'session-a', sequence: 1 },
        { id: 2, session_id: 'session-a', sequence: 1 }
      ]),
    (error) => error.code === 'state_record_identity_duplicate'
  );
} finally {
  await stateApi.checkpointAndCloseState().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('V2.2 SQLite state roundtrip, revision, rollback, restart and secret redaction tests passed');
