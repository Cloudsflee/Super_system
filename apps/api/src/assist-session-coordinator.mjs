const queues = new Map();

export function coordinateAssistSession(sessionId, operation) {
  const previous = queues.get(sessionId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(sessionId, current);
  return current.finally(() => { if (queues.get(sessionId) === current) queues.delete(sessionId); });
}

export function assistSessionCoordinatorStatus(sessionId) {
  return { busy: queues.has(sessionId) };
}
