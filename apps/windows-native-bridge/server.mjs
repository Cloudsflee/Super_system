import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeProtocol } from './src/protocol.mjs';

export function createBridge(options = {}) {
  const host = String(options.host || process.env.AIWS_BRIDGE_HOST || '127.0.0.1');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('bridge_loopback_required');
  const port = Number(options.port ?? process.env.AIWS_BRIDGE_PORT ?? 4321);
  const protocol = options.protocol || new BridgeProtocol({ stateRoot: options.stateRoot || process.env.AIWS_BRIDGE_STATE || path.join(os.homedir(), '.ai-workspace', 'windows-bridge') });
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/livez') return send(res, 200, { status: 'live', process: 'windows-native-bridge' });
      if (req.method === 'GET' && url.pathname === '/v1/identity') return send(res, 200, protocol.publicIdentity());
      const body = await readBody(req);
      if (req.method === 'POST' && url.pathname === '/v1/pairing/start') return send(res, 201, protocol.beginPairing(body));
      if (req.method === 'POST' && url.pathname === '/v1/pairing/confirm') return send(res, 200, protocol.confirmPairing(body));
      const auth = protocol.authenticate(req.headers, body);
      if (req.method === 'POST' && url.pathname === '/v1/probe') return send(res, 200, { status: 'ready', authenticated: true, nonce: auth.nonce, capabilities: protocol.publicIdentity().capabilities });
      if (req.method === 'POST' && url.pathname === '/v1/git-bundle/verify') return send(res, 200, protocol.verifyBundle(body));
      if (req.method === 'POST' && url.pathname === '/v1/rotate') return send(res, 200, protocol.rotate(auth.secretRef));
      if (req.method === 'POST' && url.pathname === '/v1/revoke') return send(res, 200, protocol.revoke(auth.secretRef));
      return send(res, 404, { error: { code: 'not_found' } });
    } catch (error) { return send(res, Number(error?.status || 500), { error: { code: String(error?.code || 'internal_error'), message: String(error?.message || 'internal error').slice(0, 160), details: error?.details || {} } }); }
  };
  return { host, port, protocol, handler };
}

export async function start(options = {}) { const app = createBridge(options); const server = http.createServer((req, res) => void app.handler(req, res)); await new Promise((resolve) => server.listen(app.port, app.host, resolve)); const address = server.address(); return { ...app, server, url: `http://${address.address}:${address.port}`, close: () => new Promise((resolve) => server.close(resolve)) }; }

async function readBody(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) { const error = new Error('body_too_large'); error.status = 413; throw error; } chunks.push(chunk); } if (!size) return {}; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const error = new Error('invalid_json'); error.status = 400; throw error; } }
function send(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); return value; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const running = await start(); process.stdout.write(`Windows Bridge listening on ${running.url}\n`); const close = async () => { await running.close(); process.exit(0); }; process.once('SIGINT', close); process.once('SIGTERM', close); }
