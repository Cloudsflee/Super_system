import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AIWS_VERSION, maskSecretsDeep } from '../../../packages/shared/index.mjs';
import { describeOperation, executeRegistryOperation, searchOperations } from './api-route-registry.mjs';
import { HttpError } from './http.mjs';
import { assertProjectAccess, assertScopes } from './mcp-client-service.mjs';
import {
  cancelMcpOperation,
  getMcpOperation,
  readMcpOperationEvents,
  waitForMcpOperation
} from './mcp-operation-service.mjs';
import { appendMcpUploadChunk, beginMcpUpload, cancelMcpUpload, commitMcpUpload } from './mcp-upload-service.mjs';
import { closeMcpGithubPullRequest, deleteMcpGithubBranch } from './mcp-github-service.mjs';
import { readState } from './state.mjs';
import { terminalRuntimeAction } from './terminal-service.mjs';
import { assertProjectRead, assertProjectRun } from './project-governance-v19.mjs';

export const MCP_TOOL_NAMES = Object.freeze([
  'aiws_system',
  'aiws_projects',
  'aiws_workflow',
  'aiws_assist',
  'aiws_runs',
  'aiws_files',
  'aiws_terminal',
  'aiws_git',
  'aiws_github',
  'aiws_assets',
  'aiws_governance',
  'aiws_admin',
  'aiws_context',
  'aiws_capabilities',
  'aiws_operations',
  'aiws_execute'
]);

export const MCP_SPECIAL_CAPABILITIES = Object.freeze([
  {
    operation_id: 'aiws.projects.create',
    domain: 'projects',
    mapping: 'tool',
    required_scopes: ['project:create'],
    risk: 'high',
    reason: 'Stable V1.9 Project creation alias.'
  },
  {
    operation_id: 'aiws.files.upload.begin',
    domain: 'files',
    mapping: 'tool',
    required_scopes: ['files:write'],
    risk: 'medium'
  },
  {
    operation_id: 'aiws.files.upload.chunk',
    domain: 'files',
    mapping: 'tool',
    required_scopes: ['files:write'],
    risk: 'medium'
  },
  {
    operation_id: 'aiws.files.upload.commit',
    domain: 'files',
    mapping: 'tool',
    required_scopes: ['files:write'],
    risk: 'high'
  },
  {
    operation_id: 'aiws.files.upload.cancel',
    domain: 'files',
    mapping: 'tool',
    required_scopes: ['files:write'],
    risk: 'low'
  },
  {
    operation_id: 'aiws.terminal.input',
    domain: 'terminal',
    mapping: 'async_adapter',
    required_scopes: ['terminal:execute'],
    risk: 'high'
  },
  {
    operation_id: 'aiws.terminal.resize',
    domain: 'terminal',
    mapping: 'async_adapter',
    required_scopes: ['terminal:write'],
    risk: 'medium'
  },
  {
    operation_id: 'aiws.terminal.signal',
    domain: 'terminal',
    mapping: 'async_adapter',
    required_scopes: ['terminal:execute'],
    risk: 'high'
  },
  {
    operation_id: 'aiws.terminal.read',
    domain: 'terminal',
    mapping: 'resource',
    required_scopes: ['terminal:read'],
    risk: 'low'
  },
  {
    operation_id: 'aiws.operations.wait',
    domain: 'operations',
    mapping: 'async_adapter',
    required_scopes: [],
    risk: 'low'
  },
  {
    operation_id: 'aiws.operations.read_events',
    domain: 'operations',
    mapping: 'resource',
    required_scopes: [],
    risk: 'low'
  },
  {
    operation_id: 'aiws.operations.cancel',
    domain: 'operations',
    mapping: 'async_adapter',
    required_scopes: [],
    risk: 'high'
  },
  {
    operation_id: 'aiws.github.pull_request.close',
    domain: 'github',
    mapping: 'tool',
    required_scopes: ['github:write'],
    risk: 'high'
  },
  {
    operation_id: 'aiws.github.branch.delete',
    domain: 'github',
    mapping: 'tool',
    required_scopes: ['github:write', 'destructive:execute'],
    risk: 'critical'
  },
  {
    operation_id: 'aiws.external.host_bridge_ws',
    domain: 'assist',
    mapping: 'external_callback',
    required_scopes: [],
    risk: 'high',
    reason: 'Host Bridge device protocol remains WebSocket-only.'
  },
  ...['canvas-drag', 'canvas-zoom', 'hover', 'keyboard-focus', 'file-picker', 'clipboard', 'visual-layout'].map(
    (id) => ({
      operation_id: `aiws.frontend.${id}`,
      domain: 'frontend',
      mapping: 'frontend_only',
      required_scopes: [],
      risk: 'low',
      reason: 'Requires a browser interaction surface.'
    })
  )
]);

const virtualActions = Object.freeze({
  aiws_projects: ['aiws.projects.create'],
  aiws_files: [
    'aiws.files.upload.begin',
    'aiws.files.upload.chunk',
    'aiws.files.upload.commit',
    'aiws.files.upload.cancel'
  ],
  aiws_terminal: ['aiws.terminal.input', 'aiws.terminal.resize', 'aiws.terminal.signal', 'aiws.terminal.read'],
  aiws_github: ['aiws.github.pull_request.close', 'aiws.github.branch.delete']
});

export function createAiwsMcpServer({ registry, client }) {
  const server = new McpServer(
    { name: 'aiws-built-in', version: AIWS_VERSION },
    {
      capabilities: { logging: {}, resources: { subscribe: true, listChanged: false }, tools: { listChanged: false } },
      instructions:
        'Use AIWS domain tools or aiws_execute with a catalog operation_id. Approval decisions require a separate approver client.'
    }
  );
  const subscriptions = new Map();
  const allowed = registry.filter((operation) =>
    operation.required_scopes.every((scope) => client.scopes.includes(scope))
  );
  registerDomainTools(server, allowed, registry, client);
  registerContextTool(server, allowed, registry, client);
  registerCapabilityTool(server, allowed, registry, client);
  registerOperationsTool(server, registry, client);
  registerExecuteTool(server, allowed, registry, client);
  registerResources(server, allowed, registry, client);
  registerSubscriptions(server, subscriptions);
  const subscriptionTimer = setInterval(() => notifySubscriptions(server, subscriptions, client), 1000);
  subscriptionTimer.unref?.();
  return {
    server,
    dispose: async () => {
      clearInterval(subscriptionTimer);
      subscriptions.clear();
      await server.close().catch(() => undefined);
    }
  };
}

function registerDomainTools(server, allowed, registry, client) {
  for (const name of MCP_TOOL_NAMES.filter(
    (item) => !['aiws_context', 'aiws_capabilities', 'aiws_operations', 'aiws_execute'].includes(item)
  )) {
    const actions = [
      ...allowed
        .filter((operation) => operation.callable && operation.mcp_binding.tool === name)
        .map((operation) => operation.operation_id),
      ...(virtualActions[name] || []).filter((action) => specialAllowed(action, client))
    ].sort();
    server.registerTool(
      name,
      {
        title: name.replace('aiws_', 'AIWS '),
        description: `AIWS ${name.slice(5)} domain operations. action must be a catalog value.`,
        inputSchema: z
          .object({
            action: actions.length ? z.enum(actions) : z.never(),
            arguments: z.record(z.string(), z.unknown()).default({})
          })
          .strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: actions.some((action) => capabilityRisk(action, registry) === 'critical'),
          openWorldHint: false
        }
      },
      async ({ action, arguments: args }) => toolResult(await executeAction(registry, action, args, client))
    );
  }
}

function registerContextTool(server, allowed, registry, client) {
  const contextOperations = new Map(
    allowed
      .filter((operation) => operation.domain === 'context')
      .map((operation) => [operation.operation_id, operation])
  );
  server.registerTool(
    'aiws_context',
    {
      title: 'AIWS 系统上下文',
      description: '先读取低成本地图，再检索、读取节点或解释某次服务端选择；运行内读取会返回可审计版本收据。',
      inputSchema: z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('map'),
            project_id: z.string().min(1).max(200).nullable().optional(),
            root_id: z.string().min(1).max(200).nullable().optional(),
            depth: z.number().int().min(1).max(12).default(4),
            limit: z.number().int().min(1).max(10_000).default(1000)
          })
          .strict(),
        z
          .object({
            action: z.literal('search'),
            query: z.string().max(20_000).default(''),
            project_id: z.string().min(1).max(200).nullable().optional(),
            anchor_node_id: z.string().min(1).max(200).nullable().optional(),
            explicit_refs: z.array(z.string().min(1).max(500)).max(200).default([]),
            token_budget: z.number().int().min(1).max(200_000).optional(),
            limit: z.number().int().min(1).max(200).default(30)
          })
          .strict(),
        z
          .object({
            action: z.literal('read'),
            node_id: z.string().min(1).max(200),
            version_id: z.string().min(1).max(200).nullable().optional(),
            selection_id: z.string().min(1).max(200).nullable().optional()
          })
          .strict(),
        z.object({ action: z.literal('explain_selection'), selection_id: z.string().min(1).max(200) }).strict()
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      const operationId =
        input.action === 'map'
          ? 'aiws.context.get.context.v1.map'
          : input.action === 'search'
            ? 'aiws.context.post.context.v1.search'
            : input.action === 'read'
              ? 'aiws.context.get.context.v1.nodes.by-id'
              : 'aiws.context.get.context.v1.selections.by-id';
      if (!contextOperations.has(operationId))
        return toolResult(fail(`aiws.context.${input.action}`, 403, 'mcp_scope_required'));
      const { action, node_id, ...rest } = input;
      const args =
        action === 'map'
          ? { query: rest }
          : action === 'search'
            ? { body: rest }
            : action === 'read'
              ? { params: { id: node_id }, query: rest }
              : { params: { id: input.selection_id } };
      return toolResult(await executeRegistryOperation(registry, operationId, args, { client }));
    }
  );
}

function registerCapabilityTool(server, allowed, registry, client) {
  server.registerTool(
    'aiws_capabilities',
    {
      title: 'AIWS capability catalog',
      description: 'Search or describe the complete classified AIWS capability catalog.',
      inputSchema: z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('search'),
            query: z.string().max(300).default(''),
            domain: z.string().max(50).optional(),
            mapping: z.enum(['tool', 'resource', 'async_adapter', 'external_callback', 'frontend_only']).optional(),
            limit: z.number().int().min(1).max(200).default(50),
            cursor: z.string().max(500).nullable().optional()
          })
          .strict(),
        z.object({ action: z.literal('describe'), operation_id: z.string().min(1).max(500) }).strict(),
        z.object({ action: z.literal('list_domains') }).strict()
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      if (input.action === 'list_domains')
        return toolResult(
          ok('aiws.capabilities.list_domains', {
            domains: [
              ...new Set([
                ...allowed.map((item) => item.domain),
                ...MCP_SPECIAL_CAPABILITIES.map((item) => item.domain)
              ])
            ].sort()
          })
        );
      if (input.action === 'describe') {
        const operation = allowed.find((item) => item.operation_id === input.operation_id),
          special = MCP_SPECIAL_CAPABILITIES.find(
            (item) => item.operation_id === input.operation_id && specialAllowed(item.operation_id, client)
          );
        return toolResult(
          operation || special
            ? ok('aiws.capabilities.describe', { capability: operation ? describeOperation(operation) : special })
            : fail('aiws.capabilities.describe', 404, 'mcp_operation_not_found')
        );
      }
      const result = searchOperations(allowed, input),
        needle = input.query.toLowerCase();
      const specials = MCP_SPECIAL_CAPABILITIES.filter(
        (item) =>
          specialAllowed(item.operation_id, client) &&
          (!input.domain || item.domain === input.domain) &&
          (!input.mapping || item.mapping === input.mapping) &&
          (!needle || JSON.stringify(item).toLowerCase().includes(needle))
      );
      return toolResult(
        ok('aiws.capabilities.search', { ...result, special_items: specials, route_count: registry.length })
      );
    }
  );
}

function registerOperationsTool(server, registry, client) {
  server.registerTool(
    'aiws_operations',
    {
      title: 'AIWS operation handles',
      description: 'Wait for, read events from, or cancel an asynchronous AIWS operation.',
      inputSchema: z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('wait'),
            operation_id: z.string().min(1).max(200),
            timeout_ms: z.number().int().min(0).max(30000).default(30000),
            poll_ms: z.number().int().min(50).max(2000).default(150)
          })
          .strict(),
        z
          .object({
            action: z.literal('read_events'),
            operation_id: z.string().min(1).max(200),
            cursor: z.string().max(500).nullable().optional(),
            limit: z.number().int().min(1).max(500).default(100)
          })
          .strict(),
        z
          .object({
            action: z.literal('cancel'),
            operation_id: z.string().min(1).max(200),
            reason: z.string().max(500).optional()
          })
          .strict()
      ]),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      try {
        if (input.action === 'wait')
          return toolResult(ok('aiws.operations.wait', await waitForMcpOperation(input.operation_id, input, client)));
        if (input.action === 'read_events')
          return toolResult(
            ok('aiws.operations.read_events', await readMcpOperationEvents(input.operation_id, input, client))
          );
        return toolResult(await cancelMcpOperation(registry, input.operation_id, input, client));
      } catch (error) {
        return toolResult(fromError(`aiws.operations.${input.action}`, error));
      }
    }
  );
}

function registerExecuteTool(server, allowed, registry, client) {
  const actions = allowed
    .filter((operation) => operation.callable)
    .map((operation) => operation.operation_id)
    .sort();
  server.registerTool(
    'aiws_execute',
    {
      title: 'AIWS catalog executor',
      description: 'Fallback executor restricted to a registered operation_id. URLs and HTTP methods are not accepted.',
      inputSchema: z
        .object({
          operation_id: actions.length ? z.enum(actions) : z.never(),
          arguments: z.record(z.string(), z.unknown()).default({})
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: actions.some((action) => capabilityRisk(action, registry) === 'critical'),
        openWorldHint: false
      }
    },
    async ({ operation_id, arguments: args }) =>
      toolResult(await executeRegistryOperation(registry, operation_id, args, { client }))
  );
}

function registerResources(server, allowed, registry, client) {
  server.registerResource(
    'aiws-capabilities',
    'aiws://capabilities',
    { title: 'AIWS capability catalog', mimeType: 'application/json' },
    async (uri) =>
      resourceResult(
        uri,
        ok('aiws.capabilities.resource', {
          items: allowed.map(describeOperation),
          special_items: MCP_SPECIAL_CAPABILITIES.filter((item) => specialAllowed(item.operation_id, client)),
          route_count: registry.length
        })
      )
  );
  registerContextResources(server, allowed, registry, client);
  for (const operation of allowed.filter(
    (item) => item.domain !== 'context' && ['resource', 'async_adapter'].includes(item.mapping)
  )) {
    const template = operation.mcp_binding.resource_uri_template;
    const read = async (uri, variables = {}) => {
      const params = Object.fromEntries(
        Object.entries(variables || {}).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
      );
      const query = Object.fromEntries(uri.searchParams || []);
      return resourceResult(
        uri,
        await executeRegistryOperation(
          registry,
          operation.operation_id,
          { ...(Object.keys(params).length ? { params } : {}), ...(Object.keys(query).length ? { query } : {}) },
          { client }
        )
      );
    };
    if (template.includes('{'))
      server.registerResource(
        `route-${operation.operation_id}`,
        new ResourceTemplate(template, { list: undefined }),
        { title: operation.summary, mimeType: 'application/json' },
        read
      );
    else
      server.registerResource(
        `route-${operation.operation_id}`,
        template,
        { title: operation.summary, mimeType: 'application/json' },
        (uri) => read(uri, {})
      );
  }
  server.registerResource(
    'aiws-operation-events',
    new ResourceTemplate('aiws://operations/{id}/events', { list: undefined }),
    { title: 'AIWS operation events', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      try {
        return resourceResult(
          uri,
          ok(
            'aiws.operations.read_events',
            await readMcpOperationEvents(
              id,
              { cursor: uri.searchParams.get('cursor'), limit: Number(uri.searchParams.get('limit') || 100) },
              client
            )
          )
        );
      } catch (error) {
        return resourceResult(uri, fromError('aiws.operations.read_events', error));
      }
    }
  );
}

function registerContextResources(server, allowed, registry, client) {
  const operationIds = new Set(allowed.filter((item) => item.domain === 'context').map((item) => item.operation_id));
  if (!operationIds.has('aiws.context.get.context.v1.map')) return;
  server.registerResource(
    'aiws-context-map',
    new ResourceTemplate('aiws://context/map/{scope}', { list: undefined }),
    { title: 'AIWS 系统上下文地图', mimeType: 'application/json' },
    async (uri, variables) => {
      const scope = Array.isArray(variables.scope) ? variables.scope[0] : variables.scope,
        projectId = scope && scope !== 'global' ? String(scope) : null;
      return resourceResult(
        uri,
        await executeRegistryOperation(
          registry,
          'aiws.context.get.context.v1.map',
          projectId ? { query: { project_id: projectId } } : {},
          { client }
        )
      );
    }
  );
  server.registerResource(
    'aiws-context-node',
    new ResourceTemplate('aiws://context/nodes/{id}', { list: undefined }),
    { title: 'AIWS 上下文文档', mimeType: 'application/json' },
    async (uri, variables) =>
      resourceResult(
        uri,
        await executeRegistryOperation(
          registry,
          'aiws.context.get.context.v1.nodes.by-id',
          { params: { id: variableValue(variables.id) } },
          { client }
        )
      )
  );
  server.registerResource(
    'aiws-context-selection',
    new ResourceTemplate('aiws://context/selections/{id}', { list: undefined }),
    { title: 'AIWS 上下文选择审计', mimeType: 'application/json' },
    async (uri, variables) =>
      resourceResult(
        uri,
        await executeRegistryOperation(
          registry,
          'aiws.context.get.context.v1.selections.by-id',
          { params: { id: variableValue(variables.id) } },
          { client }
        )
      )
  );
}

function variableValue(value) {
  return Array.isArray(value) ? value[0] : String(value || '');
}

function registerSubscriptions(server, subscriptions) {
  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    const uri = String(params.uri || '');
    if (!uri.startsWith('aiws://operations/')) throw new HttpError(400, { error: 'mcp_subscription_resource_invalid' });
    subscriptions.set(uri, null);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    subscriptions.delete(String(params.uri || ''));
    return {};
  });
}

async function notifySubscriptions(server, subscriptions, client) {
  for (const [uri, previous] of subscriptions) {
    try {
      const parsed = new URL(uri),
        id = parsed.hostname === 'operations' ? parsed.pathname.split('/').filter(Boolean)[0] : null;
      if (!id) continue;
      const operation = await getMcpOperation(decodeURIComponent(id), client),
        signature = `${operation.status}:${operation.updated_at || operation.completed_at || ''}`;
      if (previous !== null && signature !== previous) await server.server.sendResourceUpdated({ uri });
      subscriptions.set(uri, signature);
    } catch {
      subscriptions.delete(uri);
    }
  }
}

async function executeAction(registry, action, args, client) {
  if (action === 'aiws.projects.create')
    return executeRegistryOperation(
      registry,
      'aiws.projects.post.projects',
      args?.body || args?.params || args?.query ? args : { body: args || {} },
      { client }
    );
  if (action.startsWith('aiws.files.upload.')) {
    try {
      requireProjectSubject(client);
      const data = action.endsWith('.begin')
        ? await beginMcpUpload(args, client)
        : action.endsWith('.chunk')
          ? await appendMcpUploadChunk(args, client)
          : action.endsWith('.commit')
            ? await commitMcpUpload(args, client)
            : await cancelMcpUpload(args, client);
      return ok(action, data);
    } catch (error) {
      return fromError(action, error);
    }
  }
  if (virtualActions.aiws_terminal.includes(action)) {
    try {
      const mode = action.slice('aiws.terminal.'.length),
        state = await readState(),
        session = state.terminal_sessions.find((item) => item.id === args.session_id);
      if (!session) throw new HttpError(404, { error: 'terminal_session_not_found' });
      assertProjectAccess(client, session.project_id);
      assertScopes(client, [
        mode === 'read' ? 'terminal:read' : mode === 'resize' ? 'terminal:write' : 'terminal:execute'
      ]);
      requireProjectSubject(client);
      if (mode === 'read') assertProjectRead(state, session.project_id, client.subject_user_id);
      else assertProjectRun(state, session.project_id, client.subject_user_id);
      return ok(action, await terminalRuntimeAction(session.id, mode, args));
    } catch (error) {
      return fromError(action, error);
    }
  }
  if (virtualActions.aiws_github.includes(action)) {
    try {
      return ok(
        action,
        action.endsWith('.close')
          ? await closeMcpGithubPullRequest(args, client)
          : await deleteMcpGithubBranch(args, client)
      );
    } catch (error) {
      return fromError(action, error);
    }
  }
  return executeRegistryOperation(registry, action, args, { client });
}

function resourceResult(uri, result) {
  return {
    contents: [{ uri: String(uri), mimeType: 'application/json', text: JSON.stringify(maskSecretsDeep(result)) }]
  };
}
function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(maskSecretsDeep(result)) }],
    structuredContent: maskSecretsDeep(result),
    isError: result.ok === false
  };
}
function ok(operationId, data) {
  return {
    ok: true,
    operation_id: operationId,
    request_id: `mcp_${randomUUID().replaceAll('-', '')}`,
    status: 200,
    data: maskSecretsDeep(data)
  };
}
function fail(operationId, status, error, details = {}) {
  return {
    ok: false,
    operation_id: operationId,
    request_id: `mcp_${randomUUID().replaceAll('-', '')}`,
    status,
    error: { error, ...details }
  };
}
function fromError(operationId, error) {
  return error instanceof HttpError
    ? fail(
        operationId,
        error.status,
        typeof error.payload === 'string' ? error.payload : error.payload.error,
        typeof error.payload === 'object' ? error.payload : {}
      )
    : fail(operationId, 500, 'mcp_operation_failed', { message: String(error?.message || error) });
}
function specialAllowed(action, client) {
  const item = MCP_SPECIAL_CAPABILITIES.find((candidate) => candidate.operation_id === action);
  return item ? item.required_scopes.every((scope) => client.scopes.includes(scope)) : false;
}
function capabilityRisk(action, registry) {
  return (
    registry.find((item) => item.operation_id === action)?.risk ||
    MCP_SPECIAL_CAPABILITIES.find((item) => item.operation_id === action)?.risk ||
    'low'
  );
}
function requireProjectSubject(client) {
  if (!client.subject_user_id) throw new HttpError(403, { error: 'mcp_subject_user_required' });
  return client.subject_user_id;
}
