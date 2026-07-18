import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema,
  ReadResourceRequestSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema,
  SubscribeRequestSchema, ToolListChangedNotificationSchema, UnsubscribeRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

export function createForwardingServer(remote) {
  const capabilities = remote.getServerCapabilities() || {};
  const local = new Server({ name: 'aiws-mcp-gateway', version: '1.8.0' }, {
    capabilities: {
      ...(capabilities.tools ? { tools: { listChanged: Boolean(capabilities.tools.listChanged) } } : {}),
      ...(capabilities.resources ? { resources: { subscribe: Boolean(capabilities.resources.subscribe), listChanged: Boolean(capabilities.resources.listChanged) } } : {})
    },
    instructions: remote.getInstructions()
  });

  if (capabilities.tools) {
    local.setRequestHandler(ListToolsRequestSchema, ({ params }) => remote.listTools(params));
    local.setRequestHandler(CallToolRequestSchema, ({ params }) => remote.callTool(params));
  }
  if (capabilities.resources) {
    local.setRequestHandler(ListResourcesRequestSchema, ({ params }) => remote.listResources(params));
    local.setRequestHandler(ListResourceTemplatesRequestSchema, ({ params }) => remote.listResourceTemplates(params));
    local.setRequestHandler(ReadResourceRequestSchema, ({ params }) => remote.readResource(params));
  }
  if (capabilities.resources?.subscribe) {
    local.setRequestHandler(SubscribeRequestSchema, ({ params }) => remote.subscribeResource(params));
    local.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => remote.unsubscribeResource(params));
    remote.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => local.notification(notification));
  }
  if (capabilities.resources?.listChanged) remote.setNotificationHandler(ResourceListChangedNotificationSchema, (notification) => local.notification(notification));
  if (capabilities.tools?.listChanged) remote.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => local.notification(notification));
  return local;
}
