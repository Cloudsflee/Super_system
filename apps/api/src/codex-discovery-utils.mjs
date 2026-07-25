import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { codexProviderKey, isThirdPartyProvider, normalizeProviderBaseUrl } from './codex-service.mjs';

const discoveryKey = randomBytes(32);
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_BYTES = 512 * 1024;

export function opaqueId(...parts) {
  return createHmac('sha256', discoveryKey).update(parts.map(String).join('\0')).digest('base64url').slice(0, 32);
}

export function privateRevision(...parts) {
  return opaqueId('revision', ...parts);
}

export function publicProviderFromToml(
  text,
  { credentialPresent = false, apiFormat = '', sourceType = 'codex_home', displayName = '' } = {}
) {
  const root = parseProviderRoot(text);
  if (!root) return { ok: false, issue: 'invalid_config_toml' };
  const configuration = providerConfiguration(root, { credentialPresent, apiFormat, sourceType, displayName });
  const { embeddedCredential, hasCredential, issues, official, table } = configuration;
  return {
    ok: true,
    descriptor: {
      name: safeLabel(displayName || scalar(table.name) || configuration.provider, 100),
      provider: configuration.provider,
      provider_name: safeLabel(scalar(table.name) || displayName || configuration.provider, 100),
      base_url: configuration.baseUrl,
      model: configuration.model,
      wire_api: 'responses',
      requires_openai_auth: Boolean(table.requires_openai_auth),
      has_credential: hasCredential,
      credential_hint: hasCredential ? 'configured' : 'required',
      importable: issues.length === 0 && !(official && !hasCredential),
      issues
    },
    credential: embeddedCredential || ''
  };
}

function parseProviderRoot(text) {
  let root;
  try {
    root = parseToml(String(text || ''));
  } catch {
    return null;
  }
  return root && typeof root === 'object' && !Array.isArray(root) ? root : null;
}

function providerConfiguration(root, { credentialPresent, apiFormat, sourceType }) {
  const rawProvider = scalar(root.model_provider) || (scalar(root.base_url) ? 'custom' : 'openai');
  const provider = codexProviderKey(rawProvider);
  const providers = object(root.model_providers);
  const table = providerTable(providers, rawProvider, provider);
  const baseRaw = scalar(table.base_url) || scalar(root.base_url);
  const normalizedBaseUrl = baseRaw ? normalizeProviderBaseUrl(baseRaw) : null;
  const sensitiveEndpoint = normalizedBaseUrl ? endpointMayContainSecret(normalizedBaseUrl) : false;
  const baseUrl = sensitiveEndpoint ? null : normalizedBaseUrl;
  const wireApi = scalar(table.wire_api) || scalar(root.wire_api) || 'responses';
  const model = scalar(root.model);
  const embeddedCredential =
    secretScalar(table.experimental_bearer_token) ||
    secretScalar(root.experimental_bearer_token) ||
    secretScalar(root.OPENAI_API_KEY);
  const official = !isThirdPartyProvider(provider) && !baseRaw;
  const hasCredential = Boolean(credentialPresent || embeddedCredential);
  const configuration = {
    apiFormat,
    baseRaw,
    baseUrl,
    embeddedCredential,
    hasCredential,
    model,
    official,
    provider,
    sensitiveEndpoint,
    sourceType,
    table,
    wireApi
  };
  return { ...configuration, issues: providerIssues(configuration) };
}

function providerTable(providers, rawProvider, provider) {
  if (Object.hasOwn(providers, rawProvider)) return object(providers[rawProvider]);
  if (Object.hasOwn(providers, provider)) return object(providers[provider]);
  return {};
}

function providerIssues(configuration) {
  const { apiFormat, baseRaw, baseUrl, model, official, provider, sensitiveEndpoint, sourceType, wireApi } =
    configuration;
  const issues = [];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(provider)) issues.push('invalid_provider');
  if (!model || model.length > 200) issues.push('model_required');
  if (!isThirdPartyProvider(provider) && baseRaw) issues.push('official_provider_custom_base_url_mismatch');
  if (!official && !baseRaw) issues.push('base_url_required');
  else if (sensitiveEndpoint) issues.push('sensitive_base_url_rejected');
  else if (baseRaw && !baseUrl) issues.push('invalid_base_url');
  if (wireApi !== 'responses') issues.push('unsupported_wire_api');
  if (['chat', 'openai_chat'].includes(String(apiFormat || '').toLowerCase()))
    issues.push('cc_switch_local_proxy_required');
  if (official && sourceType === 'cc_switch') issues.push('official_device_login_required');
  return issues;
}

export function authJsonInfo(text) {
  if (!text) return { credential: '', oauth: false };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { credential: '', oauth: false, issue: 'invalid_auth_json' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { credential: '', oauth: false, issue: 'invalid_auth_json' };
  const credential = secretScalar(value.OPENAI_API_KEY) || secretScalar(value.api_key);
  const tokens = object(value.tokens);
  const oauth = [
    value.access_token,
    value.id_token,
    value.refresh_token,
    tokens.access_token,
    tokens.id_token,
    tokens.refresh_token
  ].some((item) => Boolean(secretScalar(item)));
  return { credential, oauth };
}

export async function readCodexHome(root) {
  const safeRoot = await fixedDirectory(root);
  if (!safeRoot) return null;
  const config = await fixedFile(safeRoot, 'config.toml', MAX_CONFIG_BYTES);
  if (!config) return null;
  const auth = await fixedFile(safeRoot, 'auth.json', MAX_SECRET_BYTES, true);
  return {
    root: safeRoot,
    config: config.text,
    auth: auth?.text || '',
    statKey: `${config.stat.size}:${config.stat.mtimeMs}:${auth?.stat.size || 0}:${auth?.stat.mtimeMs || 0}`
  };
}

export async function fixedDatabase(configDir, fileName = 'cc-switch.db') {
  const root = await fixedDirectory(configDir);
  if (!root) return null;
  const requested = path.join(root, fileName);
  try {
    const stat = await fsp.lstat(requested);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) return null;
    const real = await fsp.realpath(requested);
    return samePath(path.dirname(real), root) && path.basename(real) === fileName ? { path: real, stat } : null;
  } catch {
    return null;
  }
}

function scalar(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function secretScalar(value) {
  const item = scalar(value);
  return item && item.length <= 65536 && !/[\r\n\0]/.test(item) ? item : '';
}
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function safeLabel(value, max) {
  return String(value || '')
    .replace(/[\r\n\0]/g, ' ')
    .trim()
    .slice(0, max);
}
function endpointMayContainSecret(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((item) => {
        try {
          return decodeURIComponent(item);
        } catch {
          return item;
        }
      });
    return (
      url.hostname.split('.').some((item) => /^[a-zA-Z0-9_-]{32,}$/.test(item)) ||
      segments.some(
        (item) =>
          /(?:api[_-]?key|access[_-]?token|bearer|secret|credential)/i.test(item) || /^[a-zA-Z0-9_-]{32,}$/.test(item)
      )
    );
  } catch {
    return true;
  }
}

async function fixedDirectory(value) {
  const requested = path.resolve(String(value || ''));
  try {
    const stat = await fsp.lstat(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return await fsp.realpath(requested);
  } catch {
    return null;
  }
}

async function fixedFile(root, name, maxBytes, optional = false) {
  const requested = path.join(root, name);
  try {
    const stat = await fsp.lstat(requested);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    const real = await fsp.realpath(requested);
    if (!samePath(path.dirname(real), root) || path.basename(real) !== name) return null;
    const handle = await fsp.open(real, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > maxBytes || !sameFile(stat, opened)) return null;
      return { path: real, text: await handle.readFile('utf8'), stat: opened };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    return null;
  }
}

function samePath(left, right) {
  const a = path.resolve(left),
    b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function sameFile(left, right) {
  return (
    (!left.ino || !right.ino || left.ino === right.ino) &&
    (!left.dev || !right.dev || left.dev === right.dev) &&
    left.size === right.size
  );
}
