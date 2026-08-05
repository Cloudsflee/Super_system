import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BrokerClient } from './src/broker-client.mjs';
import { loadConfig } from './src/config.mjs';
import { openDatabase } from './src/database.mjs';
import { Domain } from './src/domain.mjs';
import { createHttpHandler } from './src/http.mjs';
import { createCommandRegistry } from './src/command-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function createApp(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const database = options.db || await openDatabase(options.databaseFile || config.databaseFile);
  const broker = options.broker || new BrokerClient(config);
  const listeners = new Set();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const domain = new Domain({ db: database, config, broker, emit: (event) => listeners.forEach((listener) => listener(event)) });
  const registry = createCommandRegistry(domain);
  const performanceProbe = () => ({
    rss_bytes: process.memoryUsage().rss,
    event_loop_lag_p95_ms: Number((loopDelay.percentile(95) / 1e6).toFixed(3)),
    uptime_seconds: Number(process.uptime().toFixed(3))
  });
  const handler = createHttpHandler({ domain, registry, db: database, config, performanceProbe, webRoot: options.webRoot || path.join(root, 'apps', 'web', 'dist') });
  await domain.recover();
  return {
    config,
    database,
    broker,
    domain,
    registry,
    handler,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() { loopDelay.disable(); await database.close(); }
  };
}

export async function start(options = {}) {
  const app = await createApp(options);
  const server = http.createServer((request, response) => {
    Promise.resolve(app.handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'internal_error', message: error.message, retryable: false } }));
    });
  });
  await new Promise((resolve) => server.listen(app.config.port, app.config.host, resolve));
  const address = server.address();
  process.stdout.write(`AIWS 3.0.0 listening on http://${address.address}:${address.port}\n`);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  };
  return { ...app, server, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await start();
  const shutdown = async () => { await running.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
