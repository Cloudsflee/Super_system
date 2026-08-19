import { createHash, randomUUID } from 'node:crypto';

/**
 * Canonical JSON is deliberately small and dependency free. Objects are
 * ordered by UTF-16 key order, arrays retain their order, and values which
 * JSON cannot represent are rejected before they can enter a receipt.
 */
export function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'bigint') throw new TypeError('canonical_bigint_invalid');
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) throw new TypeError('canonical_date_invalid');
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      output[key] = canonicalize(item);
    }
    return output;
  }
  if (value === undefined) return null;
  throw new TypeError('canonical_value_invalid');
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Ref(value) {
  return `sha256:${sha256Hex(value)}`;
}

export function canonicalHash(value) {
  return sha256Ref(canonicalJson(value));
}

export function opaqueId(prefix = 'id') {
  const clean = String(prefix).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'id';
  return `${clean}_${randomUUID().replaceAll('-', '')}`;
}

export function utcNow() {
  return new Date().toISOString();
}

export function parseCanonicalJson(value, fallback = null) {
  try { return canonicalize(JSON.parse(String(value))); } catch { return fallback; }
}
