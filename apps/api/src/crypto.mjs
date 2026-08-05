import { createHash, randomUUID } from 'node:crypto';

export function now() {
  return new Date().toISOString();
}

export function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(input).digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

export function hashJson(value) {
  return sha256(stableStringify(value));
}

export function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function asJson(value) {
  return JSON.stringify(value ?? {});
}
