import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { close, createAssistPrerequisites, createProject, createWorkspace, open } from './helpers.mjs';

test('P5 resource mutations persist one operation receipt and replay without duplicate rows', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'mutation-receipts');
    const { pack, profile } = await createAssistPrerequisites(state, project, 'mutation-receipts');
    const created = await state.runtime.assist.createSession({
      project_id: project.id, scope: 'project', scope_id: project.id,
      context_pack_id: pack.id, profile_id: profile.id, idempotency_key: 'p5-mutation-session-key'
    }, state.principal);
    let session = created.session;

    const goalRequest = { expected_revision: session.revision, goal: { objective: 'Keep receipts atomic' }, idempotency_key: 'p5-mutation-goal-key' };
    const goal = await state.runtime.assist.updateGoal(session.id, goalRequest, state.principal);
    const goalReplay = await state.runtime.assist.updateGoal(session.id, goalRequest, state.principal);
    assert.equal(goalReplay.replayed, true);
    assert.equal(goalReplay.goal.id, goal.goal.id);
    assert.equal(goalReplay.operation.operation_id, goal.operation.operation_id);
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM assist_goals WHERE session_id=?', [session.id]).count, 1);

    session = state.runtime.db.get('SELECT * FROM assist_sessions WHERE id=?', [session.id]);
    const referenceRequest = { expected_revision: session.revision, reference_type: 'context_pack', reference_id: pack.id, reference_hash: pack.pack_hash, metadata: { source: 'test' }, idempotency_key: 'p5-mutation-reference-key' };
    const reference = await state.runtime.assist.createReference(session.id, referenceRequest, state.principal);
    const referenceReplay = await state.runtime.assist.createReference(session.id, referenceRequest, state.principal);
    assert.equal(referenceReplay.replayed, true);
    assert.equal(referenceReplay.references[0].id, reference.references[0].id);
    assert.equal(referenceReplay.operation.operation_id, reference.operation.operation_id);
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM assist_references WHERE session_id=?', [session.id]).count, 1);

    const approvalRequest = { project_id: project.id, action: 'terminal.open', request: { purpose: 'test' }, expected_revision: 0, idempotency_key: 'p5-mutation-approval-key' };
    const approval = await state.runtime.assist.createApproval(approvalRequest, state.principal);
    const approvalReplay = await state.runtime.assist.createApproval(approvalRequest, state.principal);
    assert.equal(approvalReplay.replayed, true);
    assert.equal(approvalReplay.operation.operation_id, approval.operation.operation_id);
    const decisionRequest = { decision: 'approved', expected_revision: approval.approval.revision, idempotency_key: 'p5-mutation-decision-key' };
    const decision = await state.runtime.assist.decideApproval(approval.approval.id, decisionRequest, state.principal);
    const decisionReplay = await state.runtime.assist.decideApproval(approval.approval.id, decisionRequest, state.principal);
    assert.equal(decisionReplay.replayed, true);
    assert.equal(decisionReplay.operation.operation_id, decision.operation.operation_id);

    const inputRequest = { project_id: project.id, prompt_summary: 'Choose a mode', input_schema: { type: 'string' }, expected_revision: 0, idempotency_key: 'p5-mutation-input-key' };
    const input = await state.runtime.assist.createInput(inputRequest, state.principal);
    const inputReplay = await state.runtime.assist.createInput(inputRequest, state.principal);
    assert.equal(inputReplay.replayed, true);
    const answerRequest = { response: { value: 'continue' }, expected_revision: input.input.revision, idempotency_key: 'p5-mutation-answer-key' };
    const answer = await state.runtime.assist.answerInput(input.input.id, answerRequest, state.principal);
    const answerReplay = await state.runtime.assist.answerInput(input.input.id, answerRequest, state.principal);
    assert.equal(answerReplay.replayed, true);
    assert.equal(answerReplay.operation.operation_id, answer.operation.operation_id);

    const proposalRequest = { project_id: project.id, proposal_type: 'metadata', target_type: 'project', target_id: project.id, target_revision: project.revision, payload: { label: 'verified' }, expected_revision: 0, idempotency_key: 'p5-mutation-proposal-key' };
    const proposal = await state.runtime.assist.createProposal(proposalRequest, state.principal);
    const proposalReplay = await state.runtime.assist.createProposal(proposalRequest, state.principal);
    assert.equal(proposalReplay.replayed, true);
    const applyRequest = { expected_revision: proposal.proposal.revision, idempotency_key: 'p5-mutation-proposal-apply-key' };
    const applied = await state.runtime.assist.mutateProposal(proposal.proposal.id, 'apply', applyRequest, state.principal);
    const appliedReplay = await state.runtime.assist.mutateProposal(proposal.proposal.id, 'apply', applyRequest, state.principal);
    assert.equal(appliedReplay.replayed, true);
    const undoRequest = { expected_revision: applied.proposal.revision, idempotency_key: 'p5-mutation-proposal-undo-key' };
    const undone = await state.runtime.assist.mutateProposal(proposal.proposal.id, 'undo', undoRequest, state.principal);
    assert.equal(undone.proposal.status, 'cancelled');

    const attachment = await state.runtime.files.createAttachment({
      project_id: project.id, filename: 'delete.txt', media_type: 'text/plain',
      content_base64: Buffer.from('delete me').toString('base64'), idempotency_key: 'p5-mutation-attachment-key'
    }, state.principal);
    const deleteRequest = { expected_revision: attachment.attachment.revision, idempotency_key: 'p5-mutation-attachment-delete-key' };
    const deleted = await state.runtime.files.deleteAttachment(attachment.attachment.id, deleteRequest, state.principal);
    const deletedReplay = await state.runtime.files.deleteAttachment(attachment.attachment.id, deleteRequest, state.principal);
    assert.equal(deletedReplay.replayed, true);
    assert.equal(deletedReplay.operation.operation_id, deleted.operation.operation_id);
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});

test('Files recovery completes a partially replaced batch from before and after hashes', async () => {
  const state = await open();
  try {
    const project = await createProject(state, 'files-recovery');
    const { workspace, directory } = await createWorkspace(state, project, 'files-recovery');
    fs.writeFileSync(path.join(directory, 'alpha.txt'), 'before');
    const created = await state.runtime.files.createBatch({
      project_id: project.id, workspace_id: workspace.id,
      changes: [{ path: 'alpha.txt', action: 'replace', content: 'after' }, { path: 'beta.txt', action: 'create', content: 'created' }],
      idempotency_key: 'p5-recovery-batch-key'
    }, state.principal);
    const approved = await state.runtime.files.approveBatch(created.batch.id, { expected_revision: created.batch.revision, idempotency_key: 'p5-recovery-approve-key' }, state.principal);
    const queued = await state.runtime.files.applyBatch(created.batch.id, { expected_revision: approved.batch.revision, idempotency_key: 'p5-recovery-apply-key', defer: true }, state.principal);
    fs.writeFileSync(path.join(directory, 'alpha.txt'), 'after');

    assert.equal(await state.runtime.files.recoverPending(), 1);
    assert.equal(fs.readFileSync(path.join(directory, 'alpha.txt'), 'utf8'), 'after');
    assert.equal(fs.readFileSync(path.join(directory, 'beta.txt'), 'utf8'), 'created');
    assert.equal(state.runtime.files.reviewBatch(created.batch.id, state.principal).batch.status, 'applied');
    assert.equal(state.runtime.operations.get(queued.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');
    assert.equal(state.runtime.db.integrity().semantic.valid, true);
  } finally { await close(state); }
});

test('Bridge transfer replay does not invoke bundle verification twice', async () => {
  const state = await open();
  try {
    const paired = await state.runtime.bridge.pair({ label: 'Transfer Bridge', expected_revision: 0, idempotency_key: 'p5-transfer-pair-key' }, state.principal);
    let calls = 0;
    state.runtime.bridge.adapter = { verifyBundle: async () => { calls += 1; return { verified: true }; } };
    const request = {
      direction: 'send', transfer_type: 'git_bundle', repository_ref: 'refs/heads/main',
      head_sha: 'a'.repeat(40), bundle_sha256: 'b'.repeat(64), byte_length: 1024,
      expected_revision: paired.device.revision, idempotency_key: 'p5-transfer-create-key'
    };
    const transfer = await state.runtime.bridge.createTransfer(paired.device.id, request, state.principal);
    const replay = await state.runtime.bridge.createTransfer(paired.device.id, request, state.principal);
    assert.equal(replay.replayed, true);
    assert.equal(replay.transfer.id, transfer.transfer.id);
    assert.equal(replay.operation.operation_id, transfer.operation.operation_id);
    assert.equal(calls, 1);
    assert.equal(state.runtime.db.get('SELECT count(*) AS count FROM bridge_transfers').count, 1);
  } finally { await close(state); }
});
