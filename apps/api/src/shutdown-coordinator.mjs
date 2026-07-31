let draining = false;

export function isRuntimeDraining() {
  return draining;
}

export function createShutdownCoordinator({
  server,
  stopDispatcher = async () => undefined,
  stopProjector = async () => undefined,
  closeTransports = async () => undefined,
  stopRuntimeWork = async () => undefined,
  closePersistence = async () => undefined,
  timeoutMs = 30_000,
  exit = null
}) {
  let shutdownPromise = null;

  const shutdown = (signal = 'shutdown') => {
    if (shutdownPromise) return shutdownPromise;
    draining = true;
    const graceful = runGracefulShutdown({
      server,
      stopDispatcher,
      stopProjector,
      closeTransports,
      stopRuntimeWork,
      closePersistence,
      signal
    });
    shutdownPromise = withTimeout(graceful, timeoutMs, 'shutdown_timeout')
      .then((result) => {
        exit?.(0);
        return result;
      })
      .catch((error) => {
        exit?.(1);
        throw error;
      });
    return shutdownPromise;
  };

  return {
    shutdown,
    get promise() {
      return shutdownPromise;
    }
  };
}

async function runGracefulShutdown({
  server,
  stopDispatcher,
  stopProjector,
  closeTransports,
  stopRuntimeWork,
  closePersistence,
  signal
}) {
  const serverClosed = closeHttpServer(server);
  await Promise.all([stopDispatcher(), stopProjector()]);
  await stopRuntimeWork();
  await closeTransports();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await serverClosed;
  await closePersistence();
  return { stopped: true, signal };
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    if (!server?.listening) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function withTimeout(operation, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        const error = new Error(code);
        error.code = code;
        reject(error);
      },
      Math.max(1_000, Number(timeoutMs) || 30_000)
    );
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
