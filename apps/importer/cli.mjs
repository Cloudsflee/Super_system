#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCleanDatabase } from '../api/src/clean/database.mjs';
import { canonicalJson, opaqueId, sha256Hex } from '../api/src/clean/canonical.mjs';
import { logicalDatabaseHash, verifyResumeState } from './checkpoint.mjs';
import { V23DomainMapper } from './mapper.mjs';
import { buildPlan, MAPPING_FILE } from './planner.mjs';
import { consistentDatabaseCopy, digestFile, fsyncDirectory, fsyncFile } from './reader.mjs';
import { verifyTarget as verifyImportTarget } from './verifier.mjs';
import { switchPointer } from './pointer.mjs';

export const COMMANDS = Object.freeze(['inspect', 'dry-run', 'run', 'resume', 'verify', 'cutover', 'rollback']);
export { MAPPING_FILE, buildPlan, digestFile, switchPointer };

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) if (rest[index].startsWith('--')) options[rest[index].slice(2)] = rest[index + 1] && !rest[index + 1].startsWith('--') ? rest[++index] : true;
  return { command, options };
}

export async function runImport(options, resume = false) {
  const built = buildPlan(options);
  if (built.plan.blocking_conflicts.length) throw new Error(`import_plan_blocked:${built.plan.blocking_conflicts.map((item) => item.table).join(',')}`);
  const target = path.resolve(required(options.target, 'target'));
  const targetCas = path.resolve(String(options.targetCas || path.join(path.dirname(target), 'cas')));
  const sourceCasCount = Number(built.sources.v3.tables.find((table) => table.name === 'cas_objects')?.row_count || 0);
  if (sourceCasCount > 0 && !options.v3Cas) throw new Error('option_required:v3Cas');
  let db;
  let batch;
  try {
    if (!resume) {
      if (fs.existsSync(target) || fs.existsSync(targetCas)) throw new Error('target_must_be_new');
      await consistentDatabaseCopy(options.v3, target);
      if (options.v3Cas) copyCasRoot(path.resolve(String(options.v3Cas)), targetCas);
      db = openCleanDatabase(target, { targetVersion: 8, receiptRoot: path.join(path.dirname(target), 'migration-receipts') });
      const now = new Date().toISOString();
      const id = opaqueId('import_batch');
      db.run(`INSERT INTO import_batches(id,retry_of_batch_id,generation,source_v23_sha256,source_v3_sha256,plan_sha256,mapping_sha256,tool_sha256,target_sha256,status,revision,created_at,updated_at,completed_at)
        VALUES(?,NULL,1,?,?,?,?,?,'','running',1,?,?,NULL)`, [id, built.plan.source_v23_sha256, built.plan.source_v3_sha256, built.plan.plan_sha256, built.plan.mapping_sha256, built.plan.tool_sha256, now, now]);
      batch = db.get('SELECT * FROM import_batches WHERE id=?', [id]);
    } else {
      if (!fs.existsSync(target)) throw new Error('resume_target_missing');
      db = openCleanDatabase(target, { targetVersion: 8, receiptRoot: path.join(path.dirname(target), 'migration-receipts') });
      batch = db.get("SELECT * FROM import_batches WHERE source_v23_sha256=? AND source_v3_sha256=? AND status='running' ORDER BY generation DESC LIMIT 1", [built.plan.source_v23_sha256, built.plan.source_v3_sha256]);
      if (!batch) throw new Error('resume_batch_missing');
      verifyResumeState(db, batch, built.plan, options.checkpointKey);
    }

    const mapper = new V23DomainMapper({ db, batchId: batch.id, sourceFile: options.v23, sourceManifest: built.sources.v23, plan: built.plan, mapping: built.mapping, targetCasRoot: targetCas, checkpointKey: options.checkpointKey });
    let domains;
    try { domains = await mapper.mapAll({ failAfterDomain: options.failAfterDomain || options['fail-after-domain'] }); }
    finally { mapper.close(); }
    const blocked = Number(db.get("SELECT COUNT(*) AS count FROM import_conflicts WHERE batch_id=? AND disposition='blocked'", [batch.id]).count);
    if (blocked) {
      const blockingRows = db.query("SELECT entity_type,conflict_kind,details_sha256 FROM import_conflicts WHERE batch_id=? AND disposition='blocked' ORDER BY created_at,id", [batch.id]);
      const now = new Date().toISOString();
      db.run("UPDATE import_batches SET status='blocked',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='running'", [now, now, batch.id]);
      throw new Error(`import_blocking_conflicts:${blocked}:${blockingRows.map((row) => `${row.entity_type}/${row.conflict_kind}`).join(',')}`);
    }
    const targetSha = logicalDatabaseHash(db);
    const now = new Date().toISOString();
    db.run("UPDATE import_batches SET target_sha256=?,status='sealed',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='running'", [targetSha, now, now, batch.id]);
    db.exec('PRAGMA wal_checkpoint(FULL)');
    fsyncFile(target);
    fsyncDirectory(path.dirname(target));
    return { ...built, batch_id: batch.id, target_sha256: targetSha, target_file_sha256: digestFile(target), status: 'sealed', domains };
  } finally {
    if (db) {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;'); } catch { /* preserve the primary result */ }
      db.close();
    }
  }
}

export function verifyTarget(options) {
  const built = buildPlan(options);
  return verifyImportTarget(options, built);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (!COMMANDS.includes(command)) throw new Error(`command_required:${COMMANDS.join('|')}`);
  let result;
  if (command === 'inspect' || command === 'dry-run') result = buildPlan(options);
  else if (command === 'run') result = await runImport(options);
  else if (command === 'resume') result = await runImport(options, true);
  else if (command === 'verify') result = verifyTarget(options);
  else result = switchPointer(options, command === 'rollback');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

function copyCasRoot(source, target) {
  if (!fs.existsSync(source)) throw new Error('v3_cas_missing');
  if (fs.existsSync(target)) throw new Error('target_cas_must_be_new');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  const manifest = [];
  for (const file of walk(target)) { fsyncFile(file.absolute); manifest.push({ path: file.relative.replaceAll('\\', '/'), sha256: digestFile(file.absolute), byte_length: fs.statSync(file.absolute).size }); }
  fsyncDirectory(path.dirname(target));
  const receipt = { schema_version: 'aiws.import.cas-copy.v1', objects: manifest.sort((left, right) => left.path.localeCompare(right.path)) };
  receipt.receipt_sha256 = sha256Hex(canonicalJson(receipt));
  return receipt;
}

function walk(root, relative = '') {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...walk(root, child));
    else if (entry.isFile()) output.push({ absolute: path.join(root, child), relative: child });
  }
  return output;
}
function required(value, name) { if (!value || value === true) throw new Error(`option_required:${name}`); return String(value); }
