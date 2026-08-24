import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { close, createAssistPrerequisites, createProject, createWorkspace, open, waitForOperation } from './helpers.mjs';

test('Assist persists opaque provider lineage and enforces completion, interaction and retry invariants', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'assist');
    const { pack, profile } = await createAssistPrerequisites(state, project, 'assist');
    const createdSession = await state.runtime.assist.createSession({
      project_id: project.id, scope: 'project', scope_id: project.id,
      context_pack_id: pack.id, profile_id: profile.id, idempotency_key: 'p5-assist-session-key'
    }, state.principal);
    const session = createdSession.session;
    assert.equal(createdSession.operation.status, 'succeeded');
    const queued = await state.runtime.assist.createTurn({
      session_id: session.id, expected_revision: session.revision, message: 'complete this turn', defer: true,
      idempotency_key: 'p5-assist-turn-key'
    }, state.principal);
    const first = state.runtime.db.get('SELECT * FROM assist_turns WHERE operation_id=?', [queued.operation_id]);
    const completed = await state.runtime.assist.executeTurn(first.id, state.principal);
    assert.equal(completed.status, 'completed');
    assert.match(completed.provider_turn_id, /^provider_turn_/);
    assert.deepEqual(completed.messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(state.runtime.operations.get(first.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');

    let sessionRevision = state.runtime.db.get('SELECT revision FROM assist_sessions WHERE id=?', [session.id]).revision;
    const waitingOperation = await state.runtime.assist.createTurn({
      session_id: session.id, expected_revision: sessionRevision, message: 'wait for input', defer: true,
      fixture: { pending_input: { prompt_summary: 'Choose', input_schema: { type: 'string' } } },
      idempotency_key: 'p5-assist-waiting-key'
    }, state.principal);
    let waiting = state.runtime.db.get('SELECT * FROM assist_turns WHERE operation_id=?', [waitingOperation.operation_id]);
    await state.runtime.assist.executeTurn(waiting.id, state.principal);
    waiting = state.runtime.db.get('SELECT * FROM assist_turns WHERE id=?', [waiting.id]);
    assert.equal(waiting.status, 'awaiting_input');
    assert.equal(state.runtime.db.get('SELECT status FROM operations WHERE id=?', [waiting.operation_id]).status, 'paused');
    const input = state.runtime.db.get('SELECT * FROM runtime_user_inputs WHERE assist_turn_id=?', [waiting.id]);
    await state.runtime.assist.answerInput(input.id, {
      response: { value: 'continue' }, expected_revision: input.revision, idempotency_key: 'p5-assist-answer-key'
    }, state.principal);
    assert.equal((await waitForOperation(state.runtime, waiting.operation_id, state.principal.actorId)).status, 'succeeded');
    assert.equal(state.runtime.db.get('SELECT status FROM assist_turns WHERE id=?', [waiting.id]).status, 'completed');

    sessionRevision = state.runtime.db.get('SELECT revision FROM assist_sessions WHERE id=?', [session.id]).revision;
    const incompleteOperation = await state.runtime.assist.createTurn({
      session_id: session.id, expected_revision: sessionRevision, message: 'incomplete provider output', defer: true,
      fixture: { missing_terminal: true }, idempotency_key: 'p5-assist-incomplete-key'
    }, state.principal);
    let incomplete = state.runtime.db.get('SELECT * FROM assist_turns WHERE operation_id=?', [incompleteOperation.operation_id]);
    await assert.rejects(() => state.runtime.assist.executeTurn(incomplete.id, state.principal), (error) => error.code === 'assist_output_incomplete');
    incomplete = state.runtime.db.get('SELECT * FROM assist_turns WHERE id=?', [incomplete.id]);
    assert.equal(state.runtime.db.get('SELECT status FROM operations WHERE id=?', [incomplete.operation_id]).status, 'failed');
    const retry = await state.runtime.assist.retryTurn(incomplete.id, {
      expected_revision: incomplete.revision, fixture: { assistant: 'retry complete' }, idempotency_key: 'p5-assist-retry-key'
    }, state.principal);
    assert.equal((await waitForOperation(state.runtime, retry.operation_id, state.principal.actorId)).status, 'succeeded');
    const retried = state.runtime.db.get('SELECT * FROM assist_turns WHERE id=?', [incomplete.id]);
    assert.equal(retried.attempt, 2);
    assert.equal(state.runtime.db.get("SELECT relation FROM operation_links WHERE operation_id=? AND aggregate_type='operation' AND aggregate_id=?", [retry.operation_id, incomplete.operation_id]).relation, 'retry_of');
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});

test('Attachments enforce bounded previews and file batches apply and undo under Repository fencing', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'files');
    const { workspace, directory } = await createWorkspace(state, project, 'files');
    fs.writeFileSync(path.join(directory, 'alpha.txt'), 'before');
    const attachment = await state.runtime.files.createAttachment({
      project_id: project.id, filename: 'note.json', media_type: 'application/json',
      content_base64: Buffer.from('{"ok":true}').toString('base64'), idempotency_key: 'p5-attachment-key'
    }, state.principal);
    assert.equal(attachment.attachment.disposition, 'preview');
    assert.equal(Buffer.from(state.runtime.files.attachmentContent(attachment.attachment.id, state.principal, { preview: true }).content_base64, 'base64').toString('utf8'), '{"ok":true}');
    const quarantined = await state.runtime.files.createAttachment({
      project_id: project.id, filename: 'mismatch.png', media_type: 'image/png',
      content_base64: Buffer.from('plain text').toString('base64'), idempotency_key: 'p5-attachment-quarantine-key'
    }, state.principal);
    assert.equal(quarantined.attachment.status, 'quarantined');

    const created = await state.runtime.files.createBatch({
      project_id: project.id, workspace_id: workspace.id,
      changes: [{ path: 'alpha.txt', action: 'replace', content: 'after' }, { path: 'beta.txt', action: 'create', content: 'new' }],
      idempotency_key: 'p5-batch-key'
    }, state.principal);
    const approved = await state.runtime.files.approveBatch(created.batch.id, {
      expected_revision: created.batch.revision, idempotency_key: 'p5-batch-approve-key'
    }, state.principal);
    const applying = await state.runtime.files.applyBatch(created.batch.id, {
      expected_revision: approved.batch.revision, idempotency_key: 'p5-batch-apply-key'
    }, state.principal);
    assert.equal((await waitForOperation(state.runtime, applying.operation_id, state.principal.actorId)).status, 'succeeded');
    const applied = state.runtime.files.reviewBatch(created.batch.id, state.principal);
    assert.equal(applied.batch.status, 'applied');
    assert.deepEqual(applied.items.map((item) => item.status), ['applied', 'applied']);
    assert.equal(fs.readFileSync(path.join(directory, 'alpha.txt'), 'utf8'), 'after');
    const replay = await state.runtime.files.applyBatch(created.batch.id, {
      expected_revision: approved.batch.revision, idempotency_key: 'p5-batch-apply-key'
    }, state.principal);
    assert.equal(replay.replayed, true);
    assert.equal(replay.operation_id, applying.operation_id);
    const undoing = await state.runtime.files.undoBatch(created.batch.id, {
      expected_revision: applied.batch.revision, idempotency_key: 'p5-batch-undo-key'
    }, state.principal);
    assert.equal((await waitForOperation(state.runtime, undoing.operation_id, state.principal.actorId)).status, 'succeeded');
    assert.equal(fs.readFileSync(path.join(directory, 'alpha.txt'), 'utf8'), 'before');
    assert.equal(fs.existsSync(path.join(directory, 'beta.txt')), false);
    assert.equal(state.runtime.db.get("SELECT count(*) AS count FROM file_change_items WHERE status!='pending'").count, 0);
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});
