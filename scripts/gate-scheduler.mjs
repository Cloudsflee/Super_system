export async function runDependencyGraph(
  items,
  { concurrency = 1, execute, onBlocked = async () => ({ ok: false, status: 'BLOCKED' }) } = {}
) {
  if (typeof execute !== 'function') throw new TypeError('gate_scheduler_execute_required');
  const limit = normalizeConcurrency(concurrency),
    ordered = [...items],
    byId = new Map(ordered.map((item) => [item.id, item])),
    pending = new Map(ordered.map((item) => [item.id, item])),
    running = new Map(),
    outcomes = new Map();
  if (byId.size !== ordered.length) throw new Error('gate_scheduler_duplicate_id');
  for (const item of ordered)
    for (const dependency of item.dependencies || [])
      if (!byId.has(dependency)) throw new Error(`gate_scheduler_dependency_missing:${item.id}:${dependency}`);

  while (pending.size || running.size) {
    let launched = false;
    for (const item of ordered) {
      if (running.size >= limit) break;
      if (!pending.has(item.id)) continue;
      const dependencies = item.dependencies || [];
      if (dependencies.some((id) => pending.has(id) || running.has(id))) continue;
      pending.delete(item.id);
      const blockedBy = dependencies.filter((id) => outcomes.get(id)?.ok !== true),
        operation = blockedBy.length ? onBlocked(item, blockedBy) : execute(item);
      running.set(
        item.id,
        Promise.resolve(operation).then((outcome) => ({
          id: item.id,
          outcome: normalizeOutcome(outcome)
        }))
      );
      launched = true;
    }

    if (!running.size) {
      const unresolved = [...pending.keys()].join(',');
      throw new Error(`gate_scheduler_dependency_cycle:${unresolved}`);
    }
    const settled = await Promise.race(running.values());
    running.delete(settled.id);
    outcomes.set(settled.id, settled.outcome);
    if (!launched && !pending.size && !running.size) break;
  }
  return outcomes;
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

function normalizeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean')
    throw new Error('gate_scheduler_outcome_invalid');
  return outcome;
}
