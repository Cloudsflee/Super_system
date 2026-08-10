const MASK = '[redacted]';

export class SecretRegistry {
  constructor(initial = []) {
    this.values = new Map();
    for (const [label, value] of initial) this.remember(label, value);
  }

  remember(label, value) {
    const key = String(label);
    const secret = String(value ?? '');
    if (secret.length < 4) return false;
    this.forget(key);
    this.values.set(key, secret);
    try {
      const structured = JSON.parse(secret);
      rememberStructured(this.values, key, structured);
    } catch { /* Most credentials are opaque strings rather than bundles. */ }
    return true;
  }

  forget(label) {
    const key = String(label);
    for (const stored of this.values.keys()) {
      if (stored === key || stored.startsWith(`${key}:`)) this.values.delete(stored);
    }
  }

  list() {
    return [...new Set(this.values.values())];
  }

  redact(value) {
    let text = maskPatterns(String(value ?? ''));
    for (const secret of this.list()) {
      const encoded = JSON.stringify(secret).slice(1, -1);
      for (const candidate of new Set([secret, encoded])) {
        if (!candidate) continue;
        text = candidate.length >= 12
          ? text.replaceAll(candidate, MASK)
          : text.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(candidate)}(?![A-Za-z0-9_])`, 'g'), MASK);
      }
    }
    return text;
  }

  redactObject(value) {
    if (value == null) return value;
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.redactObject(item));
    if (typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactObject(item)]));
  }

  stream() {
    return new SecretStreamRedactor(this);
  }
}

export class SecretStreamRedactor {
  constructor(registry) {
    this.registry = registry;
    this.pending = '';
  }

  push(value) {
    const raw = `${this.pending}${String(value ?? '')}`;
    const knownWindow = this.registry.list().reduce((size, secret) => Math.max(size, secret.length + 16), 0);
    const window = Math.max(512, knownWindow);
    const emitLength = Math.max(0, raw.length - window);
    this.pending = raw.slice(emitLength);
    return this.registry.redact(raw.slice(0, emitLength));
  }

  flush() {
    const value = this.registry.redact(this.pending);
    this.pending = '';
    return value;
  }
}

function maskPatterns(value) {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, MASK)
    .replace(/\bBearer\s+[^\s,;]{4,}/gi, `Bearer ${MASK}`)
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, MASK)
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASK)
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)(\s*[:=]\s*)([^\s,;]{4,})/gi, `$1$2${MASK}`);
}

function rememberStructured(values, label, value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (typeof item === 'string' && /(?:token|secret|api.?key|private.?key|authorization|credential|auth)/i.test(key) && item.length >= 4) {
      values.set(`${label}:${nextPath}`, item);
    } else if (item && typeof item === 'object') {
      rememberStructured(values, label, item, nextPath);
    }
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
