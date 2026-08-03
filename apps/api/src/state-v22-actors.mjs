import { makeTrace } from '../../../packages/shared/index.mjs';
import { currentActorId } from './actor-context.mjs';

export function owner(state) {
  const actorId = currentActorId();
  return (
    state.users.find((user) => user.id === actorId) ||
    state.users.find((user) => user.id === state.instance_owner_user_id) ||
    state.users.find((user) => user.role === 'owner') ||
    state.users[0]
  );
}

export function actor(state, { required = true } = {}) {
  const actorId = currentActorId(),
    value = state.users.find((user) => user.id === actorId) || null;
  if (!value && required) throw new Error('authenticated_actor_required');
  return value;
}

export function addTrace(state, event, payload = {}, actorId = null) {
  const trace = makeTrace(event, payload, { type: actorId ? 'user' : 'system', id: actorId });
  state.traces.push(trace);
  return trace;
}
