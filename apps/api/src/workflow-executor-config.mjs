export function normalizeWorkflowExecutorConfig(input) {
  const config = { runner: ['codex', 'codex_docker'].includes(input.runner) ? input.runner : null };
  if (process.env.NODE_ENV !== 'test' || input.adapter !== 'test') return config;
  return {
    ...config,
    adapter: 'test',
    test_summary: clean(input.test_summary, 500),
    test_changes: Array.isArray(input.test_changes) ? structuredClone(input.test_changes).slice(0, 50) : [],
    test_use_required_inputs: input.test_use_required_inputs === true,
    test_use_required_context: input.test_use_required_context === true,
    test_used_input_keys: cleanList(input.test_used_input_keys, 120),
    test_used_context_node_ids: cleanList(input.test_used_context_node_ids, 200),
    test_consumption_plan:
      input.test_consumption_plan && typeof input.test_consumption_plan === 'object'
        ? structuredClone(input.test_consumption_plan)
        : null
  };
}

function cleanList(values, max) {
  return Array.isArray(values)
    ? values
        .map((item) => clean(item, max))
        .filter(Boolean)
        .slice(0, 100)
    : [];
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
