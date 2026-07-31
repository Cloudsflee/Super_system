import { contextHash } from './protocol.mjs';
import { contextDocumentRelationSnapshot } from './rendering.mjs';

export function captureProjectionSources(nodes) {
  return new Map(
    nodes.map((node) => [
      node.id,
      { source_hash: node.source_hash || null, source_generation: Number(node.source_generation || 0) }
    ])
  );
}

export function mergeDesiredProjectionNodes(state, desiredNodes) {
  const priorNodes = new Map(state.context_nodes.map((node) => [node.id, node])),
    activeSourceKeys = new Set();
  for (const desired of desiredNodes) {
    const sourceKey =
      desired.source_collection && desired.source_id ? `${desired.source_collection}:${desired.source_id}` : null;
    if (sourceKey) activeSourceKeys.add(sourceKey);
    const prior = priorNodes.get(desired.id);
    if (!prior) {
      state.context_nodes.push(desired);
      continue;
    }
    const currentVersionId = prior.current_version_id || null,
      unchanged = contextNodeProjectionHash(prior) === contextNodeProjectionHash(desired);
    Object.assign(prior, desired, {
      current_version_id: currentVersionId,
      created_at: prior.created_at || desired.created_at,
      updated_at: unchanged ? prior.updated_at || desired.updated_at : desired.updated_at,
      freshness: {
        ...desired.freshness,
        ...(unchanged && prior.freshness?.checked_at ? { checked_at: prior.freshness.checked_at } : {})
      }
    });
  }
  return activeSourceKeys;
}

export function tombstoneMissingSourceNodes(state, activeSourceKeys, timestamp) {
  for (const node of state.context_nodes) {
    if (!node.source_collection || !node.source_id || node.status === 'tombstone') continue;
    if (activeSourceKeys.has(`${node.source_collection}:${node.source_id}`)) continue;
    const sourceRecordHash = contextHash({
      tombstone: true,
      collection: node.source_collection,
      id: node.source_id
    });
    Object.assign(node, {
      kind: 'tombstone',
      status: 'tombstone',
      parent_id: null,
      freshness: { ...(node.freshness || {}), status: 'superseded', tombstoned_at: timestamp },
      source_record_hash: sourceRecordHash,
      source_hash: sourceRecordHash,
      updated_at: timestamp
    });
  }
}

export function retireDetachedProjectionNodes(state, desiredNodes, timestamp) {
  const desiredIds = new Set(desiredNodes.map((node) => node.id)),
    projectIds = new Set((state.projects || []).map((project) => String(project.id)));
  for (const node of state.context_nodes) {
    const retiredProjection = node.source_type === 'projection' && !desiredIds.has(node.id),
      orphanedResource =
        node.source_type === 'resource' &&
        ((node.project_id && !projectIds.has(String(node.project_id))) ||
          (node.parent_id &&
            !state.context_nodes.some((parent) => parent.id === node.parent_id && parent.status !== 'tombstone')));
    if ((!retiredProjection && !orphanedResource) || node.status === 'tombstone') continue;
    tombstoneProjectionNode(node, timestamp, retiredProjection ? 'projection_retired' : 'resource_orphaned');
  }
}

export function buildProjectionIndexes(state, nodeById) {
  const versionById = new Map(state.context_document_versions.map((version) => [version.id, version])),
    versionsByNode = new Map(),
    jobsById = new Map(state.context_projection_jobs.map((job) => [job.id, job])),
    edgesByNode = new Map();
  for (const version of state.context_document_versions) {
    const versions = versionsByNode.get(version.node_id) || [];
    versions.push(version);
    versionsByNode.set(version.node_id, versions);
  }
  for (const edge of state.context_edges) {
    for (const nodeId of [edge.source_node_id, edge.target_node_id]) {
      const edges = edgesByNode.get(nodeId) || [];
      edges.push(edge);
      edgesByNode.set(nodeId, edges);
    }
  }
  return { nodeById, versionById, versionsByNode, jobsById, edgesByNode };
}

export function stageChangedProjectionNodes({ state, indexes, priorNodeSources, timestamp, force, stageJob }) {
  let dirty = 0;
  for (const node of state.context_nodes) {
    const sourceRecordHash = node.source_record_hash || node.source_hash,
      adjacentEdges = indexes.edgesByNode.get(node.id) || [],
      relatedIds = new Set(
        adjacentEdges
          .flatMap((edge) => [edge.source_node_id, edge.target_node_id])
          .filter((nodeId) => nodeId !== node.id)
      ),
      relatedNodes = [...relatedIds].map((nodeId) => indexes.nodeById.get(nodeId)).filter(Boolean),
      relationSnapshot = contextDocumentRelationSnapshot(node, adjacentEdges, relatedNodes),
      priorSource = priorNodeSources.get(node.id);
    node.source_record_hash = sourceRecordHash;
    node.source_hash = contextHash({ source_record_hash: sourceRecordHash, relations: relationSnapshot });
    node.source_generation =
      priorSource?.source_hash === node.source_hash
        ? Math.max(1, priorSource.source_generation || 1)
        : Math.max(1, Number(priorSource?.source_generation || 0) + 1);
    const currentVersion = indexes.versionById.get(node.current_version_id);
    if (!force && currentVersion?.source_hash === node.source_hash) continue;
    stageJob(state, node, timestamp, indexes);
    dirty += 1;
  }
  return dirty;
}

export function stableProjectionCoverage(state, collections, warnings, timestamp) {
  const coverage = {
      source_records: collections.reduce((count, name) => count + state[name].length, 0),
      projected_records: state.context_nodes.filter((node) => node.source_collection && node.status !== 'tombstone')
        .length,
      tombstones: state.context_nodes.filter((node) => node.status === 'tombstone').length,
      warnings,
      checked_at: timestamp
    },
    previous = state.context_projection_coverage || null;
  if (previous && contextHash({ ...previous, checked_at: null }) === contextHash({ ...coverage, checked_at: null }))
    coverage.checked_at = previous.checked_at || coverage.checked_at;
  return coverage;
}

function contextNodeProjectionHash(node) {
  const stable = { ...(node || {}), freshness: { ...(node?.freshness || {}) } };
  for (const key of ['created_at', 'updated_at', 'current_version_id', 'source_hash', 'source_generation'])
    delete stable[key];
  delete stable.freshness.checked_at;
  return contextHash(stable);
}

function tombstoneProjectionNode(node, timestamp, reason) {
  const sourceRecordHash = contextHash({ tombstone: true, id: node.id, reason });
  Object.assign(node, {
    kind: 'tombstone',
    status: 'tombstone',
    parent_id: null,
    freshness: { ...(node.freshness || {}), status: 'superseded', tombstoned_at: timestamp },
    source_record_hash: sourceRecordHash,
    source_hash: sourceRecordHash,
    updated_at: timestamp
  });
}
