import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createCleanRuntime, createNotReadyRuntime } from './src/clean/runtime.mjs';
import { createCleanHttpHandler } from './src/clean/http.mjs';
import { routeParams } from './src/clean/registry.mjs';
import { createCleanWebHandler } from './src/clean/web-static.mjs';

export function createApp(options = {}) {
  let runtime = options.runtime;
  if (!runtime) {
    try {
      runtime = createCleanRuntime(options);
    } catch (error) {
      if (String(error?.code || '') !== 'not_ready') throw error;
      runtime = createNotReadyRuntime(options, error);
    }
  }
  const apiHandler = createCleanHttpHandler({ runtime, registry: runtime.registry, maxBodyBytes: runtime.config.maxBodyBytes });
  const webHandler = createCleanWebHandler({ root: options.webRoot });
  const handler = async (request, response) => {
    if (webHandler(request, response)) return;
    return apiHandler(request, response);
  };
  return {
    ...runtime,
    handler,
    async close() { await runtime.close(); }
  };
}

export async function start(options = {}) {
  const app = createApp(options);
  const server = http.createServer((request, response) => {
    Promise.resolve(app.handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ request_id: `req_${Date.now()}`, error: { code: 'internal_error', message: 'internal error', details: {}, retryable: false, redactions: [] } }));
      process.stderr.write(`clean request failed: ${String(error?.message || error)}\n`);
    });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 70 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://v3-clean.local');
    const entry = app.registry.match('GET', url.pathname.replace(/\/$/, '') || '/');
    if (!app.p5 || entry?.command_id !== 'terminal.ws' || !app.terminal) return rejectUpgrade(socket, 404, 'not_found');
    let principal;
    try { principal = app.identity.principalFromRequest(request); }
    catch (error) { return rejectUpgrade(socket, Number(error?.status || 401), String(error?.code || 'authentication_required')); }
    const params = routeParams(entry.path, url.pathname);
    try { app.terminal.get(params.id, principal); }
    catch (error) { return rejectUpgrade(socket, Number(error?.status || 403), String(error?.code || 'permission_denied')); }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws, request, { principal, terminalId: params.id, cursor: url.searchParams.get('cursor') || 0 }));
  });
  sockets.on('connection', (ws, _request, context) => {
    const { principal, terminalId, cursor } = context;
    const send = (value) => { if (ws.readyState === 1) ws.send(JSON.stringify(value)); };
    const replay = app.terminal.eventsFor(terminalId, { cursor, limit: 500 }, principal);
    for (const event of replay.events) if (event.type === 'terminal.output' && typeof event.data?.chunk === 'string') send({ type: 'output', data: event.data.chunk, cursor: event.sequence });
    send({ type: 'status', session: app.terminal.get(terminalId, principal), cursor: replay.cursor_sequence || 0 });
    const unsubscribe = app.terminal.subscribe(terminalId, principal, send);
    ws.on('message', (raw) => {
      Promise.resolve().then(async () => {
        let frame; try { frame = JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('invalid_json'), { code: 'invalid_json', status: 400 }); }
        const input = {
          ...frame,
          expected_revision: frame.revision ?? frame.expected_revision,
          idempotency_key: frame.idempotency_key || `terminal-${terminalId}-${String(frame.type || 'frame')}-${String(frame.client_sequence || 0)}`
        };
        if (frame.type === 'input') return app.terminal.input(terminalId, input, principal);
        if (frame.type === 'resize') return app.terminal.resize(terminalId, input, principal);
        if (frame.type === 'signal') return app.terminal.signal(terminalId, input, principal);
        if (frame.type === 'stop') return app.terminal.stop(terminalId, input, principal);
        throw Object.assign(new Error('frame_type_invalid'), { code: 'frame_type_invalid', status: 422 });
      }).then((result) => send({ type: 'ack', action: result?.action || 'stop', session: result?.terminal || app.terminal.get(terminalId, principal), cursor: result?.cursor || null })).catch((error) => send({ type: 'error', error: { code: String(error?.code || 'terminal_frame_failed'), message: String(error?.message || 'terminal frame failed').slice(0, 160), details: error?.details || {} } }));
    });
    ws.once('close', unsubscribe);
  });
  await new Promise((resolve) => server.listen(app.config.port, app.config.host, resolve));
  const address = server.address();
  process.stdout.write(`V3-Clean listening on http://${address.address}:${address.port}\n`);
  const close = async () => {
    for (const socket of sockets.clients) socket.close(1001, 'server_shutdown');
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  };
  return { ...app, server, close };
}

function rejectUpgrade(socket, status, code) {
  const message = JSON.stringify({ error: { code } });
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`);
  socket.destroy();
}
