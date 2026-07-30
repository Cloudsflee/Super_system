import { compareContextNodes } from './protocol.mjs';

export function compareSelectionCandidates(
  left,
  right,
  { mandatory, pinned, explicit, projectId, anchorNodeId, rankByNode, nodeById, edges }
) {
  return (
    Number(mandatory.has(right.id)) - Number(mandatory.has(left.id)) ||
    Number(pinned.has(right.id)) - Number(pinned.has(left.id)) ||
    selectionScopeDistance(left, { projectId, anchorNodeId, nodeById }) -
      selectionScopeDistance(right, { projectId, anchorNodeId, nodeById }) ||
    Number(isExplicitNode(right, explicit)) - Number(isExplicitNode(left, explicit)) ||
    candidateRank(left.id, rankByNode) - candidateRank(right.id, rankByNode) ||
    Number(isRelatedToAnchor(right.id, anchorNodeId, edges)) -
      Number(isRelatedToAnchor(left.id, anchorNodeId, edges)) ||
    Number(right.authority === 'authoritative') - Number(left.authority === 'authoritative') ||
    Number(right.freshness?.status === 'current') - Number(left.freshness?.status === 'current') ||
    compareContextNodes(left, right)
  );
}

export function normalizeCandidateRanks(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) return new Map(value.map((nodeId, index) => [String(nodeId), index]));
  if (value && typeof value === 'object')
    return new Map(Object.entries(value).map(([nodeId, rank]) => [nodeId, Number(rank)]));
  return new Map();
}

export function isExplicitNode(node, explicit) {
  return explicit.has(node.id) || explicit.has(node.uri);
}

function candidateRank(nodeId, ranks) {
  const rank = ranks.get(nodeId);
  return Number.isFinite(Number(rank)) ? Number(rank) : Number.MAX_SAFE_INTEGER;
}

function selectionScopeDistance(node, { projectId, anchorNodeId, nodeById }) {
  if (node.id === anchorNodeId) return 0;
  const anchor = anchorNodeId ? nodeById.get(anchorNodeId) : null;
  if (anchor) {
    if (node.parent_id === anchor.id || anchor.parent_id === node.id) return 1;
    if (node.parent_id && node.parent_id === anchor.parent_id) return 2;
  }
  if (projectId && node.project_id === projectId) return 3;
  if (!projectId) return 3;
  return 4;
}

function isRelatedToAnchor(nodeId, anchorNodeId, edges) {
  if (!anchorNodeId) return false;
  return edges.some(
    (edge) =>
      edge.type !== 'contains' &&
      ((edge.source_node_id === anchorNodeId && edge.target_node_id === nodeId) ||
        (edge.target_node_id === anchorNodeId && edge.source_node_id === nodeId))
  );
}
