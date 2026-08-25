import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseAssetBytes } from '../../apps/parser-worker/parser-engine.mjs';
import { close, createProject, open, waitOperation } from './helpers.mjs';

test('Evidence capture and Parser receipt create an immutable verified lineage', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'parser-evidence');
    const captured = await state.runtime.evidence.capture({
      project_id: project.id, logical_name: 'sample.json', asset_kind: 'other', source_type: 'manual', source_ref: 'fixture:sample',
      media_type: 'application/json', content_base64: Buffer.from('{"ok":true}').toString('base64'), expected_revision: 0, idempotency_key: 'p7-parser-capture-key'
    }, state.principal);
    const started = await state.runtime.parser.start(captured.asset.id, captured.asset.current_version_id, { format_key: 'json', expected_revision: captured.asset.revision, idempotency_key: 'p7-parser-start-key' }, state.principal);
    const operation = await waitOperation(state.runtime, started.operation.operation_id, state.principal.actorId);
    const run = state.runtime.db.get('SELECT * FROM parser_runs ORDER BY created_at DESC LIMIT 1');
    assert.equal(operation.status, 'succeeded');
    assert.equal(run.status, 'parsed');
    assert.match(run.receipt_sha256, /^[a-f0-9]{64}$/);
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM assets').count, 2);
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM asset_relations').count, 1);
    assert.throws(() => state.runtime.db.run("UPDATE asset_versions SET content_sha256=?", ['f'.repeat(64)]), /immutable_asset_version/);
    assert.throws(() => state.runtime.db.run("UPDATE parser_runs SET status='failed' WHERE id=?", [run.id]), /immutable_terminal_parser_run/);
    assert.deepEqual(state.runtime.db.integrity().foreign_key_check, []);
  } finally { await close(state); }
});

test('Parser engine rejects malformed, external-entity and quota inputs deterministically', async () => {
  assert.equal((await parseAssetBytes(Buffer.from('{bad'), 'json')).status, 'invalid');
  assert.equal((await parseAssetBytes(Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///x">]><x>&e;</x>'), 'xml')).error_code, 'parser_invalid_external_entity');
  const limited = await parseAssetBytes(Buffer.from('abcdef'), 'text', { limits: { max_text_chars: 5 } });
  assert.equal(limited.status, 'resource_exceeded');
  assert.equal((await parseAssetBytes(Buffer.from('not a pdf'), 'pdf')).error_code, 'parser_media_signature_mismatch');
});

test('Evidence idempotency, CAS tamper and tombstone boundaries are enforced', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'evidence-boundaries');
    const input = { project_id: project.id, logical_name: 'artifact.txt', source_type: 'manual', source_ref: 'fixture:artifact', media_type: 'text/plain', content_base64: Buffer.from('bounded artifact').toString('base64'), expected_revision: 0, idempotency_key: 'p7-evidence-idempotent' };
    const first = await state.runtime.evidence.capture(input, state.principal);
    const replay = await state.runtime.evidence.capture(input, state.principal);
    assert.equal(replay.replayed, true);
    assert.equal(replay.asset.id, first.asset.id);
    const version = state.runtime.db.get('SELECT blob_id FROM asset_versions WHERE id=?', [first.asset.current_version_id]);
    const blob = state.runtime.db.get('SELECT cas_sha256 FROM asset_blobs WHERE id=?', [version.blob_id]);
    const original = state.runtime.cas.read(blob.cas_sha256);
    fs.writeFileSync(state.runtime.cas.fileFor(blob.cas_sha256), 'tampered evidence');
    assert.throws(() => state.runtime.evidence.content(first.asset.id, first.asset.current_version_id, state.principal), (error) => error.code === 'cas_tamper');
    fs.writeFileSync(state.runtime.cas.fileFor(blob.cas_sha256), original);
    const tombstoned = await state.runtime.evidence.tombstone(first.asset.id, { expected_revision: first.asset.revision, idempotency_key: 'p7-evidence-tombstone' }, state.principal);
    assert.equal(tombstoned.asset.status, 'tombstoned');
    assert.throws(() => state.runtime.evidence.content(first.asset.id, first.asset.current_version_id, state.principal), (error) => error.code === 'asset_tombstoned');
  } finally { await close(state); }
});
