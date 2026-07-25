import MiniSearch from 'minisearch';

import { compareContextNodes, contextError, contextHash, tokenizeContextText } from './protocol.mjs';
import { contextDocumentRelationSnapshot } from './rendering.mjs';

export const CONTEXT_SEARCH_INDEX_SCHEMA = 'aiws.context_index.v1';

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

export function contextSearchIndexSnapshotHash(nodes = []) {
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
    snapshot_hash: contextSearchIndexSnapshotHash(orderedNodes)
  };
}

export function createContextSearchIndex(documents = []) {
  const index = new MiniSearch(INDEX_OPTIONS);
  index.addAll(documents);
  return index;
}

export function serializeContextSearchIndex(index, { snapshotHash, rebuiltAt }) {
  return {
    schema_version: CONTEXT_SEARCH_INDEX_SCHEMA,
    snapshot_hash: snapshotHash,
    rebuilt_at: rebuiltAt,
    index: index.toJSON()
  };
}

export function loadContextSearchIndex(payload) {
  if (payload?.schema_version !== CONTEXT_SEARCH_INDEX_SCHEMA || !payload.index)
    throw contextError('context_index_schema_invalid');
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
