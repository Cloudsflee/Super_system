import assert from 'node:assert/strict';

import { livezSnapshot } from '../../apps/api/src/runtime-health.mjs';
import { createShutdownCoordinator } from '../../apps/api/src/shutdown-coordinator.mjs';

const live = livezSnapshot();
assert.equal(live.status, 'ok');
assert.equal(typeof live.pid, 'number');
assert.equal(Object.hasOwn(live, 'schema_version'), false);

const order = [],
  server = {
    listening: true,
    close(callback) {
      order.push('server-close-start');
      this.callback = callback;
    },
    closeIdleConnections() {
      order.push('idle-connections');
    },
    closeAllConnections() {
      order.push('all-connections');
      this.callback?.();
    }
  },
  coordinator = createShutdownCoordinator({
    server,
    stopDispatcher: async () => order.push('dispatcher'),
    stopProjector: async () => order.push('projector'),
    stopRuntimeWork: async () => order.push('runtime-work'),
    closeTransports: async () => order.push('transports'),
    closePersistence: async () => order.push('persistence'),
    timeoutMs: 5_000
  }),
  first = coordinator.shutdown('SIGTERM'),
  second = coordinator.shutdown('SIGINT');
assert.equal(first, second);
await first;
assert.equal(order[0], 'server-close-start');
assert.ok(order.indexOf('dispatcher') < order.indexOf('runtime-work'));
assert.ok(order.indexOf('projector') < order.indexOf('runtime-work'));
assert.ok(order.indexOf('runtime-work') < order.indexOf('transports'));
assert.ok(order.indexOf('transports') < order.indexOf('persistence'));

console.log('V2.2 liveness and idempotent ordered shutdown coordinator tests passed');
