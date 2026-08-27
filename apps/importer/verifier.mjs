import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256Hex } from '../api/src/clean/canonical.mjs';
import { checkpointKey } from './checkpoint.mjs';
import { fieldDisposition } from './planner.mjs';
import { digestFile, quoteIdentifier, SqliteSourceReader } from './reader.mjs';

export function verifyTarget(options, planned) {
  const target = path.resolve(required(options.target, 'target'));
  const targetCas = path.resolve(String(options.targetCas || path.join(path.dirname(target), 'cas')));
  const db = new DatabaseSync(target, { readOnly: true });
  const failures = [];
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().map(normalizeRow);
    if (integrity.some((value) => value !== 'ok')) failures.push('integrity');
    if (foreignKeys.length) failures.push('foreign_keys');
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (userVersion !== 8) failures.push('user_version');
    const batch = db.prepare("SELECT * FROM import_batches WHERE status IN ('sealed','cutover') ORDER BY created_at DESC,id LIMIT 1").get();
    if (!batch) failures.push('sealed_batch');
    const plan = planned?.plan || planned || null;
    const mappingConfig = planned?.mapping || null;
    if (batch && plan) for (const field of ['source_v23_sha256', 'source_v3_sha256', 'plan_sha256', 'mapping_sha256', 'tool_sha256']) if (batch[field] !== plan[field]) failures.push(`batch_${field}`);

    const checkpoint = batch ? verifyCheckpoints(db, batch, plan, options.checkpointKey, failures) : { count: 0, domains: [] };
    const v3 = compareV3Rows(options.v3, target);
    if (v3.missing.length || v3.changed.length) failures.push('v3_preservation');
    const mapping = verifyMappings(db, batch, plan, failures);
    const heads = verifyHeads(db, batch, failures);
    const acl = verifyAcl(db, batch, failures);
    const cas = verifyCas(db, targetCas, failures);
    const credentials = verifyCredentials(db, failures);
    const redaction = verifyRedaction(options.v23, target, plan, mappingConfig, failures);
    const result = {
      schema_version: 'aiws.import.verify.v2', status: failures.length ? 'failed' : 'passed', user_version: userVersion,
      integrity, foreign_keys: foreignKeys, batch_id: batch?.id || null, source_preservation: v3, mapping, checkpoints: checkpoint,
      heads, acl, cas, credentials, redaction, target_file_sha256: digestFile(target), failures
    };
    return result;
  } finally { db.close(); }
}

function verifyCheckpoints(db, batch, plan, key, failures) {
  const rows = db.prepare('SELECT * FROM import_checkpoints WHERE batch_id=? ORDER BY fsynced_at,id').all(batch.id);
  const invalid = [];
  const domains = new Set();
  for (const row of rows) {
    domains.add(row.domain);
    const body = { schema_version: 'aiws.v3-clean.import-checkpoint.v2', batch_id: batch.id, domain: row.domain, last_source_key: row.last_source_key, row_count: Number(row.row_count), source_sha256: row.source_sha256, plan_sha256: row.plan_sha256, mapping_sha256: row.mapping_sha256, tool_sha256: row.tool_sha256, target_sha256: row.target_sha256, fsynced_at: row.fsynced_at };
    const sha = sha256Hex(canonicalJson(body));
    const signature = plan ? createHmac('sha256', checkpointKey(key, plan)).update(sha).digest('hex') : row.signature;
    if (sha !== row.checkpoint_sha256 || signature !== row.signature) invalid.push(row.id);
  }
  const missingDomains = plan ? plan.domain_order.filter((domain) => !rows.some((row) => row.domain === domain && row.last_source_key === `boundary:${domain}`)) : [];
  if (invalid.length) failures.push('checkpoint_signature');
  if (missingDomains.length) failures.push('checkpoint_domains');
  return { count: rows.length, domains: [...domains].sort(), invalid, missing_domains: missingDomains };
}

function compareV3Rows(sourceFile, targetFile) {
  const source = new SqliteSourceReader(required(sourceFile, 'v3'), { expectedVersion: 7 });
  const target = new SqliteSourceReader(targetFile);
  const missing = [];
  const changed = [];
  let compared = 0;
  try {
    for (const table of source.tables()) {
      if (table.name === 'schema_meta') continue;
      const targetTable = target.tables().find((item) => item.name === table.name);
      if (!targetTable) { missing.push(`${table.name}:table`); continue; }
      const targetRows = new Map();
      for (let offset = 0;; offset += 500) { const rows = target.rows(table.name, { offset, limit: 500 }); if (!rows.length) break; for (const row of rows) targetRows.set(rowKey(targetTable, row), canonicalJson(row)); }
      for (let offset = 0;; offset += 500) {
        const rows = source.rows(table.name, { offset, limit: 500 });
        if (!rows.length) break;
        for (const row of rows) { compared += 1; const key = rowKey(table, row); if (!targetRows.has(key)) missing.push(`${table.name}:${key}`); else if (targetRows.get(key) !== canonicalJson(row)) changed.push(`${table.name}:${key}`); }
      }
    }
  } finally { source.close(); target.close(); }
  return { compared_rows: compared, missing: missing.slice(0, 100), changed: changed.slice(0, 100) };
}

function verifyMappings(db, batch, plan, failures) {
  if (!batch || !plan) return { expected_rows: 0, mapped_rows: 0, blocking_conflicts: 0 };
  const expected = plan.classifications.filter((table) => table.disposition === 'target').reduce((sum, table) => sum + Number(table.row_count), 0);
  const mapped = Number(db.prepare("SELECT COUNT(*) AS count FROM import_id_map WHERE batch_id=? AND source_family='v23'").get(batch.id).count);
  const blocking = Number(db.prepare("SELECT COUNT(*) AS count FROM import_conflicts WHERE batch_id=? AND disposition='blocked'").get(batch.id).count);
  if (mapped !== expected) failures.push('row_mapping_count');
  if (blocking) failures.push('blocking_conflicts');
  return { expected_rows: expected, mapped_rows: mapped, blocking_conflicts: blocking };
}

function verifyHeads(db, batch, failures) {
  if (!batch) return { mapped_aggregates: 0, missing: [] };
  const types = { users: 'actor', credential_refs: 'credential', codex_profiles: 'profile', projects: 'project', brief_revisions: 'brief_revision', repository_bindings: 'repository_connection', workflow_revisions: 'workflow_revision', context_sources: 'context_source' };
  const rows = db.prepare("SELECT entity_type,target_id FROM import_id_map WHERE batch_id=? AND source_family='v23'").all(batch.id);
  const missing = [];
  for (const row of rows) {
    const type = types[row.entity_type] || 'asset';
    if (!db.prepare('SELECT 1 AS ok FROM aggregate_heads WHERE aggregate_type=? AND aggregate_id=?').get(type, row.target_id)) missing.push(`${type}:${row.target_id}`);
  }
  if (missing.length) failures.push('aggregate_heads');
  return { mapped_aggregates: rows.length, missing: missing.slice(0, 100) };
}

function verifyAcl(db, batch, failures) {
  if (!batch) return { projects: 0, missing_owner_memberships: [] };
  const rows = db.prepare("SELECT p.id,p.owner_actor_id FROM projects p JOIN import_id_map m ON m.target_id=p.id AND m.entity_type='projects' AND m.batch_id=?").all(batch.id);
  const missing = rows.filter((row) => !db.prepare("SELECT 1 AS ok FROM project_memberships WHERE project_id=? AND actor_id=? AND role='owner' AND status='active'").get(row.id, row.owner_actor_id)).map((row) => row.id);
  if (missing.length) failures.push('project_acl');
  return { projects: rows.length, missing_owner_memberships: missing };
}

function verifyCas(db, root, failures) {
  const rows = db.prepare("SELECT sha256,byte_length,relative_key,status FROM cas_objects WHERE status='active' ORDER BY sha256").all();
  const missing = [];
  const changed = [];
  for (const row of rows) {
    const file = path.join(root, String(row.relative_key).replaceAll('/', path.sep));
    if (!fs.existsSync(file)) { missing.push(row.sha256); continue; }
    const bytes = fs.readFileSync(file);
    if (bytes.byteLength !== Number(row.byte_length) || sha256Hex(bytes) !== row.sha256) changed.push(row.sha256);
  }
  if (missing.length || changed.length) failures.push('cas');
  return { active_objects: rows.length, missing, changed };
}

function verifyCredentials(db, failures) {
  const rows = db.prepare("SELECT status,external_ref,metadata_json FROM credential_refs WHERE metadata_json LIKE '%\"imported\":true%'").all();
  const invalid = rows.filter((row) => row.status !== 'rebind_required' || String(row.external_ref).startsWith('vault:')).length;
  if (invalid) failures.push('credential_rebind');
  return { imported: rows.length, invalid, secret_values_persisted: false };
}

function verifyRedaction(sourceFile, targetFile, plan, mapping, failures) {
  if (!plan) return { omitted_values_checked: 0, leaked: [], absolute_paths: [] };
  const source = new SqliteSourceReader(required(sourceFile, 'v23'), { expectedVersion: 23 });
  const targetBytes = fs.readFileSync(targetFile);
  const leaked = [];
  let checked = 0;
  try {
    for (const classification of plan.classifications) {
      if (classification.disposition !== 'target') continue;
      for (let offset = 0;; offset += 500) {
        const rows = source.rows(classification.table, { offset, limit: 500 });
        if (!rows.length) break;
        for (const row of rows) for (const [field, value] of Object.entries(row)) if (fieldDisposition(classification.table, field, mapping || { field_policy: { default: 'target' } }) === 'omitted' && typeof value === 'string' && value.length >= 8) { checked += 1; if (targetBytes.includes(Buffer.from(value))) leaked.push(`${classification.table}.${field}`); }
      }
    }
  } finally { source.close(); }
  const absolutePaths = scanAbsolutePaths(targetFile);
  if (leaked.length) failures.push('secret_scan');
  if (absolutePaths.length) failures.push('absolute_path_scan');
  return { omitted_values_checked: checked, leaked: [...new Set(leaked)].slice(0, 100), absolute_paths: absolutePaths.slice(0, 100) };
}

function scanAbsolutePaths(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const findings = [];
  try {
    const shadows = new Set(db.prepare('PRAGMA table_list').all().filter((row) => row.type === 'shadow').map((row) => row.name));
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name).filter((name) => !shadows.has(name));
    for (const table of tables) {
      const textColumns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().filter((column) => /TEXT|CLOB|CHAR/i.test(column.type || '')).map((column) => column.name);
      for (const column of textColumns) {
        const rows = db.prepare(`SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL LIMIT 10000`).all();
        if (rows.some((row) => /(?:^|[\s"'])[A-Za-z]:\\[^\r\n"']+|(?:^|[\s"'])\/(?:Users|home|var|tmp)\//.test(String(row.value)))) findings.push(`${table}.${column}`);
      }
    }
  } finally { db.close(); }
  return findings;
}

function rowKey(table, row) { const fields = table.key_columns?.length ? table.key_columns : Object.keys(row); return fields.map((field) => canonicalJson(row[field])).join('|'); }
function normalizeRow(row) { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) || value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value])); }
function required(value, name) { if (!value || value === true) throw new Error(`option_required:${name}`); return String(value); }
