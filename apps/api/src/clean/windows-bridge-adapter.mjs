import {
  createDecipheriv, createHash, createHmac, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify
} from 'node:crypto';
import { canonicalJson } from './canonical.mjs';
import { PlatformError } from './platform-error.mjs';

/** Loopback transport adapter. It has no persistence; the Clean Bridge owner
 * provides the in-memory credential lease used to sign each request. */
export class WindowsBridgeAdapter {
  constructor({ baseUrl = null, fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) { this.baseUrl = baseUrl ? String(baseUrl).replace(/\/$/, '') : null; this.fetch = fetchImpl; this.clock = clock; }
  async identity() { if (!this.baseUrl) return { capabilities: { conpty: process.platform === 'win32', dpapi: process.platform === 'win32', git_bundle: true }, fixture: true }; return this.request('/v1/identity', {}, null, 'GET'); }
  async pair({ confirmationCode = null } = {}) {
    const clientIdentity = generateKeyPairSync('ed25519');
    const clientTransport = generateKeyPairSync('x25519');
    const identityPublic = clientIdentity.publicKey.export({ type: 'spki', format: 'pem' });
    const transportPublic = clientTransport.publicKey.export({ type: 'spki', format: 'pem' });
    if (!this.baseUrl) {
      const identity = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
      const transport = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'pem' });
      const transcript = { schema_version: 'aiws.bridge.pairing.v1', bridge_identity_public_key: identity, bridge_transport_public_key: transport, client_identity_public_key: identityPublic, client_transport_public_key: transportPublic };
      return { identity_public_key: identity, transport_public_key: transport, paired_transcript_sha256: createHash('sha256').update(canonicalJson(transcript)).digest('hex'), confirmation_code_sha256: createHash('sha256').update('fixture').digest('hex'), secretRef: `pair-${randomBytes(16).toString('hex')}`, secret: randomBytes(32), fixture: true };
    }
    const challenge = await this.request('/v1/pairing/start', { identity_public_key: identityPublic, transport_public_key: transportPublic }, null);
    const transcriptJson = canonicalJson(challenge.transcript || {});
    const transcriptHash = createHash('sha256').update(transcriptJson).digest('hex');
    if (transcriptHash !== String(challenge.transcript_sha256 || '')) throw new PlatformError('pairing_transcript_mismatch', 'Bridge pairing transcript hash changed', {}, 422);
    const transcript = challenge.transcript || {};
    if (transcript.client_identity_public_key !== identityPublic || transcript.client_transport_public_key !== transportPublic) throw new PlatformError('pairing_transcript_mismatch', 'Bridge pairing transcript changed client identity', {}, 422);
    const bridgeIdentity = createPublicKey(String(transcript.bridge_identity_public_key || ''));
    const signature = Buffer.from(String(challenge.bridge_signature || ''), 'base64url');
    if (bridgeIdentity.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(transcriptHash, 'hex'), bridgeIdentity, signature)) throw new PlatformError('pairing_signature_invalid', 'Bridge pairing signature is invalid', {}, 422);
    const code = String(challenge.confirmation_code || '');
    if (confirmationCode != null && String(confirmationCode) !== code) throw new PlatformError('confirmation_mismatch', 'Bridge confirmation code differs', {}, 403);
    const clientSignature = sign(null, Buffer.from(transcriptHash, 'hex'), clientIdentity.privateKey).toString('base64url');
    const confirmed = await this.request('/v1/pairing/confirm', { pairing_id: challenge.pairing_id, confirmation_code: code, client_signature: clientSignature }, null);
    if (confirmed.paired_transcript_sha256 !== transcriptHash) throw new PlatformError('pairing_transcript_mismatch', 'Bridge confirmation transcript changed', {}, 422);
    const shared = diffieHellman({ privateKey: clientTransport.privateKey, publicKey: createPublicKey(transcript.bridge_transport_public_key) });
    const secret = Buffer.from(hkdfSync('sha256', shared, Buffer.from(transcriptHash, 'hex'), Buffer.from('aiws-windows-bridge-pairing-v1'), 32));
    const proof = openPairingProof(secret, Buffer.from(transcriptHash, 'hex'), confirmed.encrypted_secret);
    if (proof.paired !== true || proof.transcript_sha256 !== transcriptHash) throw new PlatformError('pairing_secret_invalid', 'Bridge shared-secret proof is invalid', {}, 422);
    return { identity_public_key: transcript.bridge_identity_public_key, transport_public_key: transcript.bridge_transport_public_key, paired_transcript_sha256: transcriptHash, confirmation_code_sha256: String(challenge.confirmation_code_sha256 || ''), secretRef: String(confirmed.shared_secret_ref || ''), secret };
  }
  async probe({ secretRef, secret }) { if (!this.baseUrl) return { status: 'ready', authenticated: true, capabilities: (await this.identity()).capabilities, fixture: true }; return this.request('/v1/probe', { probe: true }, { secretRef, secret }); }
  async rotate({ secretRef, secret }) { if (!this.baseUrl) return { rotated: true, secret: randomBytes(32), fixture: true }; const result = await this.request('/v1/rotate', {}, { secretRef, secret }); const salt = Buffer.from(String(result.rotation_salt || ''), 'base64url'); if (salt.length !== 32) throw new PlatformError('bridge_rotation_invalid', 'Bridge rotation salt is invalid', {}, 503); const replacement = createHmac('sha256', secret).update(Buffer.from('aiws-bridge-rotate-v1')).update(salt).digest(); const proof = createHmac('sha256', replacement).update('rotated').digest('hex'); if (!safeEqual(proof, result.rotation_proof)) throw new PlatformError('bridge_rotation_invalid', 'Bridge rotation proof is invalid', {}, 503); return { ...result, secret: replacement }; }
  async revoke({ secretRef, secret }) { if (!this.baseUrl) return { revoked: true, fixture: true }; return this.request('/v1/revoke', {}, { secretRef, secret }); }
  async verifyBundle(input, lease) { if (!this.baseUrl) return { verified: true, bundle_sha256: input.bundle_sha256 || '', byte_length: Number(input.byte_length || 0), fixture: true }; return this.request('/v1/git-bundle/verify', input, lease); }
  async submitJob(input, lease) { if (!this.baseUrl) throw new PlatformError('bridge_unavailable', 'Windows Bridge job transport is unavailable', {}, 503); return this.request('/v1/jobs', input, lease); }
  async jobStatus(jobId, lease) { if (!this.baseUrl) return { job_id: String(jobId), status: 'unknown' }; return this.request(`/v1/jobs/${encodeURIComponent(jobId)}`, {}, lease, 'GET'); }
  async cancelJob(jobId, lease) { if (!this.baseUrl) return { job_id: String(jobId), status: 'unknown' }; return this.request(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {}, lease); }
  async request(route, body, lease, method = 'POST') {
    if (!this.fetch) throw new PlatformError('bridge_unavailable', 'Bridge HTTP transport is unavailable', {}, 503);
    const headers = { 'content-type': 'application/json' };
    if (lease) { const timestamp = String(Number(this.clock())); const nonce = randomBytes(18).toString('base64url'); const bodyHash = createHash('sha256').update(canonicalJson(body || {})).digest('hex'); const signature = createHmac('sha256', lease.secret).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest('hex'); Object.assign(headers, { 'x-aiws-secret-ref': String(lease.secretRef).replace(/^vault:/, ''), 'x-aiws-timestamp': timestamp, 'x-aiws-nonce': nonce, 'x-aiws-signature': signature }); }
    let response; try { response = await this.fetch(`${this.baseUrl}${route}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }) }); } catch (error) { throw new PlatformError('bridge_unavailable', 'Bridge loopback request failed', { reason: String(error?.message || '').slice(0, 160) }, 503); }
    const payload = await response.json().catch(() => ({})); if (!response.ok) throw new PlatformError(String(payload?.error?.code || 'bridge_failed'), 'Bridge request failed', payload?.error?.details || {}, response.status); return payload;
  }
}

function openPairingProof(key, aad, value = {}) { try { const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(value.iv || ''), 'base64url')); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(String(value.tag || ''), 'base64url')); const bytes = Buffer.concat([decipher.update(Buffer.from(String(value.ciphertext || ''), 'base64url')), decipher.final()]); return JSON.parse(bytes.toString('utf8')); } catch { throw new PlatformError('pairing_secret_invalid', 'Bridge shared-secret proof is invalid', {}, 422); } }
function safeEqual(left, right) { const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || '')); return a.length === b.length && timingSafeEqual(a, b); }
