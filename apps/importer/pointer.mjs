import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../api/src/clean/canonical.mjs';
import { digestFile, fsyncDirectory, fsyncFile } from './reader.mjs';

export function switchPointer(options, rollback = false) {
  const pointer = path.resolve(required(options.pointer, 'pointer'));
  const target = path.resolve(required(options.target, 'target'));
  const approval = JSON.parse(fs.readFileSync(path.resolve(required(options.approval, 'approval')), 'utf8'));
  const now = Date.now();
  if (approval.status !== 'approved' || !Number.isFinite(Date.parse(approval.created_at)) || now - Date.parse(approval.created_at) > 15 * 60 * 1000) throw new Error('operator_approval_invalid');
  if (approval.target_sha256 !== digestFile(target)) throw new Error('operator_approval_target_mismatch');
  if (approval.verify_status !== 'passed') throw new Error('operator_approval_verify_required');
  const previous = fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : '';
  const next = rollback ? path.resolve(String(approval.rollback_target || previous)) : target;
  if (!fs.existsSync(next)) throw new Error('pointer_target_missing');
  const receiptBase = { schema_version: 'aiws.import.pointer-receipt.v1', action: rollback ? 'rollback' : 'cutover', previous_target_sha256: previous && fs.existsSync(previous) ? digestFile(previous) : null, target_sha256: digestFile(next), approval_sha256: sha256Hex(canonicalJson(approval)), dry_run: options.dryRun === true || options['dry-run'] === true };
  if (receiptBase.dry_run) return { ...receiptBase, status: 'verified', pointer_sha256: fs.existsSync(pointer) ? digestFile(pointer) : null };
  fs.mkdirSync(path.dirname(pointer), { recursive: true, mode: 0o700 });
  const temporary = `${pointer}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${next}\n`, { mode: 0o600, flag: 'wx' });
  fsyncFile(temporary);
  const priorBytes = fs.existsSync(pointer) ? fs.readFileSync(pointer) : null;
  try {
    try { fs.renameSync(temporary, pointer); }
    catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      fs.rmSync(pointer);
      fs.renameSync(temporary, pointer);
    }
    fsyncDirectory(path.dirname(pointer));
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (priorBytes && !fs.existsSync(pointer)) fs.writeFileSync(pointer, priorBytes, { mode: 0o600 });
    throw error;
  }
  const pointerSha = digestFile(pointer);
  const receipt = { ...receiptBase, status: rollback ? 'rolled_back' : 'cutover', pointer_sha256: pointerSha, target: path.basename(next), previous_target: previous ? path.basename(previous) : null };
  return { ...receipt, receipt_sha256: sha256Hex(canonicalJson(receipt)) };
}

function required(value, name) { if (!value || value === true) throw new Error(`option_required:${name}`); return String(value); }
