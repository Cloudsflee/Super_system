import MiniSearch from 'minisearch';

import { compareContextNodes, contextError, contextHash, tokenizeContextText } from './protocol.mjs';
import { contextDocumentRelationSnapshot } from './rendering.mjs';

export const CONTEXT_SEARCH_INDEX_SCHEMA = 'aiws.context_index.v2';
export const LEGACY_CONTEXT_SEARCH_INDEX_SCHEMA = 'aiws.context_index.v1';
export const CONTEXT_TOKENIZER_VERSION = 'aiws.context_tokenizer.v1';
export const CONTEXT_INDEX_OPTIONS_VERSION = 'aiws.context_index_options.v2';

const INDEX_OPTIONS = Object.freeze({
  fields: ['title', 'path', 'summary', 'facts', 'relations'],
  storeFields: ['node_id', 'title', 'path', 'summary', 'project_id', 'kind', 'uri', 'stable_order'],
  tokenize: tokenizeContextText,
  processTerm: (term) => String(term).toLowerCase()
});

export function contextIndexableNodes(nodes = []) {
  return nodes
    .filter((node) => node.status === 'active' && node.current_version_id && node.sensitivity !== 'secret')
    .slice()
    .sort(compareContextNodes);
}

export function contextSearchIndexSnapshotHash(input = []) {
  if (!Array.isArray(input)) return deterministicContextSearchIndexSnapshotHash(input);
  const nodes = input;
  return contextHash(
    contextIndexableNodes(nodes).map((node) => [
      node.id,
      node.source_hash,
      node.current_version_id,
      node.parent_id,
      node.status
    ])
  );
}

export function deterministicContextSearchIndexSnapshotHash({ nodes = [], documentVersions = [], edges = [] } = {}) {
  const orderedNodes = contextIndexableNodes(nodes),
    nodeById = new Map(nodes.map((node) => [node.id, node])),
    versionById = new Map(documentVersions.map((version) => [version.id, version])),
    activeIds = new Set(orderedNodes.map((node) => node.id)),
    normalizedEdges = edges
      .filter((edge) => activeIds.has(edge.source_node_id) && activeIds.has(edge.target_node_id))
      .map((edge) => ({
        id: String(edge.id || ''),
        type: String(edge.type || edge.edge_type || ''),
        source_node_id: String(edge.source_node_id || ''),
        target_node_id: String(edge.target_node_id || ''),
        order_index: Number(edge.order_index || 0)
      }))
      .sort(compareIndexEdges);
  return contextHash({
    schema_version: CONTEXT_SEARCH_INDEX_SCHEMA,
    tokenizer_version: CONTEXT_TOKENIZER_VERSION,
    index_options_version: CONTEXT_INDEX_OPTIONS_VERSION,
    fields: INDEX_OPTIONS.fields,
    store_fields: INDEX_OPTIONS.storeFields,
    nodes: orderedNodes.map((node) => {
      const version = versionById.get(node.current_version_id);
      return {
        id: node.id,
        title: node.title || '',
        path: contextNodePath(node, nodeById),
        summary: node.deterministic_summary || '',
        project_id: node.project_id || '',
        kind: node.kind || '',
        uri: node.uri || '',
        parent_id: node.parent_id || null,
        source_hash: node.source_hash || null,
        source_generation: Number(node.source_generation || 0),
        current_version_id: node.current_version_id,
        document_content_sha256: version?.content_sha256 || null
      };
    }),
    edges: normalizedEdges
  });
}

export async function buildContextSearchIndex({ nodes = [], documentVersions = [], edges = [], readDocument }) {
  if (typeof readDocument !== 'function') throw contextError('context_index_document_reader_required');
  const orderedNodes = contextIndexableNodes(nodes),
    nodeById = new Map(nodes.map((node) => [node.id, node])),
    versionById = new Map(documentVersions.map((version) => [version.id, version])),
    relationsByNode = buildRelations(edges, nodeById),
    documents = [];

  for (let stableOrder = 0; stableOrder < orderedNodes.length; stableOrder += 1) {
    const node = orderedNodes[stableOrder],
      version = versionById.get(node.current_version_id);
    if (!version) continue;
    documents.push({
      id: node.id,
      node_id: node.id,
      title: node.title || '',
      path: contextNodePath(node, nodeById),
      summary: node.deterministic_summary || '',
      facts: String(await readDocument(version, node)),
      relations: (relationsByNode.get(node.id) || []).sort().join(' '),
      project_id: node.project_id || '',
      kind: node.kind,
      uri: node.uri,
      stable_order: stableOrder
    });
  }

  return {
    index: createContextSearchIndex(documents),
    documents,
    nodes: orderedNodes,
    snapshot_hash: contextSearchIndexSnapshotHash(orderedNodes),
    deterministic_snapshot_hash: deterministicContextSearchIndexSnapshotHash({
      nodes,
      documentVersions,
      edges
    })
  };
}

export function createContextSearchIndex(documents = []) {
  const index = new MiniSearch(INDEX_OPTIONS);
  index.addAll(documents);
  return index;
}

export function serializeContextSearchIndex(index, { snapshotHash, rebuiltAt } = {}) {
  if (rebuiltAt !== undefined)
    return {
      schema_version: LEGACY_CONTEXT_SEARCH_INDEX_SCHEMA,
      snapshot_hash: snapshotHash,
      rebuilt_at: rebuiltAt,
      index: index.toJSON()
    };
  return {
    schema_version: CONTEXT_SEARCH_INDEX_SCHEMA,
    snapshot_hash: snapshotHash,
    tokenizer_version: CONTEXT_TOKENIZER_VERSION,
    index_options_version: CONTEXT_INDEX_OPTIONS_VERSION,
    index: index.toJSON()
  };
}

export function loadContextSearchIndex(payload) {
  if (
    ![CONTEXT_SEARCH_INDEX_SCHEMA, LEGACY_CONTEXT_SEARCH_INDEX_SCHEMA].includes(payload?.schema_version) ||
    !payload.index
  )
    throw contextError('context_index_schema_invalid');
  if (
    payload.schema_version === CONTEXT_SEARCH_INDEX_SCHEMA &&
    (payload.tokenizer_version !== CONTEXT_TOKENIZER_VERSION ||
      payload.index_options_version !== CONTEXT_INDEX_OPTIONS_VERSION)
  )
    throw contextError('context_index_options_invalid');
  return MiniSearch.loadJSON(JSON.stringify(payload.index), INDEX_OPTIONS);
}

export function searchContextSearchIndex(index, query) {
  const text = String(query || '').trim();
  if (!text) return [];
  return index.search(text, {
    prefix: true,
    fuzzy: text.length >= 5 ? 0.15 : false,
    boost: { title: 4, path: 2.5, summary: 2, relations: 1.5, facts: 1 }
  });
}

function buildRelations(edges, nodeById) {
  const relations = new Map();
  for (const node of nodeById.values()) {
    if (node.sensitivity === 'secret') continue;
    const adjacent = edges.filter((edge) => edge.source_node_id === node.id || edge.target_node_id === node.id),
      relatedIds = new Set(
        adjacent.flatMap((edge) => [edge.source_node_id, edge.target_node_id]).filter((id) => id !== node.id)
      ),
      relatedNodes = [...relatedIds]
        .map((id) => nodeById.get(id))
        .filter((related) => related && related.sensitivity !== 'secret');
    relations.set(
      node.id,
      contextDocumentRelationSnapshot(node, adjacent, relatedNodes).map(
        (relation) => `${relation.type} ${relation.other_title || relation.other_id}`
      )
    );
  }
  return relations;
}

function contextNodePath(node, nodeById) {
  const parts = [],
    seen = new Set();
  let current = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.title || current.id);
    current = nodeById.get(current.parent_id);
  }
  return parts.join(' / ');
}

function compareIndexEdges(left, right) {
  return (
    left.source_node_id.localeCompare(right.source_node_id) ||
    left.target_node_id.localeCompare(right.target_node_id) ||
    left.type.localeCompare(right.type) ||
    left.order_index - right.order_index ||
    left.id.localeCompare(right.id)
  );
}
