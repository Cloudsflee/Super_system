import { loadMcpGatewaySecret } from '../../../packages/mcp-bridge/src/index.mjs';

export function gatewayConfig(env = process.env) {
  const coreUrl = validCoreUrl(env.AIWS_MCP_CORE_URL || 'http://127.0.0.1:4317/api/mcp');
  const secret = loadMcpGatewaySecret(env);
  if (!secret) throw new Error('mcp_gateway_secret_required');
  return {
    host: String(env.AIWS_MCP_GATEWAY_HOST || '127.0.0.1'),
    port: boundedInteger(env.AIWS_MCP_GATEWAY_PORT, 4319, 1, 65535, 'mcp_gateway_port_invalid'),
    coreUrl,
    secret,
    requireProxyTls: env.AIWS_MCP_GATEWAY_REQUIRE_PROXY_TLS === '1',
    maxBodyBytes: boundedInteger(
      env.AIWS_MCP_GATEWAY_MAX_BODY_BYTES,
      1024 * 1024,
      1024,
      8 * 1024 * 1024,
      'mcp_gateway_body_limit_invalid'
    ),
    maxSessionsPerClient: boundedInteger(
      env.AIWS_MCP_GATEWAY_MAX_SESSIONS,
      20,
      1,
      100,
      'mcp_gateway_session_limit_invalid'
    ),
    concurrentLimit: boundedInteger(
      env.AIWS_MCP_GATEWAY_CONCURRENT_LIMIT,
      16,
      1,
      256,
      'mcp_gateway_concurrency_invalid'
    ),
    rateLimitPerMinute: boundedInteger(env.AIWS_MCP_GATEWAY_RATE_LIMIT, 1200, 10, 60_000, 'mcp_gateway_rate_invalid'),
    idleMs: boundedInteger(
      env.AIWS_MCP_GATEWAY_SESSION_IDLE_MS,
      30 * 60 * 1000,
      60_000,
      24 * 60 * 60 * 1000,
      'mcp_gateway_idle_invalid'
    )
  };
}

function validCoreUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('mcp_gateway_core_url_invalid');
  if (!['/mcp', '/api/mcp'].includes(url.pathname) || url.search) throw new Error('mcp_gateway_core_path_invalid');
  if (url.protocol === 'http:' && !internalHost(url.hostname)) throw new Error('mcp_gateway_core_tls_required');
  return url;
}

function internalHost(value) {
  const host = String(value || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(host) ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  );
}

function boundedInteger(value, fallback, min, max, code) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(code);
  return number;
}
