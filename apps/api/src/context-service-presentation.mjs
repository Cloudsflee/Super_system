import { cloneStateValue as structuredClone } from './state-clone.mjs';
import {
  compareContextNodes,
  contextHash,
  contextSourceRecordId,
  sanitizeContextFacts
} from '../../../packages/system-context/src/index.mjs';
import { instanceOwnerId } from './project-governance-v19.mjs';
import { resolveContextProjectionRecord } from './context-resource-adapters.mjs';

export function subtree(nodes, rootId, maxDepth) {
  const byParent = new Map(),
    byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const parent = node.parent_id || '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(node);
  }
  for (const children of byParent.values()) children.sort(compareContextNodes);
  const output = [],
    seen = new Set();
  const visit = (nodeId, depth) => {
    if (depth > maxDepth || seen.has(nodeId)) return;
    const node = byId.get(nodeId);
    if (!node) return;
    seen.add(nodeId);
    output.push(node);
    for (const child of byParent.get(nodeId) || []) visit(child.id, depth + 1);
  };
  visit(rootId, 0);
  return output;
}

export function selectionScore(node, fulltext, { pinned, explicitRefs, projectId, anchorNodeId, state }) {
  const relation = anchorNodeId
    ? state.context_edges.some(
        (edge) =>
          (edge.source_node_id === anchorNodeId && edge.target_node_id === node.id) ||
          (edge.target_node_id === anchorNodeId && edge.source_node_id === node.id)
      )
    : false;
  return (
    (pinned.has(node.id) ? 1_000_000 : 0) +
    (node.id === anchorNodeId ? 500_000 : 0) +
    (explicitRefs.has(node.id) || explicitRefs.has(node.uri) ? 250_000 : 0) +
    (projectId && node.project_id === projectId ? 100_000 : 0) +
    fulltext * 1_000 +
    (relation ? 500 : 0) +
    (node.authority === 'authoritative' ? 100 : 0) +
    (node.freshness?.status === 'current' ? 10 : 0)
  );
}

export function searchRanking(node, fulltext, { pinned, explicitRefs, projectId, anchorNodeId, state }) {
  const anchor = anchorNodeId ? state.context_nodes.find((item) => item.id === anchorNodeId) : null;
  return {
    pinned: pinned.has(node.id),
    scope_distance:
      node.id === anchorNodeId
        ? 0
        : anchor && (node.parent_id === anchor.id || anchor.parent_id === node.id)
          ? 1
          : anchor && node.parent_id && node.parent_id === anchor.parent_id
            ? 2
            : projectId && node.project_id === projectId
              ? 3
              : !projectId
                ? 3
                : 4,
    explicit: explicitRefs.has(node.id) || explicitRefs.has(node.uri),
    fulltext,
    related: anchorNodeId
      ? state.context_edges.some(
          (edge) =>
            edge.type !== 'contains' &&
            ((edge.source_node_id === anchorNodeId && edge.target_node_id === node.id) ||
              (edge.target_node_id === anchorNodeId && edge.source_node_id === node.id))
        )
      : false,
    authoritative: node.authority === 'authoritative',
    current: node.freshness?.status === 'current'
  };
}

export function compareSearchResults(left, right) {
  const leftRank = left._ranking,
    rightRank = right._ranking;
  return (
    Number(rightRank.pinned) - Number(leftRank.pinned) ||
    leftRank.scope_distance - rightRank.scope_distance ||
    Number(rightRank.explicit) - Number(leftRank.explicit) ||
    rightRank.fulltext - leftRank.fulltext ||
    Number(rightRank.related) - Number(leftRank.related) ||
    Number(rightRank.authoritative) - Number(leftRank.authoritative) ||
    Number(rightRank.current) - Number(leftRank.current) ||
    compareContextNodes(left, right)
  );
}

export async function sourceFacts(state, node) {
  const record = node.source_collection
    ? state[node.source_collection]?.find(
        (item) => contextSourceRecordId(node.source_collection, item) === String(node.source_id)
      )
    : null;
  if (!record && node.source_collection)
    return { tombstone: true, source_collection: node.source_collection, source_id: node.source_id };
  const resolved = await resolveContextProjectionRecord(state, node, record);
  return sanitizeContextFacts(resolved || {}).facts;
}

export function publicNode(node) {
  if (!node) return null;
  return {
    id: node.id,
    uri: node.uri,
    kind: node.kind,
    source_type: node.source_type,
    title: node.title,
    summary: node.deterministic_summary,
    project_id: node.project_id,
    parent_id: node.parent_id,
    source_collection: node.source_collection,
    source_id: node.source_id,
    source_version: node.source_version,
    status: node.status,
    sensitivity: node.sensitivity,
    authority: node.authority,
    freshness: node.freshness,
    current_version_id: node.current_version_id,
    required_scopes: node.required_scopes,
    sort: node.sort,
    resource: node.resource ? sanitizeContextFacts(node.resource).facts : null
  };
}

export function publicVersion(version) {
  return {
    id: version.id,
    node_id: version.node_id,
    version: version.version,
    renderer_version: version.renderer_version,
    source_hash: version.source_hash,
    content_sha256: version.content_sha256,
    size_bytes: version.size_bytes,
    media_type: version.media_type,
    token_estimate: version.token_estimate,
    deterministic_summary: version.deterministic_summary,
    redactions: version.redactions,
    created_at: version.created_at
  };
}

export function publicSelection(selection) {
  return selection ? structuredClone(selection) : null;
}

export function publicContextCoverage(state, actorContext, projectId, nodes) {
  const coverage = state.context_projection_coverage;
  if (!coverage) return null;
  if (!projectId && actorContext.actor.id === instanceOwnerId(state) && !actorContext.scopes)
    return structuredClone(coverage);
  const allowedProjects = projectId ? new Set([String(projectId)]) : actorContext.accessible,
    sourceNodes = nodes.filter((node) => node.source_collection && node.status !== 'tombstone');
  return {
    source_records: sourceNodes.length,
    projected_records: sourceNodes.length,
    tombstones: nodes.filter((node) => node.status === 'tombstone').length,
    warnings: (coverage.warnings || [])
      .filter(
        (warning) =>
          warning.project_id &&
          allowedProjects.has(String(warning.project_id)) &&
          (!String(warning.code || '').startsWith('context_repository_') ||
            !actorContext.scopes ||
            actorContext.scopes.includes('files:read'))
      )
      .map((warning) => structuredClone(warning)),
    checked_at: coverage.checked_at || null
  };
}

export function publicPolicy(policy) {
  return policy
    ? structuredClone(policy)
    : { pinned_node_ids: [], excluded_node_ids: [], revision: 0, session_id: null, project_id: null };
}

export function latestSelection(state, actorId, projectId) {
  return state.context_selections
    .filter((item) => item.actor_id === actorId && (item.project_id || null) === (projectId || null))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0];
}

export function mapSnapshotHash(nodes) {
  return contextHash(
    nodes.map((node) => [node.id, node.source_hash, node.current_version_id, node.parent_id, node.status])
  );
}

export function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

export function optionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

export function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
}
