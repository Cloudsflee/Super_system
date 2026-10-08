// Explicit Historical-only runtime factory. Active server entrypoints must not
// import this module; it exists for migration and rollback fixtures only.
import { createCleanRuntime, createNotReadyRuntime } from '../../../apps/api/src/clean/runtime.mjs';

export function createHistoricalRuntime(options = {}) {
  const targetVersion = Number(options.targetVersion);
  if (!Number.isInteger(targetVersion) || targetVersion < 2 || targetVersion > 8) {
    throw new TypeError('historical_target_version_required');
  }
  return createCleanRuntime({ ...options, targetVersion, runtimePhase: targetVersion });
}

export function createHistoricalNotReadyRuntime(options = {}, failure = null) {
  const targetVersion = Number(options.targetVersion);
  if (!Number.isInteger(targetVersion) || targetVersion < 2 || targetVersion > 8) {
    throw new TypeError('historical_target_version_required');
  }
  return createNotReadyRuntime({ ...options, targetVersion, runtimePhase: targetVersion }, failure);
}
