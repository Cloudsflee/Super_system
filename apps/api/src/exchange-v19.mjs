import { HttpError } from './http.mjs';
import { assertProjectRead, assertProjectWrite, hashSnapshot, membershipFor } from './project-governance-v19.mjs';
import { estimateTokens, id, now } from '../../../packages/shared/index.mjs';
import { redactKnownSecretsSync } from './vault.mjs';

export const EXCHANGE_SCOPE_LEVELS = Object.freeze(['project', 'workflow', 'workstream', 'task']);
export const EXCHANGE_ITEM_TYPES = Object.freeze([
  'asset',
  'asset_version',
  'workspace_digest',
  'decision_record',
  'evidence_summary'
]);
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function ensureExchangeDefaults(state) {
  if (!Array.isArray(state.exchange_requests)) state.exchange_requests = [];
  if (!Array.isArray(state.exchange_grants)) state.exchange_grants = [];
  if (!Array.isArray(state.context_packs)) state.context_packs = [];
  return state;
}

/** Mark expired requests/grants in the durable state before rejecting a use. */
export function expireExchangeRequestInState(state, requestId, { at = Date.now() } = {}) {
  const request = state.exchange_requests?.find((item) => item.id === requestId);
  if (!request || ['expired', 'revoked'].includes(request.status)) return false;
  if (new Date(request.expires_at).getTime() > Number(at)) return false;
  const timestamp = new Date(Number(at)).toISOString();
  Object.assign(request, { status: 'expired', expired_at: request.expired_at || timestamp, updated_at: timestamp });
  for (const grant of state.exchange_grants?.filter(
    (item) => item.exchange_request_id === request.id && item.status === 'active'
  ) || [])
    Object.assign(grant, { status: 'expired', expired_at: grant.expired_at || timestamp, updated_at: timestamp });
  return true;
}

export function expireExchangeRequestsInState(state, options = {}) {
  let changed = false;
  for (const request of state.exchange_requests || [])
    changed = expireExchangeRequestInState(state, request.id, options) || changed;
  return changed;
}

export function createExchangeRequestInState(state, input, actorId, options = {}) {
  ensureExchangeDefaults(state);
  const sourceProjectId = String(input.source_project_id || ''),
    targetProjectId = String(input.target_project_id || '');
  if (!sourceProjectId || !targetProjectId || sourceProjectId === targetProjectId)
    throw new HttpError(400, { error: 'exchange_projects_invalid' });
  assertProjectRead(state, sourceProjectId, actorId);
  if (!state.projects.some((item) => item.id === targetProjectId && !item.deleted_at))
    throw new HttpError(404, { error: 'project_not_found' });
  const rootScope = normalizeRootScope(
    state,
    sourceProjectId,
    input.root_scope || { type: input.scope_type || 'project', id: input.scope_id || sourceProjectId }
  );
  const allowedDepth = normalizeDepth(input.allowed_depth, rootScope.type);
  const tokenBudget = normalizeTokenBudget(input.token_budget);
  const operationKey =
    String(input.operation_key || '')
      .trim()
      .slice(0, 128) || null;
  if (operationKey) {
    const foreign = state.exchange_requests.find(
      (item) => item.operation_key === operationKey && item.requester_user_id !== actorId
    );
    if (foreign) throw new HttpError(409, { error: 'idempotency_key_actor_mismatch' });
    const prior = state.exchange_requests.find(
      (item) =>
        item.operation_key === operationKey &&
        item.requester_user_id === actorId &&
        item.source_project_id === sourceProjectId &&
        item.target_project_id === targetProjectId
    );
    if (prior)
      return {
        request: prior,
        grant: state.exchange_grants.find((item) => item.exchange_request_id === prior.id) || null,
        idempotent: true
      };
  }
  const items = normalizeExchangeItems(
    state,
    sourceProjectId,
    rootScope,
    allowedDepth,
    input.items || refsFromInput(input)
  );
  if (!items.length) throw new HttpError(400, { error: 'exchange_items_required' });
  const snapshot = buildExchangeSnapshot(state, { sourceProjectId, rootScope, allowedDepth, items });
  const estimatedTokens = estimateTokens(JSON.stringify(snapshot));
  if (estimatedTokens > tokenBudget)
    throw new HttpError(413, {
      error: 'exchange_token_budget_exceeded',
      token_budget: tokenBudget,
      estimated_tokens: estimatedTokens
    });
  const expiresAt = normalizeExpiry(input.expires_at, options.clock?.() || Date.now());
  const request = {
    id: id('exr'),
    source_project_id: sourceProjectId,
    target_project_id: targetProjectId,
    requester_user_id: actorId,
    root_scope: rootScope,
    allowed_depth: allowedDepth,
    items,
    snapshot,
    snapshot_hash: hashSnapshot(snapshot),
    snapshot_version: 1,
    token_budget: tokenBudget,
    estimated_tokens: estimatedTokens,
    source_approval: null,
    target_approval: null,
    status: 'pending_approval',
    revision: 1,
    operation_key: operationKey,
    expires_at: expiresAt,
    revoked_at: null,
    revoked_by_user_id: null,
    created_at: now(),
    updated_at: now()
  };
  state.exchange_requests.push(request);
  return { request, grant: null, idempotent: false };
}

export function approveExchangeRequestInState(state, requestId, input, actorId) {
  const request = requireExchangeRequest(state, requestId);
  assertExchangeMutable(request, input.expected_revision);
  const side = approvalSide(state, request, actorId, input.side);
  const approvalKey = `${side}_approval`;
  if (request[approvalKey]) {
    if (
      request[approvalKey].revision === request.revision &&
      request[approvalKey].snapshot_hash === request.snapshot_hash &&
      request[approvalKey].approved_by_user_id === actorId
    )
      return { request, grant: activeGrantFor(state, request.id), idempotent: true };
    throw new HttpError(409, { error: 'exchange_approval_already_recorded', side });
  }
  request[approvalKey] = {
    side,
    approved_by_user_id: actorId,
    revision: request.revision,
    snapshot_hash: request.snapshot_hash,
    approved_at: now()
  };
  request.updated_at = now();
  let grant = null;
  if (request.source_approval && request.target_approval) {
    request.status = 'approved';
    grant = createExchangeGrantInState(state, request);
  }
  return { request, grant, idempotent: false };
}

export function createExchangeGrantInState(state, request) {
  const existing = activeGrantFor(state, request.id);
  if (existing) return existing;
  const grant = {
    id: id('exg'),
    exchange_request_id: request.id,
    source_project_id: request.source_project_id,
    target_project_id: request.target_project_id,
    requester_user_id: request.requester_user_id,
    request_revision: request.revision,
    snapshot_hash: request.snapshot_hash,
    root_scope: structuredClone(request.root_scope),
    allowed_depth: request.allowed_depth,
    item_refs: request.items.map(({ type, id: itemId, version_id }) => ({
      type,
      id: itemId,
      ...(version_id ? { version_id } : {})
    })),
    token_budget: request.token_budget,
    status: 'active',
    expires_at: request.expires_at,
    revoked_at: null,
    revoked_by_user_id: null,
    created_at: now(),
    updated_at: now()
  };
  state.exchange_grants.push(grant);
  request.grant_id = grant.id;
  request.updated_at = now();
  return grant;
}

export function revokeExchangeInState(state, requestId, actorId, reason = '') {
  const request = requireExchangeRequest(state, requestId);
  if (expireExchangeRequestInState(state, request.id) || request.status === 'expired')
    throw new HttpError(410, { error: 'exchange_request_expired' });
  const sourceRole = membershipFor(state, request.source_project_id, actorId)?.role;
  const targetRole = membershipFor(state, request.target_project_id, actorId)?.role;
  if (sourceRole !== 'owner' && targetRole !== 'owner')
    throw new HttpError(403, { error: 'exchange_owner_approval_required' });
  if (!request.revoked_at)
    Object.assign(request, {
      status: 'revoked',
      revoked_at: now(),
      revoked_by_user_id: actorId,
      revoke_reason: String(reason || '').slice(0, 500),
      updated_at: now()
    });
  for (const grant of state.exchange_grants.filter(
    (item) => item.exchange_request_id === request.id && item.status === 'active'
  ))
    Object.assign(grant, {
      status: 'revoked',
      revoked_at: request.revoked_at,
      revoked_by_user_id: actorId,
      updated_at: now()
    });
  return { request, grants: state.exchange_grants.filter((item) => item.exchange_request_id === request.id) };
}

export function assertExchangeGrantActive(state, grantId, actorId = null) {
  const grant = state.exchange_grants.find((item) => item.id === grantId);
  if (!grant) throw new HttpError(404, { error: 'exchange_grant_not_found' });
  const request = requireExchangeRequest(state, grant.exchange_request_id);
  if (expireExchangeRequestInState(state, request.id) || grant.status === 'expired' || request.status === 'expired')
    throw new HttpError(410, { error: 'exchange_grant_expired' });
  if (
    grant.status !== 'active' ||
    request.status !== 'approved' ||
    grant.snapshot_hash !== request.snapshot_hash ||
    grant.request_revision !== request.revision
  )
    throw new HttpError(409, { error: 'exchange_grant_inactive' });
  if (actorId) assertProjectWrite(state, grant.target_project_id, actorId);
  return { grant, request };
}

export function createExchangeContextPackInState(state, grantId, actorId, input = {}) {
  const { grant, request } = assertExchangeGrantActive(state, grantId, actorId);
  const targetProject = state.projects.find((item) => item.id === grant.target_project_id && !item.deleted_at);
  if (!targetProject) throw new HttpError(404, { error: 'project_not_found' });
  const targetScope = normalizeTargetScope(
    state,
    targetProject.id,
    input.target_scope || { type: 'project', id: targetProject.id }
  );
  const content = {
    schema_version: 'aiws.context_pack.exchange.v1',
    project: {
      id: targetProject.id,
      title: cleanText(targetProject.title, 300),
      goal: cleanText(targetProject.goal, 2000)
    },
    precedence: 'target_local_first',
    target_scope: targetScope,
    external_context: {
      source_project: { id: request.source_project_id, title: request.snapshot.source_project.title },
      exchange_request_id: request.id,
      exchange_grant_id: grant.id,
      snapshot_hash: request.snapshot_hash,
      root_scope: structuredClone(request.root_scope),
      allowed_depth: request.allowed_depth,
      scope_path: structuredClone(request.snapshot.scope_path),
      items: structuredClone(request.snapshot.items),
      label: 'External Context Pack'
    },
    policy: {
      local_context_precedence: true,
      sibling_context_included: false,
      raw_sessions_included: false,
      absolute_paths_included: false
    },
    generated_at: now()
  };
  const serialized = JSON.stringify(content),
    estimatedTokens = estimateTokens(serialized);
  if (estimatedTokens > grant.token_budget)
    throw new HttpError(413, {
      error: 'exchange_token_budget_exceeded',
      token_budget: grant.token_budget,
      estimated_tokens: estimatedTokens
    });
  assertExchangePayloadSafe(content);
  const pack = {
    id: id('ctx'),
    source_workspace_id: targetScope.workspace_id || targetProject.current_workspace_id,
    purpose: 'cross_project_exchange',
    version: 1,
    status: 'confirmed',
    content_json: content,
    memory_manifest: {
      authority: 'exchange_grant',
      grant_id: grant.id,
      snapshot_hash: grant.snapshot_hash,
      target_local_precedence: true
    },
    token_estimate: estimatedTokens,
    content_file_ref_id: null,
    markdown_file_ref_id: null,
    confirmed_by_user_id: actorId,
    created_by_user_id: actorId,
    created_at: now(),
    updated_at: now()
  };
  state.context_packs.push(pack);
  grant.last_injected_at = now();
  grant.last_context_pack_id = pack.id;
  grant.updated_at = now();
  return pack;
}

export function buildExchangeSnapshot(state, { sourceProjectId, rootScope, allowedDepth, items }) {
  const project = state.projects.find((item) => item.id === sourceProjectId);
  const scopePath = scopePathFor(state, sourceProjectId, rootScope);
  return {
    source_project: { id: project.id, title: cleanText(project.title, 300), goal: cleanText(project.goal, 2000) },
    root_scope: structuredClone(rootScope),
    allowed_depth: allowedDepth,
    scope_path: scopePath,
    items: items.map((item) => snapshotItem(state, item)),
    captured_at: now()
  };
}

export function assertExchangePayloadSafe(value) {
  const serialized = JSON.stringify(value);
  const forbiddenKeys =
    /"(?:absolute_path|managed_path|repo_path|workspace_root|raw_session|raw_chat|full_trace|chat_messages|session_transcript)"\s*:/i;
  if (
    forbiddenKeys.test(serialized) ||
    /[A-Za-z]:\\[^"\n]+/.test(serialized) ||
    /"\/(?:Users|home|var|tmp|opt|workspace)\//i.test(serialized)
  )
    throw new HttpError(400, { error: 'exchange_payload_unsafe' });
  return true;
}

function normalizeExchangeItems(state, projectId, rootScope, allowedDepth, values) {
  if (!Array.isArray(values) || values.length > 100) throw new HttpError(400, { error: 'exchange_items_invalid' });
  const seen = new Set(),
    result = [];
  for (const raw of values) {
    const type = normalizeItemType(raw.type || raw.kind),
      itemId = String(raw.id || raw.asset_id || raw.digest_id || raw.decision_id || '');
    if (type === 'evidence_summary') {
      const summary = cleanText(raw.summary, 4000);
      if (!summary) throw new HttpError(400, { error: 'exchange_evidence_summary_required' });
      rejectPathLike(summary);
      result.push({ type, id: raw.id || id('evs'), summary, evidence_refs: sanitizeEvidenceRefs(raw.evidence_refs) });
      continue;
    }
    const source = sourceItem(state, type, itemId, raw.version_id);
    if (!source || projectForSource(state, type, source) !== projectId)
      throw new HttpError(404, { error: 'exchange_item_not_found', type, id: itemId });
    assertConfirmedSource(type, source, state);
    const scopedSource = type === 'asset_version' ? state.assets.find((item) => item.id === source.asset_id) : source;
    assertItemWithinScope(state, projectId, scopedSource, rootScope, allowedDepth);
    const key = `${type}:${itemId}:${raw.version_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type, id: itemId, ...(raw.version_id ? { version_id: String(raw.version_id) } : {}) });
  }
  return result;
}

function snapshotItem(state, item) {
  if (item.type === 'evidence_summary')
    return { type: item.type, id: item.id, summary: item.summary, evidence_refs: item.evidence_refs };
  const source = sourceItem(state, item.type, item.id, item.version_id);
  if (item.type === 'asset' || item.type === 'asset_version') {
    const asset = item.type === 'asset' ? source : state.assets.find((candidate) => candidate.id === source.asset_id),
      version =
        item.type === 'asset_version'
          ? source
          : state.asset_versions.find((candidate) => candidate.id === asset.current_version_id);
    return {
      type: item.type,
      id: item.id,
      asset_id: asset.id,
      version_id: version?.id || null,
      version: version?.version || null,
      asset_type: asset.asset_type,
      title: cleanText(version?.title || asset.title, 300),
      summary: cleanText(version?.summary || asset.summary, 4000),
      body: cleanText(version?.body || version?.summary || asset.summary, 12000),
      evidence_refs: sanitizeEvidenceRefs(version?.evidence_refs || asset.evidence_refs),
      scope: itemScope(state, asset)
    };
  }
  if (item.type === 'workspace_digest')
    return {
      type: item.type,
      id: source.id,
      version: source.version,
      title: `Workspace Digest v${source.version}`,
      summary: cleanText(source.summary, 4000),
      body: cleanText(source.body, 12000),
      evidence_refs: sanitizeEvidenceRefs(source.evidence_refs),
      scope: itemScope(state, source)
    };
  return {
    type: item.type,
    id: source.id,
    title: cleanText(source.title, 300),
    summary: cleanText(source.summary, 4000),
    rationale: cleanText(source.rationale, 8000),
    evidence_refs: sanitizeEvidenceRefs(source.evidence_refs),
    scope: itemScope(state, source)
  };
}

function normalizeRootScope(state, projectId, raw) {
  const type = String(raw.type || '').toLowerCase(),
    scopeId = String(raw.id || '');
  if (!EXCHANGE_SCOPE_LEVELS.includes(type)) throw new HttpError(400, { error: 'exchange_scope_type_invalid' });
  if (!scopeBelongsToProject(state, projectId, type, scopeId))
    throw new HttpError(404, { error: 'exchange_scope_not_found' });
  return { type, id: scopeId };
}
function normalizeTargetScope(state, projectId, raw) {
  const scope = normalizeRootScope(state, projectId, raw);
  const workspaceId =
    scope.type === 'project'
      ? state.projects.find((item) => item.id === projectId)?.current_workspace_id
      : scope.type === 'workflow'
        ? state.workflows.find((item) => item.id === scope.id)?.workspace_id
        : state.workflow_nodes.find((item) => item.id === scope.id)?.workspace_id;
  return { ...scope, workspace_id: workspaceId || null };
}
function normalizeDepth(value, rootType) {
  const remaining = 3 - EXCHANGE_SCOPE_LEVELS.indexOf(rootType),
    depth = value == null ? 0 : Number(value);
  if (!Number.isInteger(depth) || depth < 0 || depth > remaining)
    throw new HttpError(400, { error: 'exchange_allowed_depth_invalid', max_depth: remaining });
  return depth;
}
function normalizeTokenBudget(value) {
  const budget = value == null ? 12000 : Number(value);
  if (!Number.isInteger(budget) || budget < 128 || budget > 100000)
    throw new HttpError(400, { error: 'exchange_token_budget_invalid' });
  return budget;
}
function normalizeExpiry(value, current) {
  if (value == null) return new Date(current + DEFAULT_EXPIRY_MS).toISOString();
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed) || parsed <= current || parsed > current + 30 * DEFAULT_EXPIRY_MS)
    throw new HttpError(400, { error: 'exchange_expiry_invalid' });
  return new Date(parsed).toISOString();
}
function normalizeItemType(value) {
  const aliases = { digest: 'workspace_digest', decision: 'decision_record', evidence: 'evidence_summary' };
  const type = aliases[String(value || '').toLowerCase()] || String(value || '').toLowerCase();
  if (!EXCHANGE_ITEM_TYPES.includes(type)) throw new HttpError(400, { error: 'exchange_item_type_invalid', type });
  return type;
}
function sourceItem(state, type, itemId, versionId) {
  if (type === 'asset') return state.assets.find((item) => item.id === itemId);
  if (type === 'asset_version') return state.asset_versions.find((item) => item.id === (versionId || itemId));
  if (type === 'workspace_digest') return state.digests.find((item) => item.id === itemId);
  if (type === 'decision_record') return state.decisions.find((item) => item.id === itemId);
  return null;
}
function projectForSource(state, type, source) {
  if (type !== 'asset_version') return source.project_id;
  return state.assets.find((item) => item.id === source.asset_id)?.project_id || null;
}
function assertConfirmedSource(type, source, state) {
  if (type === 'asset' && source.status !== 'confirmed')
    throw new HttpError(409, { error: 'exchange_asset_not_confirmed' });
  if (type === 'asset_version') {
    const asset = state.assets.find((item) => item.id === source.asset_id);
    if (!source.confirmed_by_user_id || asset?.status !== 'confirmed')
      throw new HttpError(409, { error: 'exchange_asset_version_not_confirmed' });
  }
  if (type === 'workspace_digest' && source.status !== 'confirmed')
    throw new HttpError(409, { error: 'exchange_digest_not_confirmed' });
  if (type === 'decision_record' && !['accepted', 'confirmed'].includes(source.status))
    throw new HttpError(409, { error: 'exchange_decision_not_confirmed' });
}
function scopeBelongsToProject(state, projectId, type, scopeId) {
  if (type === 'project') return scopeId === projectId && state.projects.some((item) => item.id === projectId);
  if (type === 'workflow') return state.workflows.some((item) => item.id === scopeId && item.project_id === projectId);
  const node = state.workflow_nodes.find((item) => item.id === scopeId && item.role === type);
  return Boolean(node && state.workflows.some((item) => item.id === node.workflow_id && item.project_id === projectId));
}
function scopePathFor(state, projectId, scope) {
  const project = state.projects.find((item) => item.id === projectId),
    path = [{ type: 'project', id: project.id, title: cleanText(project.title, 300) }];
  if (scope.type === 'project') return path;
  const workflow =
    scope.type === 'workflow'
      ? state.workflows.find((item) => item.id === scope.id)
      : state.workflows.find(
          (item) => item.id === state.workflow_nodes.find((node) => node.id === scope.id)?.workflow_id
        );
  if (workflow) path.push({ type: 'workflow', id: workflow.id, title: cleanText(workflow.title, 300) });
  if (['workstream', 'task'].includes(scope.type)) {
    const node = state.workflow_nodes.find((item) => item.id === scope.id);
    const parent = node?.role === 'task' ? state.workflow_nodes.find((item) => item.id === node.parent_node_id) : node;
    if (parent) path.push({ type: 'workstream', id: parent.id, title: cleanText(parent.title, 300) });
    if (node?.role === 'task') path.push({ type: 'task', id: node.id, title: cleanText(node.title, 300) });
  }
  return path;
}
function itemScope(state, source) {
  if (source.node_id) {
    const node = state.workflow_nodes.find((item) => item.id === source.node_id);
    return node ? { type: node.role, id: node.id } : { type: 'project', id: source.project_id };
  }
  if (source.workspace_id) {
    const workspace = state.workspaces.find((item) => item.id === source.workspace_id),
      node = state.workflow_nodes.find((item) => item.id === workspace?.workflow_node_id);
    return node ? { type: node.role, id: node.id } : { type: 'project', id: source.project_id };
  }
  return { type: 'project', id: source.project_id };
}
function assertItemWithinScope(state, projectId, source, root, allowedDepth) {
  const scope = itemScope(state, source);
  if (root.type === 'project') {
    if (EXCHANGE_SCOPE_LEVELS.indexOf(scope.type) > allowedDepth)
      throw new HttpError(403, { error: 'exchange_item_outside_scope' });
    return;
  }
  if (root.type === 'workflow') {
    const workflowId =
      scope.type === 'workflow' ? scope.id : state.workflow_nodes.find((item) => item.id === scope.id)?.workflow_id;
    if (workflowId !== root.id || EXCHANGE_SCOPE_LEVELS.indexOf(scope.type) - 1 > allowedDepth)
      throw new HttpError(403, { error: 'exchange_item_outside_scope' });
    return;
  }
  if (root.type === 'workstream') {
    const node = state.workflow_nodes.find((item) => item.id === scope.id);
    const under = scope.id === root.id || node?.parent_node_id === root.id;
    if (!under || EXCHANGE_SCOPE_LEVELS.indexOf(scope.type) - 2 > allowedDepth)
      throw new HttpError(403, { error: 'exchange_item_outside_scope' });
    return;
  }
  if (scope.type !== 'task' || scope.id !== root.id) throw new HttpError(403, { error: 'exchange_item_outside_scope' });
}
function approvalSide(state, request, actorId, requested) {
  const source = membershipFor(state, request.source_project_id, actorId)?.role === 'owner',
    target = membershipFor(state, request.target_project_id, actorId)?.role === 'owner';
  const side = requested
    ? String(requested).toLowerCase()
    : source && !target
      ? 'source'
      : target && !source
        ? 'target'
        : null;
  if (!['source', 'target'].includes(side) || (side === 'source' && !source) || (side === 'target' && !target))
    throw new HttpError(403, { error: 'exchange_owner_approval_required', side: requested || null });
  return side;
}
function assertExchangeMutable(request, expectedRevision) {
  if (new Date(request.expires_at).getTime() <= Date.now()) {
    request.status = 'expired';
    throw new HttpError(410, { error: 'exchange_request_expired' });
  }
  if (request.revoked_at || request.status === 'revoked')
    throw new HttpError(409, { error: 'exchange_request_revoked' });
  if (expectedRevision != null && Number(expectedRevision) !== request.revision)
    throw new HttpError(409, {
      error: 'exchange_revision_conflict',
      expected_revision: Number(expectedRevision),
      current_revision: request.revision
    });
}
function requireExchangeRequest(state, idValue) {
  const request = state.exchange_requests.find((item) => item.id === idValue);
  if (!request) throw new HttpError(404, { error: 'exchange_request_not_found' });
  return request;
}
function activeGrantFor(state, requestId) {
  return (
    state.exchange_grants.find((item) => item.exchange_request_id === requestId && item.status === 'active') || null
  );
}
function sanitizeEvidenceRefs(values) {
  return (Array.isArray(values) ? values : [])
    .slice(0, 100)
    .map((value) => cleanText(value, 500))
    .filter((value) => value && !pathLike(value));
}
function cleanText(value, max) {
  const text = redactKnownSecretsSync(String(value || ''))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, max);
  rejectPathLike(text);
  return text;
}
function rejectPathLike(value) {
  if (pathLike(value)) throw new HttpError(400, { error: 'exchange_absolute_path_forbidden' });
}
function pathLike(value) {
  return /(?:^|[\s"'`(\[{:=])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/)|\.{1,2}[\\/]|~[\\/])/i.test(String(value || ''));
}
function refsFromInput(input) {
  return [
    ...(input.asset_ids || []).map((idValue) => ({ type: 'asset', id: idValue })),
    ...(input.asset_version_ids || []).map((idValue) => ({ type: 'asset_version', id: idValue })),
    ...(input.digest_ids || []).map((idValue) => ({ type: 'workspace_digest', id: idValue })),
    ...(input.decision_ids || []).map((idValue) => ({ type: 'decision_record', id: idValue })),
    ...(input.evidence_summaries || []).map((summary) => ({ type: 'evidence_summary', summary }))
  ];
}

export const createExchangeRequest = createExchangeRequestInState;
export const approveExchangeRequest = approveExchangeRequestInState;
export const revokeExchangeGrantInState = revokeExchangeInState;
export const buildContextPackFromExchange = createExchangeContextPackInState;
export const expireExchangeInState = expireExchangeRequestInState;
export const expireExchangesInState = expireExchangeRequestsInState;
