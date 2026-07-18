#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema,
  ReadResourceRequestSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema,
  SubscribeRequestSchema, ToolListChangedNotificationSchema, UnsubscribeRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const token = String(process.env.AIWS_MCP_TOKEN || ''), url = new URL(process.env.AIWS_MCP_URL || 'http://127.0.0.1:4317/api/mcp');
if (!token) { process.stderr.write('AIWS_MCP_TOKEN is required\n'); process.exit(2); }

const remote = new Client({ name: 'aiws-stdio-bridge', version: '1.9.0' }, { capabilities: {} });
const remoteTransport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
await remote.connect(remoteTransport);
const capabilities = remote.getServerCapabilities() || {};
const local = new Server({ name: 'aiws-stdio-bridge', version: '1.9.0' }, {
  capabilities: {
    ...(capabilities.tools ? { tools: { listChanged: Boolean(capabilities.tools.listChanged) } } : {}),
    ...(capabilities.resources ? { resources: { subscribe: Boolean(capabilities.resources.subscribe), listChanged: Boolean(capabilities.resources.listChanged) } } : {})
  }, instructions: remote.getInstructions()
});

local.setRequestHandler(ListToolsRequestSchema, ({ params }) => remote.listTools(params));
local.setRequestHandler(CallToolRequestSchema, ({ params }) => remote.callTool(params));
local.setRequestHandler(ListResourcesRequestSchema, ({ params }) => remote.listResources(params));
local.setRequestHandler(ListResourceTemplatesRequestSchema, ({ params }) => remote.listResourceTemplates(params));
local.setRequestHandler(ReadResourceRequestSchema, ({ params }) => remote.readResource(params));
if (capabilities.resources?.subscribe) {
  local.setRequestHandler(SubscribeRequestSchema, ({ params }) => remote.subscribeResource(params));
  local.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => remote.unsubscribeResource(params));
}
if (capabilities.resources?.listChanged) remote.setNotificationHandler(ResourceListChangedNotificationSchema, (notification) => local.notification(notification));
if (capabilities.resources?.subscribe) remote.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => local.notification(notification));
if (capabilities.tools?.listChanged) remote.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => local.notification(notification));

const stdio = new StdioServerTransport();
await local.connect(stdio);

let closing = false;
async function close() {
  if (closing) return; closing = true;
  await Promise.allSettled([local.close(), remote.close()]);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close().finally(() => process.exit(0)); });
process.on('beforeExit', () => { void close(); });
