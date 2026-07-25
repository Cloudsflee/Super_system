import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  compactContextMap,
  contextHash,
  createContextSearchIndex,
  createContextSelection,
  ensureContextCollections,
  searchContextSearchIndex
} from '../../packages/system-context/src/index.mjs';

const nodeCount = 10_000;
const projectId = 'project-performance';
const state = ensureContextCollections({});
const projectNode = node('project-node', null, 'project', '性能项目');
state.context_nodes.push(projectNode);
for (let index = 0; index < nodeCount - 1; index += 1) {
  const value = node(`node-${String(index).padStart(5, '0')}`, projectNode.id, 'record', `上下文节点 ${index}`);
  const version = {
    id: `version-${index}`,
    node_id: value.id,
    source_hash: value.source_hash,
    content_sha256: contextHash(`document-${index}`),
    token_estimate: 10
  };
  value.current_version_id = version.id;
  state.context_nodes.push(value);
  state.context_document_versions.push(version);
}

compactContextMap(state.context_nodes, { rootId: projectNode.id, maxDepth: 2, maxNodes: nodeCount });
const mapP95 = timedP95(12, () =>
  compactContextMap(state.context_nodes, { rootId: projectNode.id, maxDepth: 2, maxNodes: nodeCount })
);
assert.ok(mapP95 <= 150, `cached map p95 ${mapP95.toFixed(2)}ms exceeds 150ms`);

const index = createContextSearchIndex(
  state.context_nodes.map((item) => ({
    id: item.id,
    node_id: item.id,
    title: item.title,
    path: item.title,
    summary: item.deterministic_summary,
    facts: `${item.title} 确定性事实 searchable context`
  }))
);
searchContextSearchIndex(index, '上下文 4321');
const searchP95 = timedP95(30, () => searchContextSearchIndex(index, '上下文 4321'));
assert.ok(searchP95 <= 250, `full-text search p95 ${searchP95.toFixed(2)}ms exceeds 250ms`);

const candidates = state.context_nodes.slice(1, 201).map((item) => item.id);
createContextSelection(state, {
  id: 'selection-warmup',
  actorId: 'owner',
  projectId,
  candidateNodeIds: candidates,
  tokenBudget: 4000,
  allowedProjectIds: [projectId]
});
let sequence = 0;
const selectionP95 = timedP95(20, () =>
  createContextSelection(state, {
    id: `selection-${sequence++}`,
    actorId: 'owner',
    projectId,
    candidateNodeIds: candidates,
    tokenBudget: 4000,
    allowedProjectIds: [projectId]
  })
);
assert.ok(selectionP95 <= 500, `cached selection assembly p95 ${selectionP95.toFixed(2)}ms exceeds 500ms`);

console.log(
  `V2.0 10k context performance passed (map p95=${mapP95.toFixed(2)}ms, search p95=${searchP95.toFixed(2)}ms, selection p95=${selectionP95.toFixed(2)}ms)`
);

function node(id, parentId, kind, title) {
  return {
    id,
    uri: `aiws://context/nodes/${id}`,
    kind,
    title,
    deterministic_summary: `${title} 摘要`,
    project_id: projectId,
    parent_id: parentId,
    status: 'active',
    sensitivity: 'internal',
    authority: 'authoritative',
    freshness: { status: 'current' },
    required_scopes: ['context:read', 'project:read'],
    source_hash: contextHash({ id }),
    current_version_id: null,
    sort: { type_order: kind === 'project' ? 10 : 120, order_index: 0, stable_id: id }
  };
}

function timedP95(iterations, action) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    action();
    values.push(performance.now() - started);
  }
  values.sort((left, right) => left - right);
  return values[Math.ceil(values.length * 0.95) - 1];
}
