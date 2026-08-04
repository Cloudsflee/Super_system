import net from 'node:net';

const DEFAULT_MIN_PORT = 20_000,
  DEFAULT_MAX_PORT = 29_999;

export function createLoopbackPortAllocator({
  host = '127.0.0.1',
  minPort = DEFAULT_MIN_PORT,
  maxPort = DEFAULT_MAX_PORT,
  seed = process.pid + Date.now()
} = {}) {
  if (
    !Number.isInteger(minPort) ||
    !Number.isInteger(maxPort) ||
    minPort < 1024 ||
    maxPort > 65_535 ||
    minPort > maxPort
  )
    throw portError('loopback_port_range_invalid');
  const size = maxPort - minPort + 1,
    issued = new Set(),
    pending = new Set();
  let cursor = Math.abs(Number(seed) || 0) % size;

  return async function allocateLoopbackPort() {
    for (let attempt = 0; attempt < size; attempt += 1) {
      const port = minPort + cursor;
      cursor = (cursor + 1) % size;
      if (issued.has(port) || pending.has(port)) continue;
      pending.add(port);
      let available;
      try {
        available = await canBind(host, port);
      } finally {
        pending.delete(port);
      }
      if (!available) continue;
      issued.add(port);
      return port;
    }
    throw portError('loopback_port_range_exhausted');
  };
}

function canBind(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      if (['EACCES', 'EADDRINUSE'].includes(error.code)) resolve(false);
      else reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function portError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
