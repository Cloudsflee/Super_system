import http from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PROTOCOL = '2025-06-18';
const MAX_BODY = 10 * 1024 * 1024;

export function gatewaySignature({ secret, method = 'POST', path = '/api/v2/gateway/forward', timestamp, nonce, body = {} } = {}) {
  const bodyHash = sha256(canonicalJson(body));
  const input = `${String(method).toUpperCase()}\n${String(path)}\n${String(timestamp)}\n${String(nonce)}\n${bodyHash}`;
  return createHmac('sha256', String(secret || '')).update(input).digest('hex');
}

export async function forward({ apiUrl, secret, body, fetchImpl = fetch, headers = {} } = {}) {
  const endpoint = new URL('/api/v2/gateway/forward', String(apiUrl || 'http://127.0.0.1:4317'));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('base64url');
  const signature = gatewaySignature({ secret, method: 'POST', path: endpoint.pathname, timestamp, nonce, body });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-AIWS-Gateway-Id': String(headers['x-aiws-gateway-id'] || process.env.AIWS_GATEWAY_ID || 'gateway-process'),
      'X-AIWS-Gateway-Timestamp': timestamp,
      'X-AIWS-Gateway-Nonce': nonce,
      'X-AIWS-Gateway-Signature': signature
    },
    body: canonicalJson(body || {})
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error: { code: 'gateway_upstream_invalid_json' } }; }
  return { status: response.status, headers: response.headers, payload };
}

export function createGatewayServer(options = {}) {
  const host = String(options.host || process.env.AIWS_GATEWAY_BIND_HOST || '127.0.0.1');
  const port = Number(options.port ?? process.env.AIWS_GATEWAY_PORT ?? 4320);
  const apiUrl = String(options.apiUrl || process.env.AIWS_GATEWAY_API_URL || 'http://127.0.0.1:4317');
  const production = String(options.nodeEnv || process.env.NODE_ENV || '').toLowerCase() === 'production';
  const secret = String(options.secret ?? process.env.AIWS_GATEWAY_SECRET ?? (production ? '' : 'p4-gateway-fixture-secret'));
  const gatewayId = String(options.gatewayId || process.env.AIWS_GATEWAY_ID || 'gateway-process');
  const fetchImpl = options.fetchImpl || fetch;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('gateway_port_invalid');
  if (secret.length < 16 || (production && secret.length < 32)) throw new Error('gateway_secret_required');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://gateway.local').pathname.replace(/\/$/, '') || '/';
    try {
      if (req.method === 'GET' && pathname === '/livez') return json(res, 200, { status: 'live', runtime: 'aiws-gateway', protocol_version: PROTOCOL });
      if (req.method === 'GET' && pathname === '/readyz') return json(res, 200, { status: 'ready', runtime: 'aiws-gateway', upstream: apiUrl, gateway_id: gatewayId });
      if (req.method !== 'POST' || pathname !== '/api/v2/gateway/forward') return json(res, 404, { error: { code: 'not_found' } });
      const body = await readJson(req);
      const result = await forward({ apiUrl, secret, body, fetchImpl, headers: { 'x-aiws-gateway-id': gatewayId } });
      return json(res, result.status, result.payload);
    } catch (error) {
      return json(res, Number(error.status || 500), { error: { code: String(error.code || 'gateway_internal_error'), message: String(error.message || 'gateway request failed') } });
    }
  });
  return { server, host, port, apiUrl, gatewayId, async listen() { await new Promise((resolve) => server.listen(port, host, resolve)); return server.address(); }, async close() { if (server.listening) await new Promise((resolve) => server.close(resolve)); } };
}

export async function start(options = {}) {
  const gateway = createGatewayServer(options);
  const address = await gateway.listen();
  process.stdout.write(`AIWS Gateway listening on http://${address.address}:${address.port}\n`);
  return gateway;
}

async function readJson(req) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > MAX_BODY) { const error = new Error('gateway_payload_too_large'); error.code = 'payload_too_large'; error.status = 413; throw error; }
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > MAX_BODY) { const error = new Error('gateway_payload_too_large'); error.code = 'payload_too_large'; error.status = 413; throw error; } chunks.push(chunk); }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const error = new Error('gateway_invalid_json'); error.code = 'schema_invalid'; error.status = 400; throw error; }
}

function json(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(payload)); }
function sha256(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('canonical_number_invalid'); return Object.is(value, -0) ? 0 : value; }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') { const output = {}; for (const key of Object.keys(value).sort()) if (value[key] !== undefined) output[key] = canonicalize(value[key]); return output; }
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const running = await start();
  const shutdown = async () => { await running.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

export { PROTOCOL };
