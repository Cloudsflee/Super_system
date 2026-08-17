import fs from 'node:fs';
import path from 'node:path';
import MiniSearch from 'minisearch';
import { hashJson } from '../../crypto.mjs';

export const CONTEXT_INDEX_SCHEMA = 'aiws.context_index.v2';
export const CONTEXT_TOKENIZER_VERSION = 'aiws.context_tokenizer.v1';
export const CONTEXT_INDEX_OPTIONS_VERSION = 'aiws.context_index_options.v2';

const OPTIONS = Object.freeze({
  fields: ['title', 'path', 'content', 'relations'],
  storeFields: ['node_id', 'uri', 'title', 'path', 'kind', 'project_id', 'stable_order'],
  tokenize: (value) => String(value || '').toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(Boolean),
  processTerm: (value) => String(value || '').toLowerCase()
});

export function deterministicIndexSnapshot({ nodes = [], versions = [], edges = [] } = {}) {
  const versionById = new Map(versions.map((version) => [String(version.id), version]));
  const active = nodes.filter((node) => node.status !== 'tombstone' && node.sensitivity !== 'secret').slice().sort(compareNode);
  const activeIds = new Set(active.map((node) => String(node.id)));
  return hashJson({
    schema_version: CONTEXT_INDEX_SCHEMA,
    tokenizer_version: CONTEXT_TOKENIZER_VERSION,
    index_options_version: CONTEXT_INDEX_OPTIONS_VERSION,
    nodes: active.map((node) => ({ id: node.id, uri: node.uri, source_hash: node.source_hash, version_id: node.current_document_version_id, status: node.status, parent_id: node.parent_id, title: node.title, kind: node.kind, content_hash: versionById.get(String(node.current_document_version_id))?.content_hash || null })),
    edges: edges.filter((edge) => activeIds.has(String(edge.parent_id)) && activeIds.has(String(edge.child_id))).map((edge) => ({ parent_id: edge.parent_id, child_id: edge.child_id, relation: edge.relation, order_index: Number(edge.order_index || 0) })).sort(compareEdge)
  });
}

export function buildIndex({ nodes = [], versions = [], edges = [] } = {}) {
  const versionById = new Map(versions.map((version) => [String(version.id), version]));
  const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
  const relations = new Map();
  for (const edge of edges) {
    for (const id of [edge.parent_id, edge.child_id]) {
      const other = String(id) === String(edge.parent_id) ? edge.child_id : edge.parent_id;
      const list = relations.get(String(id)) || [];
      list.push(`${edge.relation || 'contains'}:${other}`);
      relations.set(String(id), list);
    }
  }
  const ordered = nodes.filter((node) => node.status !== 'tombstone' && node.sensitivity !== 'secret' && node.current_document_version_id).slice().sort(compareNode);
  const documents = ordered.map((node, stable_order) => {
    const version = versionById.get(String(node.current_document_version_id));
    return {
      id: String(node.id), node_id: String(node.id), uri: node.uri, title: node.title || '', path: node.path || '', kind: node.kind || '', project_id: node.project_id || '', stable_order,
      content: String(version?.content || ''), relations: (relations.get(String(node.id)) || []).sort().join(' ')
    };
  });
  const index = new MiniSearch(OPTIONS);
  index.addAll(documents);
  return { index, documents, snapshotHash: deterministicIndexSnapshot({ nodes, versions, edges }), indexHash: hashJson(index.toJSON()) };
}

export function serializeIndex(index, { snapshotHash, indexHash, rebuiltAt = new Date().toISOString() } = {}) {
  return { schema_version: CONTEXT_INDEX_SCHEMA, tokenizer_version: CONTEXT_TOKENIZER_VERSION, index_options_version: CONTEXT_INDEX_OPTIONS_VERSION, snapshot_hash: snapshotHash || '', index_hash: indexHash || hashJson(index.toJSON()), rebuilt_at: rebuiltAt, index: index.toJSON() };
}

export function loadIndex(payload) {
  if (payload?.schema_version !== CONTEXT_INDEX_SCHEMA || payload.tokenizer_version !== CONTEXT_TOKENIZER_VERSION || payload.index_options_version !== CONTEXT_INDEX_OPTIONS_VERSION || !payload.index) throw new Error('context_index_schema_invalid');
  const actualHash = hashJson(payload.index);
  if (payload.index_hash && payload.index_hash !== actualHash) throw new Error('context_index_hash_mismatch');
  return MiniSearch.loadJSON(JSON.stringify(payload.index), OPTIONS);
}

export function searchIndex(index, query) {
  const value = String(query || '').trim();
  if (!value) return [];
  return index.search(value, { prefix: true, fuzzy: value.length > 4 ? 0.15 : false, boost: { title: 4, path: 2, content: 1, relations: 1.5 } }).sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || Number(left.stable_order || 0) - Number(right.stable_order || 0) || String(left.node_id).localeCompare(String(right.node_id)));
}

export function indexFile(root, projectId) {
  return path.join(path.resolve(root), 'context-index', `${encodeURIComponent(String(projectId))}.json`);
}

export function writeIndexAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

export function readIndexPayload(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function compareNode(left, right) {
  return String(left.uri || '').localeCompare(String(right.uri || '')) || String(left.id).localeCompare(String(right.id));
}
function compareEdge(left, right) {
  return String(left.parent_id).localeCompare(String(right.parent_id)) || Number(left.order_index || 0) - Number(right.order_index || 0) || String(left.child_id).localeCompare(String(right.child_id)) || String(left.relation).localeCompare(String(right.relation));
}
