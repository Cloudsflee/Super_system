import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { HttpError, normalizeErrorPayload, route as matchRoute } from './http.mjs';
import { assertProjectAccess, assertScopes, bindInternalCodexTaskLease } from './mcp-client-service.mjs';
import { readStateSnapshot } from './state.mjs';
import { maskSecretsDeep } from '../../../packages/shared/index.mjs';
import { runAsActor } from './actor-context.mjs';
import { authorizeApiRoute } from './project-governance-v19.mjs';
export const MCP_MAPPINGS = Object.freeze(['tool', 'resource', 'async_adapter', 'external_callback', 'frontend_only']);
export function createApiRouteRegistry(routes) {
  const operations = routes.map((item) => enrichRoute(item));
  const ids = new Set();
  for (const operation of operations) {
    if (ids.has(operation.operation_id)) throw new Error(`duplicate_api_operation_id:${operation.operation_id}`);
    ids.add(operation.operation_id);
    validateOperation(operation);
  }
  return Object.freeze(operations.map(Object.freeze));
}
export function describeOperation(operation) {
  if (!operation) return null;
  const { handler, ...description } = operation;
  return structuredClone(description);
}
export function searchOperations(
  registry,
  { query = '', domain = null, mapping = null, limit = 50, cursor = null } = {}
) {
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  const start = decodeCursor(cursor);
  const filtered = registry.filter(
    (item) =>
      (!domain || item.domain === domain) &&
      (!mapping || item.mapping === mapping) &&
      (!needle ||
        [item.operation_id, item.pattern, item.domain, item.summary, item.source_module]
          .join(' ')
          .toLowerCase()
          .includes(needle))
  );
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200),
    page = filtered.slice(start, start + size);
  return {
    items: page.map(describeOperation),
    total: filtered.length,
    next_cursor: start + size < filtered.length ? encodeCursor(start + size) : null
  };
}
export async function executeRegistryOperation(registry, operationId, args = {}, context = {}) {
  const operation = registry.find((item) => item.operation_id === operationId);
  const requestId = context.requestId || `mcp_${randomUUID().replaceAll('-', '')}`;
  if (!operation) return failure(operationId, requestId, 404, { error: 'mcp_operation_not_found' });
  try {
    validateArguments(operation, args);
    args = bindInternalCodexTaskLease(context.client, args);
    if (operation.mapping === 'external_callback' || operation.mapping === 'frontend_only')
      throw new HttpError(403, { error: 'mcp_operation_not_callable', mapping: operation.mapping });
    if (context.client) {
      assertScopes(context.client, operation.required_scopes);
      const projectId = await resolveProjectId(operation, args, context.client);
      if (
        operation.project_scoped &&
        context.client.project_allowlist?.length &&
        !projectId &&
        operation.pattern !== '/projects'
      )
        throw new HttpError(400, { error: 'mcp_project_context_required', operation_id: operation.operation_id });
      assertProjectAccess(context.client, projectId);
      if (operation.project_scoped && !context.client.subject_user_id)
        throw new HttpError(403, { error: 'mcp_subject_user_required' });
      if (!isInvitationAcceptance(operation.pattern) && (context.client.subject_user_id || operation.method !== 'GET'))
        await runAsActor(context.client.subject_user_id || null, () =>
          authorizeApiRoute(operation, invocationContext(operation, args, requestId, context), {
            strict: Boolean(context.client.subject_user_id),
            state: null
          })
        );
    }
    if (operation.stream_response) {
      return success(operation, requestId, 202, null, {
        type: operation.mapping === 'async_adapter' ? 'operation_events' : 'resource',
        uri: resourceUriFor(operation, args),
        cursor: args.query?.after || null
      });
    }
    const invocation = await runAsActor(context.client?.subject_user_id || null, () =>
      invokeHandler(operation, args, requestId, context)
    );
    let data = invocation.data;
    if (context.client?.project_allowlist?.length && operation.pattern === '/projects' && Array.isArray(data))
      data = data.filter((project) => context.client.project_allowlist.includes(project.id));
    if (invocation.status >= 400) return failure(operation.operation_id, requestId, invocation.status, data);
    if (invocation.status === 202)
      return success(operation, requestId, invocation.status, null, operationHandle(operation, data));
    return success(operation, requestId, invocation.status, data);
  } catch (error) {
    if (error instanceof HttpError)
      return failure(
        operation.operation_id,
        requestId,
        error.status,
        typeof error.payload === 'string' ? { error: error.payload } : error.payload
      );
    return failure(operation.operation_id, requestId, 500, {
      error: 'mcp_operation_failed',
      message: error?.message || String(error)
    });
  }
}
function enrichRoute(item) {
  const domain = classifyDomain(item.pattern);
  const mapping = classifyMapping(item);
  const requiredScopes = item.required_scopes || scopesFor(item, domain);
  const parameterNames = [...item.pattern.matchAll(/:([^/]+)/g)].map((match) => match[1]);
  return {
    ...item,
    operation_id: item.operation_id || operationIdFor(item.method, item.pattern, domain),
    domain,
    summary: item.summary || `${item.method} ${item.pattern}`,
    input_schema: item.input_schema || inputSchema(parameterNames, item.method),
    output_schema: item.output_schema || { type: ['object', 'array', 'string', 'null'] },
    required_scopes: requiredScopes,
    risk: riskFor(item, requiredScopes),
    idempotency: idempotencyFor(item),
    mapping,
    mcp_binding:
      mapping === 'resource' || mapping === 'async_adapter'
        ? {
            resource_uri_template: item.mcp_resource_uri_template || resourceTemplateFor(item.pattern),
            tool: domainTool(domain)
          }
        : { tool: domainTool(domain) },
    stream_response: isStreamResponse(item),
    project_scoped: isProjectScoped(item.pattern),
    callable: !['external_callback', 'frontend_only'].includes(mapping),
    ...(item.pattern === '/mcp' ? { protocol_reason: 'mcp_transport_endpoint' } : {})
  };
}
function validateOperation(operation) {
  for (const field of [
    'operation_id',
    'method',
    'pattern',
    'source_module',
    'domain',
    'input_schema',
    'output_schema',
    'required_scopes',
    'risk',
    'idempotency',
    'mapping',
    'mcp_binding'
  ])
    if (operation[field] == null)
      throw new Error(`api_operation_metadata_missing:${operation.operation_id || operation.pattern}:${field}`);
  if (!MCP_MAPPINGS.includes(operation.mapping))
    throw new Error(`api_operation_mapping_invalid:${operation.operation_id}`);
  if (!/^aiws\.[a-z0-9-]+\.(?:get|post|put|patch|delete)\.[a-z0-9.-]+$/.test(operation.operation_id))
    throw new Error(`api_operation_id_invalid:${operation.operation_id}`);
}
function validateArguments(operation, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, { error: 'mcp_operation_arguments_invalid' });
  const allowed = new Set(['params', 'query', 'body', 'idempotency_key']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new HttpError(400, { error: 'mcp_operation_arguments_unknown', fields: unknown });
  for (const key of ['params', 'query', 'body'])
    if (value[key] != null && (typeof value[key] !== 'object' || Array.isArray(value[key])))
      throw new HttpError(400, { error: `mcp_operation_${key}_invalid` });
  const required = [...operation.pattern.matchAll(/:([^/]+)/g)].map((match) => match[1]);
  const missing = required.filter((key) => !String(value.params?.[key] ?? ''));
  const extra = Object.keys(value.params || {}).filter((key) => !required.includes(key));
  if (missing.length || extra.length)
    throw new HttpError(400, { error: 'mcp_operation_params_invalid', missing, extra });
  if (
    operation.idempotency === 'key_required' &&
    operation.method === 'POST' &&
    value.idempotency_key != null &&
    !/^[A-Za-z0-9._:-]{8,128}$/.test(String(value.idempotency_key))
  )
    throw new HttpError(400, { error: 'mcp_idempotency_key_invalid' });
}

async function invokeHandler(operation, args, requestId, context) {
  const req = Readable.from([]);
  Object.assign(req, {
    method: operation.method,
    url: buildPath(operation.pattern, args.params || {}),
    headers: {
      'content-type': 'application/json',
      'x-aiws-request-id': requestId,
      ...(args.idempotency_key ? { 'x-idempotency-key': String(args.idempotency_key) } : {}),
      ...(context.headers || {})
    },
    socket: { remoteAddress: '127.0.0.1' }
  });
  if (context.client)
    req.auth = {
      clientId: context.client.id,
      scopes: context.client.scopes,
      extra: { project_allowlist: context.client.project_allowlist, subject_user_id: context.client.subject_user_id }
    };
  const res = new CaptureResponse(requestId);
  const params = matchRoute(buildPath(operation.pattern, args.params || {}), operation.pattern) || {};
  await operation.handler({
    req,
    res,
    pathname: operation.pattern,
    params,
    query: args.query || {},
    body: args.body || {}
  });
  if (!res.writableEnded) await res.waitForEnd();
  return { status: res.statusCode, data: res.value() };
}

function invocationContext(operation, args, requestId, context) {
  const req = {
    method: operation.method,
    headers: { 'x-aiws-request-id': requestId, ...(context.headers || {}) },
    socket: { remoteAddress: '127.0.0.1' }
  };
  if (context.client)
    req.auth = {
      clientId: context.client.id,
      scopes: context.client.scopes,
      extra: { project_allowlist: context.client.project_allowlist, subject_user_id: context.client.subject_user_id }
    };
  return { req, params: args.params || {}, query: args.query || {}, body: args.body || {} };
}

class CaptureResponse extends Writable {
  constructor(requestId) {
    super();
    this.statusCode = 200;
    this.headers = new Map([['x-aiws-request-id', requestId]]);
    this.chunks = [];
    this.size = 0;
  }
  _write(chunk, encoding, callback) {
    this.size += chunk.length;
    if (this.size > 8 * 1024 * 1024) return callback(new HttpError(413, { error: 'mcp_result_too_large' }));
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }
  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }
  writeHead(status, headers = {}) {
    this.statusCode = Number(status);
    for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    return this;
  }
  value() {
    const text = Buffer.concat(this.chunks).toString('utf8');
    if (!text) return null;
    if (String(this.getHeader('content-type') || '').includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch {}
    }
    return text;
  }
  waitForEnd() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HttpError(504, { error: 'mcp_operation_response_timeout' })), 30_000);
      timer.unref?.();
      this.once('finish', () => {
        clearTimeout(timer);
        resolve();
      });
      this.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

async function resolveProjectId(operation, args, client = null) {
  const explicitPath =
    args.params?.projectId || (operation.pattern.startsWith('/projects/:id') ? args.params?.id : null);
  if (explicitPath) return String(explicitPath);
  const state = await readStateSnapshot(),
    params = args.params || {};
  const pattern = operation.pattern;
  const resolved = resolveProjectRoute(pattern, state, params, args.body, client);
  if (resolved.matched) return resolved.projectId;
  if (params.id) return null;
  const declared = args.query?.project_id || args.body?.project_id;
  if (declared) return String(declared);
  if (pattern.startsWith('/context/v1/') && client?.project_allowlist?.length === 1)
    return String(client.project_allowlist[0]);
  return null;
}

const directProjectRoutes = [
  ['/assist/v3/sessions/:id', 'assist_sessions'],
  ['/assist/v2/sessions/:id', 'assist_sessions'],
  ['/assist/v3/turns/:id', 'assist_turns'],
  ['/assist/v3/terminal-sessions/:id', 'terminal_sessions'],
  ['/assist/v3/operations/:id', 'assist_operations'],
  ['/assist/v3/change-batches/:id', 'assist_change_batches'],
  ['/assist/v3/attachments/:id', 'attachments'],
  ['/agent-sessions/:id', 'agent_sessions'],
  ['/runs/:id', 'node_runs'],
  ['/deliveries/:id', 'deliveries'],
  ['/workflow-executions/:id', 'workflow_executions'],
  ['/task-executions/:id', 'task_executions'],
  ['/delivery-policies/:id', 'delivery_policies'],
  ['/repository-workspaces/:id', 'repository_workspaces'],
  ['/pull-request-intents/:id', 'pull_request_intents'],
  ['/project-invitations/:id', 'project_invitations'],
  ['/workflows/:id', 'workflows'],
  ['/workspaces/:id', 'workspaces'],
  ['/change-proposals/:id', 'change_proposals'],
  ['/assets/:id', 'assets']
];

const projectRouteResolvers = [
  resolveDirectProjectRoute,
  resolveContextPackProject,
  resolveContextRecordProject,
  resolveWorkflowNodeProject,
  resolveExchangeRouteProject,
  resolveRepositoryDeletionProject,
  resolveCanonicalRepositoryBindingProject,
  resolveApprovalProject,
  resolveAssetProject
];

function resolveProjectRoute(pattern, state, params, body, client) {
  const input = { pattern, state, params, body, client };
  for (const resolver of projectRouteResolvers) {
    const result = resolver(input);
    if (result.matched) return result;
  }
  return { matched: false };
}

function resolveDirectProjectRoute({ pattern, state, params }) {
  return directProjectRoute(pattern, state, params.id);
}

function resolveContextPackProject({ pattern, state, params }) {
  if (!pattern.startsWith('/context-packs/:id')) return { matched: false };
  const contextPack = state.context_packs.find((item) => item.id === params.id);
  return {
    matched: true,
    projectId:
      contextPack?.content_json?.project?.id ||
      state.workspaces.find((item) => item.id === contextPack?.source_workspace_id)?.project_id ||
      null
  };
}

function resolveContextRecordProject({ pattern, state, params }) {
  const collection = pattern.startsWith('/context/v1/nodes/:id')
    ? 'context_nodes'
    : pattern.startsWith('/context/v1/selections/:id')
      ? 'context_selections'
      : null;
  return collection
    ? { matched: true, projectId: state[collection].find((item) => item.id === params.id)?.project_id || null }
    : { matched: false };
}

function resolveWorkflowNodeProject({ pattern, state, params }) {
  if (!['/nodes/:id', '/tasks/:id', '/workstreams/:id'].some((prefix) => pattern.startsWith(prefix)))
    return { matched: false };
  const node = state.workflow_nodes.find((item) => item.id === params.id),
    workflow = state.workflows.find((item) => item.id === node?.workflow_id);
  return { matched: true, projectId: workflow?.project_id || null };
}

function resolveExchangeRouteProject({ pattern, state, params, body, client }) {
  return resolveExchangeProject(pattern, state, params.id, body, client);
}

function resolveRepositoryDeletionProject({ pattern, state, params, client }) {
  return resolveCanonicalRepositoryProject(pattern, state, params.id, client);
}

function resolveCanonicalRepositoryBindingProject({ pattern, state, params, client }) {
  if (!pattern.startsWith('/canonical-repositories/:id') && !pattern.startsWith('/github/repositories/:id/deletion'))
    return { matched: false };
  const canonical = state.canonical_repositories.find(
    (item) => item.id === params.id || String(item.repository_id) === String(params.id)
  );
  return {
    matched: true,
    projectId: chooseAllowedProject(
      client,
      ...state.project_repository_bindings
        .filter((item) => item.canonical_repository_id === canonical?.id && item.status !== 'removed')
        .map((item) => item.project_id)
    )
  };
}

function resolveApprovalProject({ pattern, state, params }) {
  if (!pattern.startsWith('/approvals/:type/:id')) return { matched: false };
  return {
    matched: true,
    projectId:
      params.type === 'runtime'
        ? findProject(state, 'runtime_approvals', params.id)
        : findProject(state, 'change_proposals', params.id)
  };
}

function resolveAssetProject({ pattern, state, params }) {
  if (pattern.startsWith('/asset-candidates/:id'))
    return {
      matched: true,
      projectId: findProject(state, 'assets', params.id) || findProject(state, 'runner_memory_candidates', params.id)
    };
  if (!pattern.startsWith('/asset-versions/:id')) return { matched: false };
  const version = state.asset_versions.find((item) => item.id === params.id);
  return { matched: true, projectId: findProject(state, 'assets', version?.asset_id) };
}

function directProjectRoute(pattern, state, id) {
  const route = directProjectRoutes.find(([prefix]) => pattern.startsWith(prefix));
  return route ? { matched: true, projectId: findProject(state, route[1], id) } : { matched: false };
}

function findProject(state, collection, value) {
  return state[collection]?.find((item) => item.id === value)?.project_id || null;
}

function resolveExchangeProject(pattern, state, id, body, client) {
  if (pattern.startsWith('/exchange-requests/:id')) {
    const request = state.exchange_requests.find((item) => item.id === id);
    if (body?.side === 'source') return { matched: true, projectId: request?.source_project_id || null };
    if (body?.side === 'target' || pattern.endsWith('/context-packs'))
      return { matched: true, projectId: request?.target_project_id || null };
    return {
      matched: true,
      projectId: chooseAllowedProject(client, request?.source_project_id, request?.target_project_id)
    };
  }
  if (pattern.startsWith('/exchange-grants/:id')) {
    const grant = state.exchange_grants.find((item) => item.id === id);
    return { matched: true, projectId: findProject(state, 'exchange_grants', id) || grant?.target_project_id || null };
  }
  return { matched: false };
}

function resolveCanonicalRepositoryProject(pattern, state, id, client) {
  if (!pattern.startsWith('/repository-deletion-intents/:id')) return { matched: false };
  const intent = state.repository_deletion_intents.find((item) => item.id === id);
  const projectIds = state.project_repository_bindings
    .filter((item) => item.canonical_repository_id === intent?.canonical_repository_id && item.status !== 'removed')
    .map((item) => item.project_id);
  return {
    matched: true,
    projectId: chooseAllowedProject(
      client,
      ...projectIds,
      ...(intent?.snapshot?.bindings || []).map((item) => item.project_id)
    )
  };
}

function chooseAllowedProject(client, ...values) {
  const projects = values.filter(Boolean);
  if (!projects.length) return null;
  const allowlist = client?.project_allowlist || [];
  return allowlist.length ? projects.find((item) => allowlist.includes(item)) || projects[0] : projects[0];
}

function classifyDomain(pattern) {
  if (pattern.startsWith('/context/v1/')) return 'context';
  if (/^\/(?:health|system|account)/.test(pattern)) return 'system';
  if (
    /^\/(?:setup|workflow-migrations)/.test(pattern) ||
    pattern === '/mcp' ||
    /^\/mcp\/clients/.test(pattern) ||
    /^\/tools/.test(pattern) ||
    /^\/codex\/(?:auth|profiles|probe|discovery|capabilities|docker|cc-switch)/.test(pattern)
  )
    return 'admin';
  if (/^\/assist\/v3\/terminal/.test(pattern)) return 'terminal';
  if (/\/files(?:\/|$)|\/attachments/.test(pattern)) return 'files';
  if (/^\/assist/.test(pattern)) return 'assist';
  if (/\/git\//.test(pattern) || /git-repositories/.test(pattern)) return 'git';
  if (
    /^\/github/.test(pattern) ||
    /\/github\//.test(pattern) ||
    /repository-(?:connections|targets|branches|workspaces)/.test(pattern) ||
    /pull-request-intents|pull-requests|delivery|deliveries/.test(pattern) ||
    /^\/(?:canonical-repositories|repository-deletion-intents)/.test(pattern)
  )
    return 'github';
  if (/^\/(?:assets|asset-candidates|asset-versions)/.test(pattern) || /\/digests$/.test(pattern)) return 'assets';
  if (/^\/(?:approvals|change-proposals|review)/.test(pattern)) return 'governance';
  if (/^\/(?:exchange-requests|exchange-grants)/.test(pattern) || /\/exchange(?:-requests|s)$/.test(pattern))
    return 'governance';
  if (/^\/(?:runs|context-packs)/.test(pattern) || /\/run(?:\/|$)/.test(pattern)) return 'runs';
  if (
    /^\/(?:workflows|workflow-executions|task-executions|nodes|workstreams|tasks)/.test(pattern) ||
    /workflow-draft/.test(pattern) ||
    /brief/.test(pattern)
  )
    return 'workflow';
  return 'projects';
}

function classifyMapping(item) {
  if (item.pattern === '/mcp' || item.pattern === '/github/webhook' || /\/(?:manifest)\/callback$/.test(item.pattern))
    return 'external_callback';
  if (isEventStream(item)) return 'async_adapter';
  return item.method === 'GET' ? 'resource' : 'tool';
}

function scopesFor(item, domain) {
  if (domain === 'context')
    return [item.pattern.endsWith('/rebuild') || item.pattern.endsWith('/status') ? 'context:admin' : 'context:read'];
  if (item.pattern === '/projects' && item.method === 'POST') return ['project:create'];
  if (item.pattern.endsWith('/share') && item.method === 'POST') return ['project:share'];
  if (item.pattern.endsWith('/project-invitations/:id/accept')) return ['project:read'];
  if (item.pattern.endsWith('/project-invitations/:id/revoke')) return ['project:share'];
  if (/\/(?:members|memberships|invitations)(?:\/|$)/.test(item.pattern) && item.method !== 'GET')
    return ['project:share'];
  if (/exchange-(?:requests|grants)|\/exchanges(?:$|\/)/.test(item.pattern))
    return [`exchange:${item.method === 'GET' ? 'read' : 'write'}`];
  if (/repository-deletion-intents|\/deletion-intent(?:s)?$/.test(item.pattern))
    return [
      item.method === 'GET' ? 'github:read' : 'github:write',
      ...(item.pattern.endsWith('/execute') || item.method === 'DELETE' ? ['destructive:execute'] : [])
    ];
  if (item.pattern.startsWith('/mcp/clients')) return ['mcp:admin'];
  if (item.pattern.startsWith('/setup') && item.method !== 'GET') return ['setup:admin'];
  if (/^\/approvals\/:type\/:id\/decision$/.test(item.pattern)) return ['approval:decide'];
  if (/^\/(?:tasks|workstreams)\/:id\/review$/.test(item.pattern)) return ['workflow:write', 'approval:decide'];
  if (/^\/task-executions\/:id\/human-approve$/.test(item.pattern)) return ['project:write', 'approval:decide'];
  if (/^\/workflow-executions\/:id\/outcome-waivers/.test(item.pattern)) return ['project:approve', 'approval:decide'];
  if (/^\/task-executions\/:id\/stages\/:stage\/replay$/.test(item.pattern)) return ['project:run'];
  if (/^\/asset-versions\/:id\/attestations$/.test(item.pattern) && item.method === 'POST')
    return ['assets:write', 'approval:decide'];
  if (/^\/workstreams\/:id\/delivery-policies$/.test(item.pattern) && item.method === 'POST')
    return ['github:write', 'approval:decide'];
  if (/^\/pull-request-intents\/:id\/(?:approve|execute)$/.test(item.pattern))
    return ['github:write', 'approval:decide'];
  if (domain === 'admin') return [item.method === 'GET' ? 'setup:read' : 'setup:admin'];
  const scopeDomain = { projects: 'project', governance: 'governance' }[domain] || domain;
  const scopes = [`${scopeDomain}:${item.method === 'GET' ? 'read' : 'write'}`];
  if (isDestructive(item)) scopes.push('destructive:execute');
  return scopes;
}

function riskFor(item, scopes) {
  if (scopes.includes('destructive:execute') || scopes.includes('approval:decide')) return 'critical';
  if (item.method === 'GET') return 'low';
  if (item.method === 'DELETE' || /apply|commit|confirm|complete|publish|repository|\/merge$/.test(item.pattern))
    return 'high';
  return 'medium';
}
function idempotencyFor(item) {
  if (item.idempotency) return item.idempotency;
  if (item.method === 'GET') return 'safe';
  if (['PUT', 'DELETE'].includes(item.method)) return 'idempotent';
  return item.method === 'POST' ? 'key_required' : 'conditional';
}
function isDestructive(item) {
  return (
    /\/(?:purge|reset|disconnect)$/.test(item.pattern) ||
    item.pattern === '/projects/:id/trash' ||
    (item.method === 'DELETE' &&
      (item.pattern === '/projects/:id' || /^\/(?:mcp\/clients|codex\/profiles)/.test(item.pattern)))
  );
}
function isEventStream(item) {
  return item.method === 'GET' && /\/events$/.test(item.pattern);
}
function isStreamResponse(item) {
  return (
    isEventStream(item) ||
    item.body === 'stream' ||
    (item.method === 'GET' &&
      /\/(?:content|download)$/.test(item.pattern) &&
      /(?:attachments|asset-versions)/.test(item.pattern))
  );
}
function isProjectScoped(pattern) {
  return (
    /^\/context\/v1\/(?:map|search|nodes|selections|policy)/.test(pattern) ||
    /^\/(?:projects|workspaces|repository-workspaces|pull-request-intents|workflows|workflow-executions|task-executions|nodes|workstreams|tasks|runs|deliveries|delivery-policies|context-packs|assets|asset-versions|asset-candidates|change-proposals|approvals|agent-sessions|exchange-requests|exchange-grants|project-invitations|submissions|review)/.test(
      pattern
    ) ||
    /^\/assist\/(?:v2\/sessions|v3\/(?:sessions|turns|terminal-sessions|operations|change-batches|attachments))/.test(
      pattern
    ) ||
    pattern === '/brief-templates/:templateId/apply'
  );
}

function domainTool(domain) {
  return `aiws_${domain}`.replace('aiws_admin', 'aiws_admin');
}
function operationIdFor(method, pattern, domain) {
  const suffix = pattern
    .split('/')
    .filter(Boolean)
    .map((part) =>
      part.startsWith(':')
        ? `by-${part.slice(1).replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`
        : part.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()
    )
    .join('.');
  return `aiws.${domain}.${method.toLowerCase()}.${suffix || 'root'}`;
}
function inputSchema(parameterNames, method) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      params: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(parameterNames.map((name) => [name, { type: 'string', minLength: 1 }])),
        required: parameterNames
      },
      query: { type: 'object', additionalProperties: true },
      body: { type: 'object', additionalProperties: true },
      idempotency_key: { type: 'string', minLength: 8, maxLength: 128 }
    },
    required: parameterNames.length ? ['params'] : method === 'GET' ? [] : ['body']
  };
}
function resourceTemplateFor(pattern) {
  const parts = pattern.split('/').filter(Boolean);
  const authority = parts.shift() || 'system';
  return `aiws://${authority}/${parts.map((part) => (part.startsWith(':') ? `{${part.slice(1)}}` : part)).join('/')}`.replace(
    /\/$/,
    ''
  );
}
function resourceUriFor(operation, args) {
  const path = operation.pattern.replace(/:([^/]+)/g, (_, key) => encodeURIComponent(String(args.params?.[key] || '')));
  const query = new URLSearchParams(
    Object.entries(args.query || {})
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)])
  );
  return `aiws://${operation.domain}${path}${query.size ? `?${query}` : ''}`;
}
function buildPath(pattern, params) {
  return pattern.replace(/:([^/]+)/g, (_, key) => encodeURIComponent(String(params[key] || '')));
}
function operationHandle(operation, data) {
  const id =
    data?.operation?.id || data?.turn?.id || data?.task?.id || data?.run?.id || data?.build?.id || data?.id || null;
  return {
    type: 'operation',
    id,
    status:
      data?.operation?.status ||
      data?.turn?.status ||
      data?.task?.status ||
      data?.run?.status ||
      data?.status ||
      'accepted',
    resource_uri: id ? `aiws://operations/${encodeURIComponent(id)}/events` : null,
    data
  };
}
function success(operation, requestId, status, data, handle = null) {
  return maskSecretsDeep({
    ok: true,
    operation_id: operation.operation_id,
    request_id: requestId,
    status,
    ...(handle ? { handle } : { data })
  });
}
function failure(operationId, requestId, status, payload) {
  return maskSecretsDeep({
    ok: false,
    operation_id: operationId,
    request_id: requestId,
    status,
    error: normalizeErrorPayload(payload || { error: 'request_failed' }, requestId)
  });
}
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}
function decodeCursor(value) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return Math.max(0, Number(parsed.offset) || 0);
  } catch {
    throw new HttpError(400, { error: 'mcp_cursor_invalid' });
  }
}
function isInvitationAcceptance(pattern) {
  return pattern === '/project-invitations/:id/accept';
}
