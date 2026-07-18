import { makeRoute, send, sendOneTimeSecret } from '../http.mjs';
import { assertLocalMcpAdmin, createMcpClient, listMcpClients, MCP_SCOPES, revokeMcpClient } from '../mcp-client-service.mjs';
import { owner, readState } from '../state.mjs';

export const mcpClientV18Routes = [
  makeRoute('GET', '/mcp/clients', async ({ req, res }) => {
    assertLocalMcpAdmin(req);
    const state = await readState();
    const availableSubjects = state.users.map((user) => ({ id: user.id, display_name: user.display_name, role: user.role }));
    return send(res, 200, { clients: await listMcpClients(), available_scopes: MCP_SCOPES, available_subjects: availableSubjects });
  }),
  makeRoute('POST', '/mcp/clients', async ({ req, res, body }) => {
    assertLocalMcpAdmin(req);
    const actor = owner(await readState());
    const created = await createMcpClient(body, actor?.id || null);
    return sendOneTimeSecret(res, 201, { ...created, token_visible_once: true, configuration: clientConfiguration(req, created.token) });
  }),
  makeRoute('DELETE', '/mcp/clients/:id', async ({ req, res, params }) => {
    assertLocalMcpAdmin(req);
    const actor = owner(await readState());
    return send(res, 200, { client: await revokeMcpClient(params.id, actor?.id || null) });
  })
];

function clientConfiguration(req, token) {
  const host = /^[a-zA-Z0-9.:[\]-]{1,255}$/.test(String(req.headers.host || '')) ? String(req.headers.host) : '127.0.0.1:4317';
  const url = publicMcpUrl(process.env.AIWS_PUBLIC_MCP_URL) || `http://${host}/api/mcp`;
  return {
    streamable_http: { url, headers: { Authorization: `Bearer ${token}` } },
    codex_toml: `[mcp_servers.aiws-built-in]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "AIWS_MCP_TOKEN"\n`,
    stdio_json: { command: 'corepack', args: ['pnpm', 'mcp:stdio'], env: { AIWS_MCP_URL: url, AIWS_MCP_TOKEN: token } }
  };
}

function publicMcpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash || !['/mcp', '/api/mcp'].includes(url.pathname) || url.search) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}
