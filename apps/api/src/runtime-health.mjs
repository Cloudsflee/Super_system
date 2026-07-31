import { AIWS_STATE_SCHEMA_VERSION, AIWS_VERSION } from '../../../packages/shared/index.mjs';
import { contextIndexRuntimeStatus } from './context-index-runtime.mjs';
import { contextProjectorRuntimeStatus } from './context-projector-coordinator.mjs';
import { isRuntimeDraining } from './shutdown-coordinator.mjs';
import { readStateSnapshot, statePersistenceStatus } from './state.mjs';

export function livezSnapshot() {
  return {
    status: 'ok',
    version: AIWS_VERSION,
    pid: process.pid,
    uptime_seconds: process.uptime(),
    draining: isRuntimeDraining()
  };
}

export async function readyzSnapshot({ heartbeatTimeoutMs = 5_000 } = {}) {
  const [state, persistence] = await Promise.all([readStateSnapshot(), statePersistenceStatus()]),
    projector = contextProjectorRuntimeStatus(),
    index = contextIndexRuntimeStatus(),
    heartbeatAge = projector.heartbeat_at ? Date.now() - Date.parse(projector.heartbeat_at) : Number.POSITIVE_INFINITY,
    projectorDisabled = process.env.NODE_ENV === 'test' && process.env.AIWS_TEST_DISABLE_CONTEXT_PROJECTOR === '1',
    checks = {
      draining: { ready: !isRuntimeDraining() },
      schema: {
        ready: Number(state.schema_version) === AIWS_STATE_SCHEMA_VERSION,
        expected: AIWS_STATE_SCHEMA_VERSION,
        actual: state.schema_version
      },
      sqlite: {
        ready:
          persistence.healthy === true &&
          persistence.writable === true &&
          persistence.migration_complete === true &&
          Number(persistence.schema_version) === AIWS_STATE_SCHEMA_VERSION,
        writable: persistence.writable === true,
        integrity: persistence.integrity,
        revision: persistence.revision
      },
      projector: {
        ready:
          projectorDisabled ||
          (!['stopped', 'failed', 'draining'].includes(projector.state) && heartbeatAge <= heartbeatTimeoutMs),
        state: projectorDisabled ? 'disabled_for_test' : projector.state,
        heartbeat_age_ms: Number.isFinite(heartbeatAge) ? Math.max(0, heartbeatAge) : null
      },
      index: {
        ready: index.state === 'ready',
        state: index.state,
        snapshot_hash: index.snapshot_hash,
        generation: index.generation
      }
    },
    ready = Object.values(checks).every((check) => check.ready);
  return {
    status: ready ? 'ready' : 'not_ready',
    version: AIWS_VERSION,
    schema_version: state.schema_version,
    ready,
    checks
  };
}
