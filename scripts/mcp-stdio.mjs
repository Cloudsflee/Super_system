#!/usr/bin/env node
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const endpoint = String(process.env.AIWS_MCP_URL || 'http://127.0.0.1:4317/api/v2/mcp');
const token = String(process.env.AIWS_MCP_TOKEN || '');
let parsedEndpoint;
try { parsedEndpoint = new URL(endpoint); } catch { throw new Error('mcp_stdio_endpoint_invalid'); }
if (!['http:', 'https:'].includes(parsedEndpoint.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsedEndpoint.hostname)) throw new Error('mcp_stdio_endpoint_invalid');
if (!token) throw new Error('mcp_stdio_token_required');

let nextId = 1;
let remoteSessionId = '';
async function remote(method, params = {}) {
  const response = await fetch(parsedEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-aiws-mcp-token': token,
      'mcp-protocol-version': '2025-06-18',
      'mcp-transport': 'stdio',
      ...(remoteSessionId ? { 'mcp-session-id': remoteSessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  });
  remoteSessionId = response.headers.get('mcp-session-id') || remoteSessionId;
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) throw new Error(String(payload?.error?.data?.code || payload?.error?.message || `mcp_http_${response.status}`));
  return payload?.result || {};
}

await remote('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aiws-stdio-bridge', version: '4' } });

const server = new McpSdkServer({ name: 'aiws-v3-clean-stdio', version: '4' }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => remote('tools/list'));
server.setRequestHandler(CallToolRequestSchema, async (request) => remote('tools/call', request.params));
server.setRequestHandler(ListResourcesRequestSchema, async () => remote('resources/list'));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => remote('resources/read', request.params));

const transport = new StdioServerTransport();
await server.connect(transport);
