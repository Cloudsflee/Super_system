import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex, sha256Ref, canonicalize } from './canonical.mjs';
import { DEFAULT_REDACTION_POLICY } from './redaction.mjs';

const HASH = /^[a-f0-9]{64}$/;

export class CasError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CasError';
    this.code = code;
    this.details = details;
    this.status = /^cas_(?:tamper|manifest|missing)/.test(code) ? 503 : 400;
  }
}

export class CasStore {
  constructor({ root, db = null, policy = DEFAULT_REDACTION_POLICY, clock = () => new Date().toISOString() } = {}) {
    if (!root) throw new TypeError('cas_root_required');
    this.root = path.resolve(String(root));
    this.db = db;
    this.policy = policy;
    this.clock = clock;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.manifestPath = path.join(this.root, 'manifest.json');
  }

  keyFor(hash) {
    const clean = normalizeHash(hash);
    return `${clean.slice(0, 2)}/${clean}`;
  }

  fileFor(hash) {
    return path.join(this.root, this.keyFor(hash).replaceAll('/', path.sep));
  }

  put(value, options = {}) {
    const bytes = toBytes(value, options.canonical === true);
    const hash = sha256Hex(bytes);
    const contentRedactions = scanContent(bytes, this.policy);
    if (contentRedactions.length) {
      this.#redactionFailure(contentRedactions, decodeForReceipt(bytes));
      throw new CasError('redaction_blocked', 'CAS content contains restricted values', { redactions: contentRedactions, receipt_status: 'redacted_failure' });
    }
    const relativeKey = this.keyFor(hash);
    const target = this.fileFor(hash);
    const metadataResult = this.policy.redact(options.metadata || {});
    if (metadataResult.redactions.length) {
      this.#redactionFailure(metadataResult.redactions, options.metadata || {});
      throw new CasError('redaction_blocked', 'CAS metadata contains restricted values', { redactions: metadataResult.redactions, receipt_status: 'redacted_failure' });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${randomUUID()}`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const verified = sha256Hex(fs.readFileSync(temporary));
      if (verified !== hash) throw new CasError('cas_hash_mismatch', 'CAS temporary object hash changed', { expected: hash, actual: verified });
      if (fs.existsSync(target)) {
        const existingHash = sha256Hex(fs.readFileSync(target));
        if (existingHash !== hash) throw new CasError('cas_tamper', 'CAS object at hash key does not match its key', { hash, actual: existingHash });
        fs.rmSync(temporary, { force: true });
      } else {
        fs.renameSync(temporary, target);
        fsyncDirectory(path.dirname(target));
      }
    } catch (error) {
      try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch { /* no-op */ }
      try { fs.rmSync(temporary, { force: true }); } catch { /* no-op */ }
      throw error;
    }
    const metadata = canonicalize(metadataResult.value);
    const record = {
      sha256: hash,
      byte_length: bytes.byteLength,
      media_type: String(options.mediaType || 'application/octet-stream').slice(0, 160),
      relative_key: relativeKey,
      metadata_json: canonicalJson(metadata),
      status: 'active',
      created_at: this.clock()
    };
    if (this.db) {
      const existing = this.db.get('SELECT sha256,byte_length,media_type,relative_key FROM cas_objects WHERE sha256=?', [hash]);
      if (existing && (Number(existing.byte_length) !== bytes.byteLength || existing.relative_key !== relativeKey)) {
        throw new CasError('cas_tamper', 'CAS metadata does not match the object', { hash });
      }
      if (!existing) this.db.run(`INSERT INTO cas_objects(sha256,byte_length,media_type,relative_key,metadata_json,status,created_at)
        VALUES(?,?,?,?,?,'active',?)`, [record.sha256, record.byte_length, record.media_type, record.relative_key, record.metadata_json, record.created_at]);
      // Keep the durable manifest synchronized with every promoted object so a
      // restart does not mistake a valid post-start write for tampering.
      this.createManifest();
    }
    return { hash, sha256: sha256Ref(bytes), byte_length: bytes.byteLength, media_type: record.media_type, relative_key: relativeKey };
  }

  putCanonical(value, options = {}) {
    return this.put(canonicalJson(value), { ...options, canonical: false, mediaType: options.mediaType || 'application/json' });
  }

  read(hash) {
    const clean = normalizeHash(hash);
    const file = this.fileFor(clean);
    if (!fs.existsSync(file)) throw new CasError('cas_missing', 'CAS object is missing', { hash: clean });
    const bytes = fs.readFileSync(file);
    const actual = sha256Hex(bytes);
    if (actual !== clean) throw new CasError('cas_tamper', 'CAS object failed hash verification', { hash: clean, actual });
    return bytes;
  }

  has(hash) {
    try { this.read(hash); return true; } catch { return false; }
  }

  createManifest(options = {}) {
    const objects = [];
    for (const entry of walk(this.root)) {
      if (entry.relative === 'manifest.json' || entry.relative.includes('.tmp-') || entry.relative.endsWith('.tmp')) continue;
      const bytes = fs.readFileSync(entry.file);
      const hash = sha256Hex(bytes);
      if (!HASH.test(entry.name) || hash !== entry.name) throw new CasError('cas_tamper', 'CAS manifest found an invalid object', { relative_key: entry.relative, expected: entry.name, actual: hash });
      objects.push({ sha256: hash, byte_length: bytes.byteLength, relative_key: entry.relative.replaceAll('\\', '/') });
    }
    objects.sort((a, b) => a.sha256.localeCompare(b.sha256));
    const payload = { schema_version: 'aiws.v3-clean.cas-manifest.v1', objects, created_at: options.createdAt || this.clock() };
    payload.manifest_sha256 = sha256Hex(canonicalJson({ ...payload }));
    const temporary = `${this.manifestPath}.tmp-${randomUUID()}`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.renameSync(temporary, this.manifestPath);
    } catch (error) {
      // Windows does not replace an existing file with rename; remove only the
      // manifest path that this store owns, then retry the atomic promotion.
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      fs.rmSync(this.manifestPath, { force: true });
      fs.renameSync(temporary, this.manifestPath);
    }
    fsyncDirectory(this.root);
    return payload;
  }

  verifyManifest(manifest = null) {
    let candidate = manifest;
    if (!candidate && fs.existsSync(this.manifestPath)) candidate = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    if (!candidate) {
      const files = walk(this.root);
      const rows = this.db ? this.db.query("SELECT sha256 FROM cas_objects WHERE status='active' LIMIT 1") : [];
      if (files.length || rows.length) throw new CasError('cas_manifest_missing', 'CAS manifest is missing for a non-empty store', { object_count: files.length || rows.length });
      candidate = this.createManifest({ createdAt: this.clock() });
    }
    if (candidate.schema_version !== 'aiws.v3-clean.cas-manifest.v1') throw new CasError('cas_manifest_invalid', 'CAS manifest schema is invalid');
    if (!HASH.test(String(candidate.manifest_sha256 || ''))) throw new CasError('cas_manifest_invalid', 'CAS manifest hash is missing or invalid');
    const expectedManifestHash = sha256Hex(canonicalJson({ ...candidate, manifest_sha256: undefined }));
    if (candidate.manifest_sha256 !== expectedManifestHash) throw new CasError('cas_manifest_mismatch', 'CAS manifest hash does not match', { expected: expectedManifestHash, actual: candidate.manifest_sha256 });
    const listed = new Set();
    for (const object of candidate.objects || []) {
      listed.add(String(object.relative_key).replaceAll('\\', '/'));
      const bytes = this.read(object.sha256);
      if (bytes.byteLength !== Number(object.byte_length) || this.keyFor(object.sha256) !== object.relative_key) throw new CasError('cas_manifest_mismatch', 'CAS manifest object metadata does not match', { hash: object.sha256 });
      if (this.db) {
        const row = this.db.get('SELECT byte_length,relative_key,status FROM cas_objects WHERE sha256=?', [String(object.sha256).replace(/^sha256:/, '').toLowerCase()]);
        if (!row || row.status !== 'active' || Number(row.byte_length) !== bytes.byteLength || row.relative_key !== object.relative_key) throw new CasError('cas_manifest_mismatch', 'CAS database metadata does not match the manifest', { hash: object.sha256 });
      }
    }
    for (const entry of walk(this.root)) {
      if (!listed.has(entry.relative.replaceAll('\\', '/'))) throw new CasError('cas_manifest_mismatch', 'CAS contains an object absent from the manifest', { relative_key: entry.relative.replaceAll('\\', '/') });
    }
    if (this.db) {
      const rows = this.db.query("SELECT sha256,byte_length,relative_key FROM cas_objects WHERE status='active' ORDER BY sha256");
      for (const row of rows) {
        const object = (candidate.objects || []).find((item) => String(item.sha256).replace(/^sha256:/, '').toLowerCase() === row.sha256);
        if (!object || Number(object.byte_length) !== Number(row.byte_length) || object.relative_key !== row.relative_key) throw new CasError('cas_manifest_mismatch', 'CAS manifest is missing a database object', { hash: row.sha256 });
      }
    }
    return { valid: true, object_count: (candidate.objects || []).length, manifest_sha256: candidate.manifest_sha256 };
  }

  #redactionFailure(redactions, payload) {
    if (!this.db) return;
    try {
      const redacted = this.policy.redact(payload).value;
      const json = canonicalJson({ status: 'redacted_failure', redactions, payload: redacted });
      this.db.run(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`, [`receipt_redaction_${randomUUID().replaceAll('-', '')}`, 'cas.redaction', 'failed', json, sha256Hex(json), null, this.clock(), null]);
    } catch { /* the primary redaction error remains authoritative */ }
  }
}

function normalizeHash(value) {
  const raw = String(value || '').replace(/^sha256:/, '').toLowerCase();
  if (!HASH.test(raw)) throw new CasError('cas_hash_invalid', 'CAS hash must be a SHA-256 hex digest');
  return raw;
}

function toBytes(value, canonical) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (canonical) return Buffer.from(canonicalJson(value), 'utf8');
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(canonicalJson(value), 'utf8');
}

function scanContent(bytes, policy) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return [];
  }
  if (!text || text.includes('\u0000')) return [];
  const findings = [];
  try {
    const structured = JSON.parse(text);
    findings.push(...policy.redact(structured).redactions);
  } catch {
    findings.push(...policy.redact(text).redactions);
  }
  if (/(?:^|\n)\s*(?:system|developer|user|assistant)\s*:/i.test(text)) findings.push({ path: '$', reason: 'prompt_envelope' });
  if (/(?:^|[\s(])(?:[A-Za-z]:\\|\/(?!(?:\/|api(?:\/|$)|livez(?:[/?#]|$)|readyz(?:[/?#]|$))))[^\r\n\t"']{2,}/.test(text)) findings.push({ path: '$', reason: 'host_path' });
  return findings;
}

function decodeForReceipt(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, 4000); } catch { return { byte_length: bytes.byteLength }; }
}

function fsyncDirectory(directory) {
  try {
    const handle = fs.openSync(directory, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  } catch { /* Windows may not permit directory fsync; rename remains atomic. */ }
}

function walk(root, relativeRoot = '') {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
    if (entry.name === 'manifest.json') continue;
    const relative = path.join(relativeRoot, entry.name);
    const full = path.join(root, relative);
    if (entry.isDirectory()) output.push(...walk(root, relative));
    else if (entry.isFile()) output.push({ file: full, name: entry.name, relative });
  }
  return output;
}
