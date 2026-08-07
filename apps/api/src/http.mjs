import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashJson, now, parseJson, sha256 } from './crypto.mjs';
import { AppError, asAppError } from './errors.mjs';

const MUTATING = new Set(['POST', 'PATCH', 'DELETE']);

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function pathParts(urlPath) {
  return urlPath.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new AppError('payload_too_large', 'request body is too large', { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { throw new AppError('invalid_json', 'request body must be JSON', { status: 400 }); }
}

function errorPayload(error, requestId) {
  const appError = asAppError(error);
  return {
    error: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
      request_id: requestId,
      details: appError.details || {}
    }
  };
}

function responseForCommand(result) {
  return result ?? {};
}

export function createHttpHandler({ domain, registry, db, config, performanceProbe = () => ({}), webRoot }) {
  async function executeCommand(command, body, req, requestPath, explicitKey = null, responseStatus = 201) {
    const key = explicitKey || req.headers['idempotency-key'];
    if (!key || String(key).length > 200) throw new AppError('idempotency_required', 'Idempotency-Key header is required');
    const scope = `${req.method}:${requestPath}`;
    const requestHash = hashJson({ command, body });
    const existing = await db.get('SELECT * FROM idempotency_keys WHERE scope=? AND key=?', [scope, String(key)]);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new AppError('idempotency_conflict', 'Idempotency-Key was used with a different request', { details: { scope } });
      if (existing.response_json) return { status: Number(existing.response_status) || 200, body: JSON.parse(existing.response_json) };
      throw new AppError('idempotency_in_progress', 'an identical command is already in progress', { retryable: true, status: 409 });
    }
    try {
      await db.run('INSERT INTO idempotency_keys(scope,key,request_hash,created_at) VALUES(?,?,?,?)', [scope, String(key), requestHash, now()]);
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
      const retry = await db.get('SELECT * FROM idempotency_keys WHERE scope=? AND key=?', [scope, String(key)]);
      if (retry?.response_json) return { status: Number(retry.response_status) || 200, body: JSON.parse(retry.response_json) };
      throw new AppError('idempotency_in_progress', 'an identical command is already in progress', { retryable: true, status: 409 });
    }
    try {
      const result = await registry.execute(command, body, { actor: req.headers['x-aiws-actor'] || 'local-user' });
      const responseBody = responseForCommand(result);
      await db.run('UPDATE idempotency_keys SET response_status=?,response_json=? WHERE scope=? AND key=?', [responseStatus, JSON.stringify(responseBody), scope, String(key)]);
      return { status: responseStatus, body: responseBody };
    } catch (error) {
      await db.run('DELETE FROM idempotency_keys WHERE scope=? AND key=?', [scope, String(key)]).catch(() => undefined);
      throw error;
    }
  }

  async function mcp(req, requestId) {
    const body = await readBody(req);
    const rpcId = body.id ?? null;
    if (body.method === 'initialize') {
      return { jsonrpc: '2.0', id: rpcId, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aiws-v3', version: config.version } } };
    }
    if (body.method === 'notifications/initialized') return { jsonrpc: '2.0', id: rpcId, result: {} };
    if (body.method === 'tools/list') {
      const tools = [
        ...registry.list().map((name) => ({ name, description: `AIWS command ${name}`, inputSchema: { type: 'object' } })),
        { name: 'projects.list', description: 'List projects', inputSchema: { type: 'object' } },
        { name: 'project.get', description: 'Get a project bundle', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } }
      ];
      return { jsonrpc: '2.0', id: rpcId, result: { tools } };
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      await domain.authorizeMcpToken(req.headers['x-aiws-mcp-token'], args.project_id || args.projectId || '');
      let result;
      if (name === 'projects.list') result = await domain.listProjects();
      else if (name === 'project.get') result = await domain.getProject(args.project_id);
      else {
        if (!registry.list().includes(name)) throw new AppError('unknown_command', `unknown command: ${name}`, { status: 404 });
        const key = req.headers['idempotency-key'] || `mcp-${rpcId || randomUUID()}`;
        const commandResult = await executeCommand(name, args, req, '/api/v1/mcp', key);
        result = commandResult.body;
      }
      return { jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } };
    }
    throw new AppError('invalid_input', 'unsupported MCP method');
  }

  async function handler(req, res) {
    const requestId = String(req.headers['x-request-id'] || randomUUID());
    const parsed = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const urlPath = parsed.pathname;
    try {
      if (req.method === 'GET' && urlPath === '/livez') return send(res, 200, { status: 'alive', request_id: requestId });
      if (req.method === 'GET' && urlPath === '/readyz') {
        const health = await domain.health();
        const ready = health.sqlite.integrity?.every((item) => item === 'ok') && health.sqlite.user_version === 1 && health.broker.status === 'available' && health.broker.runner_digest === config.runnerDigest;
        return send(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks: health, request_id: requestId });
      }
      if (!urlPath.startsWith(config.apiPrefix)) return serveWeb(req, res, webRoot, urlPath);
      if (urlPath === `${config.apiPrefix}/mcp` && req.method === 'POST') return send(res, 200, await mcp(req, requestId));
      if (urlPath === `${config.apiPrefix}/mcp/tools` && req.method === 'GET') return send(res, 200, { tools: [
        ...registry.list().map((name) => ({ name, description: `AIWS command ${name}`, input_schema: { type: 'object' } })),
        { name: 'projects.list', description: 'List projects', input_schema: { type: 'object' } },
        { name: 'project.get', description: 'Get a project bundle', input_schema: { type: 'object', required: ['project_id'] } }
      ] });
      if (urlPath === `${config.apiPrefix}/system/capabilities` && req.method === 'GET') return send(res, 200, await domain.capabilities());
      if (urlPath === `${config.apiPrefix}/integrations/codex/probe` && req.method === 'POST') {
        const probeBody = await readBody(req);
        const key = req.headers['idempotency-key'];
        const probe = await executeCommand('integration.codex.probe', probeBody, req, urlPath, key, 200);
        return send(res, probe.status, probe.body);
      }
      if (urlPath === `${config.apiPrefix}/integrations/github/probe` && req.method === 'POST') {
        const probeBody = await readBody(req);
        const key = req.headers['idempotency-key'];
        const probe = await executeCommand('integration.github.probe', probeBody, req, urlPath, key, 200);
        return send(res, probe.status, probe.body);
      }
      if (urlPath === `${config.apiPrefix}/system/performance` && req.method === 'GET') return send(res, 200, performanceProbe());
      if (urlPath === `${config.apiPrefix}/system` && req.method === 'GET') return send(res, 200, { version: config.version, api_prefix: config.apiPrefix, data_volume: config.dataVolume });

      const parts = pathParts(urlPath.slice(config.apiPrefix.length));
      const body = MUTATING.has(req.method) ? await readBody(req) : {};
      let result;
      let status = 200;
      const command = (name, input = body) => executeCommand(name, input, req, urlPath);

      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'projects') result = await domain.listProjects();
      else if (req.method === 'GET' && parts.length === 1 && parts[0] === 'setup') result = await domain.setupState();
      else if (parts[0] === 'sessions') {
        if (req.method === 'GET' && parts.length === 1) result = await domain.listSessions();
        else if (req.method === 'POST' && parts.length === 1) ({ status, body: result } = await command('session.create'));
        else if (req.method === 'POST' && parts[2] === 'revoke') ({ status, body: result } = await command('session.revoke', { ...body, session_id: parts[1] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'account' && req.method === 'GET') result = await domain.db.get("SELECT id,display_name,status,revision,created_at,updated_at FROM users WHERE id='usr_local_owner'");
      else if (parts[0] === 'github' && parts[1] === 'apps') {
        if (req.method === 'GET' && parts.length === 2) result = await domain.listGithubAppConfigs();
        else if (req.method === 'POST' && parts.length === 2) ({ status, body: result } = await command('github_app.create'));
        else if (req.method === 'POST' && parts[3] === 'installations') ({ status, body: result } = await command('github_installation.create', { ...body, app_config_id: parts[2] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'assist' && parts[1] === 'sessions') {
        if (req.method === 'GET' && parts.length === 2) result = await domain.listAssistSessions(parsed.searchParams.get('project_id'));
        else if (req.method === 'POST' && parts.length === 2) ({ status, body: result } = await command('assist_session.create'));
        else if (req.method === 'GET' && parts.length === 3) result = await domain.getAssistSession(parts[2]);
        else if (req.method === 'GET' && parts[3] === 'events') return streamAssistEvents(req, res, domain, parts[2]);
        else if (req.method === 'POST' && parts[3] === 'turns') ({ status, body: result } = await command('assist_turn.create', { ...body, session_id: parts[2] }));
        else if (req.method === 'POST' && ['cancel', 'interrupt', 'resume', 'complete'].includes(parts[3])) ({ status, body: result } = await command('assist_session.transition', { ...body, session_id: parts[2], action: parts[3] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'mcp' && parts[1] === 'clients') {
        if (req.method === 'GET' && parts.length === 2) result = await domain.listMcpClients();
        else if (req.method === 'POST' && parts.length === 2) ({ status, body: result } = await command('mcp_client.create'));
        else if (req.method === 'POST' && parts[3] === 'revoke') ({ status, body: result } = await command('mcp_client.revoke', { ...body, client_id: parts[2] }));
        else throw new AppError('not_found', 'route not found');
      }
      else if (parts[0] === 'credentials') {
        if (req.method === 'GET' && parts.length === 1) result = await domain.listCredentials();
        else if (req.method === 'POST' && parts.length === 1) ({ status, body: result } = await command('credential.create'));
        else if (req.method === 'POST' && parts[2] === 'rotate') ({ status, body: result } = await command('credential.rotate', { ...body, credential_id: parts[1] }));
        else if (req.method === 'POST' && parts[2] === 'revoke') ({ status, body: result } = await command('credential.revoke', { ...body, credential_id: parts[1] }));
        else if (req.method === 'DELETE' && parts.length === 2) ({ status, body: result } = await command('credential.delete', { ...body, credential_id: parts[1] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'profiles' && parts[1] === 'codex') {
        if (req.method === 'GET' && parts.length === 2) result = await domain.listCodexProfiles();
        else if (req.method === 'POST' && parts.length === 2) ({ status, body: result } = await command('codex_profile.create'));
        else if (req.method === 'PATCH' && parts.length === 3) ({ status, body: result } = await command('codex_profile.update', { ...body, profile_id: parts[2] }));
        else throw new AppError('not_found', 'route not found');
      }
      else if (req.method === 'POST' && parts.length === 1 && parts[0] === 'projects') ({ status, body: result } = await command('project.create'));
      else if (parts[0] === 'projects' && parts.length >= 2) {
        const projectId = parts[1];
        if (req.method === 'GET' && parts.length === 2) result = await domain.getProject(projectId);
        else if (req.method === 'PATCH' && parts.length === 2) ({ status, body: result } = await command('project.update', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'briefs') result = await domain.listBriefs(projectId);
        else if (req.method === 'POST' && parts[2] === 'briefs') ({ status, body: result } = await command('brief.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'workflows') result = await domain.listWorkflows(projectId);
        else if (req.method === 'POST' && parts[2] === 'workflows') ({ status, body: result } = await command('workflow.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'node-contracts') result = await domain.listNodeContracts(projectId, parsed.searchParams.get('workflow_revision'));
        else if (req.method === 'POST' && parts[2] === 'node-contracts') ({ status, body: result } = await command('node_contract.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'workflow-generations') result = await domain.listWorkflowGenerations(projectId);
        else if (req.method === 'POST' && parts[2] === 'workflow-generations') ({ status, body: result } = await command('workflow.generate', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'outcome-requirements') result = await domain.listOutcomeRequirements(projectId, parsed.searchParams.get('workflow_revision'));
        else if (req.method === 'POST' && parts[2] === 'outcome-requirements') ({ status, body: result } = await command('outcome_requirement.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'sources') result = await domain.listContextSources(projectId, parsed.searchParams.get('q') || '');
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'sources') ({ status, body: result } = await command('context.source.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'packs') result = await domain.listContextPacks(projectId);
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'packs') ({ status, body: result } = await command('context.pack.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'map') result = await domain.contextMap(projectId);
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'rebuild') ({ status, body: result } = await command('context.rebuild', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'status') result = await domain.contextProjectionStatus(projectId);
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'read') result = await domain.readContextNode(projectId, parsed.searchParams.get('uri'));
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'selections') ({ status, body: result } = await command('context.selection.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'assets') result = await domain.listAssets(projectId);
        else if (req.method === 'POST' && parts[2] === 'assets') ({ status, body: result } = await command('asset.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'attachments') result = await domain.listAttachments(projectId);
        else if (req.method === 'POST' && parts[2] === 'attachments') ({ status, body: result } = await command('attachment.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'files') result = await domain.readProjectFile(projectId, parsed.searchParams.get('path'));
        else if (req.method === 'POST' && parts[2] === 'change-batches') ({ status, body: result } = await command('change_batch.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'quality-reviews') result = await domain.listQualityReviewRuns(projectId);
        else if (req.method === 'POST' && parts[2] === 'quality-reviews') ({ status, body: result } = await command('quality_review.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'diff') result = await domain.gitDiff(projectId);
        else if (req.method === 'GET' && parts[2] === 'executions') result = await domain.listExecutions(projectId);
        else if (req.method === 'POST' && parts[2] === 'executions') ({ status, body: result } = await command('execution.create', { ...body, project_id: projectId }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'executions' && parts.length >= 2) {
        const executionId = parts[1];
        if (req.method === 'GET' && parts[2] === 'events') return streamEvents(req, res, domain, executionId);
        if (req.method === 'GET' && parts[2] === 'outcome') result = await domain.outcomeView(executionId);
        else if (req.method === 'GET' && parts[2] === 'diff') result = await domain.executionDiff(executionId);
        else if (req.method === 'GET' && parts.length === 2) result = await domain.getExecution(executionId);
        else if (req.method === 'POST' && parts[2] === 'start') ({ status, body: result } = await command('execution.start', { ...body, execution_id: executionId }));
        else if (req.method === 'POST' && parts[2] === 'cancel') ({ status, body: result } = await command('execution.cancel', { ...body, execution_id: executionId }));
        else if (req.method === 'POST' && parts[2] === 'evidence' && parts[3] === 'resolve') ({ status, body: result } = await command('execution.evidence.resolve', { ...body, execution_id: executionId }));
        else if (req.method === 'POST' && parts[2] === 'outcome' && parts[3] === 'evaluate') ({ status, body: result } = await command('outcome.evaluate', { ...body, execution_id: executionId }));
        else if (req.method === 'POST' && parts[2] === 'outcome' && parts[3] === 'waive') ({ status, body: result } = await command('outcome.waive', { ...body, execution_id: executionId }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'reviews') {
        if (req.method === 'GET') result = await domain.listReviews(parsed.searchParams.get('project_id') || null);
        else if (req.method === 'POST' && parts.length === 1) ({ status, body: result } = await command('review.create'));
        else if (req.method === 'POST' && parts[2] === 'decisions') ({ status, body: result } = await command('review.decide', { ...body, review_id: parts[1] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'assets' && req.method === 'GET') {
        const asset = await db.get('SELECT * FROM asset_versions WHERE id=?', [parts[1]]);
        if (!asset) throw new AppError('not_found', 'asset not found');
        if (parts[2] === 'content') return serveAsset(res, asset, config);
        result = asset;
      } else if (parts[0] === 'attachments' && req.method === 'GET') {
        const attachment = await db.get('SELECT * FROM attachments WHERE id=?', [parts[1]]);
        if (!attachment) throw new AppError('not_found', 'attachment not found');
        if (parts[2] === 'content') return serveAsset(res, { ...attachment, cas_hash: attachment.sha256 }, config);
        if (parts[2] === 'preview') return serveAsset(res, { ...attachment, cas_hash: attachment.sha256 }, config, { preview: true });
        const { cas_path: _casPath, ...metadata } = attachment;
        result = metadata;
      } else if (parts[0] === 'deliveries') {
        if (req.method === 'GET') result = await domain.listDeliveries(parsed.searchParams.get('project_id') || null);
        else if (req.method === 'POST' && parts.length === 1) ({ status, body: result } = await command('delivery.create'));
        else if (req.method === 'POST' && parts[2] === 'merge') ({ status, body: result } = await command('delivery.merge', { ...body, delivery_id: parts[1] }));
        else if (req.method === 'POST' && parts[2] === 'retry') ({ status, body: result } = await command('delivery.retry', { ...body, delivery_id: parts[1] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'change-batches' && parts.length >= 2) {
        if (req.method === 'GET' && parts.length === 2) result = await domain.getChangeBatch(parts[1]);
        else if (req.method === 'POST' && parts[2] === 'apply') ({ status, body: result } = await command('change_batch.apply', { ...body, batch_id: parts[1] }));
        else if (req.method === 'POST' && parts[2] === 'rollback') ({ status, body: result } = await command('change_batch.rollback', { ...body, batch_id: parts[1] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'audit' && req.method === 'GET') result = await domain.listAudit(parsed.searchParams.get('limit'));
      else throw new AppError('not_found', 'route not found');
      return send(res, status, result);
    } catch (error) {
      const appError = asAppError(error);
      return send(res, appError.status, errorPayload(appError, requestId));
    }
  }

  return handler;
}

async function streamEvents(req, res, domain, executionId) {
  const initial = Number(req.headers['last-event-id'] || 0);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let cursor = initial;
  let closed = false;
  const pump = async () => {
    if (closed) return;
    try {
      const events = await domain.events(executionId, cursor);
      for (const event of events) {
        cursor = event.cursor;
        res.write(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (!events.length) res.write(': heartbeat\n\n');
    } catch {
      closed = true;
      res.end();
    }
  };
  const timer = setInterval(pump, 500);
  req.on('close', () => { closed = true; clearInterval(timer); });
  await pump();
}

async function streamAssistEvents(req, res, domain, sessionId) {
  const initial = Number(req.headers['last-event-id'] || 0);
  const events = await domain.assistEvents(sessionId, initial);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'close' });
  for (const event of events) res.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function serveWeb(req, res, webRoot, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 404, { error: { code: 'not_found', message: 'route not found', retryable: false } });
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  const candidate = path.resolve(webRoot, relative);
  const root = path.resolve(webRoot);
  const file = candidate.startsWith(`${root}${path.sep}`) ? candidate : path.join(root, 'index.html');
  const fallback = path.join(root, 'index.html');
  const selected = fs.existsSync(file) && fs.statSync(file).isFile() ? file : fallback;
  if (!fs.existsSync(selected)) return send(res, 404, { error: { code: 'not_found', message: 'web bundle not found', retryable: false } });
  const contentType = selected.endsWith('.html') ? 'text/html; charset=utf-8' : selected.endsWith('.js') ? 'text/javascript; charset=utf-8' : selected.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType, 'cache-control': selected.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(selected).pipe(res);
}

const PREVIEWABLE_TYPES = new Set([
  'text/plain', 'text/markdown', 'application/json', 'text/csv', 'application/xml',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'text/html'
]);
const PREVIEW_MAX_BYTES = 1 * 1024 * 1024;

function sanitizeMarkup(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '')
    .replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2')
    .replace(/(href|src|xlink:href)\s*=\s*javascript:[^\s>]+/gi, '$1="#"')
    .replace(/url\(\s*javascript:[^)]+\)/gi, 'none');
}

function serveAsset(res, asset, config, { preview = false } = {}) {
  const file = path.resolve(config.casRoot, asset.cas_hash.slice(0, 2), asset.cas_hash);
  const root = path.resolve(config.casRoot);
  let safe = file.startsWith(`${root}${path.sep}`) && fs.existsSync(file);
  if (safe) {
    try {
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(file);
      safe = !fs.lstatSync(file).isSymbolicLink() && (realFile === realRoot || realFile.startsWith(`${realRoot}${path.sep}`));
    } catch { safe = false; }
  }
  if (!safe) throw new AppError('not_found', 'asset content not found');
  const stat = fs.statSync(file);
  if (stat.size !== Number(asset.byte_size)) throw new AppError('asset_corrupt', 'asset size does not match metadata', { status: 500 });
  if (preview && !PREVIEWABLE_TYPES.has(String(asset.media_type || '').toLowerCase())) {
    throw new AppError('attachment_preview_unsupported', 'attachment preview is not supported for this media type', { status: 415 });
  }
  if (preview && stat.size > PREVIEW_MAX_BYTES) {
    throw new AppError('attachment_preview_too_large', 'attachment preview exceeds the 1 MiB preview limit', { status: 413, details: { limit: PREVIEW_MAX_BYTES } });
  }
  const filename = String(asset.name).replace(/[\r\n"\\/]/g, '_');
  let body = null;
  let contentType = asset.media_type || 'application/octet-stream';
  let entityTag = asset.cas_hash;
  if (preview) {
    body = fs.readFileSync(file);
    const mediaType = String(asset.media_type || '').toLowerCase();
    if (mediaType === 'text/html' || mediaType === 'image/svg+xml') {
      body = Buffer.from(sanitizeMarkup(body.toString('utf8')), 'utf8');
      entityTag = sha256(body);
    } else if (mediaType === 'application/xml') {
      contentType = 'text/plain; charset=utf-8';
    } else if (contentType.startsWith('text/') || mediaType === 'application/json') {
      contentType = `${contentType}; charset=utf-8`;
    }
  }
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(body?.byteLength ?? asset.byte_size),
    'content-disposition': `${preview ? 'inline' : 'attachment'}; filename="${filename}"`,
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    ...(preview ? { 'content-security-policy': "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'" } : {}),
    etag: `"sha256-${entityTag}"`
  });
  if (body) return res.end(body);
  fs.createReadStream(file).pipe(res);
}
