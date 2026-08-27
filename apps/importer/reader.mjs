import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256Hex } from '../api/src/clean/canonical.mjs';

export class SqliteSourceReader {
  constructor(file, { expectedVersion = null } = {}) {
    this.file = path.resolve(String(file));
    if (!fs.existsSync(this.file)) throw new Error(`source_missing:${path.basename(this.file)}`);
    this.db = new DatabaseSync(this.file, { readOnly: true });
    this.version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (expectedVersion != null && this.version !== Number(expectedVersion)) throw new Error(`source_version_mismatch:${expectedVersion}:${this.version}`);
    this.tableInventory = this.#tables();
  }

  manifest() {
    const integrity = this.db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all().map(normalizeRow);
    if (integrity.some((item) => item !== 'ok') || foreignKeys.length) throw new Error('source_integrity_failed');
    const byteManifest = sqliteByteManifest(this.file);
    const tables = this.tableInventory.map((table) => ({ ...table, row_count: this.count(table.name), rows_sha256: this.tableHash(table.name) }));
    const schemaRows = this.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all().filter((row) => !this.#isShadow(row.name)).map(normalizeRow);
    const base = { file_sha256: byteManifest.main_sha256, sqlite_family_sha256: byteManifest.family_sha256, user_version: this.version, byte_length: fs.statSync(this.file).size, schema_sha256: sha256Hex(canonicalJson(schemaRows)), tables, integrity, foreign_keys: foreignKeys };
    return { ...base, manifest_sha256: sha256Hex(canonicalJson(base)) };
  }

  tables() { return this.tableInventory.map((table) => ({ ...table, columns: table.columns.map((column) => ({ ...column })) })); }
  hasTable(name) { return this.tableInventory.some((table) => table.name === String(name)); }
  count(name) { return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(this.#requiredTable(name).name)}`).get().count); }

  rows(name, { offset = 0, limit = 500 } = {}) {
    const table = this.#requiredTable(name);
    const order = table.key_columns.length ? table.key_columns : table.columns.map((column) => column.name);
    const orderSql = order.length ? ` ORDER BY ${order.map(quoteIdentifier).join(',')}` : '';
    return this.db.prepare(`SELECT * FROM ${quoteIdentifier(table.name)}${orderSql} LIMIT ? OFFSET ?`).all(Number(limit), Number(offset)).map(normalizeRow);
  }

  tableHash(name) {
    const table = this.#requiredTable(name);
    const hash = createHash('sha256');
    let offset = 0;
    for (;;) {
      const rows = this.rows(table.name, { offset, limit: 500 });
      if (!rows.length) break;
      for (const row of rows) hash.update(canonicalJson(row)).update('\n');
      offset += rows.length;
    }
    return hash.digest('hex');
  }

  close() { this.db.close(); }

  #tables() {
    const list = this.db.prepare('PRAGMA table_list').all();
    const shadows = new Set(list.filter((row) => row.type === 'shadow').map((row) => row.name));
    this.shadowTables = shadows;
    return list.filter((row) => row.schema === 'main' && row.type === 'table' && !row.name.startsWith('sqlite_') && !shadows.has(row.name)).map((row) => {
      const columns = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`).all().map((column) => ({ name: column.name, type: column.type || '', not_null: Boolean(column.notnull), primary_key_ordinal: Number(column.pk) }));
      return { name: row.name, strict: Boolean(row.strict), columns, key_columns: columns.filter((column) => column.primary_key_ordinal > 0).sort((left, right) => left.primary_key_ordinal - right.primary_key_ordinal).map((column) => column.name) };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  #requiredTable(name) { const table = this.tableInventory.find((item) => item.name === String(name)); if (!table) throw new Error(`source_table_missing:${name}`); return table; }
  #isShadow(name) { return this.shadowTables?.has(String(name)); }
}

export function inspectSource(file, expectedVersion) {
  const reader = new SqliteSourceReader(file, { expectedVersion });
  try { return reader.manifest(); } finally { reader.close(); }
}

export async function consistentDatabaseCopy(source, target) {
  const sourceFile = path.resolve(String(source));
  const targetFile = path.resolve(String(target));
  if (fs.existsSync(targetFile)) throw new Error('target_must_be_new');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(sourceFile, { readOnly: true });
  try { db.exec(`VACUUM INTO ${sqlLiteral(targetFile)}`); } finally { db.close(); }
  fsyncFile(targetFile);
  fsyncDirectory(path.dirname(targetFile));
  return { source_manifest: inspectSource(sourceFile, null), target_sha256: digestFile(targetFile) };
}

export function sqliteByteManifest(file) {
  const absolute = path.resolve(String(file));
  const members = ['main', 'wal', 'shm'].map((kind) => ({ kind, file: kind === 'main' ? absolute : `${absolute}-${kind}` })).filter((entry) => fs.existsSync(entry.file)).map((entry) => ({ kind: entry.kind, byte_length: fs.statSync(entry.file).size, sha256: digestFile(entry.file) }));
  const main = members.find((entry) => entry.kind === 'main');
  return { main_sha256: main?.sha256 || sha256Hex(''), members, family_sha256: sha256Hex(canonicalJson(members.map(({ kind, byte_length, sha256 }) => ({ kind, byte_length, sha256 })))) };
}

export function digestFile(file) { return createHash('sha256').update(fs.readFileSync(path.resolve(String(file)))).digest('hex'); }
export function quoteIdentifier(value) { const text = String(value); if (!text || text.includes('\0')) throw new Error('sqlite_identifier_invalid'); return `"${text.replaceAll('"', '""')}"`; }
export function fsyncFile(file) { const handle = fs.openSync(file, 'r+'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); } }
export function fsyncDirectory(directory) { try { const handle = fs.openSync(directory, 'r'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); } } catch { /* Windows may reject directory fsync. */ } }

function normalizeRow(row) { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) || value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value])); }
function sqlLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }
