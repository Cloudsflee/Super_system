import { containerizeLoopbackUrl } from './codex-container-network.mjs';
import { PORT } from './config.mjs';
import { issueInternalCodexToken, revokeMcpClient } from './mcp-client-service.mjs';

export const AIWS_BUILTIN_MCP_NAME = 'aiws-built-in';

export async function issueCodexMcpAccess(
  projectId,
  profile,
  { ttlSeconds = 3600, contextBinding = null, taskExecutionLeaseToken = null } = {}
) {
  if (!projectId) return null;
  const issued = await issueInternalCodexToken(projectId, {
    ttlSeconds,
    name: `AIWS built-in Codex (${projectId})`,
    contextBinding,
    taskExecutionLeaseToken
  });
  const hostUrl = String(process.env.AIWS_INTERNAL_MCP_URL || `http://127.0.0.1:${PORT}/api/mcp`);
  const url = profile?.kind === 'docker' ? containerizeLoopbackUrl(hostUrl) : hostUrl;
  const configArgs = [
    '-c',
    `mcp_servers.${AIWS_BUILTIN_MCP_NAME}.url=${JSON.stringify(url)}`,
    '-c',
    `mcp_servers.${AIWS_BUILTIN_MCP_NAME}.bearer_token_env_var=${JSON.stringify('AIWS_MCP_TOKEN')}`
  ];
  let released = false;
  return {
    client_id: issued.client.id,
    url,
    configArgs,
    env: { AIWS_MCP_URL: url, AIWS_MCP_TOKEN: issued.token },
    containerEnv: { AIWS_MCP_URL: url, AIWS_MCP_TOKEN: null },
    release: async () => {
      if (released) return;
      released = true;
      await revokeMcpClient(issued.client.id, null).catch(() => undefined);
    }
  };
}

export function withCodexMcpEnvironment(env, access) {
  return access ? { ...env, ...access.env } : env;
}
export function codexMcpConfigArgs(access) {
  return access?.configArgs || [];
}
