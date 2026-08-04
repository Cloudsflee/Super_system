export async function runDependencyGraph(
  items,
  {
    concurrency = 1,
    execute,
    onBlocked = async () => ({ ok: false, status: 'BLOCKED' }),
    resourceKey = () => null
  } = {}
) {
  if (typeof execute !== 'function') throw new TypeError('gate_scheduler_execute_required');
  if (typeof resourceKey !== 'function') throw new TypeError('gate_scheduler_resource_key_required');
  const limit = normalizeConcurrency(concurrency),
    ordered = [...items],
    byId = new Map(ordered.map((item) => [item.id, item])),
    pending = new Map(ordered.map((item) => [item.id, item])),
    running = new Map(),
    outcomes = new Map(),
    activeResources = new Set();
  if (byId.size !== ordered.length) throw new Error('gate_scheduler_duplicate_id');
  for (const item of ordered)
    for (const dependency of item.dependencies || [])
      if (!byId.has(dependency)) throw new Error(`gate_scheduler_dependency_missing:${item.id}:${dependency}`);

  while (pending.size || running.size) {
    let launched = false;
    for (const item of ordered) {
      if (running.size >= limit) break;
      if (!pending.has(item.id)) continue;
      launched =
        launchReadyItem({ item, pending, running, outcomes, activeResources, execute, onBlocked, resourceKey }) ||
        launched;
    }

    if (!running.size) {
      const unresolved = [...pending.keys()].join(',');
      throw new Error(`gate_scheduler_dependency_cycle:${unresolved}`);
    }
    const settled = await Promise.race(running.values());
    running.delete(settled.id);
    releaseResource(activeResources, settled.resource);
    outcomes.set(settled.id, settled.outcome);
    if (!launched && !pending.size && !running.size) break;
  }
  return outcomes;
}

function launchReadyItem({ item, pending, running, outcomes, activeResources, execute, onBlocked, resourceKey }) {
  const dependencies = item.dependencies || [];
  if (dependencies.some((id) => pending.has(id) || running.has(id))) return false;
  const blockedBy = dependencies.filter((id) => outcomes.get(id)?.ok !== true),
    resource = blockedBy.length ? null : normalizeResource(resourceKey(item));
  if (resource && activeResources.has(resource)) return false;
  pending.delete(item.id);
  if (resource) activeResources.add(resource);
  const operation = blockedBy.length ? onBlocked(item, blockedBy) : execute(item);
  running.set(
    item.id,
    Promise.resolve(operation).then((outcome) => ({
      id: item.id,
      resource,
      outcome: normalizeOutcome(outcome)
    }))
  );
  return true;
}

function releaseResource(activeResources, resource) {
  if (resource) activeResources.delete(resource);
}

export function resolveGateConcurrency(mode, env = process.env) {
  const fallback = mode === 'pr' ? 2 : 1,
    raw = env.AIWS_TEST_CONCURRENCY;
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error('gate_concurrency_invalid');
  return value;
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('gate_scheduler_concurrency_invalid');
  return parsed;
}

function normalizeResource(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('gate_scheduler_resource_key_invalid');
  return value;
}

function normalizeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean')
    throw new Error('gate_scheduler_outcome_invalid');
  return outcome;
}
