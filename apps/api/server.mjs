import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp as createCleanApp, start as startClean } from './clean-server.mjs';

// Phase and schema are intentionally separate in P9: release/Web behavior
// advances without inventing a ninth migration.
export const ACTIVE_RUNTIME_PHASE = 9;
export const ACTIVE_SCHEMA_VERSION = 8;
export const ACTIVE_TARGET_VERSION = ACTIVE_SCHEMA_VERSION;

function activeOptions(options = {}) {
  return { targetVersion: ACTIVE_SCHEMA_VERSION, runtimePhase: ACTIVE_RUNTIME_PHASE, ...options };
}

export { createCleanApp, startClean };

export async function createApp(options = {}) {
  return createCleanApp(activeOptions(options));
}

export async function start(options = {}) {
  return startClean(activeOptions(options));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await start();
  const shutdown = async () => { await running.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
