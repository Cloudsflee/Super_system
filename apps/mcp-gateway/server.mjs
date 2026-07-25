import http from 'node:http';
import { gatewayConfig } from './src/config.mjs';
import { GatewayError, McpGatewayRuntime } from './src/runtime.mjs';

const config = gatewayConfig();
const runtime = new McpGatewayRuntime(config);
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const url = new URL(req.url || '/', 'http://aiws-gateway.local');
    if (req.method === 'GET' && url.pathname === '/health')
      return json(res, 200, { status: 'ok', service: 'aiws-mcp-gateway', version: '1.8.0', ...runtime.snapshot() });
    if (!['/mcp', '/api/mcp'].includes(url.pathname)) throw new GatewayError(404, 'mcp_gateway_not_found');
    if (!['GET', 'POST', 'DELETE'].includes(req.method || ''))
      throw new GatewayError(405, 'mcp_gateway_method_not_allowed');
    assertProxyTls(req);
    const body = req.method === 'POST' ? await readJson(req, config.maxBodyBytes) : undefined;
    await runtime.handle(req, res, body);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const status = error instanceof GatewayError ? error.status : 500;
    const code = error instanceof GatewayError ? error.code : 'mcp_gateway_internal_error';
    json(res, status, { error: code });
  }
});

server.listen(config.port, config.host, () =>
  console.log(`AIWS MCP Gateway listening on http://${config.host}:${config.port}/mcp`)
);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await runtime.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void close();
  });

function assertProxyTls(req) {
  if (!config.requireProxyTls || !req.headers['x-forwarded-for']) return;
  const protocol = String(
    Array.isArray(req.headers['x-forwarded-proto'])
      ? req.headers['x-forwarded-proto'][0]
      : req.headers['x-forwarded-proto'] || ''
  )
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (protocol !== 'https') throw new GatewayError(426, 'mcp_gateway_https_required');
}

async function readJson(req, limit) {
  const type = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/json') throw new GatewayError(415, 'mcp_gateway_json_required');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new GatewayError(413, 'mcp_gateway_body_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GatewayError(400, 'mcp_gateway_json_invalid');
  }
}

function securityHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}
