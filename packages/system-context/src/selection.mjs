import {
  CONTEXT_INTERNAL_COLLECTIONS,
  CONTEXT_SELECTION_SCHEMA,
  compareContextNodes,
  contextError,
  contextHash
} from './protocol.mjs';
import { compareSelectionCandidates, isExplicitNode, normalizeCandidateRanks } from './selection-ranking.mjs';

const SELECTION_DEFAULTS = Object.freeze({
  sessionId: null,
  projectId: null,
  anchorNodeId: null,
  candidateNodeIds: [],
  tokenBudget: 4000,
  scopes: null,
  allowedProjectIds: null,
  explicitRefs: [],
  candidateRanks: null,
  alreadyBudgetedDocumentVersionIds: [],
  retrievalPlan: null,
  rubricHash: null,
  outcomeContractHash: null,
  mandatoryEvidenceNodeIds: [],
  schemaVersion: CONTEXT_SELECTION_SCHEMA,
  timestamp: null
});

export function createContextSelection(state, options) {
  const {
    id,
    actorId,
    sessionId,
    projectId,
    anchorNodeId,
    candidateNodeIds,
    tokenBudget,
    scopes,
    allowedProjectIds,
    explicitRefs,
    candidateRanks,
    alreadyBudgetedDocumentVersionIds,
    retrievalPlan,
    rubricHash,
    outcomeContractHash,
    mandatoryEvidenceNodeIds,
    schemaVersion,
    timestamp
  } = normalizeSelectionOptions(options);
  ensureContextCollections(state);
  const scope = selectionScope(state, {
    actorId,
    sessionId,
    projectId,
    anchorNodeId,
    scopes,
    allowedProjectIds,
    explicitRefs,
    candidateRanks,
    alreadyBudgetedDocumentVersionIds,
    mandatoryEvidenceNodeIds
  });
  const candidates = rankedSelectionCandidates(state, candidateNodeIds, scope);
  const selected = selectContextCandidates(candidates, scope, Number(tokenBudget));
  return buildContextSelection({
    id,
    actorId,
    sessionId,
    projectId,
    anchorNodeId,
    tokenBudget,
    retrievalPlan,
    rubricHash,
    outcomeContractHash,
    mandatoryEvidenceNodeIds,
    schemaVersion,
    timestamp,
    candidates,
    selected,
    scope,
    state
  });
}

function normalizeSelectionOptions(options) {
  const normalized = { ...SELECTION_DEFAULTS };
  for (const [key, value] of Object.entries(options || {})) if (value !== undefined) normalized[key] = value;
  if (!normalized.timestamp) normalized.timestamp = new Date().toISOString();
  return normalized;
}

export function upsertContextPolicy(
  state,
  { id, actorId, sessionId = null, projectId = null, pinnedNodeIds = [], excludedNodeIds = [], timestamp }
) {
  ensureContextCollections(state);
  const overlap = pinnedNodeIds.filter((nodeId) => excludedNodeIds.includes(nodeId));
  if (overlap.length) throw contextError('context_policy_conflict', { node_ids: overlap });
  const known = new Set(state.context_nodes.map((node) => node.id));
  const unknown = [...pinnedNodeIds, ...excludedNodeIds].filter((nodeId) => !known.has(nodeId));
  if (unknown.length) throw contextError('context_policy_node_missing', { node_ids: [...new Set(unknown)] });
  const existing = findContextPolicy(state, { actorId, sessionId, projectId });
  const next = {
    id: existing?.id || id,
    actor_id: actorId,
    session_id: sessionId,
    project_id: projectId,
    pinned_node_ids: [...new Set(pinnedNodeIds)].sort(),
    excluded_node_ids: [...new Set(excludedNodeIds)].sort(),
    revision: Number(existing?.revision || 0) + 1,
    created_at: existing?.created_at || timestamp,
    updated_at: timestamp
  };
  if (existing) Object.assign(existing, next);
  else state.context_policies.push(next);
  return next;
}

export function findContextPolicy(state, { actorId, sessionId = null, projectId = null }) {
  return (
    state.context_policies?.find(
      (item) =>
        item.actor_id === actorId &&
        (item.session_id || null) === (sessionId || null) &&
        (item.project_id || null) === (projectId || null)
    ) || null
  );
}

function selectionScope(state, options) {
  const policy = findContextPolicy(state, options);
  return {
    projectId: options.projectId,
    anchorNodeId: options.anchorNodeId,
    pinned: new Set(policy?.pinned_node_ids || []),
    mandatory: new Set(options.mandatoryEvidenceNodeIds),
    excludedByUser: new Set(policy?.excluded_node_ids || []),
    explicit: new Set(options.explicitRefs),
    scopeSet: options.scopes ? new Set(options.scopes) : null,
    allowedProjects: options.allowedProjectIds ? new Set(options.allowedProjectIds) : null,
    alreadyBudgeted: new Set(options.alreadyBudgetedDocumentVersionIds),
    rankByNode: normalizeCandidateRanks(options.candidateRanks),
    nodeById: new Map(state.context_nodes.map((node) => [node.id, node])),
    versionById: new Map(state.context_document_versions.map((version) => [version.id, version])),
    edges: state.context_edges
  };
}

function rankedSelectionCandidates(state, candidateNodeIds, scope) {
  return [...new Set([...scope.mandatory, ...scope.pinned, ...candidateNodeIds])]
    .map((nodeId) => scope.nodeById.get(nodeId))
    .filter(Boolean)
    .sort((left, right) =>
      compareSelectionCandidates(left, right, {
        mandatory: scope.mandatory,
        pinned: scope.pinned,
        explicit: scope.explicit,
        projectId: scope.projectId,
        anchorNodeId: scope.anchorNodeId,
        rankByNode: scope.rankByNode,
        nodeById: scope.nodeById,
        edges: state.context_edges
      })
    );
}

function selectContextCandidates(candidates, scope, tokenBudget) {
  const included = [];
  const excluded = [];
  let used = 0;
  for (const node of candidates) {
    const version = scope.versionById.get(node.current_version_id);
    const reason = exclusionReason(node, version, scope);
    const tokens = Number(version?.token_estimate || 0);
    const chargedTokens = scope.alreadyBudgeted.has(version?.id) ? 0 : tokens;
    if (reason) excluded.push(selectionExclusion(node, version, reason));
    else if (used + chargedTokens > tokenBudget) excluded.push(selectionExclusion(node, version, 'budget_exceeded'));
    else {
      used += chargedTokens;
      included.push(selectionInclusion(node, version, tokens, scope));
    }
  }
  return { included, excluded, used };
}

function selectionInclusion(node, version, tokens, scope) {
  return {
    node_id: node.id,
    document_version_id: version.id,
    content_sha256: version.content_sha256,
    token_estimate: tokens,
    reason: selectionReason(node, scope)
  };
}

function selectionReason(node, scope) {
  if (scope.pinned.has(node.id)) return 'user_pinned';
  if (isExplicitNode(node, scope.explicit)) return 'explicit_reference';
  return node.id === scope.anchorNodeId ? 'current_anchor' : 'ranked_candidate';
}

function buildContextSelection(options) {
  const { selected, candidates, scope } = options;
  return {
    id: options.id,
    schema_version: options.schemaVersion,
    actor_id: options.actorId,
    session_id: options.sessionId,
    project_id: options.projectId,
    anchor_node_id: options.anchorNodeId,
    candidate_node_ids: candidates.map((node) => node.id),
    included: selected.included,
    excluded: selected.excluded,
    token_budget: Number(options.tokenBudget),
    token_used: selected.used,
    map_snapshot_hash: contextMapSnapshotHash(options.state, options.projectId),
    retrieval_plan: options.retrievalPlan || defaultRetrievalPlan(scope.explicit, options.anchorNodeId),
    rubric_hash: options.rubricHash,
    outcome_contract_hash: options.outcomeContractHash,
    mandatory_evidence: mandatoryEvidenceSnapshot(options.mandatoryEvidenceNodeIds, selected.included),
    immutable: true,
    created_at: options.timestamp
  };
}

function contextMapSnapshotHash(state, projectId) {
  const snapshot = state.context_nodes
    .filter((node) => !projectId || !node.project_id || node.project_id === projectId)
    .slice()
    .sort(compareContextNodes)
    .map((node) => [node.id, node.source_hash, node.current_version_id, node.status]);
  return contextHash(snapshot);
}

function defaultRetrievalPlan(explicit, anchorNodeId) {
  return {
    strategy: 'minisearch_graph_deterministic',
    query: null,
    explicit_refs: [...explicit].sort(),
    anchor_node_id: anchorNodeId
  };
}

function mandatoryEvidenceSnapshot(requiredNodeIds, included) {
  const required = [...new Set(requiredNodeIds)].sort();
  const covered = included
    .map((item) => item.node_id)
    .filter((nodeId) => requiredNodeIds.includes(nodeId))
    .sort();
  return {
    required_node_ids: required,
    covered_node_ids: covered,
    missing_node_ids: required.filter((nodeId) => !included.some((item) => item.node_id === nodeId))
  };
}

function exclusionReason(node, version, scope) {
  if (node.project_id && scope.allowedProjects && !scope.allowedProjects.has(node.project_id))
    return 'permission_denied';
  if (scope.scopeSet && node.required_scopes.some((item) => !scope.scopeSet.has(item))) return 'permission_denied';
  if (scope.projectId && node.project_id !== scope.projectId) return 'cross_scope';
  if (node.sensitivity === 'secret') return 'sensitive';
  if (!contextNodeIsCurrent(node, version)) return 'stale';
  return scope.excludedByUser.has(node.id) ? 'user_excluded' : null;
}

function contextNodeIsCurrent(node, version) {
  return (
    node.freshness?.status === 'current' &&
    node.status === 'active' &&
    Boolean(version) &&
    version.source_hash === node.source_hash
  );
}

function selectionExclusion(node, version, reason) {
  return {
    node_id: node.id,
    document_version_id: version?.id || null,
    reason,
    token_estimate: Number(version?.token_estimate || 0)
  };
}

function ensureContextCollections(state) {
  for (const name of CONTEXT_INTERNAL_COLLECTIONS) if (!Array.isArray(state[name])) state[name] = [];
}
