import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex } from '../api/src/clean/canonical.mjs';
import { fsyncDirectory, fsyncFile, quoteIdentifier } from './reader.mjs';

const EXCLUDED = new Set(['import_batches', 'import_checkpoints', 'import_id_map', 'import_conflicts']);

export function writeCheckpoint(db, { batchId, domain, lastSourceKey, rowCount, plan, key, now = new Date().toISOString() }) {
  const targetSha = logicalDatabaseHash(db);
  const sourceSha = sha256Hex(canonicalJson({ v23: plan.source_v23_sha256, v3: plan.source_v3_sha256 }));
  const body = {
    schema_version: 'aiws.v3-clean.import-checkpoint.v2', batch_id: batchId, domain, last_source_key: String(lastSourceKey), row_count: Number(rowCount),
    source_sha256: sourceSha, plan_sha256: plan.plan_sha256, mapping_sha256: plan.mapping_sha256, tool_sha256: plan.tool_sha256, target_sha256: targetSha, fsynced_at: now
  };
  const checkpointSha = sha256Hex(canonicalJson(body));
  const signature = createHmac('sha256', checkpointKey(key, plan)).update(checkpointSha).digest('hex');
  db.run('INSERT INTO import_checkpoints(id,batch_id,domain,last_source_key,row_count,source_sha256,plan_sha256,mapping_sha256,tool_sha256,target_sha256,checkpoint_sha256,signature,fsynced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [opaqueId('import_checkpoint'), batchId, domain, body.last_source_key, body.row_count, sourceSha, plan.plan_sha256, plan.mapping_sha256, plan.tool_sha256, targetSha, checkpointSha, signature, now]);
  db.exec('PRAGMA wal_checkpoint(FULL)');
  fsyncFile(db.file);
  fsyncDirectory(path.dirname(db.file));
  return { ...body, checkpoint_sha256: checkpointSha, signature };
}

export function verifyResumeState(db, batch, plan, key) {
  for (const field of ['source_v23_sha256', 'source_v3_sha256', 'plan_sha256', 'mapping_sha256', 'tool_sha256']) if (String(batch[field]) !== String(plan[field])) throw new Error(`resume_hash_mismatch:${field}`);
  const checkpoint = db.get('SELECT * FROM import_checkpoints WHERE batch_id=? ORDER BY fsynced_at DESC,id DESC LIMIT 1', [batch.id]);
  if (!checkpoint) throw new Error('resume_checkpoint_missing');
  const body = {
    schema_version: 'aiws.v3-clean.import-checkpoint.v2', batch_id: batch.id, domain: checkpoint.domain, last_source_key: checkpoint.last_source_key, row_count: Number(checkpoint.row_count),
    source_sha256: checkpoint.source_sha256, plan_sha256: checkpoint.plan_sha256, mapping_sha256: checkpoint.mapping_sha256, tool_sha256: checkpoint.tool_sha256, target_sha256: checkpoint.target_sha256, fsynced_at: checkpoint.fsynced_at
  };
  const expectedSha = sha256Hex(canonicalJson(body));
  const expectedSignature = createHmac('sha256', checkpointKey(key, plan)).update(expectedSha).digest('hex');
  if (expectedSha !== checkpoint.checkpoint_sha256 || expectedSignature !== checkpoint.signature) throw new Error('resume_checkpoint_signature_invalid');
  const targetSha = logicalDatabaseHash(db);
  if (targetSha !== checkpoint.target_sha256) throw new Error('resume_hash_mismatch:checkpoint_target_sha256');
  return checkpoint;
}

export function logicalDatabaseHash(db) {
  const hash = createHash('sha256');
  const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name).filter((name) => !EXCLUDED.has(name) && !isShadow(db, name));
  for (const table of tables) {
    const columns = db.query(`PRAGMA table_info(${quoteIdentifier(table)})`);
    const keys = columns.filter((column) => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk)).map((column) => column.name);
    const order = keys.length ? keys : columns.map((column) => column.name);
    const rows = db.query(`SELECT * FROM ${quoteIdentifier(table)}${order.length ? ` ORDER BY ${order.map(quoteIdentifier).join(',')}` : ''}`);
    hash.update(table).update('\n');
    for (const row of rows) hash.update(canonicalJson(normalizeRow(row))).update('\n');
  }
  return hash.digest('hex');
}

export function checkpointKey(value, plan) {
  if (value && value !== true) return Buffer.from(String(value), 'utf8');
  return Buffer.from(sha256Hex(canonicalJson({ source_v23_sha256: plan.source_v23_sha256, source_v3_sha256: plan.source_v3_sha256, tool_sha256: plan.tool_sha256 })), 'hex');
}

function isShadow(db, name) { return db.query('PRAGMA table_list').some((row) => row.name === name && row.type === 'shadow'); }
function normalizeRow(row) { return Object.fromEntries(Object.entries(row).map(([field, value]) => [field, Buffer.isBuffer(value) || value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value])); }
