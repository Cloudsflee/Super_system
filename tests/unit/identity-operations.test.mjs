import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../../apps/api/src/database.mjs';
import { IdentityService } from '../../apps/api/src/modules/identity/service.mjs';
import { OperationService } from '../../apps/api/src/modules/operations/service.mjs';
import { SecretRegistry } from '../../apps/api/src/secret-registry.mjs';

async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-r2-services-'));
  const db = await openDatabase(path.join(home, 'state.sqlite'));
  const identity = new IdentityService({ db });
  await identity.initialize();
  return { home, db, identity, async close() { await db.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

test('Bearer sessions persist only hashes and enforce expiry, revoke, and revision', async () => {
  const env = await fixture();
  try {
    const created = await env.identity.createSession({ ttl_seconds: 3600 }, { actor: 'usr_local_owner' });
    assert.equal((await env.identity.authenticate(`Bearer ${created.token}`)).session_id, created.id);
    const stored = await env.db.get('SELECT token_hash FROM sessions WHERE id=?', [created.id]);
    assert.equal(stored.token_hash.length, 64);
    assert.equal(stored.token_hash.includes(created.token), false);
    await assert.rejects(() => env.identity.revokeSession(created.id, { expected_revision: 2 }), (error) => error.code === 'revision_conflict');
    const revoked = await env.identity.revokeSession(created.id, { expected_revision: 1 });
    assert.equal(revoked.revision, 2);
    await assert.rejects(() => env.identity.authenticate(`Bearer ${created.token}`), (error) => error.code === 'session_revoked');
  } finally { await env.close(); }
});

test('operations persist events, redact results, cancel by revision, and recover interruptions', async () => {
  const env = await fixture();
  const secrets = new SecretRegistry([['fixture', 'operation-secret-sentinel']]);
  const operations = new OperationService({ db: env.db, secrets });
  try {
    const complete = await operations.create({ kind: 'fixture.complete', executor: async ({ emit }) => {
      await emit('fixture.progress', { message: 'operation-secret-sentinel' });
      return { summary: 'operation-secret-sentinel done' };
    } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const completed = await operations.get(complete.operation_id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result.summary, '[redacted] done');
    assert.equal(JSON.stringify(await operations.events(complete.operation_id)).includes('operation-secret-sentinel'), false);

    const cancellable = await operations.create({ kind: 'fixture.cancel', executor: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const running = await operations.get(cancellable.operation_id);
    assert.equal((await operations.cancel(cancellable.operation_id, { expected_revision: running.revision })).status, 'cancelled');

    const interrupted = await operations.create({ kind: 'fixture.interrupt' });
    assert.equal(await operations.recover(), 1);
    assert.equal((await operations.get(interrupted.operation_id)).error_code, 'operation_interrupted');
  } finally { await env.close(); }
});
