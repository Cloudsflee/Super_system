import {
  CONTEXT_EDGE_TYPES,
  CONTEXT_INTERNAL_COLLECTIONS,
  URI_PATTERN,
  canonicalJson,
  contextError,
  contextSourceRecordId
} from './protocol.mjs';
import {
  ensureUniqueIds,
  validateContainsTree,
  validateContextSelections,
  validateNodeHashes,
  validSha
} from './validation.mjs';

export function validateContextState(state, { sourceCollections = [] } = {}) {
  ensureContextCollections(state);
  for (const name of CONTEXT_INTERNAL_COLLECTIONS) ensureUniqueIds(state[name], name);
  const indexes = contextValidationIndexes(state);
  validateContextNodes(state.context_nodes, indexes);
  validateContainsTree(state.context_nodes, state.context_edges);
  validateContextEdges(state.context_edges, indexes.nodeIds);
  validateContextDocumentVersions(state.context_document_versions, indexes.nodeIds);
  validateContextSelections(state.context_selections, indexes);
  validateProjectionCoverage(state, sourceCollections);
  return state;
}

export function assertContextImmutability(before, after, { allowDeletion = false } = {}) {
  for (const collection of ['context_document_versions', 'context_selections']) {
    const nextById = new Map((after[collection] || []).map((item) => [item.id, item]));
    for (const item of before[collection] || []) {
      const next = nextById.get(item.id);
      if (next === item) continue;
      if ((!next && !allowDeletion) || (next && canonicalJson(item) !== canonicalJson(next)))
        throw contextError('context_immutable_record_changed', { collection, id: item.id });
    }
  }
}

function contextValidationIndexes(state) {
  return {
    nodeIds: new Set(state.context_nodes.map((node) => node.id)),
    versionIds: new Set(state.context_document_versions.map((version) => version.id)),
    versionById: new Map(state.context_document_versions.map((version) => [version.id, version])),
    selectionIds: new Set(state.context_selections.map((selection) => selection.id))
  };
}

function validateContextNodes(nodes, indexes) {
  const uriSet = new Set();
  for (const node of nodes) {
    validateContextNodeIdentity(node, uriSet);
    if (node.parent_id && !indexes.nodeIds.has(node.parent_id))
      throw contextError('context_node_parent_missing', { id: node.id, parent_id: node.parent_id });
    if (node.current_version_id && !indexes.versionIds.has(node.current_version_id))
      throw contextError('context_node_version_missing', { id: node.id, version_id: node.current_version_id });
    if (!['public', 'internal', 'restricted', 'secret'].includes(node.sensitivity))
      throw contextError('context_node_sensitivity_invalid', { id: node.id });
    validateNodeHashes(node);
  }
}

function validateContextNodeIdentity(node, uriSet) {
  if (!URI_PATTERN.test(String(node.uri || '')))
    throw contextError('context_node_uri_invalid', { id: node.id, uri: node.uri });
  if (uriSet.has(node.uri)) throw contextError('context_node_uri_duplicate', { uri: node.uri });
  uriSet.add(node.uri);
}

function validateContextEdges(edges, nodeIds) {
  for (const edge of edges) {
    if (!CONTEXT_EDGE_TYPES.includes(edge.type)) throw contextError('context_edge_type_invalid', { id: edge.id });
    if (!nodeIds.has(edge.source_node_id) || !nodeIds.has(edge.target_node_id))
      throw contextError('context_edge_node_missing', { id: edge.id });
  }
}

function validateContextDocumentVersions(versions, nodeIds) {
  for (const version of versions) {
    if (!nodeIds.has(version.node_id) || version.immutable !== true)
      throw contextError('context_document_invalid', { id: version.id });
    if (!validSha(version.content_sha256) || !validSha(version.source_hash) || !validSha(version.markdown_hash))
      throw contextError('context_document_hash_invalid', { id: version.id });
    if (version.content_sha256 !== version.markdown_hash)
      throw contextError('context_document_content_hash_mismatch', { id: version.id });
    if (!version.cas_ref || version.cas_ref.sha256 !== version.content_sha256)
      throw contextError('context_document_cas_ref_invalid', { id: version.id });
  }
}

function validateProjectionCoverage(state, sourceCollections) {
  const expected = expectedProjectionSources(state, sourceCollections);
  const covered = new Set(
    state.context_nodes
      .filter((node) => node.source_collection && node.source_id && node.status !== 'tombstone')
      .map((node) => `${node.source_collection}:${node.source_id}`)
  );
  const missing = [...expected].filter((key) => !covered.has(key));
  if (missing.length) throw contextError('context_projection_coverage_incomplete', { missing: missing.slice(0, 100) });
}

function expectedProjectionSources(state, sourceCollections) {
  return new Set(
    sourceCollections
      .filter((name) => !CONTEXT_INTERNAL_COLLECTIONS.includes(name) && Array.isArray(state[name]))
      .flatMap((name) => state[name].map((record) => `${name}:${contextSourceRecordId(name, record)}`))
  );
}

function ensureContextCollections(state) {
  for (const name of CONTEXT_INTERNAL_COLLECTIONS) if (!Array.isArray(state[name])) state[name] = [];
}
