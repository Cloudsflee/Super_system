import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Hex } from '../api/src/clean/canonical.mjs';
import { digestFile, inspectSource } from './reader.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MAPPING_FILE = path.join(here, 'mapping-inventory.json');
export const TOOL_FILES = Object.freeze(['cli.mjs', 'reader.mjs', 'planner.mjs', 'mapper.mjs', 'checkpoint.mjs', 'verifier.mjs', 'pointer.mjs'].map((name) => path.join(here, name)));

export function buildPlan(options) {
  const v23 = inspectSource(required(options.v23, 'v23'), 23);
  const v3 = inspectSource(required(options.v3, 'v3'), 7);
  const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
  validateMapping(mapping);
  const mappingSha = digestFile(MAPPING_FILE);
  const toolFiles = TOOL_FILES.filter((file) => fs.existsSync(file)).map((file) => ({ path: path.basename(file), sha256: digestFile(file) }));
  const toolSha = sha256Hex(canonicalJson(toolFiles));
  const classifications = classifyTables(v23.tables, mapping);
  const blocking = classifications.flatMap((table) => table.disposition === 'blocking' ? [{ kind: 'unknown_table', table: table.table }] : table.fields.filter((field) => field.disposition === 'blocking').map((field) => ({ kind: 'unknown_field', table: table.table, field: field.field })));
  const domainCounts = Object.fromEntries(mapping.domain_order.map((domain) => [domain, classifications.filter((table) => table.domain === domain).reduce((sum, table) => sum + table.row_count, 0)]));
  const base = {
    schema_version: 'aiws.import.plan.v2',
    source_v23_sha256: v23.manifest_sha256,
    source_v3_sha256: v3.manifest_sha256,
    source_v23_file_sha256: v23.file_sha256,
    source_v3_file_sha256: v3.file_sha256,
    source_v23_schema_sha256: v23.schema_sha256,
    source_v3_schema_sha256: v3.schema_sha256,
    mapping_sha256: mappingSha,
    tool_sha256: toolSha,
    tool_files: toolFiles,
    target_user_version: 8,
    precedence: mapping.precedence,
    domain_order: mapping.domain_order,
    checkpoint_rows: Number(mapping.checkpoint_rows),
    classifications,
    domain_row_counts: domainCounts,
    blocking_conflicts: blocking
  };
  return { sources: { v23, v3 }, mapping, plan: { ...base, plan_sha256: sha256Hex(canonicalJson(base)) } };
}

export function classifyTables(tables, mapping) {
  const index = mappingIndex(mapping);
  return tables.map((table) => {
    const rule = index.get(table.name);
    if (!rule) return { table: table.name, domain: null, mode: null, disposition: mapping.unknown_table, row_count: table.row_count, rows_sha256: table.rows_sha256, key_columns: table.key_columns, fields: table.columns.map((column) => ({ field: column.name, disposition: mapping.unknown_field })) };
    return {
      table: table.name,
      domain: rule.domain,
      mode: rule.mode,
      disposition: 'target',
      row_count: table.row_count,
      rows_sha256: table.rows_sha256,
      key_columns: table.key_columns,
      fields: table.columns.map((column) => ({ field: column.name, disposition: fieldDisposition(table.name, column.name, mapping) }))
    };
  }).sort((left, right) => left.table.localeCompare(right.table));
}

export function mappingIndex(mapping) {
  const index = new Map();
  for (const [domain, config] of Object.entries(mapping.domains || {})) {
    for (const mode of ['live', 'evidence']) for (const table of config[mode] || []) {
      if (index.has(table)) throw new Error(`mapping_duplicate_table:${table}`);
      index.set(table, { domain, mode });
    }
  }
  return index;
}

export function fieldDisposition(table, field, mapping) {
  if ((mapping.field_policy?.target_overrides?.[table] || []).includes(field)) return 'target';
  const name = String(field).toLowerCase();
  const sensitive = mapping.field_policy?.omitted_names || [];
  if (sensitive.includes(name)) return 'omitted';
  if (/(?:^|_)(?:token|secret|cookie|proof|prompt|password|private_key|webhook_secret)(?:_|$)/.test(name)) return 'omitted';
  if (/(?:^|_)(?:access_token|refresh_token|api_key|private_key|webhook_secret|session_cookie|password)(?:_|$)/.test(name)) return 'omitted';
  return mapping.field_policy?.default || mapping.unknown_field;
}

export function sanitizeRow(table, row, mapping) {
  const output = {};
  const omitted = [];
  for (const [field, value] of Object.entries(row)) {
    const disposition = fieldDisposition(table, field, mapping);
    if (disposition === 'target') output[field] = value;
    else omitted.push({ field, sha256: value == null ? null : sha256Hex(canonicalJson(value)) });
  }
  return { value: output, omitted };
}

function validateMapping(mapping) {
  if (mapping.schema_version !== 'aiws.import.mapping-inventory.v2' || mapping.owner !== 'Importer' || mapping.phase !== 'P8') throw new Error('mapping_inventory_invalid');
  if (!Array.isArray(mapping.domain_order) || new Set(mapping.domain_order).size !== mapping.domain_order.length || Number(mapping.checkpoint_rows) !== 500) throw new Error('mapping_inventory_invalid');
  mappingIndex(mapping);
}
function required(value, name) { if (!value || value === true) throw new Error(`option_required:${name}`); return String(value); }
