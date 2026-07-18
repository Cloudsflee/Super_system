import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMcpGatewaySecret, signMcpGatewayRequest, verifyMcpGatewayRequest } from '../../packages/mcp-bridge/src/index.mjs';

const secret = 'v18-gateway-unit-secret-32-bytes-minimum';
const authorization = 'Bearer aiws_mcp_unit_token_value';
const timestamp = 1_784_290_000_000;
const nonce = 'unit_nonce_1234567890';
const signed = signMcpGatewayRequest({ secret, method: 'POST', url: '/api/mcp', authorization, timestamp, nonce });
const seen = new Map();

assert.equal(verifyMcpGatewayRequest({ secret, method: 'POST', url: '/api/mcp', authorization, headers: signed, now: timestamp, seenNonces: seen }).ok, true);
assert.equal(verifyMcpGatewayRequest({ secret, method: 'POST', url: '/api/mcp', authorization, headers: signed, now: timestamp, seenNonces: seen }).error, 'gateway_signature_replayed');
assert.equal(verifyMcpGatewayRequest({ secret, method: 'DELETE', url: '/api/mcp', authorization, headers: signed, now: timestamp }).error, 'gateway_signature_invalid');
assert.equal(verifyMcpGatewayRequest({ secret, method: 'POST', url: '/api/mcp', authorization: `${authorization}x`, headers: signed, now: timestamp }).error, 'gateway_signature_invalid');
assert.equal(verifyMcpGatewayRequest({ secret, method: 'POST', url: '/api/mcp', authorization, headers: signed, now: timestamp + 30_001 }).error, 'gateway_signature_expired');
assert.throws(() => signMcpGatewayRequest({ secret: 'short', method: 'POST', url: '/api/mcp', authorization }), /secret_too_short/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiws-gateway-secret-'));
try {
  const file = path.join(root, 'gateway.secret');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  assert.equal(loadMcpGatewaySecret({ AIWS_MCP_GATEWAY_SECRET_FILE: file }), secret);
  assert.equal(loadMcpGatewaySecret({ AIWS_MCP_GATEWAY_SECRET: secret }), secret);

  const previous = { mode: process.env.AIWS_MCP_REMOTE_MODE, secret: process.env.AIWS_MCP_GATEWAY_SECRET };
  process.env.AIWS_MCP_REMOTE_MODE = 'gateway';
  process.env.AIWS_MCP_GATEWAY_SECRET = secret;
  try {
    const { assertLocalMcpAdmin, assertMcpPeer } = await import('../../apps/api/src/mcp-client-service.mjs');
    const peerNonce = 'peer_nonce_1234567890';
    const peerHeaders = { authorization, ...signMcpGatewayRequest({ secret, method: 'POST', url: '/api/mcp', authorization, nonce: peerNonce }) };
    const request = { method: 'POST', url: '/api/mcp', headers: peerHeaders, socket: { remoteAddress: '172.22.0.5' } };
    assert.equal(assertMcpPeer(request), true);
    assert.throws(() => assertMcpPeer(request), (error) => error.status === 403 && error.payload.reason === 'gateway_signature_replayed');
    assert.throws(() => assertMcpPeer({ ...request, headers: { authorization }, socket: { remoteAddress: '172.22.0.6' } }), (error) => error.status === 403 && error.payload.error === 'mcp_gateway_signature_required');
    assert.throws(() => assertLocalMcpAdmin(request), (error) => error.status === 403 && error.payload.error === 'mcp_local_admin_required');
    assert.equal(assertLocalMcpAdmin({ socket: { remoteAddress: '127.0.0.1' } }), true);
  } finally {
    if (previous.mode === undefined) delete process.env.AIWS_MCP_REMOTE_MODE; else process.env.AIWS_MCP_REMOTE_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.AIWS_MCP_GATEWAY_SECRET; else process.env.AIWS_MCP_GATEWAY_SECRET = previous.secret;
  }
  console.log('V1.8 MCP Gateway signature unit tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
