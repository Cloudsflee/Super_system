import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCleanDatabase } from '../apps/api/src/clean/database.mjs';
import { digestFile } from '../apps/importer/reader.mjs';
import { switchPointer } from '../apps/importer/pointer.mjs';
import { approved, close, open, prepare } from '../tests/p8/helpers.mjs';
import { emitProbe } from './lib/v3-clean-p6-runner-probe.mjs';

await emitProbe('aiws.v3-clean.p8-backup-restore-gc-probe.v2', async () => {
  const state = await open({ config: { runtimeBuild: 'v3-clean-p8-backup-restore-gc-probe' } });
  try {
    const base = await prepare(state, 'backup-gc-probe');
    const backupApproval = await approved(state, base.project.id, 'backup.create', {}, 'backup-gc-probe-backup');
    const backup = await state.runtime.p8Service.createBackup({ retention_class: 'diagnostic', components: { sqlite: true, cas: true }, approval_id: backupApproval.id, expected_revision: 0, idempotency_key: 'p8-backup-gc-probe-backup' }, state.principal);
    const restoreApproval = await approved(state, base.project.id, 'restore.prepare', { backup_id: backup.backup.id }, 'backup-gc-probe-restore');
    const restore = await state.runtime.p8Service.prepareRestore({ backup_id: backup.backup.id, target_volume_ref: 'probe-restore-volume', approval_id: restoreApproval.id, expected_revision: 0, idempotency_key: 'p8-backup-gc-probe-restore' }, state.principal);

    const object = state.runtime.cas.put(Buffer.from('p8-probe-unreferenced-object'));
    state.runtime.db.run("UPDATE cas_objects SET created_at='2000-01-01T00:00:00.000Z' WHERE sha256=?", [object.hash]);
    const plan = state.runtime.p8Service.gcPlan({ cutoff: '2026-01-01T00:00:00.000Z', limit: 100, expected_revision: 0, idempotency_key: 'p8-backup-gc-probe-plan' }, state.principal).plan;
    const gcApproval = await approved(state, base.project.id, 'cas.gc.apply', {}, 'backup-gc-probe-gc');
    const applied = await state.runtime.p8Service.gcApply({ plan, approval_id: gcApproval.id, expected_revision: 0, idempotency_key: 'p8-backup-gc-probe-apply' }, state.principal);
    const rolledBack = state.runtime.p8Service.rollbackGc(plan.plan_sha256);
    const pointer = pointerProbe(state.root);
    const schemaRollback = schemaRollbackProbe(state.root);
    return {
      backup: { id: backup.backup.id, manifest_sha256: backup.backup.manifest_sha256, source_user_version: backup.backup.source_user_version },
      restore: { status: restore.restore.status, pointer_switched: restore.restore.pointer_switched, source_manifest_sha256: restore.restore.source_manifest_sha256 },
      gc: { plan_sha256: plan.plan_sha256, candidates: plan.count, apply_status: applied.receipt.status, rollback_restored: rolledBack.restored, object_active: state.runtime.cas.has(object.hash) },
      pointer,
      schema_rollback: schemaRollback
    };
  } finally { await close(state); }
});

function pointerProbe(root) {
  const directory = path.join(root, 'pointer-probe');
  fs.mkdirSync(directory, { recursive: true });
  const oldTarget = path.join(directory, 'old.sqlite');
  const newTarget = path.join(directory, 'new.sqlite');
  const pointer = path.join(directory, 'active.ptr');
  const approvalFile = path.join(directory, 'approval.json');
  fs.writeFileSync(oldTarget, 'old-volume');
  fs.writeFileSync(newTarget, 'new-volume');
  fs.writeFileSync(pointer, `${oldTarget}\n`);
  fs.writeFileSync(approvalFile, JSON.stringify({ status: 'approved', created_at: new Date().toISOString(), target_sha256: digestFile(newTarget), verify_status: 'passed', rollback_target: oldTarget }));
  const dryRun = switchPointer({ pointer, target: newTarget, approval: approvalFile, dryRun: true });
  const applied = switchPointer({ pointer, target: newTarget, approval: approvalFile });
  const rollback = switchPointer({ pointer, target: newTarget, approval: approvalFile }, true);
  return { dry_run_status: dryRun.status, apply_status: applied.status, rollback_status: rollback.status, restored_old_target: fs.readFileSync(pointer, 'utf8').trim() === oldTarget };
}

function schemaRollbackProbe(root) {
  const source = path.join(root, 'rollback-source-v7.sqlite');
  const restored = path.join(root, 'rollback-applied-v7.sqlite');
  openCleanDatabase(source, { targetVersion: 7, receiptRoot: path.join(root, 'rollback-receipts') }).close();
  fs.copyFileSync(source, restored);
  const db = openCleanDatabase(restored, { targetVersion: 7, receiptRoot: path.join(root, 'rollback-receipts') });
  try {
    const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('deliveries','deployment_candidates','import_batches','backup_manifests')");
    return { restored_user_version: db.integrity().user_version, byte_exact: digestFile(source) === digestFile(restored), p8_tables_absent: tables.length === 0, ledger: db.query('SELECT version FROM schema_migrations ORDER BY version').map((row) => row.version) };
  } finally { db.close(); }
}
