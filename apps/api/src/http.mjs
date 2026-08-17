import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashJson, now, parseJson, sha256 } from './crypto.mjs';
import { AppError, asAppError } from './errors.mjs';
import { readBody, readMultipartUpload, readRawBody } from './http-body.mjs';
import { createMcpHandler } from './modules/mcp/http.mjs';
import { MCP_PUBLIC_TOOL_SNAPSHOT } from './modules/mcp/public-tools.mjs';
const MUTATING = new Set(['POST', 'PATCH', 'DELETE']);
function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function pathParts(urlPath) {
  return urlPath.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
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
function responseForCommand(result, domain) {
  return domain.redact(result ?? {});
}
function persistableCommandResponse(command, result, domain) {
  const clean = responseForCommand(result, domain);
  if (command !== 'session.create' || !clean || typeof clean !== 'object' || Array.isArray(clean)) return clean;
  const { token: _token, ...persistable } = clean;
  return { ...persistable, token_issued: false };
}
export function createHttpHandler({ domain, registry, db, config, performanceProbe = () => ({}), webRoot }) {
  async function executeCommand(command, body, req, requestPath, explicitKey = null, responseStatus = 201) {
    const key = explicitKey || req.headers['idempotency-key'];
    if (!key || String(key).length > 200) throw new AppError('idempotency_required', 'Idempotency-Key header is required');
    const scope = `${req.method}:${requestPath}`;
    const requestHash = hashJson({ command, body: commandHashBody(command, body) });
    const existing = await db.get('SELECT * FROM idempotency_keys WHERE scope=? AND key=?', [scope, String(key)]);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new AppError('idempotency_conflict', 'Idempotency-Key was used with a different request', { details: { scope } });
      if (existing.response_json) return { status: Number(existing.response_status) || 200, body: JSON.parse(existing.response_json), replayed: true };
      throw new AppError('idempotency_in_progress', 'an identical command is already in progress', { retryable: true, status: 409 });
    }
    try {
      await db.run('INSERT INTO idempotency_keys(scope,key,request_hash,created_at) VALUES(?,?,?,?)', [scope, String(key), requestHash, now()]);
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
      const retry = await db.get('SELECT * FROM idempotency_keys WHERE scope=? AND key=?', [scope, String(key)]);
      if (retry?.response_json) return { status: Number(retry.response_status) || 200, body: JSON.parse(retry.response_json), replayed: true };
      throw new AppError('idempotency_in_progress', 'an identical command is already in progress', { retryable: true, status: 409 });
    }
    try {
      const result = await registry.execute(command, body, req.aiwsAuth);
      const responseBody = responseForCommand(result, domain);
      const persisted = persistableCommandResponse(command, responseBody, domain);
      await db.run('UPDATE idempotency_keys SET response_status=?,response_json=? WHERE scope=? AND key=?', [responseStatus, JSON.stringify(persisted), scope, String(key)]);
      return { status: responseStatus, body: responseBody };
    } catch (error) {
      await db.run('DELETE FROM idempotency_keys WHERE scope=? AND key=?', [scope, String(key)]).catch(() => undefined);
      throw error;
    }
  }
  const mcp = createMcpHandler({ domain, registry, config, executeCommand });
  async function handler(req, res) {
    const requestId = String(req.headers['x-request-id'] || randomUUID());
    const parsed = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const urlPath = parsed.pathname;
    try {
      if (urlPath === '/livez') throw new AppError('not_found', 'route not found');
      if (req.method === 'GET' && urlPath === '/health') return send(res, 200, { status: 'alive', request_id: requestId });
      if (req.method === 'GET' && urlPath === '/readyz') {
        const health = await domain.health();
        const ready = health.sqlite.integrity?.every((item) => item === 'ok') && health.sqlite.user_version === health.sqlite.migration_version && health.broker.status === 'available' && health.broker.runner_digest === config.runnerDigest;
        return send(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks: health, request_id: requestId });
      }
      if (!urlPath.startsWith(config.apiPrefix)) return serveWeb(req, res, webRoot, urlPath);
      req.aiwsAuth = await domain.authenticate(req.headers.authorization);
      if (urlPath === `${config.apiPrefix}/integrations/github/webhook` && req.method === 'POST') {
        const rawBody = await readRawBody(req);
        const receipt = await domain.githubWebhook(rawBody, req.headers);
        return send(res, 200, domain.redact(receipt));
      }
      if (urlPath === `${config.apiPrefix}/mcp` && req.method === 'POST') {
        const payload = await mcp(req, requestId);
        const headers = payload.__mcp_headers || {};
        return send(res, 200, payload, headers);
      }
      if (urlPath === `${config.apiPrefix}/mcp` && req.method === 'GET') {
        res.writeHead(405, { allow: 'POST, OPTIONS', 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(errorPayload(new AppError('invalid_input', 'MCP stream requires a POST JSON-RPC request', { status: 405 }), requestId)));
      }
      if (urlPath === `${config.apiPrefix}/mcp` && req.method === 'OPTIONS') {
        res.writeHead(204, { allow: 'POST, GET, OPTIONS', 'mcp-protocol-version': '2025-06-18' });
        return res.end();
      }
      if (urlPath === `${config.apiPrefix}/mcp/tools` && req.method === 'GET') {
        const authorization = req.headers['x-aiws-mcp-token'] ? await domain.authorizeMcpToken(req.headers['x-aiws-mcp-token'], '') : { client: null };
        const allow = authorization.client?.scope && Object.prototype.hasOwnProperty.call(authorization.client.scope, 'tools') ? authorization.client.scope.tools : null;
        const names = MCP_PUBLIC_TOOL_SNAPSHOT.filter((name) => !Array.isArray(allow) || allow.includes(name));
        return send(res, 200, { tools: names.sort().map((name) => ({ name, description: `AIWS command ${name}`, input_schema: { type: 'object' } })) });
      }
      if (urlPath === `${config.apiPrefix}/system/capabilities` && req.method === 'GET') return send(res, 200, await domain.capabilities());
      if (urlPath === `${config.apiPrefix}/system/performance` && req.method === 'GET') return send(res, 200, performanceProbe());
      if (urlPath === `${config.apiPrefix}/system` && req.method === 'GET') return send(res, 200, { version: config.version, api_prefix: config.apiPrefix, data_volume: config.dataVolume });

      const parts = pathParts(urlPath.slice(config.apiPrefix.length));
      const multipartUpload = req.method === 'POST' && parts[0] === 'intakes' && parts[2] === 'upload';
      const body = MUTATING.has(req.method) && !multipartUpload ? await readBody(req) : {};
      let result;
      let status = 200;
      const command = (name, input = body, explicitKey = null, responseStatus = 201) => executeCommand(name, input, req, urlPath, explicitKey, responseStatus);
      const r2Route = domain.r2?.routes.match(req.method, parts);
      if (r2Route) {
        const routeBody = r2Route.multipart
          ? await readMultipartUpload(req, config.projectUploadLimits, config.home)
          : body;
        const input = { ...Object.fromEntries(parsed.searchParams), ...routeBody, ...r2Route.params };
        if (r2Route.stream && String(req.headers.accept || '').includes('text/event-stream')) {
          return streamQueryEvents(req, res, domain, r2Route.query, input);
        }
        if (r2Route.query) result = await domain.r2.queries.execute(r2Route.query, input, req.aiwsAuth);
        else {
          try {
            const commandResult = await executeCommand(r2Route.command, input, req, urlPath, null, r2Route.responseStatus);
            ({ status, body: result } = commandResult);
            if (r2Route.multipart && commandResult.replayed) cleanupMultipartStaging(routeBody);
          } catch (error) {
            if (r2Route.multipart) cleanupMultipartStaging(routeBody);
            throw error;
          }
        }
        return send(res, status, domain.redact(result));
      }

      if (parts[0] === 'assist' && parts[1] === 'sessions') {
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
      } else if (parts[0] === 'mcp' && parts[1] === 'scopes') {
        if (req.method === 'GET' && parts.length === 2) result = await domain.listMcpScopes(parsed.searchParams.get('project_id') || null);
        else if (req.method === 'POST' && parts[2] === 'requests' && parts.length === 3) ({ status, body: result } = await command('mcp_scope.request'));
        else if (req.method === 'POST' && parts[2] === 'requests' && parts[4] === 'grant') ({ status, body: result } = await command('mcp_scope.grant', { ...body, request_id: parts[3] }));
        else if (req.method === 'POST' && parts[2] === 'grants' && parts[4] === 'revoke') ({ status, body: result } = await command('mcp_scope.revoke', { ...body, grant_id: parts[3] }));
        else throw new AppError('not_found', 'route not found');
      }
      else if (parts[0] === 'terminals') {
        if (req.method === 'GET' && parts.length === 1) result = await domain.listTerminalSessions(parsed.searchParams.get('project_id') || null);
        else if (req.method === 'POST' && parts.length === 1) ({ status, body: result } = await command('terminal.create'));
        else if (req.method === 'GET' && parts[1] === 'capabilities' && parts.length === 2) result = domain.terminalCapabilities();
        else if (req.method === 'GET' && parts.length === 2) result = await domain.getTerminalSession(parts[1]);
        else if (req.method === 'GET' && parts[2] === 'events') {
          if (String(req.headers.accept || '').includes('text/event-stream')) return streamTerminalEvents(req, res, domain, parts[1], parsed.searchParams.get('after'));
          result = await domain.terminalEvents(parts[1], parsed.searchParams.get('after'));
        }
        else if (req.method === 'POST' && ['input', 'resize', 'signal', 'stop'].includes(parts[2])) ({ status, body: result } = await command(`terminal.${parts[2]}`, { ...body, terminal_id: parts[1] }));
        else throw new AppError('not_found', 'route not found');
      }
      else if (parts[0] === 'projects' && parts.length >= 2) {
        const projectId = parts[1];
        if (req.method === 'GET' && parts[2] === 'workflow-draft' && parts[3] === 'layouts') result = await domain.listWorkflowLayouts(projectId, parsed.searchParams.get('draft_id'));
        else if (req.method === 'POST' && parts[2] === 'workflow-draft' && parts[3] === 'layouts') ({ status, body: result } = await command('workflow.layout.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'workflow-draft') result = await domain.getWorkflowDraft(projectId);
        else if (req.method === 'PATCH' && parts[2] === 'workflow-draft') ({ status, body: result } = await command('workflow.draft.update', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'workflows') result = await domain.listWorkflows(projectId);
        else if (req.method === 'POST' && parts[2] === 'workflows') ({ status, body: result } = await command('workflow.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'node-contracts') result = await domain.listNodeContracts(projectId, parsed.searchParams.get('workflow_revision'));
        else if (req.method === 'POST' && parts[2] === 'node-contracts') ({ status, body: result } = await command('node_contract.create', { ...body, project_id: projectId }));
        else if (req.method === 'PATCH' && parts[2] === 'node-contracts' && parts[3]) ({ status, body: result } = await command('node_contract.update', { ...body, project_id: projectId, contract_id: parts[3] }, null, 200));
        else if (req.method === 'GET' && parts[2] === 'workflow-generations') result = await domain.listWorkflowGenerations(projectId);
        else if (req.method === 'POST' && parts[2] === 'workflow-generations' && parts[3] === 'replan') ({ status, body: result } = await command('workflow.replan', { ...body, project_id: projectId }, null, 202));
        else if (req.method === 'POST' && parts[2] === 'workflow-generations') ({ status, body: result } = await command('workflow.generate', { ...body, project_id: projectId }, null, (body?.provider || body?.async) ? 202 : 201));
        else if (req.method === 'GET' && parts[2] === 'outcome-requirements') result = await domain.listOutcomeRequirements(projectId, parsed.searchParams.get('workflow_revision'));
        else if (req.method === 'POST' && parts[2] === 'outcome-requirements') ({ status, body: result } = await command('outcome_requirement.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'sources') result = await domain.listContextSources(projectId, parsed.searchParams.get('q') || '');
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'sources') ({ status, body: result } = await command('context.source.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'packs' && parts[4]) result = await domain.contextPack(projectId, parts[4]);
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'packs') result = await domain.listContextPacks(projectId);
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'packs') ({ status, body: result } = await command('context.pack.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'map') result = await domain.contextMap(projectId);
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'search') result = await domain.contextSearch(projectId, parsed.searchParams.get('q') || parsed.searchParams.get('query') || '', { limit: parsed.searchParams.get('limit') });
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'rebuild') ({ status, body: result } = await command('context.rebuild', { ...body, project_id: projectId }, null, body?.async ? 202 : 201));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'status') result = await domain.contextProjectionStatus(projectId);
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'read') result = await domain.readContextNode(projectId, parsed.searchParams.get('uri'), { versionId: parsed.searchParams.get('version_id') });
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'policy' && parts[4] === 'history') result = await domain.contextPolicyHistory(projectId);
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'policy') result = await domain.contextPolicy(projectId);
        else if (req.method === 'PATCH' && parts[2] === 'context' && parts[3] === 'policy') ({ status, body: result } = await command('context.policy.update', { ...body, project_id: projectId }, null, 200));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'selections') result = await domain.listContextSelections(projectId);
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'selections') ({ status, body: result } = await command('context.selection.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'nodes' && parts[4] && parts[5] === 'versions') result = await domain.contextNodeVersions(projectId, parts[4]);
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'nodes' && parts[4]) result = await domain.contextNode(projectId, parts[4], { versionId: parsed.searchParams.get('version_id') });
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'jobs' && parts[4] && parts[5] === 'events') {
          if (String(req.headers.accept || '').includes('text/event-stream')) return streamContextProjectionEvents(req, res, domain, projectId, parts[4], parsed.searchParams.get('after'));
          result = await domain.contextProjectionEvents(projectId, parts[4], parsed.searchParams.get('after'));
        }
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'jobs' && parts[4] && parts.length === 5) result = await domain.contextProjectionJob(projectId, parts[4]);
        else if (req.method === 'GET' && parts[2] === 'context' && parts[3] === 'jobs') result = await domain.contextProjectionJobs(projectId);
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'jobs' && parts[4] && parts[5] === 'cancel') ({ status, body: result } = await command('context.projection.cancel', { ...body, project_id: projectId, job_id: parts[4] }, null, 202));
        else if (req.method === 'POST' && parts[2] === 'context' && parts[3] === 'jobs' && parts[4] && parts[5] === 'retry') ({ status, body: result } = await command('context.projection.retry', { ...body, project_id: projectId, job_id: parts[4] }, null, 202));
        else if (req.method === 'GET' && parts[2] === 'assets') result = await domain.listAssets(projectId);
        else if (req.method === 'POST' && parts[2] === 'assets') ({ status, body: result } = await command('asset.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'attachments') result = await domain.listAttachments(projectId);
        else if (req.method === 'POST' && parts[2] === 'attachments') ({ status, body: result } = await command('attachment.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'files') result = await domain.readProjectFile(projectId, parsed.searchParams.get('path'));
        else if (req.method === 'POST' && parts[2] === 'change-batches') ({ status, body: result } = await command('change_batch.create', { ...body, project_id: projectId }));
        else if (req.method === 'POST' && parts[2] === 'approvals') ({ status, body: result } = await command('runtime_approval.create', { ...body, project_id: projectId }));
        else if (req.method === 'POST' && parts[2] === 'ui-action-intents') ({ status, body: result } = await command('ui_action_intent.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'quality-reviews') result = await domain.listQualityReviewRuns(projectId);
        else if (req.method === 'POST' && parts[2] === 'quality-reviews') ({ status, body: result } = await command('quality_review.create', { ...body, project_id: projectId }));
        else if (req.method === 'GET' && parts[2] === 'diff') result = await domain.gitDiff(projectId);
        else if (req.method === 'GET' && parts[2] === 'executions') result = await domain.listExecutions(projectId);
        else if (req.method === 'POST' && parts[2] === 'executions') ({ status, body: result } = await command('execution.create', { ...body, project_id: projectId }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'workflow-generations' && parts[1]) {
        const generationId = parts[1];
        if (req.method === 'GET' && parts.length === 2) result = await domain.getWorkflowGeneration(generationId);
        else if (req.method === 'GET' && parts[2] === 'events') {
          if (String(req.headers.accept || '').includes('text/event-stream')) return streamWorkflowGenerationEvents(req, res, domain, generationId, parsed.searchParams.get('after'));
          result = await domain.workflowGenerationEvents(generationId, parsed.searchParams.get('after'));
        }
        else if (req.method === 'POST' && parts[2] === 'cancel') {
          const generation = await domain.getWorkflowGeneration(generationId);
          ({ status, body: result } = await command('workflow.generation.cancel', { ...body, operation_id: generation.operation_id }, null, 202));
        }
        else if (req.method === 'POST' && parts[2] === 'retry') ({ status, body: result } = await command('workflow.generation.retry', { ...body, generation_id: generationId }, null, 202));
        else if (req.method === 'POST' && parts[2] === 'apply') {
          const generation = await domain.getWorkflowGeneration(generationId);
          if (!generation.proposal?.id) throw new AppError('workflow_proposal_missing', 'generation has no pending proposal', { status: 409 });
          ({ status, body: result } = await command('workflow.proposal.apply', { ...body, async: true, proposal_id: generation.proposal.id }, null, 202));
        }
        else if (req.method === 'POST' && parts[2] === 'replan') {
          const generation = await domain.getWorkflowGeneration(generationId);
          ({ status, body: result } = await command('workflow.replan', { ...body, generation_id: generationId, project_id: generation.project_id }, null, 202));
        }
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'workflow-proposals' && parts[1]) {
        const proposalId = parts[1];
        if (req.method === 'GET' && parts.length === 2) result = await domain.getWorkflowProposal(proposalId);
        else if (req.method === 'POST' && parts[2] === 'apply') {
          const proposal = await domain.getWorkflowProposal(proposalId);
          if (!['pending', 'applied'].includes(proposal.status)) throw new AppError('workflow_proposal_stale', 'workflow proposal is no longer pending', { status: 409 });
          ({ status, body: result } = await command('workflow.proposal.apply', { ...body, async: true, proposal_id: proposalId }, null, 202));
        }
        else if (req.method === 'POST' && parts[2] === 'reject') ({ status, body: result } = await command('workflow.proposal.reject', { ...body, proposal_id: proposalId }));
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
        else if (req.method === 'POST' && parts[2] === 'user-inputs') ({ status, body: result } = await command('runtime_user_input.create', { ...body, execution_id: executionId }));
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
      } else if (parts[0] === 'approvals') {
        if (req.method === 'GET' && parts.length === 1) result = await domain.listRuntimeApprovals(parsed.searchParams.get('project_id') || null);
        else if (req.method === 'POST' && parts[2] === 'decision') ({ status, body: result } = await command('runtime_approval.decide', { ...body, approval_id: parts[1] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'user-inputs') {
        if (req.method === 'GET' && parts.length === 1) result = await domain.listRuntimeUserInputs(parsed.searchParams.get('execution_id') || null);
        else if (req.method === 'POST' && parts[2] === 'answer') ({ status, body: result } = await command('runtime_user_input.resolve', { ...body, input_id: parts[1], action: 'answer' }));
        else if (req.method === 'POST' && parts[2] === 'cancel') ({ status, body: result } = await command('runtime_user_input.resolve', { ...body, input_id: parts[1], action: 'cancel' }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'ui-action-intents') {
        if (req.method === 'GET' && parts.length === 1) result = await domain.listUiActionIntents(parsed.searchParams.get('project_id') || null);
        else if (req.method === 'POST' && parts[2] === 'resolve') ({ status, body: result } = await command('ui_action_intent.resolve', { ...body, intent_id: parts[1] }));
        else throw new AppError('not_found', 'route not found');
      } else if (parts[0] === 'audit' && req.method === 'GET') result = await domain.listAudit(parsed.searchParams.get('limit'));
      else throw new AppError('not_found', 'route not found');
      return send(res, status, domain.redact(result));
    } catch (error) {
      const appError = asAppError(error);
      return send(res, appError.status, domain.redact(errorPayload(appError, requestId)));
    }
  }

  return handler;
}

function commandHashBody(command, body) {
  if (command !== 'intake.upload') return body;
  return {
    intake_id: body.intake_id,
    fields: body.fields || {},
    files: (body.files || []).map((file) => ({ field: file.field, path: file.path, byte_size: file.byte_size, sha256: file.sha256 }))
  };
}

function cleanupMultipartStaging(upload) {
  const root = String(upload?.staging_root || '');
  if (root) fs.rmSync(root, { recursive: true, force: true });
}

async function streamQueryEvents(req, res, domain, query, input) {
  const initial = Number(req.headers['last-event-id'] || input.after || 0);
  const events = await domain.r2.queries.execute(query, { ...input, after: initial }, req.aiwsAuth);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'close' });
  for (const event of events) {
    const clean = domain.redact(event);
    res.write(`id: ${clean.cursor}\nevent: ${clean.type}\ndata: ${JSON.stringify(clean)}\n\n`);
  }
  res.end();
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

async function streamWorkflowGenerationEvents(req, res, domain, generationId, queryCursor = null) {
  const initial = Number(req.headers['last-event-id'] || queryCursor || 0);
  const events = await domain.workflowGenerationEvents(generationId, initial);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'close' });
  for (const event of events) {
    const clean = domain.redact(event);
    res.write(`id: ${clean.cursor}\nevent: ${clean.type}\ndata: ${JSON.stringify(clean)}\n\n`);
  }
  res.end();
}

async function streamAssistEvents(req, res, domain, sessionId) {
  const initial = Number(req.headers['last-event-id'] || 0);
  const events = await domain.assistEvents(sessionId, initial);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'close' });
  for (const event of events) res.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

async function streamContextProjectionEvents(req, res, domain, projectId, jobId, queryCursor = null) {
  const initial = Number(req.headers['last-event-id'] || queryCursor || 0);
  const events = await domain.contextProjectionEvents(projectId, jobId, initial);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'close' });
  for (const event of events) {
    const clean = domain.redact(event);
    res.write(`id: ${clean.cursor}\nevent: ${clean.type}\ndata: ${JSON.stringify(clean)}\n\n`);
  }
  res.end();
}

async function streamTerminalEvents(req, res, domain, sessionId, queryCursor = null) {
  const initial = Number(req.headers['last-event-id'] || queryCursor || 0);
  const events = await domain.terminalEvents(sessionId, initial);
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
