import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp as createCleanApp, start as startClean } from './clean-server.mjs';

// The process entrypoint is the released V3-Clean surface.  The lower-level
// clean runtime keeps its P2 default for phase-specific fixture tests, while
// this wrapper is the active P7 Clean process surface.
export const ACTIVE_TARGET_VERSION = 7;

function activeOptions(options = {}) {
  return { targetVersion: ACTIVE_TARGET_VERSION, ...options };
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
