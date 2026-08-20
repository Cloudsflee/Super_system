import { canonicalize, canonicalJson, sha256Ref } from './canonical.mjs';

const SENSITIVE_KEY = /(?:^|_)(?:secret|token|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|credential|prompt|full[_-]?prompt|parser_text|parser_output|extracted_text|raw_text)(?:$|_)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_TOKEN = /\b(?:sk|rk|key|token|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\r\n\t"']{2,}\b/g;
// Public API-relative URIs are contract data, not host filesystem paths.
const POSIX_PATH = /(^|[\s(])\/(?!(?:\/|api(?:\/|$)|livez(?:[/?#]|$)|readyz(?:[/?#]|$)))[^\r\n\t"']{2,}/g;

export class RedactionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RedactionError';
    this.code = 'redaction_blocked';
    this.details = details;
  }
}

export class RedactionPolicy {
  constructor(options = {}) {
    this.maxString = Number.isInteger(options.maxString) ? options.maxString : 4000;
    this.maxArray = Number.isInteger(options.maxArray) ? options.maxArray : 500;
    this.maxObject = Number.isInteger(options.maxObject) ? options.maxObject : 200;
  }

  redact(value) {
    const findings = [];
    const output = this.#walk(value, '$', findings, false);
    return { value: output, redactions: findings };
  }

  redactObject(value) {
    return this.redact(value).value;
  }

  scan(value) {
    const result = this.redact(value);
    return {
      safe: result.redactions.length === 0,
      redactions: result.redactions,
      redacted: result.value,
      payload_sha256: sha256Ref(canonicalJson(result.value))
    };
  }

  assertSafe(value, options = {}) {
    const result = this.scan(value);
    if (!result.safe) {
      throw new RedactionError(options.message || 'payload contains a restricted value', {
        ...result,
        receipt_status: 'redacted_failure'
      });
    }
    return result.redacted;
  }

  #walk(value, path, findings, sensitiveParent) {
    if (typeof value === 'string') return this.#string(value, path, findings, sensitiveParent);
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      return value.slice(0, this.maxArray).map((item, index) => this.#walk(item, `${path}[${index}]`, findings, sensitiveParent));
    }
    if (value && typeof value === 'object') {
      const output = {};
      for (const key of Object.keys(value).slice(0, this.maxObject)) {
        if (value[key] === undefined) continue;
        const sensitive = sensitiveParent || isSensitiveKey(key);
        if (sensitive && isMetadataObject(key, value[key])) {
          output[key] = this.#walk(value[key], `${path}.${key}`, findings, false);
        } else if (sensitive) {
          findings.push({ path: `${path}.${key}`, reason: 'restricted_field' });
          output[key] = '[redacted]';
        } else {
          output[key] = this.#walk(value[key], `${path}.${key}`, findings, false);
        }
      }
      return output;
    }
    findings.push({ path, reason: 'unsupported_value' });
    return '[redacted]';
  }

  #string(value, path, findings, sensitive) {
    if (sensitive) return '[redacted]';
    let output = String(value);
    if (output.length > this.maxString) {
      findings.push({ path, reason: 'bounded_length' });
      output = `${output.slice(0, this.maxString)}...[truncated]`;
    }
    const before = output;
    output = output.replace(BEARER, 'Bearer [redacted]').replace(KEY_TOKEN, '[redacted]');
    output = output.replace(WINDOWS_PATH, '[redacted-path]');
    output = output.replace(POSIX_PATH, '$1[redacted-path]');
    if (output !== before) findings.push({ path, reason: 'restricted_text' });
    return output;
  }
}

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  if (/^credential_(?:id|ref|ref_id)$/.test(normalized)) return false;
  if (/^token_(?:budget|estimate|used|count|prefix)$/.test(normalized)) return false;
  return SENSITIVE_KEY.test(normalized);
}

function isMetadataObject(key, value) {
  // A public credential/profile record is metadata; only a credential object
  // carrying an actual secret is collapsed.  This keeps clean API references
  // queryable while preserving the historical secret redaction boundary.
  if (!/credential|profile/i.test(String(key)) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  return !containsSecretField(value);
}

function containsSecretField(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:secret|token|password|authorization|api[_-]?key|private[_-]?key|auth)$/i.test(String(key))) return true;
    if (item && typeof item === 'object' && containsSecretField(item)) return true;
  }
  return false;
}

export const DEFAULT_REDACTION_POLICY = Object.freeze(new RedactionPolicy());

export function redact(value, policy = DEFAULT_REDACTION_POLICY) {
  return policy.redact(value);
}

export function redactObject(value, policy = DEFAULT_REDACTION_POLICY) {
  return policy.redactObject(value);
}

export function scanRedactions(value, policy = DEFAULT_REDACTION_POLICY) {
  return policy.scan(value);
}
