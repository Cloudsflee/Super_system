import { opaqueId, sha256Hex } from './canonical.mjs';
import { PlatformError } from './platform.mjs';

export class ReceiptService {
  constructor({ platform, clock = () => new Date().toISOString() } = {}) {
    if (!platform) throw new TypeError('receipt_platform_required');
    this.platform = platform;
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
    const manifest = this.platform.createReceipt({ id: receiptId, kind: 'download', payload, status: 'created', casSha256: cleanHash, expiresAt });
    this.issued.set(receiptId, payload);
    return { receipt: receiptId, receipt_id: receiptId, expires_at: expiresAt, cas_sha256: `sha256:${cleanHash}`, media_type: payload.media_type, manifest_id: manifest.receipt_id };
  }

  consume(receipt, { actorId, projectId = null, casSha256 = null } = {}) {
    const id = String(receipt || '');
    const consumedId = `receipt_consumed_${sha256Hex(id).slice(0, 32)}`;
    if (this.used.has(id) || this.platform.db.get('SELECT id FROM receipt_manifests WHERE id=? AND kind=?', [consumedId, 'download.consumed'])) throw new PlatformError('receipt_expired', 'download receipt is expired or already consumed', {}, 410);
    let payload = this.issued.get(id);
    if (!payload) {
      const row = this.platform.db.get('SELECT payload_json FROM receipt_manifests WHERE id=? AND kind=?', [id, 'download']);
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
      this.platform.createReceipt({ id: consumedId, kind: 'download.consumed', payload: { receipt_id: id, consumed_at: this.#time() }, status: 'verified' });
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new PlatformError('receipt_expired', 'download receipt is expired or already consumed', {}, 410);
      throw error;
    }
    this.used.add(id);
    return { ...payload, cas_sha256: `sha256:${payload.cas_sha256}`, consumed: true };
  }

  #time() { const value = this.clock(); return typeof value === 'string' ? value : new Date(value).toISOString(); }
}
