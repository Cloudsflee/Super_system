import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { hashJson, sha256 } from '../../crypto.mjs';
import { AppError, assert } from '../../errors.mjs';

const SOURCE_TYPES = new Set(['codex_home', 'cc_switch']);
const MAX_SOURCE_FILE = 1024 * 1024;

export class CodexDiscoveryService {
  constructor({ config, setup }) {
    this.config = config;
    this.setup = setup;
  }

  roots() {
    const configured = Array.isArray(this.config.codexDiscoveryRoots) ? this.config.codexDiscoveryRoots : [];
    const unique = new Map();
    for (const input of configured) {
      const sourceType = String(input?.type || 'codex_home');
      const configuredPath = String(input?.path || '');
      if (!SOURCE_TYPES.has(sourceType) || !path.isAbsolute(configuredPath)) continue;
      const root = path.resolve(configuredPath);
      const sourceKey = sha256(`${sourceType}\n${normalizePath(root)}`);
      unique.set(sourceKey, {
        sourceType,
        root,
        sourceKey,
        id: `cds_${sourceKey.slice(0, 24)}`,
        displayName: String(input?.display_name || input?.label || (sourceType === 'codex_home' ? 'Codex Home' : 'CC Switch')).slice(0, 120)
      });
    }
    return [...unique.values()];
  }

  async discover(context = null) {
    const sources = [];
    for (const root of this.roots()) {
      context?.ensureActive?.();
      const scanned = scanRoot(root);
      await this.setup.repository.upsertDiscoverySource({ ...scanned.source, timestamp: this.setup.clock() });
      sources.push(publicSource(scanned.source));
      await context?.emit?.('codex.discovery.source', {
        source_id: scanned.source.id,
        status: scanned.source.status,
        source_revision: scanned.source.sourceRevision,
        records: scanned.source.records.length
      });
    }
    return { sources };
  }

  async import(input = {}, ctx = {}) {
    assert(input?.confirmed === true, 'confirmation_required', 'discovery import requires confirmation', { status: 400 });
    const sourceId = String(input?.source_id || '');
    const recordId = String(input?.record_id || '');
    const expectedRevision = String(input?.source_revision || '');
    assert(sourceId && recordId && /^[a-f0-9]{64}$/.test(expectedRevision), 'invalid_input', 'discovery source selection is invalid', { status: 422 });
    const root = this.roots().find((candidate) => candidate.id === sourceId);
    if (!root) throw new AppError('not_found', 'discovery source not found');
    const scanned = scanRoot(root);
    await this.setup.repository.upsertDiscoverySource({ ...scanned.source, timestamp: this.setup.clock() });
    if (scanned.source.sourceRevision !== expectedRevision) {
      throw new AppError('discovery_source_stale', 'discovery source changed', {
        status: 409,
        details: { source_id: sourceId, current_revision: scanned.source.sourceRevision }
      });
    }
    const selected = scanned.imports.get(recordId);
    if (!selected) throw new AppError('not_found', 'discovery record not found');
    assert(selected.secret, 'credential_unavailable', 'discovered credential is unavailable', { status: 409 });
    const pending = await this.setup.createPendingCredential({
      kind: selected.kind,
      label: String(input?.label || selected.label || 'Imported Codex credential').slice(0, 120),
      origin: 'discovery',
      actor: ctx.actor
    });
    let credential;
    try {
      credential = await this.setup.activatePendingCredential(pending.id, selected.secret, pending.revision, ctx);
    } catch (error) {
      await this.setup.revokeCredential(pending.id, { expected_revision: pending.revision }, ctx).catch(() => undefined);
      throw error;
    }
    let profile = null;
    if (input?.create_profile !== false && selected.model) {
      profile = await this.setup.createCodexProfile({
        label: String(input?.profile_label || selected.label || 'Imported Codex profile').slice(0, 120),
        provider: selected.provider,
        model: selected.model,
        base_url: selected.baseUrl,
        wire_api: selected.wireApi,
        reasoning: selected.reasoning,
        timeout_ms: selected.timeoutMs,
        credential_ref: credential.id,
        is_active: input?.activate !== false
      }, ctx);
    }
    return { source_id: sourceId, source_revision: scanned.source.sourceRevision, credential, profile };
  }
}

function scanRoot(root) {
  const imports = new Map();
  let status = 'available';
  let records = [];
  let sourceRevision = sha256(`${root.sourceKey}\nunavailable`);
  try {
    assertDirectory(root.root);
    const names = root.sourceType === 'codex_home'
      ? ['config.toml', 'auth.json']
      : ['config.toml', 'auth.json', 'profiles.json', 'config.json', 'settings.json'];
    const files = new Map();
    const digest = createHash('sha256').update(`${root.sourceType}\n`);
    for (const name of names) {
      const file = path.join(root.root, name);
      if (!fs.existsSync(file)) continue;
      const bytes = readRegularFile(file);
      files.set(name, bytes);
      digest.update(name).update('\0').update(bytes).update('\0');
    }
    sourceRevision = digest.digest('hex');
    const extracted = root.sourceType === 'codex_home'
      ? extractCodexHome(root, files)
      : extractCcSwitch(root, files);
    records = extracted.records;
    for (const item of extracted.imports) imports.set(item.recordId, item);
  } catch (error) {
    status = error?.code === 'ENOENT' ? 'unavailable' : 'invalid';
    records = [];
  }
  return {
    source: {
      id: root.id,
      sourceType: root.sourceType,
      displayName: root.displayName,
      sourceKey: root.sourceKey,
      sourceRevision,
      status,
      records
    },
    imports
  };
}

function extractCodexHome(root, files) {
  const config = parseConfig(files.get('config.toml'));
  const auth = parseJson(files.get('auth.json'));
  const selected = profileFromConfig(config, auth, 'default');
  const recordId = `drec_${sha256(`${root.sourceKey}\ndefault`).slice(0, 24)}`;
  return {
    records: [publicRecord(recordId, selected)],
    imports: [{ recordId, ...selected }]
  };
}

function extractCcSwitch(root, files) {
  const config = parseJson(files.get('profiles.json')) || parseJson(files.get('config.json')) || parseJson(files.get('settings.json')) || {};
  const fallbackAuth = parseJson(files.get('auth.json'));
  const candidates = Array.isArray(config) ? config : Array.isArray(config.profiles) ? config.profiles : Array.isArray(config.items) ? config.items : [];
  if (!candidates.length) return extractCodexHome(root, files);
  const records = [];
  const imports = [];
  candidates.slice(0, 100).forEach((candidate, index) => {
    const key = String(candidate?.id || candidate?.name || index);
    const selected = profileFromConfig(candidate || {}, candidate?.auth || candidate?.credential || fallbackAuth, key);
    const recordId = `drec_${sha256(`${root.sourceKey}\n${key}`).slice(0, 24)}`;
    records.push(publicRecord(recordId, selected));
    imports.push({ recordId, ...selected });
  });
  return { records, imports };
}

function profileFromConfig(config, auth, fallbackLabel) {
  const provider = String(config?.model_provider || config?.provider || 'openai').slice(0, 64);
  const providerConfig = config?.model_providers?.[provider] || config?.provider_config || {};
  const model = String(config?.model || '').slice(0, 128);
  const baseUrl = String(providerConfig?.base_url || config?.base_url || (provider === 'openai' ? '' : '')).replace(/\/+$/, '').slice(0, 1024);
  const wireApi = String(providerConfig?.wire_api || config?.wire_api || 'responses').toLowerCase() === 'chat' ? 'chat' : 'responses';
  const reasoning = ['low', 'medium', 'high'].includes(String(config?.reasoning || config?.model_reasoning_effort))
    ? String(config.reasoning || config.model_reasoning_effort)
    : 'medium';
  const timeoutMs = Number.isInteger(Number(config?.timeout_ms)) ? Math.min(15 * 60 * 1000, Math.max(5000, Number(config.timeout_ms))) : 120000;
  const apiKey = typeof auth?.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : typeof auth?.api_key === 'string' ? auth.api_key : '';
  const kind = apiKey ? 'codex_api_key' : auth && typeof auth === 'object' ? 'codex_oauth_bundle' : 'codex_api_key';
  const secret = apiKey || (auth && typeof auth === 'object' ? JSON.stringify(auth) : '');
  return {
    label: String(config?.name || config?.label || fallbackLabel || 'Codex profile').slice(0, 120),
    provider,
    model,
    baseUrl,
    wireApi,
    reasoning,
    timeoutMs,
    kind,
    secret
  };
}

function publicRecord(recordId, selected) {
  return {
    id: recordId,
    label: selected.label,
    provider: selected.provider,
    model: selected.model,
    base_url_configured: Boolean(selected.baseUrl),
    wire_api: selected.wireApi,
    reasoning: selected.reasoning,
    timeout_ms: selected.timeoutMs,
    auth_kind: selected.kind === 'codex_oauth_bundle' ? 'oauth_bundle' : 'api_key',
    credential_available: Boolean(selected.secret)
  };
}

function publicSource(source) {
  return {
    id: source.id,
    source_type: source.sourceType,
    display_name: source.displayName,
    source_revision: source.sourceRevision,
    status: source.status,
    records: source.records
  };
}

function parseConfig(bytes) {
  if (!bytes) return {};
  return parseToml(bytes.toString('utf8'));
}

function parseJson(bytes) {
  if (!bytes) return null;
  const value = JSON.parse(bytes.toString('utf8'));
  return value && typeof value === 'object' ? value : null;
}

function assertDirectory(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('discovery_root_invalid');
  const resolved = path.resolve(root);
  const real = path.resolve(fs.realpathSync(root));
  if (normalizePath(resolved) !== normalizePath(real)) throw new Error('discovery_root_invalid');
}

function readRegularFile(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SOURCE_FILE) throw new Error('discovery_file_invalid');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const current = fs.fstatSync(descriptor);
    if (!current.isFile() || current.size !== before.size || current.size > MAX_SOURCE_FILE) throw new Error('discovery_file_invalid');
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizePath(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function discoveryRevisionFixture(value) {
  return hashJson(value);
}
