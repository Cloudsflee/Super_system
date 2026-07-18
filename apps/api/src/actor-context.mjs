import { AsyncLocalStorage } from 'node:async_hooks';

const actorContext = new AsyncLocalStorage();

export function runAsActor(actorId, operation) {
  const normalized = String(actorId || '').trim() || null;
  return actorContext.run({ actor_id: normalized }, operation);
}

export function currentActorId() {
  return actorContext.getStore()?.actor_id || null;
}
