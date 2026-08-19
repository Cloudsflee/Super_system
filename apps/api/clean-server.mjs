import http from 'node:http';
import { createCleanRuntime, createNotReadyRuntime } from './src/clean/runtime.mjs';
import { createCleanHttpHandler } from './src/clean/http.mjs';

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
  const handler = createCleanHttpHandler({ runtime, registry: runtime.registry, maxBodyBytes: runtime.config.maxBodyBytes });
  return {
    ...runtime,
    handler,
    async close() { runtime.close(); }
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
  await new Promise((resolve) => server.listen(app.config.port, app.config.host, resolve));
  const address = server.address();
  process.stdout.write(`V3-Clean listening on http://${address.address}:${address.port}\n`);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  };
  return { ...app, server, close };
}
