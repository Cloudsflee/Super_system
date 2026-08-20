import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, opaqueId, sha256Hex, utcNow } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

const NONCE = /^[A-Za-z0-9._~-]{8,200}$/;

export class CleanGatewayService {
  constructor({ db, policy, clock = utcNow, secret, gatewayId = 'gateway-local' } = {}) {
    if (!db) throw new TypeError('clean_gateway_database_required');
    if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('clean_gateway_secret_required');
    this.db = db;
    this.policy = policy;
    this.clock = clock;
    this.secret = String(secret || '');
    this.gatewayId = String(gatewayId || 'gateway-local');
  }

  sign({ method = 'POST', path = '/api/v2/gateway/forward', timestamp = Math.floor(Date.now() / 1000), nonce, body = {} } = {}) {
    const bodyHash = sha256Hex(canonicalJson(body));
    const input = `${String(method).toUpperCase()}\n${String(path)}\n${String(timestamp)}\n${String(nonce)}\n${bodyHash}`;
    return createHmac('sha256', this.secret).update(input).digest('hex');
  }

  verify({ headers = {}, method = 'POST', path = '/api/v2/gateway/forward', body = {} } = {}) {
    const normalized = normalizeHeaders(headers);
    const gatewayId = String(normalized['x-aiws-gateway-id'] || '');
    const timestampValue = String(normalized['x-aiws-gateway-timestamp'] || '');
    const nonce = String(normalized['x-aiws-gateway-nonce'] || '');
    const signature = String(normalized['x-aiws-gateway-signature'] || '').toLowerCase();
    if (!gatewayId || !timestampValue || !NONCE.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw new PlatformError('gateway_signature_invalid', 'gateway signature headers are invalid', {}, 401);
    const timestamp = parseTimestamp(timestampValue);
    const now = Date.now();
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 60_000) throw new PlatformError('gateway_signature_invalid', 'gateway timestamp is outside the accepted window', {}, 401);
    const expected = this.sign({ method, path, timestamp: timestampValue, nonce, body });
    if (!safeEqual(signature, expected)) throw new PlatformError('gateway_signature_invalid', 'gateway signature does not match', {}, 401);
    return { gateway_id: gatewayId, timestamp: timestampValue, nonce, nonce_hash: sha256Hex(nonce), request_hash: sha256Hex(canonicalJson(body)) };
  }

  async forward({ headers = {}, method = 'POST', path = '/api/v2/gateway/forward', body = {}, principal = null, dispatch } = {}) {
    const verified = this.verify({ headers, method, path, body });
    const now = this.time();
    const prior = this.db.get('SELECT id,decision FROM gateway_forward_receipts WHERE nonce_hash=?', [verified.nonce_hash]);
    if (prior) {
      this.record({ ...verified, decision: 'replayed', response: { error: 'gateway_replay' }, operationId: null, now });
      throw new PlatformError('gateway_replay', 'gateway nonce has already been used', { receipt_id: prior.id }, 409);
    }
    if (typeof dispatch !== 'function') throw new PlatformError('gateway_destination_unavailable', 'gateway destination dispatcher is unavailable', {}, 503);
    let result;
    let decision = 'accepted';
    let operationId = null;
    try {
      result = await dispatch(body, principal);
      operationId = result?.operation?.operation_id || result?.operation_id || null;
    } catch (error) {
      decision = 'denied';
      result = { error: { code: String(error?.code || 'gateway_destination_denied') } };
      this.record({ ...verified, decision, response: result, operationId, now });
      throw error;
    }
    const receipt = this.record({ ...verified, decision, response: result, operationId, now });
    return { result, receipt };
  }

  receipt(id) {
    const row = this.db.get('SELECT * FROM gateway_forward_receipts WHERE id=?', [String(id)]);
    if (!row) throw new PlatformError('not_found', 'gateway receipt not found', {}, 404);
    return { id: row.id, gateway_id: row.gateway_id, nonce_hash: row.nonce_hash, command_id: row.command_id, request_hash: row.request_hash, response_hash: row.response_hash, decision: row.decision, operation_id: row.operation_id || null, created_at: row.created_at };
  }

  record({ gateway_id: gatewayId, nonce_hash: nonceHash, request_hash: requestHash, decision, response, operationId = null, now = this.time() } = {}) {
    const responseHash = sha256Hex(canonicalJson(response || {}));
    const commandId = String(response?.command_id || response?.result?.command_id || 'gateway.forward');
    const id = opaqueId('gwreceipt');
    try {
      this.db.run(`INSERT INTO gateway_forward_receipts(id,gateway_id,nonce_hash,command_id,request_hash,response_hash,decision,operation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, [id, String(gatewayId || this.gatewayId), String(nonceHash), commandId, String(requestHash), responseHash, decision, operationId, now]);
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new PlatformError('gateway_replay', 'gateway nonce has already been used', {}, 409);
      throw error;
    }
    return this.receipt(id);
  }

  time() { const value = typeof this.clock === 'function' ? this.clock() : this.clock; return typeof value === 'string' ? value : new Date(value).toISOString(); }
}

function normalizeHeaders(headers) { return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), Array.isArray(value) ? value[0] : value])); }
function parseTimestamp(value) { const numeric = Number(value); if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : NaN; }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
