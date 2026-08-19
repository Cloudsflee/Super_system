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
import { GitHubIntegration } from './src/github-integration.mjs';

// Historical V2.3 behavior fixture. Clean startup never imports this module.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function createApp(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const database = options.db || await openDatabase(options.databaseFile || config.databaseFile);
  const broker = options.broker || new BrokerClient(config);
  const github = options.github || new GitHubIntegration(config, options.githubOptions);
  const listeners = new Set();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const domain = new Domain({ db: database, config, broker, github, emit: (event) => listeners.forEach((listener) => listener(event)) });
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
    github,
    domain,
    registry,
    handler,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() { loopDelay.disable(); await domain.shutdown(); await database.close(); }
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
  app.domain.attachTerminalTransport(server);
  await new Promise((resolve) => server.listen(app.config.port, app.config.host, resolve));
  const address = server.address();
  process.stdout.write(`AIWS 3.0.0 listening on http://${address.address}:${address.port}\n`);
  const close = async () => {
    const serverClosed = new Promise((resolve) => server.close(resolve));
    await app.close();
    await serverClosed;
  };
  return { ...app, server, close };
}
