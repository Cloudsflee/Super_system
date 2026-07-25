import fs from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MCP_GATEWAY_HEADERS = Object.freeze({
  timestamp: 'x-aiws-mcp-gateway-timestamp',
  nonce: 'x-aiws-mcp-gateway-nonce',
  signature: 'x-aiws-mcp-gateway-signature'
});

export function loadMcpGatewaySecret(env = process.env) {
  const inline = String(env.AIWS_MCP_GATEWAY_SECRET || '').trim();
  const file = String(env.AIWS_MCP_GATEWAY_SECRET_FILE || '').trim();
  const secret = inline || (file ? fs.readFileSync(file, 'utf8').trim() : '');
  if (!secret) return null;
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('mcp_gateway_secret_too_short');
  return secret;
}

export function signMcpGatewayRequest({
  secret,
  method,
  url,
  authorization,
  timestamp = Date.now(),
  nonce = randomBytes(18).toString('base64url')
}) {
  assertSecret(secret);
  const normalizedTimestamp = String(Math.trunc(Number(timestamp)));
  if (!/^\d{13}$/.test(normalizedTimestamp)) throw new Error('mcp_gateway_timestamp_invalid');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(String(nonce))) throw new Error('mcp_gateway_nonce_invalid');
  const signature = createHmac('sha256', secret)
    .update(signaturePayload({ method, url, authorization, timestamp: normalizedTimestamp, nonce }))
    .digest('hex');
  return {
    [MCP_GATEWAY_HEADERS.timestamp]: normalizedTimestamp,
    [MCP_GATEWAY_HEADERS.nonce]: String(nonce),
    [MCP_GATEWAY_HEADERS.signature]: `v1=${signature}`
  };
}

export function verifyMcpGatewayRequest({
  secret,
  method,
  url,
  authorization,
  headers,
  now = Date.now(),
  maxSkewMs = 30_000,
  seenNonces = null
}) {
  try {
    assertSecret(secret);
  } catch {
    return { ok: false, error: 'gateway_secret_invalid' };
  }
  const timestamp = header(headers, MCP_GATEWAY_HEADERS.timestamp);
  const nonce = header(headers, MCP_GATEWAY_HEADERS.nonce);
  const supplied = header(headers, MCP_GATEWAY_HEADERS.signature);
  if (!/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,80}$/.test(nonce) || !/^v1=[a-f0-9]{64}$/.test(supplied))
    return { ok: false, error: 'gateway_signature_missing' };
  const issuedAt = Number(timestamp);
  if (Math.abs(Number(now) - issuedAt) > maxSkewMs) return { ok: false, error: 'gateway_signature_expired' };
  pruneNonces(seenNonces, Number(now) - maxSkewMs);
  if (seenNonces?.has(nonce)) return { ok: false, error: 'gateway_signature_replayed' };
  const expected = signMcpGatewayRequest({ secret, method, url, authorization, timestamp, nonce })[
    MCP_GATEWAY_HEADERS.signature
  ];
  const expectedBytes = Buffer.from(expected),
    suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes))
    return { ok: false, error: 'gateway_signature_invalid' };
  seenNonces?.set(nonce, issuedAt);
  return { ok: true, issued_at: issuedAt, nonce };
}

function signaturePayload({ method, url, authorization, timestamp, nonce }) {
  const target = new URL(String(url || '/'), 'http://aiws.internal');
  const authHash = createHash('sha256')
    .update(String(authorization || ''))
    .digest('hex');
  return [
    'aiws-mcp-gateway-v1',
    timestamp,
    nonce,
    String(method || 'GET').toUpperCase(),
    `${target.pathname}${target.search}`,
    authHash
  ].join('\n');
}

function assertSecret(value) {
  if (Buffer.byteLength(String(value || ''), 'utf8') < 32) throw new Error('mcp_gateway_secret_too_short');
}

function header(headers, name) {
  if (headers?.get) return String(headers.get(name) || '');
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function pruneNonces(store, cutoff) {
  if (!store) return;
  for (const [nonce, timestamp] of store) if (timestamp < cutoff) store.delete(nonce);
}
