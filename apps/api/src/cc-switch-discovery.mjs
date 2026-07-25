import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fixedDatabase, opaqueId, privateRevision, publicProviderFromToml } from './codex-discovery-utils.mjs';

const MAX_ROWS = 200;

export async function scanCcSwitchDiscovery() {
  const hostMounted = String(process.env.AIWS_HOST_CC_SWITCH_CONFIG_DIR || '').trim();
  const configured = hostMounted || String(process.env.CC_SWITCH_CONFIG_DIR || '').trim();
  const configDir = configured ? path.resolve(configured) : path.join(os.homedir(), '.cc-switch');
  const pathHint = hostMounted
    ? '$AIWS_HOST_CC_SWITCH_CONFIG_DIR/cc-switch.db'
    : configured
      ? '$CC_SWITCH_CONFIG_DIR/cc-switch.db'
      : '~/.cc-switch/cc-switch.db';
  const sourceId = opaqueId('source', 'cc_switch', pathHint);
  const base = {
    source_id: sourceId,
    type: 'cc_switch',
    display_name: 'cc-switch local providers',
    path_hint: pathHint,
    read_only: true
  };
  const database = await fixedDatabase(configDir);
  if (!database) return { source: { ...base, status: 'unavailable', revision: null, providers: [] }, records: [] };
  let opened;
  try {
    opened = await openDatabase(database.path);
  } catch {
    return {
      source: { ...base, status: 'invalid', revision: null, providers: [], issues: ['cc_switch_database_unreadable'] },
      records: []
    };
  }
  const { db, schemaVersion, columns } = opened;
  try {
    const openedStat = await fsp.stat(database.path);
    if (
      (database.stat.ino && openedStat.ino && database.stat.ino !== openedStat.ino) ||
      database.stat.size !== openedStat.size
    )
      throw new Error('database_changed');
    if (
      schemaVersion < 1 ||
      schemaVersion > 11 ||
      !['id', 'app_type', 'name', 'settings_config'].every((item) => columns.has(item))
    ) {
      return {
        source: {
          ...base,
          status: 'unsupported',
          schema_version: schemaVersion,
          revision: null,
          providers: [],
          issues: ['unsupported_cc_switch_schema']
        },
        records: []
      };
    }
    const rows = queryRows(db, columns);
    if (rows.length > MAX_ROWS)
      return {
        source: {
          ...base,
          status: 'invalid',
          schema_version: schemaVersion,
          revision: null,
          providers: [],
          issues: ['too_many_cc_switch_providers']
        },
        records: []
      };
    const statKey = `${database.stat.size}:${database.stat.mtimeMs}:${schemaVersion}`;
    const sourceRevision = privateRevision(
      'cc-switch',
      statKey,
      ...rows.map((row) => `${row.id}:${row.config_toml || ''}:${row.credential_fingerprint || ''}`)
    );
    const records = rows.map((row) => recordFromRow(row, sourceId, sourceRevision)).filter(Boolean);
    return {
      source: {
        ...base,
        status: 'available',
        schema_version: schemaVersion,
        revision: sourceRevision,
        providers: records.map((item) => item.descriptor)
      },
      records,
      database_path: database.path
    };
  } catch {
    return {
      source: {
        ...base,
        status: 'invalid',
        revision: null,
        providers: [],
        issues: ['cc_switch_database_query_failed']
      },
      records: []
    };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

export async function readCcSwitchCredential(databasePath, sourceProviderId) {
  const { db, columns } = await openDatabase(databasePath);
  try {
    if (!['id', 'app_type', 'settings_config'].every((item) => columns.has(item))) return null;
    const row = db
      .prepare(
        `SELECT CASE WHEN json_valid(settings_config) THEN json_extract(settings_config, '$.config') END config_toml, CASE WHEN json_valid(settings_config) THEN json_extract(settings_config, '$.auth.OPENAI_API_KEY') END credential, CASE WHEN json_valid(settings_config) THEN aiws_private_fingerprint(json_extract(settings_config, '$.auth.OPENAI_API_KEY')) END credential_fingerprint FROM providers WHERE app_type = ? AND id = ? LIMIT 1`
      )
      .get('codex', sourceProviderId);
    if (!row || typeof row.config_toml !== 'string' || row.config_toml.length > 2 * 1024 * 1024) return null;
    const parsed = publicProviderFromToml(row.config_toml, {
      credentialPresent: Boolean(secret(row.credential)),
      sourceType: 'cc_switch'
    });
    if (!parsed.ok) return null;
    return {
      credential: secret(row.credential) || parsed.credential,
      credential_fingerprint: String(row.credential_fingerprint || ''),
      descriptor: parsed.descriptor
    };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

async function openDatabase(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 2000 });
  db.function('aiws_private_fingerprint', { deterministic: true, directOnly: true }, (value) =>
    privateRevision('cc-credential', secret(value))
  );
  try {
    db.enableDefensive(true);
  } catch {}
  try {
    db.enableLoadExtension(false);
  } catch {}
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=2000');
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  const objectType = db.prepare("SELECT type FROM sqlite_master WHERE name='providers' LIMIT 1").get()?.type;
  const columns =
    objectType === 'table'
      ? new Set(
          db
            .prepare('PRAGMA table_info(providers)')
            .all()
            .map((item) => String(item.name))
        )
      : new Set();
  return { db, schemaVersion, columns };
}

function queryRows(db, columns) {
  const current = columns.has('is_current') ? 'CAST(is_current AS INTEGER)' : '0';
  const category = columns.has('category') ? 'category' : "''";
  const meta = columns.has('meta') ? 'meta' : "'{}'";
  const sort = columns.has('sort_index') ? 'COALESCE(sort_index, 999999),' : '';
  return db
    .prepare(
      `SELECT CAST(id AS TEXT) id, CAST(name AS TEXT) name, ${current} is_current, ${category} category, CASE WHEN json_valid(${meta}) THEN json_extract(${meta}, '$.apiFormat') END api_format, CASE WHEN json_valid(settings_config) THEN json_extract(settings_config, '$.config') END config_toml, CASE WHEN json_valid(settings_config) AND json_type(settings_config, '$.auth.OPENAI_API_KEY') = 'text' AND length(trim(json_extract(settings_config, '$.auth.OPENAI_API_KEY'))) > 0 THEN 1 ELSE 0 END credential_present, CASE WHEN json_valid(settings_config) THEN aiws_private_fingerprint(json_extract(settings_config, '$.auth.OPENAI_API_KEY')) END credential_fingerprint FROM providers WHERE app_type = ? ORDER BY ${sort} id LIMIT ${MAX_ROWS + 1}`
    )
    .all('codex');
}

function recordFromRow(row, sourceId, sourceRevision) {
  if (
    !row.id ||
    String(row.id).length > 256 ||
    typeof row.config_toml !== 'string' ||
    row.config_toml.length > 2 * 1024 * 1024
  )
    return null;
  const parsed = publicProviderFromToml(row.config_toml, {
    credentialPresent: Boolean(row.credential_present),
    apiFormat: row.api_format,
    sourceType: 'cc_switch',
    displayName: row.name
  });
  const discoveryId = opaqueId('provider', sourceId, row.id);
  const descriptor = parsed.ok
    ? parsed.descriptor
    : {
        name: safe(row.name),
        provider: 'unknown',
        provider_name: safe(row.name),
        base_url: null,
        model: null,
        wire_api: 'responses',
        requires_openai_auth: false,
        has_credential: false,
        credential_hint: 'required',
        importable: false,
        issues: [parsed.issue]
      };
  return {
    source_provider_id: String(row.id),
    credential_fingerprint: String(row.credential_fingerprint || ''),
    config_toml: row.config_toml,
    descriptor: {
      discovery_id: discoveryId,
      source_revision: sourceRevision,
      ...descriptor,
      is_current: Boolean(row.is_current),
      category: safe(row.category)
    }
  };
}

function secret(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 65536 && !/[\r\n\0]/.test(text) ? text : '';
}
function safe(value) {
  return String(value || '')
    .replace(/[\r\n\0]/g, ' ')
    .trim()
    .slice(0, 100);
}
