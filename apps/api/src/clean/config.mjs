import path from 'node:path';

export function loadCleanConfig(env = process.env) {
  const home = path.resolve(String(env.AIWS_CLEAN_HOME || env.AIWS_HOME || path.join(process.cwd(), '.ai-workspace', 'v3-clean')));
  const port = Number(env.AIWS_CLEAN_PORT || env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('clean_port_invalid');
  const requestedMaxBody = Number(env.AIWS_CLEAN_MAX_BODY || 1024 * 1024);
  if (!Number.isInteger(requestedMaxBody) || requestedMaxBody < 1) throw new Error('clean_max_body_invalid');
  const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const mcpPepper = String(env.AIWS_CLEAN_MCP_PEPPER || (production ? '' : 'p4-mcp-fixture-pepper'));
  const gatewaySecret = String(env.AIWS_GATEWAY_SECRET || (production ? '' : 'p4-gateway-fixture-secret'));
  const providerMode = String(env.AIWS_CLEAN_PROVIDER_MODE || 'process').toLowerCase();
  if (!['process', 'deterministic'].includes(providerMode)) throw new Error('clean_provider_mode_invalid');
  const providerTimeoutMs = Number(env.AIWS_CLEAN_PROVIDER_TIMEOUT_MS || 30_000);
  const runnerPollIntervalMs = Number(env.AIWS_RUNNER_POLL_INTERVAL_MS || 50);
  const parserPollIntervalMs = Number(env.AIWS_PARSER_POLL_INTERVAL_MS || 50);
  const corsOrigins = parseCorsOrigins(env.AIWS_CLEAN_CORS_ORIGINS, { production });
  if (!Number.isInteger(providerTimeoutMs) || providerTimeoutMs < 1000 || providerTimeoutMs > 300_000) throw new Error('clean_provider_timeout_invalid');
  if (!Number.isInteger(runnerPollIntervalMs) || runnerPollIntervalMs < 1 || runnerPollIntervalMs > 5000) throw new Error('runner_poll_interval_invalid');
  if (!Number.isInteger(parserPollIntervalMs) || parserPollIntervalMs < 1 || parserPollIntervalMs > 5000) throw new Error('parser_poll_interval_invalid');
  if (production && mcpPepper.length < 32) throw new Error('mcp_pepper_required');
  if (production && gatewaySecret.length < 32) throw new Error('gateway_secret_required');
  return Object.freeze({
    runtime: 'v3-clean',
    apiVersion: '2',
    corsOrigins,
    host: env.AIWS_CLEAN_BIND_HOST || env.AIWS_BIND_HOST || '127.0.0.1',
    port,
    home,
    databaseFile: path.resolve(String(env.AIWS_CLEAN_DATABASE || path.join(home, 'data', 'state.sqlite'))),
    casRoot: path.resolve(String(env.AIWS_CLEAN_CAS || path.join(home, 'cas', 'sha256'))),
    receiptRoot: path.resolve(String(env.AIWS_CLEAN_RECEIPTS || path.join(home, 'receipts'))),
    cursorSecret: String(env.AIWS_CLEAN_CURSOR_SECRET || 'v3-clean-local-cursor'),
    sessionSecret: String(env.AIWS_CLEAN_SESSION_SECRET || env.AIWS_CLEAN_CURSOR_SECRET || 'v3-clean-local-session'),
    mcpPepper,
    gatewaySecret,
    gatewayId: String(env.AIWS_GATEWAY_ID || 'gateway-local'),
    providerMode,
    providerCommand: String(env.AIWS_CLEAN_PROVIDER_COMMAND || 'codex'),
    providerTimeoutMs,
    providerHomeRoot: path.resolve(String(env.AIWS_CLEAN_PROVIDER_HOME || path.join(home, 'provider-homes'))),
    bridgeUrl: env.AIWS_WINDOWS_BRIDGE_URL ? String(env.AIWS_WINDOWS_BRIDGE_URL).replace(/\/$/, '') : null,
    runnerBrokerUrl: env.AIWS_RUNNER_BROKER_URL ? String(env.AIWS_RUNNER_BROKER_URL).replace(/\/$/, '') : null,
    runnerBrokerSecret: String(env.AIWS_RUNNER_BROKER_SECRET || (production ? '' : 'p6-clean-broker-fixture-secret')),
    runnerPollIntervalMs,
    parserBrokerUrl: env.AIWS_PARSER_BROKER_URL ? String(env.AIWS_PARSER_BROKER_URL).replace(/\/$/, '') : (env.AIWS_RUNNER_BROKER_URL ? String(env.AIWS_RUNNER_BROKER_URL).replace(/\/$/, '') : null),
    parserBrokerSecret: String(env.AIWS_PARSER_BROKER_SECRET || env.AIWS_RUNNER_BROKER_SECRET || (production ? '' : 'p7-clean-parser-broker-fixture-secret')),
    parserImageDigest: String(env.AIWS_PARSER_IMAGE_DIGEST || 'sha256:bc69569bc471a27833b7f1174ac1634b5760614c6742237c443641ac5da808e4').toLowerCase(),
    parserPollIntervalMs,
    runnerHomeRoot: path.resolve(String(env.AIWS_HOST_RUNNER_HOME || path.join(home, 'runner-homes'))),
    workspaceRoot: path.resolve(String(env.AIWS_CLEAN_WORKSPACES || path.join(home, 'workspaces'))),
    vaultRoot: path.resolve(String(env.AIWS_CLEAN_VAULT || path.join(home, 'vault'))),
    vaultMasterKey: env.AIWS_CLEAN_VAULT_KEY == null ? null : String(env.AIWS_CLEAN_VAULT_KEY),
    runtimeBuild: String(env.AIWS_CLEAN_BUILD || 'v3-clean-p10'),
    maxBodyBytes: Math.max(1024, Math.min(16 * 1024 * 1024, requestedMaxBody))
  });
}

export function parseCorsOrigins(value, { production = false } = {}) {
  const source = value == null || String(value).trim() === ''
    ? (production ? [] : ['http://127.0.0.1:5174'])
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);
  const origins = [];
  for (const candidate of source) {
    if (candidate === '*' || candidate === 'null') throw new Error('clean_cors_origin_invalid');
    let parsed;
    try { parsed = new URL(candidate); } catch { throw new Error('clean_cors_origin_invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash || parsed.origin !== candidate) {
      throw new Error('clean_cors_origin_invalid');
    }
    if (!origins.includes(candidate)) origins.push(candidate);
  }
  return Object.freeze(origins);
}
