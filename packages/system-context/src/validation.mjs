import {
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_SELECTION_LEGACY_SCHEMAS,
  CONTEXT_SELECTION_SCHEMA,
  contextError
} from './protocol.mjs';

export function validateContextSelections(selections, { nodeIds, versionById, selectionIds }) {
  for (const selection of selections) {
    if (
      selection.immutable !== true ||
      ![CONTEXT_SELECTION_SCHEMA, ...CONTEXT_SELECTION_LEGACY_SCHEMAS].includes(selection.schema_version)
    )
      throw contextError('context_selection_invalid', { id: selection.id });
    validateContextSelectionVersions(selection, nodeIds, versionById);
    validateContextSelectionExclusions(selection);
    validateRuntimeContextSelection(selection, selectionIds);
  }
}

function validateContextSelectionVersions(selection, nodeIds, versionById) {
  for (const item of selection.included || []) {
    const version = versionById.get(item.document_version_id);
    if (!nodeIds.has(item.node_id) || !version || version.node_id !== item.node_id)
      throw contextError('context_selection_version_invalid', { id: selection.id });
  }
}

function validateContextSelectionExclusions(selection) {
  for (const item of selection.excluded || [])
    if (!CONTEXT_EXCLUSION_REASONS.includes(item.reason))
      throw contextError('context_selection_reason_invalid', { id: selection.id, reason: item.reason });
}

function validateRuntimeContextSelection(selection, selectionIds) {
  const runtime = selection.runtime_context;
  if (!runtime) return;
  if (
    runtime.schema_version !== 'aiws.context_runtime_selection.v1' ||
    !['mcp_search', 'mcp_read_approved', 'mcp_read', 'mcp_read_denied'].includes(runtime.purpose) ||
    !selectionIds.has(runtime.initial_context_selection_id)
  )
    throw contextError('context_runtime_selection_invalid', { id: selection.id });
  if (runtime.purpose !== 'mcp_read') return;
  const readIncluded = (selection.included || []).some(
    (item) => item.node_id === runtime.read_node_id && item.document_version_id === runtime.read_document_version_id
  );
  if (!readIncluded) throw contextError('context_runtime_read_selection_invalid', { id: selection.id });
}

export function validateContainsTree(nodes, edges) {
  const contains = edges.filter((edge) => edge.type === 'contains');
  const parentByChild = new Map(),
    nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of contains) {
    if (parentByChild.has(edge.target_node_id))
      throw contextError('context_contains_multiple_parents', { node_id: edge.target_node_id });
    parentByChild.set(edge.target_node_id, edge.source_node_id);
  }
  for (const node of nodes) {
    if (node.parent_id && parentByChild.get(node.id) !== node.parent_id)
      throw contextError('context_contains_parent_mismatch', { node_id: node.id });
    const seen = new Set([node.id]);
    let cursor = node.parent_id;
    while (cursor) {
      if (seen.has(cursor)) throw contextError('context_contains_cycle', { node_id: node.id });
      seen.add(cursor);
      cursor = nodeById.get(cursor)?.parent_id || null;
    }
  }
}

export function ensureUniqueIds(items, collection) {
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || !String(item.id || ''))
      throw contextError('context_record_id_missing', { collection });
    if (seen.has(item.id)) throw contextError('context_record_id_duplicate', { collection, id: item.id });
    seen.add(item.id);
  }
}

export function validSha(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

export function validateNodeHashes(node) {
  if (
    (node.source_record_hash && !validSha(node.source_record_hash)) ||
    (node.source_hash && !validSha(node.source_hash))
  )
    throw contextError('context_node_source_hash_invalid', { id: node.id });
}
