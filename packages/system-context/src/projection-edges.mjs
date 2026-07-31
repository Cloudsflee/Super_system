import { CONTEXT_INTERNAL_COLLECTIONS, contextHash, contextSourceRecordId, uniqueBy } from './protocol.mjs';
import { compareContextEdges as compareEdges } from './rendering.mjs';

export function buildDesiredEdges(state, activeIds, timestamp, nodeById = null) {
  const edges = [];
  const allNodesById = nodeById || new Map(state.context_nodes.map((node) => [node.id, node]));
  const bySource = activeNodesBySource(state, activeIds);
  const push = createEdgeCollector(edges, activeIds, timestamp);
  addContainmentEdges(state, activeIds, allNodesById, push);
  addWorkflowDependencyEdges(state, bySource, push);
  addAssetProductionEdges(state, bySource, push);
  addAssetRelationEdges(state, bySource, push);
  addExecutionEdges(state, bySource, push);
  addAssistSessionEdges(state, bySource, push);
  addEvidenceAndSupersessionEdges(state, bySource, push);
  return uniqueBy(edges, (edge) => edge.id).sort(compareEdges);
}

export function mergeCurrentEdges(existing, desired) {
  const created = new Map(existing.map((edge) => [edge.id, edge.created_at]));
  return desired.map((edge) => ({ ...edge, created_at: created.get(edge.id) || edge.created_at }));
}

function activeNodesBySource(state, activeIds) {
  return new Map(
    state.context_nodes
      .filter((node) => node.source_collection && node.source_id && activeIds.has(node.id))
      .map((node) => [`${node.source_collection}:${node.source_id}`, node])
  );
}

function createEdgeCollector(edges, activeIds, timestamp) {
  return (type, source, target, sourceInfo = {}) => {
    if (!source || !target || source.id === target.id || !activeIds.has(source.id) || !activeIds.has(target.id)) return;
    const id = `ctxe_${contextHash(`${type}:${source.id}:${target.id}`).slice(0, 24)}`;
    edges.push({
      id,
      type,
      source_node_id: source.id,
      target_node_id: target.id,
      order_index: Number(sourceInfo.order_index || 0),
      source: sourceInfo,
      version: 1,
      created_at: timestamp
    });
  };
}

function addContainmentEdges(state, activeIds, nodesById, push) {
  for (const node of state.context_nodes.filter((item) => activeIds.has(item.id) && item.parent_id)) {
    const parent = nodesById.get(node.parent_id);
    push('contains', parent, node, { type: 'projection_tree', order_index: node.sort?.order_index || 0 });
  }
}

function addWorkflowDependencyEdges(state, bySource, push) {
  for (const record of state.workflow_nodes || []) {
    const target = bySource.get(`workflow_nodes:${record.id}`);
    for (const value of record.dependencies || record.dependency_ids || []) {
      const dependencyId = typeof value === 'string' ? value : value?.node_id || value?.id;
      push('depends_on', target, bySource.get(`workflow_nodes:${dependencyId}`), {
        type: 'source_field',
        collection: 'workflow_nodes',
        field: 'dependencies'
      });
    }
  }
}

function addAssetProductionEdges(state, bySource, push) {
  for (const asset of state.assets || [])
    push('produces', bySource.get(`workflow_nodes:${asset.node_id}`), bySource.get(`assets:${asset.id}`), {
      type: 'source_field',
      collection: 'assets',
      field: 'node_id'
    });
}

function addAssetRelationEdges(state, bySource, push) {
  for (const relation of state.asset_relations || [])
    push(
      contextAssetRelationType(relation),
      bySource.get(`asset_versions:${relation.target_asset_version_id}`) ||
        bySource.get(`assets:${relation.target_asset_id}`),
      bySource.get(`asset_versions:${relation.source_asset_version_id}`) ||
        bySource.get(`assets:${relation.source_asset_id}`),
      { type: 'source_record', collection: 'asset_relations', id: relation.id }
    );
}

function addExecutionEdges(state, bySource, push) {
  for (const run of state.node_runs || [])
    push('executes', bySource.get(`node_runs:${run.id}`), bySource.get(`workflow_nodes:${run.node_id}`), {
      type: 'source_field',
      collection: 'node_runs',
      field: 'node_id'
    });
  for (const execution of state.task_executions || [])
    push(
      'executes',
      bySource.get(`task_executions:${execution.id}`),
      bySource.get(`workflow_nodes:${execution.task_id}`),
      { type: 'source_field', collection: 'task_executions', field: 'task_id' }
    );
}

function addAssistSessionEdges(state, bySource, push) {
  for (const session of state.assist_sessions || []) {
    const scopeCollection = assistScopeCollection(session.scope_type);
    push(
      'discussed_in',
      bySource.get(`${scopeCollection}:${session.scope_id}`),
      bySource.get(`assist_sessions:${session.id}`),
      { type: 'source_field', collection: 'assist_sessions', field: 'scope_id' }
    );
  }
}

function assistScopeCollection(scopeType) {
  if (['task', 'workstream'].includes(scopeType)) return 'workflow_nodes';
  return scopeType === 'workflow' ? 'workflows' : 'projects';
}

function addEvidenceAndSupersessionEdges(state, bySource, push) {
  for (const collection of Object.keys(state)) {
    if (!Array.isArray(state[collection]) || CONTEXT_INTERNAL_COLLECTIONS.includes(collection)) continue;
    for (const record of state[collection]) addRecordReferenceEdges(collection, record, bySource, push);
  }
}

function addRecordReferenceEdges(collection, record, bySource, push) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  const source = bySource.get(`${collection}:${contextSourceRecordId(collection, record)}`);
  for (const evidence of record.evidence_refs || []) {
    const [targetCollection, targetId] = String(evidence).split(':');
    const target = bySource.get(`${normalizeEvidenceCollection(targetCollection)}:${targetId}`);
    push('evidenced_by', source, target, { type: 'source_field', collection, field: 'evidence_refs' });
  }
  if (record.supersedes_id)
    push('supersedes', source, bySource.get(`${collection}:${record.supersedes_id}`), {
      type: 'source_field',
      collection,
      field: 'supersedes_id'
    });
}

function contextAssetRelationType(relation) {
  return ['verified_against', 'evidenced_by'].includes(relation?.relation_type) ? 'evidenced_by' : 'derived_from';
}

function normalizeEvidenceCollection(value) {
  return (
    {
      asset: 'assets',
      asset_version: 'asset_versions',
      node_run: 'node_runs',
      run: 'node_runs',
      trace: 'traces',
      decision: 'decisions',
      task_execution: 'task_executions'
    }[value] || value
  );
}
