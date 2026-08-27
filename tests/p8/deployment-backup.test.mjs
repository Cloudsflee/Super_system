import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { approved, close, open, prepare } from './helpers.mjs';

const digest = 'd'.repeat(64);

test('Deployment candidate verification requires owner approval and creates an immutable receipt', async () => {
  const state = await open();
  try {
    const base = await prepare(state, 'deployment');
    assert.throws(() => state.runtime.p8Service.createDeploymentCandidate(candidateInput('missing', 0, 'p8-deploy-denied'), { ...state.principal, sessionId: 'missing' }), (error) => error.code === 'owner_session_required');
    const createApproval = await approved(state, base.project.id, 'deployment.create', {}, 'deployment-create');
    const created = await state.runtime.p8Service.createDeploymentCandidate(candidateInput(createApproval.id, 0, 'p8-deployment-create'), state.principal);
    assert.equal(created.candidate.status, 'candidate');
    const verifyApproval = await approved(state, base.project.id, 'deployment.verify', { candidate_id: created.candidate.id }, 'deployment-verify');
    const verified = await state.runtime.p8Service.verifyDeployment(created.candidate.id, {
      checks: [{ name: 'health', status: 'passed', passed: true }, { name: 'browser', status: 'passed', passed: true }],
      viewport_evidence: [{ viewport: '1440x900', screenshot_sha256: digest }], volume_manifest_sha256: digest,
      approval_id: verifyApproval.id, expected_revision: created.candidate.revision, idempotency_key: 'p8-deployment-verify'
    }, state.principal);
    assert.equal(verified.candidate.status, 'verified');
    assert.equal(verified.verification.status, 'passed');
    assert.equal(state.runtime.operations.get(verified.operation.operation_id, { actorId: state.principal.actorId }).status, 'succeeded');
    assert.throws(() => state.runtime.db.run("UPDATE deployment_verifications SET status='failed' WHERE id=?", [verified.verification.id]), /immutable_deployment_verification/);
  } finally { await close(state); }
});

test('Backup, restore.prepare and reset.prepare operate on new isolated artifacts without switching a pointer', async () => {
  const state = await open();
  try {
    const base = await prepare(state, 'backup');
    const backupApproval = await approved(state, base.project.id, 'backup.create', {}, 'backup-create');
    const backup = await state.runtime.p8Service.createBackup({ retention_class: 'diagnostic', components: { sqlite: true, cas: true }, approval_id: backupApproval.id, expected_revision: 0, idempotency_key: 'p8-backup-create' }, state.principal);
    assert.equal(backup.backup.source_user_version, 8);
    assert.match(backup.backup.manifest_sha256, /^[a-f0-9]{64}$/);
    const backupRoot = path.join(state.root, 'operations-artifacts', 'backups', backup.backup.id);
    assert.equal(fs.existsSync(path.join(backupRoot, 'manifest.json')), true);

    const restoreApproval = await approved(state, base.project.id, 'restore.prepare', { backup_id: backup.backup.id }, 'restore-prepare');
    const restore = await state.runtime.p8Service.prepareRestore({ backup_id: backup.backup.id, target_volume_ref: 'restore-volume', approval_id: restoreApproval.id, expected_revision: 0, idempotency_key: 'p8-restore-prepare' }, state.principal);
    assert.equal(restore.restore.status, 'prepared');
    assert.equal(restore.restore.pointer_switched, false);
    assert.equal(fs.existsSync(path.join(state.root, 'operations-artifacts', 'staging', 'restore-volume', 'manifest.json')), true);

    const resetApproval = await approved(state, base.project.id, 'system.reset.prepare', {}, 'reset-prepare');
    const reset = await state.runtime.p8Service.prepareReset({ target_volume_ref: 'reset-volume', preserve_backups: true, approval_id: resetApproval.id, expected_revision: 0, idempotency_key: 'p8-reset-prepare' }, state.principal);
    assert.equal(reset.reset.status, 'prepared');
    assert.equal(reset.reset.pointer_switched, false);
    assert.equal(fs.existsSync(path.join(state.root, 'operations-artifacts', 'staging', 'reset-volume', 'reset-manifest.json')), true);
  } finally { await close(state); }
});

function candidateInput(approvalId, revision, key) {
  return { app_digest: digest, broker_digest: digest, runner_digest: digest, parser_digest: digest, bridge_identity: 'bridge-fixture-identity', sbom_sha256: digest, source_tree_sha256: digest, lockfile_sha256: digest, gate_fingerprint: digest, compose_sha256: digest, volume_manifest: { sqlite: digest, cas: digest }, approval_id: approvalId, expected_revision: revision, idempotency_key: key };
}
