import { now } from '../../../packages/shared/index.mjs';

const RETIRED_TOOL_NAME = 'mock_runner';

export function removeRetiredRuntimeRecordsForMigration(state, timestamp = now()) {
  let changed = false;
  const productionTools = (state.tools || []).filter((item) => item.name !== RETIRED_TOOL_NAME);
  if (productionTools.length !== (state.tools || []).length) {
    state.tools = productionTools;
    changed = true;
  }
  for (const contract of state.node_contracts || []) {
    if (!Array.isArray(contract.allowed_tools)) continue;
    const allowed = contract.allowed_tools.filter((item) => item !== RETIRED_TOOL_NAME);
    if (allowed.length === contract.allowed_tools.length) continue;
    contract.allowed_tools = allowed;
    contract.updated_at = timestamp;
    changed = true;
  }
  for (const run of state.node_runs || []) {
    if (run.runner !== 'mock') continue;
    run.legacy_runner = 'mock';
    run.runner = 'legacy_retired_adapter';
    run.legacy_read_only = true;
    changed = true;
  }
  return { changed };
}
