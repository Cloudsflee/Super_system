import assert from 'node:assert/strict';
import test from 'node:test';
import { open, close, settle } from './helpers.mjs';

test('one ledger preserves terminal operation, replay, idempotency, links, audit, and redaction', async () => {
  const state = await open();
  try {
    const { runtime, principal } = state;
    const requestHash = 'a'.repeat(64);
    const first = await runtime.operations.create({ actorId: principal.actorId, commandId: 'p31.ledger', kind: 'p31.ledger', resourceType: 'fixture', resourceId: 'fixture_1', projectId: null, requestHash, idempotencyKey: 'p31-ledger-key', status: 'succeeded' });
    const replay = await runtime.operations.create({ actorId: principal.actorId, commandId: 'p31.ledger', kind: 'p31.ledger', resourceType: 'fixture', resourceId: 'fixture_1', requestHash, idempotencyKey: 'p31-ledger-key', status: 'succeeded' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation_id, first.operation_id);
    runtime.db.withTransaction((tx) => {
      const links = runtime.operations.linkInTransaction(tx, first.operation_id, [['fixture', 'fixture_1'], ['fixture', 'fixture_1']], new Date().toISOString());
      assert.equal(links.length, 0);
    });
    const summary = runtime.operations.summary(first.operation_id);
    assert.equal(summary.status, 'succeeded');
    assert.equal(summary.terminal, true);
    const replayed = runtime.operations.eventsFor(first.operation_id, { actorId: principal.actorId });
    assert.equal(replayed.terminal, true);
    assert.ok(replayed.events.length >= 1);
    assert.equal(runtime.db.get('SELECT count(*) AS count FROM operations WHERE id=?', [first.operation_id]).count, 1);
    assert.equal(runtime.db.get('SELECT count(*) AS count FROM audit_events WHERE operation_id=?', [first.operation_id]).count >= 1, true);
    await settle(runtime);
  } finally { close(state); }
});

test('idempotency conflict remains explicit and redacted', async () => {
  const state = await open();
  try {
    const { runtime, principal } = state;
    const hash = 'b'.repeat(64);
    await runtime.operations.create({ actorId: principal.actorId, commandId: 'p31.redaction', resourceType: 'fixture', resourceId: 'fixture_2', requestHash: hash, idempotencyKey: 'p31-redaction-key', status: 'succeeded' });
    await assert.rejects(() => runtime.operations.create({ actorId: principal.actorId, commandId: 'p31.redaction', resourceType: 'fixture', resourceId: 'fixture_2', requestHash: 'c'.repeat(64), idempotencyKey: 'p31-redaction-key', status: 'succeeded' }), (error) => error.code === 'idempotency_conflict');
    const receipt = runtime.operations.getReceipt(runtime.db.get("SELECT id FROM operations WHERE command_id='p31.redaction'").id);
    assert.equal(JSON.stringify(receipt).includes('p31-session-secret'), false);
  } finally { close(state); }
});
