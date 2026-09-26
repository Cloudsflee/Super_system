import { canonicalJson, opaqueId, sha256Hex, utcNow } from './canonical.mjs';
import { DEFAULT_REDACTION_POLICY } from './redaction.mjs';
import { PlatformError } from './platform-error.mjs';

/**
 * The only writer for the Clean receipt_manifests ledger.
 *
 * Domain services may keep their surrounding transaction, but they must pass
 * that transaction to createManifestInTransaction rather than issuing receipt
 * SQL themselves.  Keeping the writer as a small dependency-free function
 * also lets the migration bootstrap use the exact same redaction, canonical
 * JSON and hash rules before a CleanDatabase wrapper exists.
 */
export function createManifestInTransaction(tx, {
  id: requestedId = null,
  kind,
  payload = {},
  status = 'created',
  casSha256 = null,
  expiresAt = null,
  createdAt = utcNow(),
  policy = DEFAULT_REDACTION_POLICY
} = {}) {
  if (!tx || typeof tx.run !== 'function') throw new TypeError('receipt_transaction_required');
  const cleanKind = normalizeKind(kind);
  const cleanStatus = normalizeStatus(status);
  const clean = (policy || DEFAULT_REDACTION_POLICY).redact(payload == null ? {} : payload);
  const payloadJson = canonicalJson(clean.value);
  const timestamp = normalizeTime(createdAt);
  const cleanCas = casSha256 == null || casSha256 === '' ? null : normalizeHash(casSha256);
  if (clean.redactions.length) {
    const failure = canonicalJson({ status: 'redacted_failure', kind: cleanKind, redactions: clean.redactions });
    tx.run(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?)`, [opaqueId('receipt'), 'receipt.redaction', 'failed', failure, sha256Hex(failure), null, timestamp, null]);
  }
  const id = requestedId ? String(requestedId) : opaqueId('receipt');
  tx.run(`INSERT INTO receipt_manifests(id,kind,status,payload_json,payload_sha256,cas_sha256,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`, [id, cleanKind, cleanStatus, payloadJson, sha256Hex(payloadJson), cleanCas, timestamp, expiresAt == null ? null : normalizeTime(expiresAt)]);
  return {
    receipt_id: id,
    kind: cleanKind,
    status: cleanStatus,
    payload: clean.value,
    payload_sha256: `sha256:${sha256Hex(payloadJson)}`,
    cas_sha256: cleanCas ? `sha256:${cleanCas}` : null,
    expires_at: expiresAt == null ? null : normalizeTime(expiresAt),
    redactions: clean.redactions
  };
}

/**
 * Write one manifest through the receipt owner.  This intentionally remains
 * synchronous because CleanDatabase transactions are synchronous callbacks.
 */
export function createManifest({ db = null, platform = null, policy = null, ...options } = {}) {
  const database = db || platform?.db;
  if (!database || typeof database.run !== 'function') throw new TypeError('receipt_database_required');
  return createManifestInTransaction(database, { policy: policy || platform?.policy || DEFAULT_REDACTION_POLICY, ...options });
}

export class ReceiptService {
  constructor({ platform = null, db = null, policy = null, clock = utcNow } = {}) {
    this.platform = platform || null;
    this.db = db || platform?.db;
    this.policy = policy || platform?.policy || DEFAULT_REDACTION_POLICY;
    if (!this.db) throw new TypeError('receipt_database_required');
    this.clock = clock;
    this.issued = new Map();
    this.used = new Set();
  }

  issue({ actorId, projectId = null, casSha256, mediaType = 'application/octet-stream', ttlMs = 5 * 60 * 1000 } = {}) {
    if (!actorId) throw new PlatformError('authentication_required', 'download receipt actor is required', {}, 401);
    const cleanHash = String(casSha256 || '').replace(/^sha256:/, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(cleanHash)) throw new PlatformError('invalid_request', 'download receipt CAS hash is invalid', {}, 400);
    const now = this.#time();
    const expiresAt = new Date(Date.parse(now) + Math.max(1000, Math.min(60 * 60 * 1000, ttlMs))).toISOString();
    const receiptId = opaqueId('download');
    const payload = { receipt_id: receiptId, actor_id: String(actorId), project_id: projectId == null ? null : String(projectId), cas_sha256: cleanHash, media_type: String(mediaType).slice(0, 160), expires_at: expiresAt };
    const manifest = this.createManifest({ id: receiptId, kind: 'download', payload, status: 'created', casSha256: cleanHash, expiresAt });
    this.issued.set(receiptId, payload);
    return { receipt: receiptId, receipt_id: receiptId, expires_at: expiresAt, cas_sha256: `sha256:${cleanHash}`, media_type: payload.media_type, manifest_id: manifest.receipt_id };
  }

  consume(receipt, { actorId, projectId = null, casSha256 = null } = {}) {
    const id = String(receipt || '');
    const consumedId = `receipt_consumed_${sha256Hex(id).slice(0, 32)}`;
    if (this.used.has(id) || this.db.get('SELECT id FROM receipt_manifests WHERE id=? AND kind=?', [consumedId, 'download.consumed'])) throw new PlatformError('receipt_expired', 'download receipt is expired or already consumed', {}, 410);
    let payload = this.issued.get(id);
    if (!payload) {
      const row = this.db.get('SELECT payload_json FROM receipt_manifests WHERE id=? AND kind=?', [id, 'download']);
      if (row) {
        try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
      }
    }
    if (!payload) throw new PlatformError('receipt_expired', 'download receipt is expired or already consumed', {}, 410);
    const now = this.#time();
    if (Date.parse(payload.expires_at) <= Date.parse(now)) throw new PlatformError('receipt_expired', 'download receipt is expired', {}, 410);
    if (payload.actor_id !== String(actorId) || (payload.project_id || null) !== (projectId || null)) throw new PlatformError('permission_denied', 'download receipt scope does not match', {}, 403);
    if (casSha256 && payload.cas_sha256 !== String(casSha256).replace(/^sha256:/, '').toLowerCase()) throw new PlatformError('scope_denied', 'download receipt object does not match', {}, 403);
    try {
      this.createManifest({ id: consumedId, kind: 'download.consumed', payload: { receipt_id: id, consumed_at: this.#time() }, status: 'verified' });
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new PlatformError('receipt_expired', 'download receipt is expired or already consumed', {}, 410);
      throw error;
    }
    this.used.add(id);
    return { ...payload, cas_sha256: `sha256:${payload.cas_sha256}`, consumed: true };
  }

  createManifest(options = {}) {
    return createManifest({ db: this.db, policy: this.policy, createdAt: this.#time(), ...options });
  }

  createManifestInTransaction(tx, options = {}) {
    return createManifestInTransaction(tx, { policy: this.policy, createdAt: this.#time(), ...options });
  }

  #time() { const value = this.clock(); return typeof value === 'string' ? value : new Date(value).toISOString(); }
}

function normalizeKind(value) {
  const result = String(value || '').trim();
  if (!result || result.length > 160 || !/^[a-z][a-z0-9._:-]*$/.test(result)) throw new PlatformError('invalid_request', 'receipt kind is invalid', {}, 400);
  return result;
}

function normalizeStatus(value) {
  const result = String(value || '').trim();
  if (!result || result.length > 64 || !/^[a-z][a-z0-9._:-]*$/.test(result)) throw new PlatformError('invalid_request', 'receipt status is invalid', {}, 400);
  return result;
}

function normalizeHash(value) {
  const result = String(value).replace(/^sha256:/, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new PlatformError('invalid_request', 'receipt CAS hash is invalid', {}, 400);
  return result;
}

function normalizeTime(value) {
  const result = typeof value === 'string' ? value : new Date(value).toISOString();
  if (Number.isNaN(Date.parse(result))) throw new PlatformError('invalid_request', 'receipt timestamp is invalid', {}, 400);
  return result;
}
