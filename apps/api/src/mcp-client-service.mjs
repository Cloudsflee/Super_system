import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.mjs';
import { addTrace, mutate, readState } from './state.mjs';
import { rememberSecret } from './vault.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { loadMcpGatewaySecret, verifyMcpGatewayRequest } from '../../../packages/mcp-bridge/src/index.mjs';
export const MCP_SCOPES = Object.freeze([
  'system:read',
  'system:write',
  'project:create',
  'project:read',
  'project:write',
  'project:share',
  'workflow:read',
  'workflow:write',
  'assist:read',
  'assist:write',
  'runs:read',
  'runs:write',
  'files:read',
  'files:write',
  'terminal:read',
  'terminal:write',
  'terminal:execute',
  'git:read',
  'git:write',
  'github:read',
  'github:write',
  'assets:read',
  'assets:write',
  'governance:read',
  'governance:write',
  'approval:read',
  'approval:decide',
  'exchange:read',
  'exchange:write',
  'context:read',
  'context:admin',
  'setup:read',
  'setup:admin',
  'mcp:admin',
  'destructive:execute'
]);

export const DEFAULT_OPERATOR_SCOPES = Object.freeze(
  MCP_SCOPES.filter(
    (scope) =>
      ![
        'project:share',
        'approval:decide',
        'context:admin',
        'setup:admin',
        'mcp:admin',
        'destructive:execute',
        'github:write'
      ].includes(scope)
  )
);

export const INTERNAL_CODEX_SCOPES = Object.freeze(
  DEFAULT_OPERATOR_SCOPES.filter((scope) => !['system:write', 'project:create', 'governance:write'].includes(scope))
);

const scopeSet = new Set(MCP_SCOPES);
const requestWindows = new Map();
const activeRequests = new Map();
const gatewayNonces = new Map();
let gatewaySecretCache = { key: null, value: null };
export async function createMcpClient(input = {}, actorId = null, options = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 120) throw new HttpError(400, { error: 'mcp_client_name_invalid' });
  const scopes = normalizeScopes(input.scopes ?? DEFAULT_OPERATOR_SCOPES);
  const projectAllowlist = normalizeProjectAllowlist(input.project_allowlist);
  const expiresAt = normalizeExpiry(input.expires_at, input.ttl_seconds, options);
  const concurrentLimit = boundedInteger(input.concurrent_limit, 4, 1, 32, 'mcp_client_concurrent_limit_invalid');
  const rateLimit = boundedInteger(input.rate_limit_per_minute, 120, 1, 6000, 'mcp_client_rate_limit_invalid');
  const token = makeToken();
  const timestamp = now();
  const client = await mutate((state) => {
    for (const projectId of projectAllowlist)
      if (!state.projects.some((project) => project.id === projectId && !project.deleted_at))
        throw new HttpError(400, { error: 'mcp_client_project_not_found', project_id: projectId });
    const implicitSubject = state.users.some((user) => user.id === actorId) ? actorId : null;
    const subjectUserId = normalizeSubjectUserId(
      input.subject_user_id === undefined ? implicitSubject : input.subject_user_id,
      state
    );
    assertCollaborativeClientPolicy({
      state,
      subjectUserId,
      scopes,
      projectAllowlist,
      input,
      kind: options.kind || 'external'
    });
    const contextBinding = normalizeInternalContextBinding(
      state,
      projectAllowlist,
      subjectUserId,
      options.contextBinding,
      options.kind || 'external'
    );
    const record = {
      id: id('mcp'),
      name,
      kind: options.kind || 'external',
      token_prefix: token.slice(0, 16),
      token_hash: tokenHash(token),
      scopes,
      project_allowlist: projectAllowlist,
      expires_at: expiresAt,
      status: 'active',
      concurrent_limit: concurrentLimit,
      rate_limit_per_minute: rateLimit,
      subject_user_id: subjectUserId,
      context_binding: contextBinding,
      created_by: actorId,
      created_at: timestamp,
      updated_at: timestamp,
      last_used_at: null,
      revoked_at: null,
      revoked_by: null,
      usage_count: 0
    };
    state.mcp_clients.push(record);
    addTrace(
      state,
      'mcp.client.created',
      {
        target_type: 'mcp_client',
        target_id: record.id,
        summary: `MCP client created: ${record.name}`,
        scopes: record.scopes,
        project_allowlist: record.project_allowlist
      },
      actorId
    );
    return record;
  });
  rememberSecret(`mcp-${client.id}`, token);
  return { client: publicMcpClient(client), token };
}

export async function listMcpClients() {
  const state = await readState();
  return state.mcp_clients
    .map(publicMcpClient)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function revokeMcpClient(clientId, actorId = null) {
  const revoked = await mutate((state) => {
    const client = state.mcp_clients.find((item) => item.id === clientId);
    if (!client) throw new HttpError(404, { error: 'mcp_client_not_found' });
    if (client.status !== 'revoked')
      Object.assign(client, { status: 'revoked', revoked_at: now(), revoked_by: actorId, updated_at: now() });
    addTrace(
      state,
      'mcp.client.revoked',
      { target_type: 'mcp_client', target_id: client.id, summary: `MCP client revoked: ${client.name}` },
      actorId
    );
    return client;
  });
  requestWindows.delete(clientId);
  activeRequests.delete(clientId);
  return publicMcpClient(revoked);
}

export async function issueInternalCodexToken(
  projectId,
  { ttlSeconds = 3600, name = 'AIWS built-in Codex', contextBinding = null } = {}
) {
  if (!projectId) throw new HttpError(400, { error: 'mcp_internal_project_required' });
  const state = await readState(),
    project = state.projects.find((item) => item.id === projectId && !item.deleted_at),
    subjectUserId =
      project?.owner_user_id ||
      state.instance_owner_user_id ||
      state.users.find((item) => item.role === 'owner')?.id ||
      null;
  if (!project) throw new HttpError(404, { error: 'mcp_internal_project_not_found', project_id: projectId });
  return createMcpClient(
    {
      name,
      subject_user_id: subjectUserId,
      scopes: INTERNAL_CODEX_SCOPES,
      project_allowlist: [projectId],
      ttl_seconds: Math.min(Math.max(Number(ttlSeconds) || 3600, 60), 21600),
      concurrent_limit: 4,
      rate_limit_per_minute: 600
    },
    subjectUserId,
    { kind: 'internal_codex', maxTtlSeconds: 21600, contextBinding }
  );
}

export async function authenticateMcpToken(rawToken, { requiredScopes = [], projectId = null } = {}) {
  const token = String(rawToken || '');
  if (!token.startsWith('aiws_mcp_') || token.length < 48 || token.length > 256)
    throw new HttpError(401, { error: 'mcp_token_invalid' });
  const digest = Buffer.from(tokenHash(token), 'hex');
  const state = await readState();
  let matched = null;
  for (const candidate of state.mcp_clients) {
    const stored = /^[a-f0-9]{64}$/.test(String(candidate.token_hash || ''))
      ? Buffer.from(candidate.token_hash, 'hex')
      : Buffer.alloc(32);
    const equal = stored.length === digest.length && timingSafeEqual(stored, digest);
    if (equal) matched = candidate;
  }
  if (!matched) throw new HttpError(401, { error: 'mcp_token_invalid' });
  rememberSecret(`mcp-auth-${matched.id}`, token);
  const timestamp = Date.now();
  if (matched.status !== 'active') throw new HttpError(401, { error: 'mcp_client_revoked' });
  if (matched.expires_at && new Date(matched.expires_at).getTime() <= timestamp) {
    await markExpired(matched.id);
    throw new HttpError(401, { error: 'mcp_client_expired' });
  }
  assertScopes(matched, requiredScopes);
  assertProjectAccess(matched, projectId);
  return publicMcpClient(matched);
}

export async function authenticateMcpRequest(req, options = {}) {
  assertMcpPeer(req);
  const authorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, { error: 'mcp_bearer_required' });
  const client = await authenticateMcpToken(match[1], options);
  const release = acquireRequestLease(client);
  req.auth = {
    token: match[1],
    clientId: client.id,
    scopes: client.scopes,
    extra: { project_allowlist: client.project_allowlist, subject_user_id: client.subject_user_id }
  };
  void auditMcpUse(client.id);
  return { client, release };
}

export function assertMcpPeer(req) {
  const address = normalizeAddress(req.socket?.remoteAddress || '');
  if (isLoopbackAddress(address)) return true;
  if (process.env.AIWS_MCP_REMOTE_MODE === 'gateway') {
    if (!isPrivateAddress(address)) throw new HttpError(403, { error: 'mcp_gateway_private_peer_required' });
    let secret;
    try {
      secret = activeGatewaySecret();
    } catch {
      throw new HttpError(503, { error: 'mcp_gateway_secret_invalid' });
    }
    if (!secret) throw new HttpError(503, { error: 'mcp_gateway_secret_required' });
    rememberSecret('mcp-gateway-shared-secret', secret);
    const verified = verifyMcpGatewayRequest({
      secret,
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      headers: req.headers,
      seenNonces: gatewayNonces
    });
    if (!verified.ok) throw new HttpError(403, { error: 'mcp_gateway_signature_required', reason: verified.error });
    return true;
  }
  const managedContainer =
    process.env.AIWS_MCP_ALLOW_MANAGED_CONTAINER !== '0' &&
    (process.env.AIWS_DEPLOYMENT_MODE === 'container' || fs.existsSync('/.dockerenv'));
  if (managedContainer && isPrivateAddress(address)) return true;
  throw new HttpError(403, { error: 'mcp_local_peer_required' });
}

export function assertLocalMcpAdmin(req) {
  const address = normalizeAddress(req.socket?.remoteAddress || '');
  if (isLoopbackAddress(address)) return true;
  const localContainer =
    process.env.AIWS_MCP_REMOTE_MODE !== 'gateway' &&
    (process.env.AIWS_DEPLOYMENT_MODE === 'container' || fs.existsSync('/.dockerenv')) &&
    isPrivateAddress(address);
  if (!localContainer) throw new HttpError(403, { error: 'mcp_local_admin_required' });
  return true;
}

export function assertScopes(client, requiredScopes = []) {
  const granted = new Set(client.scopes || []);
  const missing = [...new Set(requiredScopes)].filter((scope) => !granted.has(scope));
  if (missing.length) throw new HttpError(403, { error: 'mcp_scope_required', required_scopes: missing });
}

export function assertProjectAccess(client, projectId) {
  if (!projectId) return;
  const allowlist = client.project_allowlist || [];
  if (allowlist.length && !allowlist.includes(projectId))
    throw new HttpError(403, { error: 'mcp_project_access_denied', project_id: projectId });
}

export function publicMcpClient(client) {
  return {
    id: client.id,
    name: client.name,
    kind: client.kind || 'external',
    token_prefix: client.token_prefix,
    subject_user_id: client.subject_user_id || null,
    scopes: [...(client.scopes || [])],
    project_allowlist: [...(client.project_allowlist || [])],
    expires_at: client.expires_at,
    status: effectiveStatus(client),
    concurrent_limit: client.concurrent_limit,
    rate_limit_per_minute: client.rate_limit_per_minute,
    created_by: client.created_by,
    created_at: client.created_at,
    updated_at: client.updated_at,
    last_used_at: client.last_used_at,
    revoked_at: client.revoked_at,
    usage_count: Number(client.usage_count || 0)
  };
}

export function normalizeScopes(value) {
  if (!Array.isArray(value) || !value.length) throw new HttpError(400, { error: 'mcp_client_scopes_required' });
  const scopes = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
  const unknown = scopes.filter((scope) => !scopeSet.has(scope));
  if (unknown.length) throw new HttpError(400, { error: 'mcp_client_scope_invalid', scopes: unknown });
  return scopes;
}

function normalizeProjectAllowlist(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, { error: 'mcp_client_project_allowlist_invalid' });
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function normalizeSubjectUserId(value, state) {
  if (value == null || value === '') return null;
  const userId = String(value).trim();
  if (!state.users.some((user) => user.id === userId))
    throw new HttpError(400, { error: 'mcp_client_subject_user_not_found', subject_user_id: userId });
  return userId;
}

function assertCollaborativeClientPolicy({ state, subjectUserId, scopes, projectAllowlist, input, kind }) {
  const subject = state.users.find((user) => user.id === subjectUserId);
  const instanceOwner = state.instance_owner_user_id || state.users.find((user) => user.role === 'owner')?.id;
  if (scopes.includes('project:create') && !subject)
    throw new HttpError(400, { error: 'mcp_client_subject_user_required' });
  if (scopes.includes('project:create') && subjectUserId !== instanceOwner)
    throw new HttpError(403, { error: 'project_create_owner_required' });
  if (process.env.AIWS_MCP_REMOTE_MODE !== 'gateway' || kind !== 'external') return;
  if (!subject) throw new HttpError(400, { error: 'mcp_client_subject_user_required' });
  const role = String(subject.role || 'member');
  const elevated = scopes.some((scope) => ['setup:admin', 'mcp:admin', 'destructive:execute'].includes(scope));
  if (elevated && !['owner', 'leader', 'admin'].includes(role))
    throw new HttpError(403, { error: 'mcp_client_subject_role_forbidden', role });
  if (scopes.includes('approval:decide') && !['owner', 'leader', 'approver'].includes(role))
    throw new HttpError(403, { error: 'mcp_client_approver_role_required', role });
  if (!projectAllowlist.length && !(role === 'owner' && input.allow_all_projects === true))
    throw new HttpError(400, { error: 'mcp_client_project_allowlist_required' });
}

function normalizeInternalContextBinding(state, projectAllowlist, subjectUserId, value, kind) {
  if (value == null) return null;
  const projectId = validateContextBindingEnvelope(projectAllowlist, value, kind),
    runId = cleanBindingId(value.run_id),
    taskExecutionId = cleanBindingId(value.task_execution_id),
    contextSelectionId = cleanBindingId(value.context_selection_id),
    contextPackId = cleanBindingId(value.context_pack_id),
    sessionId = cleanBindingId(value.session_id || runId),
    anchorNodeId = cleanBindingId(value.anchor_node_id);
  if (!runId && !taskExecutionId && !contextSelectionId && !sessionId)
    throw new HttpError(400, { error: 'mcp_context_binding_anchor_required' });
  const run = validateContextBindingRun(state, projectId, runId, taskExecutionId),
    execution = validateContextBindingExecution(state, projectId, taskExecutionId, run, runId),
    selection = validateContextBindingSelection(state, projectId, subjectUserId, contextSelectionId, execution);
  validateContextBindingPack(state, projectId, contextPackId, run);
  const tokenBudget = Number(selection?.token_budget || value.token_budget || 4000);
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 200_000)
    throw new HttpError(400, { error: 'mcp_context_binding_token_budget_invalid' });
  return {
    schema_version: 'aiws.mcp_context_binding.v1',
    project_id: projectId,
    run_id: runId,
    task_execution_id: taskExecutionId,
    context_selection_id: contextSelectionId,
    context_pack_id: contextPackId,
    session_id: sessionId,
    anchor_node_id: anchorNodeId || selection?.anchor_node_id || null,
    token_budget: tokenBudget
  };
}

function validateContextBindingEnvelope(projectAllowlist, value, kind) {
  if (kind !== 'internal_codex') throw new HttpError(400, { error: 'mcp_context_binding_internal_only' });
  if (typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, { error: 'mcp_context_binding_invalid' });
  const projectId = cleanBindingId(value.project_id || projectAllowlist[0]);
  if (!projectId || projectAllowlist.length !== 1 || projectAllowlist[0] !== projectId)
    throw new HttpError(400, { error: 'mcp_context_binding_project_invalid' });
  return projectId;
}

function validateContextBindingRun(state, projectId, runId, taskExecutionId) {
  const run = runId ? state.node_runs.find((item) => item.id === runId) : null;
  if (runId && (!run || run.project_id !== projectId))
    throw new HttpError(400, { error: 'mcp_context_binding_run_invalid', run_id: runId });
  if (run?.task_execution_id && run.task_execution_id !== taskExecutionId)
    throw new HttpError(400, { error: 'mcp_context_binding_execution_mismatch', run_id: runId });
  return run;
}

function validateContextBindingExecution(state, projectId, taskExecutionId, run, runId) {
  const execution = taskExecutionId
    ? state.task_executions.find((item) => item.id === taskExecutionId && item.project_id === projectId)
    : null;
  if (taskExecutionId && !execution)
    throw new HttpError(400, {
      error: 'mcp_context_binding_execution_invalid',
      task_execution_id: taskExecutionId
    });
  if (execution && run && execution.id !== run.task_execution_id)
    throw new HttpError(400, { error: 'mcp_context_binding_execution_mismatch', run_id: runId });
  return execution;
}

function validateContextBindingSelection(state, projectId, subjectUserId, contextSelectionId, execution) {
  const selection = contextSelectionId
    ? state.context_selections.find((item) => item.id === contextSelectionId && item.project_id === projectId)
    : null;
  if (contextSelectionId && (!selection || selection.actor_id !== subjectUserId))
    throw new HttpError(400, {
      error: 'mcp_context_binding_selection_invalid',
      context_selection_id: contextSelectionId
    });
  const expectedSelectionId = execution?.context_snapshot?.system_context?.context_selection_id || null;
  if (expectedSelectionId && contextSelectionId !== expectedSelectionId)
    throw new HttpError(400, {
      error: 'mcp_context_binding_selection_mismatch',
      context_selection_id: contextSelectionId,
      expected_context_selection_id: expectedSelectionId
    });
  return selection;
}

function validateContextBindingPack(state, projectId, contextPackId, run) {
  const contextPack = contextPackId ? state.context_packs.find((item) => item.id === contextPackId) : null;
  if (contextPackId && !contextPack)
    throw new HttpError(400, { error: 'mcp_context_binding_context_pack_invalid', context_pack_id: contextPackId });
  const contextPackProjectId =
    contextPack?.content_json?.project?.id ||
    state.workspaces.find((item) => item.id === contextPack?.source_workspace_id)?.project_id ||
    null;
  if (contextPackProjectId && contextPackProjectId !== projectId)
    throw new HttpError(400, { error: 'mcp_context_binding_context_pack_invalid', context_pack_id: contextPackId });
  if (run?.context_pack_id && contextPackId !== run.context_pack_id)
    throw new HttpError(400, {
      error: 'mcp_context_binding_context_pack_mismatch',
      context_pack_id: contextPackId,
      expected_context_pack_id: run.context_pack_id
    });
}

function cleanBindingId(value) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 240) : null;
}

function normalizeExpiry(expiresAt, ttlSeconds, options) {
  const current = Date.now();
  if (ttlSeconds != null) {
    const ttl = Number(ttlSeconds);
    if (!Number.isFinite(ttl) || ttl < 60 || ttl > Number(options.maxTtlSeconds || 31_536_000))
      throw new HttpError(400, { error: 'mcp_client_ttl_invalid' });
    return new Date(current + ttl * 1000).toISOString();
  }
  if (expiresAt == null || expiresAt === '') return null;
  const parsed = new Date(expiresAt).getTime();
  if (!Number.isFinite(parsed) || parsed <= current || parsed > current + 366 * 24 * 60 * 60 * 1000)
    throw new HttpError(400, { error: 'mcp_client_expiry_invalid' });
  return new Date(parsed).toISOString();
}

function makeToken() {
  return `aiws_mcp_${randomBytes(9).toString('base64url')}_${randomBytes(32).toString('base64url')}`;
}
function tokenHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
function boundedInteger(value, fallback, min, max, code) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new HttpError(400, { error: code });
  return result;
}
function effectiveStatus(client) {
  return client.status === 'active' && client.expires_at && new Date(client.expires_at).getTime() <= Date.now()
    ? 'expired'
    : client.status;
}

function acquireRequestLease(client) {
  const current = Date.now(),
    windowStart = current - 60_000;
  const recent = (requestWindows.get(client.id) || []).filter((value) => value > windowStart);
  if (recent.length >= client.rate_limit_per_minute)
    throw new HttpError(429, {
      error: 'mcp_rate_limit_exceeded',
      retry_after_ms: Math.max(1, recent[0] + 60_000 - current)
    });
  const active = Number(activeRequests.get(client.id) || 0);
  if (active >= client.concurrent_limit)
    throw new HttpError(429, { error: 'mcp_concurrency_limit_exceeded', retry_after_ms: 250 });
  recent.push(current);
  requestWindows.set(client.id, recent);
  activeRequests.set(client.id, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(0, Number(activeRequests.get(client.id) || 1) - 1);
    if (next) activeRequests.set(client.id, next);
    else activeRequests.delete(client.id);
  };
}

async function auditMcpUse(clientId) {
  await mutate((state) => {
    const client = state.mcp_clients.find((item) => item.id === clientId);
    if (!client || client.status !== 'active') return;
    client.last_used_at = now();
    client.updated_at = client.last_used_at;
    client.usage_count = Number(client.usage_count || 0) + 1;
  }).catch(() => undefined);
}

async function markExpired(clientId) {
  await mutate((state) => {
    const client = state.mcp_clients.find((item) => item.id === clientId);
    if (client?.status === 'active') Object.assign(client, { status: 'expired', updated_at: now() });
  });
}

function normalizeAddress(value) {
  return String(value || '')
    .replace(/^::ffff:/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
}
function isLoopbackAddress(value) {
  return value === '::1' || value === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(value);
}
function isPrivateAddress(value) {
  return (
    /^10\./.test(value) ||
    /^192\.168\./.test(value) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(value) ||
    /^f[cd][0-9a-f]{2}:/i.test(value)
  );
}
function activeGatewaySecret() {
  const inline = String(process.env.AIWS_MCP_GATEWAY_SECRET || '').trim();
  const file = String(process.env.AIWS_MCP_GATEWAY_SECRET_FILE || '').trim();
  const stat = !inline && file ? fs.statSync(file) : null;
  const key = inline
    ? `env:${createHash('sha256').update(inline).digest('hex')}`
    : file
      ? `file:${file}:${stat.mtimeMs}:${stat.size}`
      : 'none';
  if (gatewaySecretCache.key === key) return gatewaySecretCache.value;
  const value = loadMcpGatewaySecret();
  gatewaySecretCache = { key, value };
  return value;
}
