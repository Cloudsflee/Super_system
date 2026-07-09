export function normalizeMcpConfig(config = {}) {
  return {
    type: config.type || 'mcp_http',
    name: config.name || 'unnamed_mcp',
    command: config.command || null,
    args: config.args || [],
    url: config.url || null,
    env_refs: config.env_refs || []
  };
}

export function mockHealthCheck(config = {}) {
  const normalized = normalizeMcpConfig(config);
  return { status: 'healthy', discovered_tools: [{ name: `${normalized.name}.echo` }], config: normalized };
}
