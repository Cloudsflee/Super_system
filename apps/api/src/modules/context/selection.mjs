import { hashJson } from '../../crypto.mjs';

export const SELECTION_SCHEMA = 'aiws.context_selection.v2';

export function normalizePolicy(input = {}) {
  const pinned = unique(input.pinned_node_ids ?? input.pinned ?? []);
  const excluded = unique(input.excluded_node_ids ?? input.excluded ?? []);
  const overlap = pinned.filter((id) => excluded.includes(id));
  if (overlap.length) {
    const error = new Error('context_policy_conflict');
    error.code = 'context_policy_conflict';
    error.details = { node_ids: overlap };
    throw error;
  }
  return {
    pinned_node_ids: pinned.sort(),
    excluded_node_ids: excluded.sort(),
    allowed_project_ids: input.allowed_project_ids == null ? null : unique(input.allowed_project_ids).sort(),
    required_scopes: input.required_scopes == null ? null : unique(input.required_scopes).sort(),
    sensitivity_max: input.sensitivity_max || 'restricted',
    freshness: input.freshness || 'current'
  };
}

export function createSelection({ id, projectId, actor = 'local-user', nodes = [], versions = [], policy = {}, policyRevision = 0, query = '', explicitNodeIds = [], anchorNodeId = null, tokenBudget = 4000, retrievalPlan = {}, mandatoryNodeIds = [], timestamp = new Date().toISOString() } = {}) {
  const normalizedPolicy = normalizePolicy(policy);
  const versionById = new Map(versions.map((version) => [String(version.id), version]));
  const explicit = new Set(explicitNodeIds.map(String));
  const mandatory = new Set(mandatoryNodeIds.map(String));
  const pinned = new Set(normalizedPolicy.pinned_node_ids);
  const excludedByPolicy = new Set(normalizedPolicy.excluded_node_ids);
  const allNodes = nodes.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
  // Access, scope, sensitivity and freshness are evaluated before ranking so a
  // denied document cannot displace an eligible document in a bounded pack.
  const preExcluded = [];
  const eligible = [];
  for (const node of allNodes) {
    const version = versionById.get(String(node.current_document_version_id)) || null;
    const tokens = Number(version?.token_estimate || estimateTokens(version?.content || ''));
    const reason = exclusionReason(node, version, { projectId, normalizedPolicy });
    if (reason) preExcluded.push({ node, version, tokens, reason });
    else eligible.push(node);
  }
  const searchRank = rankByQuery(eligible, query);
  const candidates = eligible.slice().sort((left, right) => {
    const l = String(left.id), r = String(right.id);
    return Number(pinned.has(r)) - Number(pinned.has(l)) || (searchRank.get(l) ?? Number.MAX_SAFE_INTEGER) - (searchRank.get(r) ?? Number.MAX_SAFE_INTEGER) || typeOrder(left.kind) - typeOrder(right.kind) || l.localeCompare(r);
  });
  const included = [], excluded = preExcluded
    .sort((left, right) => typeOrder(left.node.kind) - typeOrder(right.node.kind) || String(left.node.id).localeCompare(String(right.node.id)))
    .map(({ node, version, tokens, reason }) => ({ node_id: node.id, document_version_id: version?.id || null, token_estimate: tokens, reason }));
  let tokenUsed = 0;
  for (const node of candidates) {
    const version = versionById.get(String(node.current_document_version_id)) || null;
    const tokens = Number(version?.token_estimate || estimateTokens(version?.content || ''));
    if (!version) {
      excluded.push({ node_id: node.id, document_version_id: null, token_estimate: tokens, reason: 'stale' });
      continue;
    }
    if (tokenUsed + tokens > Number(tokenBudget)) {
      excluded.push({ node_id: node.id, document_version_id: version?.id || null, token_estimate: tokens, reason: 'budget_exceeded' });
      continue;
    }
    tokenUsed += tokens;
    included.push({ node_id: node.id, document_version_id: version.id, content_sha256: version.content_hash, token_estimate: tokens, reason: pinned.has(String(node.id)) ? 'user_pinned' : explicit.has(String(node.id)) ? 'explicit_reference' : node.id === anchorNodeId ? 'current_anchor' : 'search_rank' });
  }
  const selection = {
    id, schema_version: SELECTION_SCHEMA, actor, project_id: String(projectId), anchor_node_id: anchorNodeId || null,
    candidate_node_ids: allNodes.map((node) => node.id), included, excluded,
    token_budget: Number(tokenBudget), token_used: tokenUsed, policy_revision: Number(policyRevision),
    retrieval_plan: { ...retrievalPlan, strategy: retrievalPlan.strategy || 'minisearch_deterministic', query: query || null, anchor_node_id: anchorNodeId || null, token_budget: Number(tokenBudget) },
    mandatory_evidence: { required_node_ids: [...mandatory].sort(), covered_node_ids: included.filter((item) => mandatory.has(item.node_id)).map((item) => item.node_id).sort() },
    created_at: timestamp, immutable: true
  };
  selection.mandatory_evidence.missing_node_ids = selection.mandatory_evidence.required_node_ids.filter((nodeId) => !selection.mandatory_evidence.covered_node_ids.includes(nodeId));
  selection.selection_hash = hashJson(selection);
  return selection;
}

function exclusionReason(node, version, { projectId, normalizedPolicy }) {
  if (normalizedPolicy.allowed_project_ids && !normalizedPolicy.allowed_project_ids.includes(String(node.project_id))) return 'permission_denied';
  if (normalizedPolicy.required_scopes && (node.required_scopes || []).some((scope) => !normalizedPolicy.required_scopes.includes(String(scope)))) return 'permission_denied';
  if (projectId && String(node.project_id) !== String(projectId)) return 'cross_scope';
  if (node.sensitivity === 'secret') return 'sensitive';
  if (normalizedPolicy.sensitivity_max === 'normal' && !['normal', ''].includes(node.sensitivity)) return 'sensitive';
  if (!version || node.status === 'tombstone') return 'stale';
  if (normalizedPolicy.freshness === 'current' && node.freshness?.status && node.freshness.status !== 'current') return 'stale';
  if (normalizedPolicy.excluded_node_ids.includes(String(node.id))) return 'user_excluded';
  return null;
}

function rankByQuery(nodes, query) {
  const text = String(query || '').trim().toLowerCase();
  return new Map(nodes.map((node) => {
    const haystack = `${node.title || ''} ${node.uri || ''} ${node.kind || ''}`.toLowerCase();
    const score = text ? (haystack.includes(text) ? 0 : haystack.split(/\s+/).reduce((count, part) => count + (part.startsWith(text) ? 1 : 0), 0) ? 1 : 2) : 1;
    return [String(node.id), score];
  }));
}

function typeOrder(kind) {
  return ({ project: 10, brief: 20, repository: 30, workflow: 40, node_contract: 50, note: 60, file: 70, diff: 80, test_report: 90 }[kind] || 100);
}
function estimateTokens(content) { return Math.ceil(String(content || '').length / 4); }
function unique(values) { return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]; }
