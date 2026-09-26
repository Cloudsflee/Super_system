import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp as createCleanApp, start as startClean } from './clean-server.mjs';

export const ACTIVE_RUNTIME_PHASE = 10;
export const ACTIVE_SCHEMA_VERSION = 9;
export const ACTIVE_TARGET_VERSION = ACTIVE_SCHEMA_VERSION;

function activeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('active_runtime_options_invalid');
  // The public server entrypoint is the one active Clean runtime.  Historical
  // phase/version switches belong to importer and fixture entrypoints and
  // must never be able to alter the process started by this module.
  const retiredKeys = ['schemaVersion', 'phase', 'cleanPhase', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
  const retired = retiredKeys.find((key) => Object.prototype.hasOwnProperty.call(options, key));
  if (retired) throw new TypeError(`active_runtime_option_retired:${retired}`);
  if (Object.prototype.hasOwnProperty.call(options, 'targetVersion') && Number(options.targetVersion) !== ACTIVE_SCHEMA_VERSION) throw new TypeError('active_schema_version_required');
  if (Object.prototype.hasOwnProperty.call(options, 'runtimePhase') && Number(options.runtimePhase) !== ACTIVE_RUNTIME_PHASE) throw new TypeError('active_runtime_phase_required');
  return { ...options, targetVersion: ACTIVE_SCHEMA_VERSION, runtimePhase: ACTIVE_RUNTIME_PHASE };
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
