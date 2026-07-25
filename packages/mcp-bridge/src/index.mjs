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

export function inspectMcpConfig(config = {}) {
  const normalized = normalizeMcpConfig(config);
  const configured = Boolean(normalized.url || normalized.command);
  return { status: configured ? 'configured' : 'configuration_required', discovered_tools: [], config: normalized };
}

export {
  MCP_GATEWAY_HEADERS,
  loadMcpGatewaySecret,
  signMcpGatewayRequest,
  verifyMcpGatewayRequest
} from './gateway-auth.mjs';
