import { randomUUID } from 'node:crypto';
import { readBody } from '../../http-body.mjs';
import { AppError } from '../../errors.mjs';
import { MCP_PUBLIC_TOOL_SNAPSHOT } from './public-tools.mjs';

export function createMcpHandler({ domain, registry, config, executeCommand }) {
  return async function mcp(req) {
    const body = await readBody(req);
    const rpcId = body.id ?? null;
    const sessionId = String(req.headers['mcp-session-id'] || randomUUID());
    const withSession = (payload) => {
      Object.defineProperty(payload, '__mcp_headers', { value: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' }, enumerable: false });
      return payload;
    };
    if (body.method === 'initialize') return withSession({ jsonrpc: '2.0', id: rpcId, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aiws-v3', version: config.version } } });
    if (body.method === 'notifications/initialized' || body.method === 'ping') return withSession({ jsonrpc: '2.0', id: rpcId, result: {} });
    if (body.method === 'tools/list') {
      const authorization = req.headers['x-aiws-mcp-token'] ? await domain.authorizeMcpToken(req.headers['x-aiws-mcp-token'], '') : { local: true, client: null };
      const allowedTools = authorization.client?.scope && Object.prototype.hasOwnProperty.call(authorization.client.scope, 'tools') ? authorization.client.scope.tools : null;
      const registered = new Set([...registry.list(), ...(domain.r2?.queries?.list?.() || [])]);
      const tools = MCP_PUBLIC_TOOL_SNAPSHOT.filter((name) => (registered.has(name) || ['operation.get', 'operation.wait', 'operation.events', 'operation.cancel'].includes(name)) && (!Array.isArray(allowedTools) || allowedTools.includes(name)))
        .map((name) => ({ name, description: name === 'projects.list' ? 'List projects' : name === 'project.get' ? 'Get a project bundle' : `AIWS command ${name}`, inputSchema: name === 'project.get' ? { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } : { type: 'object' } }));
      return withSession({ jsonrpc: '2.0', id: rpcId, result: { tools } });
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      if (!MCP_PUBLIC_TOOL_SNAPSHOT.includes(String(name))) throw new AppError('unknown_command', `unknown command: ${name}`, { status: 404 });
      const authorization = await domain.authorizeMcpToken(req.headers['x-aiws-mcp-token'], args.project_id || args.projectId || '');
      const allowedTools = authorization.client?.scope && Object.prototype.hasOwnProperty.call(authorization.client.scope, 'tools') ? authorization.client.scope.tools : null;
      if (Array.isArray(allowedTools) && !allowedTools.includes(String(name))) throw new AppError('mcp_scope_denied', 'MCP token is not scoped to this tool', { status: 403 });
      if (!authorization.local && name === 'project.create' && authorization.client?.scope?.allow_all_projects !== true) throw new AppError('mcp_scope_denied', 'MCP token cannot create projects outside its allowlist', { status: 403 });
      if (String(name).startsWith('operation.')) await domain.assertMcpOperationScope(authorization, args.operation_id);
      let result;
      if (name === 'projects.list' && !authorization.local && authorization.client?.scope?.allow_all_projects !== true) {
        const projects = await domain.listProjects();
        const allow = new Set((authorization.client?.scope?.project_ids || []).map(String));
        result = projects.filter((project) => allow.has(String(project.id)));
      } else if (domain.r2?.queries?.list?.().includes(name)) result = await domain.r2.queries.execute(name, args, req.aiwsAuth);
      else if (name === 'operation.get') result = await domain.operationService.get(args.operation_id);
      else if (name === 'operation.wait') result = await waitForOperation(domain, args.operation_id, args.timeout_ms);
      else if (name === 'operation.events') result = await domain.operationService.events(args.operation_id, args.cursor || args.after || 0);
      else if (name === 'operation.cancel') result = await domain.operationService.cancel(args.operation_id, args);
      else {
        if (!registry.list().includes(name)) throw new AppError('unknown_command', `unknown command: ${name}`, { status: 404 });
        const key = req.headers['idempotency-key'] || `mcp-${rpcId || randomUUID()}`;
        result = (await executeCommand(name, args, req, '/api/v1/mcp', key)).body;
      }
      const clean = domain.redact(result);
      return withSession({ jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: JSON.stringify(clean) }], structuredContent: clean, operation: clean?.operation_id ? { operation_id: clean.operation_id, status: clean.status, cursor: clean.cursor, revision: clean.revision } : undefined } });
    }
    throw new AppError('invalid_input', 'unsupported MCP method');
  };
}

async function waitForOperation(domain, operationId, timeoutMs = 30_000) {
  const timeout = Math.min(Math.max(Number(timeoutMs) || 30_000, 0), 30_000);
  const started = Date.now();
  while (true) {
    const operation = await domain.operationService.get(operationId);
    if (['completed', 'failed', 'cancelled'].includes(operation.status) || Date.now() - started >= timeout) return { ...operation, timed_out: !['completed', 'failed', 'cancelled'].includes(operation.status), waited_ms: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
