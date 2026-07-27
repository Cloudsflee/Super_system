import {
  CATEGORY_LABELS,
  COLLECTION_SCOPE,
  CONTEXT_CATEGORY_ORDER,
  CONTEXT_EDGE_TYPES,
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_INTERNAL_COLLECTIONS,
  CONTEXT_PROTOCOL_VERSION,
  CONTEXT_SELECTION_SCHEMA,
  CONTEXT_STATE_ADAPTERS,
  SECRET_KEY,
  TYPE_ORDER,
  URI_PATTERN,
  canonicalJson,
  compareContextNodes,
  contextDirectoryId,
  contextError,
  contextHash,
  contextNodeId,
  contextNodeUri,
  contextSourceHash,
  contextSourceRecordId,
  defaultCollectionScope,
  sanitizeContextFacts,
  uniqueBy
} from './protocol.mjs';
import {
  cleanContextInline as cleanInline,
  compareContextEdges as compareEdges,
  contextDocumentRelationSnapshot
} from './rendering.mjs';
import {
  ensureUniqueIds,
  validateContainsTree,
  validateContextSelections,
  validateNodeHashes,
  validSha
} from './validation.mjs';

export * from './search-index.mjs';
export { compactContextMap, contextDocumentRelationSnapshot, renderContextMarkdown } from './rendering.mjs';

export {
  CONTEXT_CATEGORY_ORDER,
  CONTEXT_EDGE_TYPES,
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_INTERNAL_COLLECTIONS,
  CONTEXT_PACK_SCHEMA,
  CONTEXT_PROTOCOL_VERSION,
  CONTEXT_RENDERER_VERSION,
  CONTEXT_SELECTION_SCHEMA,
  CONTEXT_STATE_ADAPTERS,
  canonicalJson,
  compareContextNodes,
  contextDirectoryId,
  contextHash,
  contextMapUri,
  contextNodeId,
  contextNodeUri,
  contextSourceHash,
  contextSourceRecordId,
  sanitizeContextFacts,
  tokenizeContextText
} from './protocol.mjs';

export function reconcileContextProjectionState(
  state,
  { sourceCollections = Object.keys(state), timestamp = new Date().toISOString(), force = false } = {}
) {
  ensureContextCollections(state);
  const collections = sourceCollections.filter(
    (name) => !CONTEXT_INTERNAL_COLLECTIONS.includes(name) && Array.isArray(state[name])
  );
  const priorNodes = new Map(state.context_nodes.map((node) => [node.id, node]));
  const desiredNodes = buildDesiredNodes(state, collections, timestamp);
  const activeSourceKeys = new Set();
  let dirty = 0;

  for (const desired of desiredNodes) {
    const key =
      desired.source_collection && desired.source_id ? `${desired.source_collection}:${desired.source_id}` : null;
    if (key) activeSourceKeys.add(key);
    const prior = priorNodes.get(desired.id);
    if (prior) {
      const currentVersionId = prior.current_version_id || null;
      Object.assign(prior, desired, {
        current_version_id: currentVersionId,
        created_at: prior.created_at || desired.created_at
      });
    } else state.context_nodes.push(desired);
  }

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

  const desiredIds = new Set(desiredNodes.map((node) => node.id));
  const projectIds = new Set((state.projects || []).map((project) => String(project.id)));
  for (const node of state.context_nodes) {
    const retiredProjection = node.source_type === 'projection' && !desiredIds.has(node.id);
    const orphanedResource =
      node.source_type === 'resource' &&
      ((node.project_id && !projectIds.has(String(node.project_id))) ||
        (node.parent_id &&
          !state.context_nodes.some((parent) => parent.id === node.parent_id && parent.status !== 'tombstone')));
    if ((!retiredProjection && !orphanedResource) || node.status === 'tombstone') continue;
    tombstoneContextNode(state, node, timestamp, retiredProjection ? 'projection_retired' : 'resource_orphaned');
  }

  const activeIds = new Set(state.context_nodes.filter((node) => node.status !== 'tombstone').map((node) => node.id));
  const nodeById = new Map(state.context_nodes.map((node) => [node.id, node]));
  const desiredEdges = buildDesiredEdges(state, activeIds, timestamp, nodeById);
  state.context_edges = mergeCurrentEdges(state.context_edges, desiredEdges);
  const versionById = new Map(state.context_document_versions.map((version) => [version.id, version]));
  const versionsByNode = new Map();
  for (const version of state.context_document_versions) {
    const versions = versionsByNode.get(version.node_id) || [];
    versions.push(version);
    versionsByNode.set(version.node_id, versions);
  }
  const jobsById = new Map(state.context_projection_jobs.map((job) => [job.id, job]));
  const edgesByNode = new Map();
  for (const edge of state.context_edges) {
    for (const nodeId of [edge.source_node_id, edge.target_node_id]) {
      const edges = edgesByNode.get(nodeId) || [];
      edges.push(edge);
      edgesByNode.set(nodeId, edges);
    }
  }
  for (const node of state.context_nodes) {
    const sourceRecordHash = node.source_record_hash || node.source_hash,
      adjacentEdges = edgesByNode.get(node.id) || [],
      relatedIds = new Set(
        adjacentEdges
          .flatMap((edge) => [edge.source_node_id, edge.target_node_id])
          .filter((nodeId) => nodeId !== node.id)
      ),
      relatedNodes = [...relatedIds].map((nodeId) => nodeById.get(nodeId)).filter(Boolean),
      relationSnapshot = contextDocumentRelationSnapshot(node, adjacentEdges, relatedNodes);
    node.source_record_hash = sourceRecordHash;
    node.source_hash = contextHash({ source_record_hash: sourceRecordHash, relations: relationSnapshot });
    const currentVersion = versionById.get(node.current_version_id);
    if (force || !currentVersion || currentVersion.source_hash !== node.source_hash) {
      stageContextProjectionJob(state, node, timestamp, { jobsById, versionsByNode });
      dirty += 1;
    }
  }
  const warnings = coverageWarnings(state, collections);
  state.context_projection_coverage = {
    source_records: collections.reduce((count, name) => count + state[name].length, 0),
    projected_records: state.context_nodes.filter((node) => node.source_collection && node.status !== 'tombstone')
      .length,
    tombstones: state.context_nodes.filter((node) => node.status === 'tombstone').length,
    warnings,
    checked_at: timestamp
  };
  return { dirty, warnings, nodes: state.context_nodes.length, edges: state.context_edges.length };
}

export function ensureContextCollections(state) {
  for (const name of CONTEXT_INTERNAL_COLLECTIONS) if (!Array.isArray(state[name])) state[name] = [];
  return state;
}

export function createContextSelection(
  state,
  {
    id,
    actorId,
    sessionId = null,
    projectId = null,
    anchorNodeId = null,
    candidateNodeIds = [],
    tokenBudget = 4000,
    scopes = null,
    allowedProjectIds = null,
    explicitRefs = [],
    candidateRanks = null,
    alreadyBudgetedDocumentVersionIds = [],
    timestamp = new Date().toISOString()
  }
) {
  ensureContextCollections(state);
  const policy = findContextPolicy(state, { actorId, sessionId, projectId });
  const pinned = new Set(policy?.pinned_node_ids || []),
    excludedByUser = new Set(policy?.excluded_node_ids || []),
    explicit = new Set(explicitRefs),
    scopeSet = scopes ? new Set(scopes) : null,
    allowedProjects = allowedProjectIds ? new Set(allowedProjectIds) : null,
    alreadyBudgeted = new Set(alreadyBudgetedDocumentVersionIds),
    rankByNode = normalizeCandidateRanks(candidateRanks),
    nodeById = new Map(state.context_nodes.map((node) => [node.id, node])),
    versionById = new Map(state.context_document_versions.map((version) => [version.id, version]));
  const candidates = [...new Set([...pinned, ...candidateNodeIds])]
    .map((nodeId) => nodeById.get(nodeId))
    .filter(Boolean)
    .sort((left, right) =>
      compareSelectionCandidates(left, right, {
        pinned,
        explicit,
        projectId,
        anchorNodeId,
        rankByNode,
        nodeById,
        edges: state.context_edges
      })
    );
  const included = [],
    excluded = [];
  let used = 0;
  for (const node of candidates) {
    const version = versionById.get(node.current_version_id);
    const reason = exclusionReason(node, version, {
      projectId,
      excludedByUser,
      scopeSet,
      allowedProjects
    });
    const tokens = Number(version?.token_estimate || 0),
      chargedTokens = alreadyBudgeted.has(version?.id) ? 0 : tokens;
    if (reason) {
      excluded.push(selectionExclusion(node, version, reason));
      continue;
    }
    if (used + chargedTokens > tokenBudget) {
      excluded.push(selectionExclusion(node, version, 'budget_exceeded'));
      continue;
    }
    used += chargedTokens;
    included.push({
      node_id: node.id,
      document_version_id: version.id,
      content_sha256: version.content_sha256,
      token_estimate: tokens,
      reason: pinned.has(node.id)
        ? 'user_pinned'
        : isExplicitNode(node, explicit)
          ? 'explicit_reference'
          : node.id === anchorNodeId
            ? 'current_anchor'
            : 'ranked_candidate'
    });
  }
  const mapSnapshot = state.context_nodes
    .filter((node) => !projectId || !node.project_id || node.project_id === projectId)
    .slice()
    .sort(compareContextNodes)
    .map((node) => [node.id, node.source_hash, node.current_version_id, node.status]);
  return {
    id,
    schema_version: CONTEXT_SELECTION_SCHEMA,
    actor_id: actorId,
    session_id: sessionId,
    project_id: projectId,
    anchor_node_id: anchorNodeId,
    candidate_node_ids: candidates.map((node) => node.id),
    included,
    excluded,
    token_budget: Number(tokenBudget),
    token_used: used,
    map_snapshot_hash: contextHash(mapSnapshot),
    immutable: true,
    created_at: timestamp
  };
}

export function upsertContextPolicy(
  state,
  { id, actorId, sessionId = null, projectId = null, pinnedNodeIds = [], excludedNodeIds = [], timestamp }
) {
  ensureContextCollections(state);
  const overlap = pinnedNodeIds.filter((nodeId) => excludedNodeIds.includes(nodeId));
  if (overlap.length) throw contextError('context_policy_conflict', { node_ids: overlap });
  const known = new Set(state.context_nodes.map((node) => node.id));
  const unknown = [...pinnedNodeIds, ...excludedNodeIds].filter((nodeId) => !known.has(nodeId));
  if (unknown.length) throw contextError('context_policy_node_missing', { node_ids: [...new Set(unknown)] });
  const existing = findContextPolicy(state, { actorId, sessionId, projectId });
  const next = {
    id: existing?.id || id,
    actor_id: actorId,
    session_id: sessionId,
    project_id: projectId,
    pinned_node_ids: [...new Set(pinnedNodeIds)].sort(),
    excluded_node_ids: [...new Set(excludedNodeIds)].sort(),
    revision: Number(existing?.revision || 0) + 1,
    created_at: existing?.created_at || timestamp,
    updated_at: timestamp
  };
  if (existing) Object.assign(existing, next);
  else state.context_policies.push(next);
  return next;
}

export function findContextPolicy(state, { actorId, sessionId = null, projectId = null }) {
  return (
    state.context_policies?.find(
      (item) =>
        item.actor_id === actorId &&
        (item.session_id || null) === (sessionId || null) &&
        (item.project_id || null) === (projectId || null)
    ) || null
  );
}

export function validateContextState(state, { sourceCollections = [] } = {}) {
  ensureContextCollections(state);
  for (const name of CONTEXT_INTERNAL_COLLECTIONS) ensureUniqueIds(state[name], name);
  const nodeIds = new Set(state.context_nodes.map((node) => node.id));
  const versionIds = new Set(state.context_document_versions.map((version) => version.id)),
    versionById = new Map(state.context_document_versions.map((version) => [version.id, version])),
    selectionIds = new Set(state.context_selections.map((selection) => selection.id));
  const uriSet = new Set();
  for (const node of state.context_nodes) {
    if (!URI_PATTERN.test(String(node.uri || '')))
      throw contextError('context_node_uri_invalid', { id: node.id, uri: node.uri });
    if (uriSet.has(node.uri)) throw contextError('context_node_uri_duplicate', { uri: node.uri });
    uriSet.add(node.uri);
    if (node.parent_id && !nodeIds.has(node.parent_id))
      throw contextError('context_node_parent_missing', { id: node.id, parent_id: node.parent_id });
    if (node.current_version_id && !versionIds.has(node.current_version_id))
      throw contextError('context_node_version_missing', { id: node.id, version_id: node.current_version_id });
    if (!['public', 'internal', 'restricted', 'secret'].includes(node.sensitivity))
      throw contextError('context_node_sensitivity_invalid', { id: node.id });
    validateNodeHashes(node);
  }
  validateContainsTree(state.context_nodes, state.context_edges);
  for (const edge of state.context_edges) {
    if (!CONTEXT_EDGE_TYPES.includes(edge.type)) throw contextError('context_edge_type_invalid', { id: edge.id });
    if (!nodeIds.has(edge.source_node_id) || !nodeIds.has(edge.target_node_id))
      throw contextError('context_edge_node_missing', { id: edge.id });
  }
  for (const version of state.context_document_versions) {
    if (!nodeIds.has(version.node_id) || version.immutable !== true)
      throw contextError('context_document_invalid', { id: version.id });
    if (!validSha(version.content_sha256) || !validSha(version.source_hash) || !validSha(version.markdown_hash))
      throw contextError('context_document_hash_invalid', { id: version.id });
    if (version.content_sha256 !== version.markdown_hash)
      throw contextError('context_document_content_hash_mismatch', { id: version.id });
    if (!version.cas_ref || version.cas_ref.sha256 !== version.content_sha256)
      throw contextError('context_document_cas_ref_invalid', { id: version.id });
  }
  validateContextSelections(state.context_selections, { nodeIds, versionById, selectionIds });
  const expectedSources = new Set(
    sourceCollections
      .filter((name) => !CONTEXT_INTERNAL_COLLECTIONS.includes(name) && Array.isArray(state[name]))
      .flatMap((name) => state[name].map((record) => `${name}:${contextSourceRecordId(name, record)}`))
  );
  const coveredSources = new Set(
    state.context_nodes
      .filter((node) => node.source_collection && node.source_id && node.status !== 'tombstone')
      .map((node) => `${node.source_collection}:${node.source_id}`)
  );
  const missing = [...expectedSources].filter((key) => !coveredSources.has(key));
  if (missing.length) throw contextError('context_projection_coverage_incomplete', { missing: missing.slice(0, 100) });
  return state;
}

export function assertContextImmutability(before, after, { allowDeletion = false } = {}) {
  for (const collection of ['context_document_versions', 'context_selections']) {
    const nextById = new Map((after[collection] || []).map((item) => [item.id, item]));
    for (const item of before[collection] || []) {
      const next = nextById.get(item.id);
      if ((!next && !allowDeletion) || (next && canonicalJson(item) !== canonicalJson(next)))
        throw contextError('context_immutable_record_changed', { collection, id: item.id });
    }
  }
}

function buildDesiredNodes(state, collections, timestamp) {
  const desired = [systemRoot(timestamp)];
  for (const collection of collections) {
    for (const record of state[collection]) {
      const node = sourceNode(state, collection, record, timestamp);
      desired.push(node);
    }
  }
  const nodeLookup = new Map(desired.map((node) => [`${node.source_collection}:${node.source_id}`, node]));
  const categoryNodes = new Map();
  for (const node of desired.filter((item) => item.source_collection)) {
    const direct = directParentNode(state, node, nodeLookup);
    if (direct) {
      node.parent_id = direct.id;
      continue;
    }
    if (node.kind === 'project') {
      node.parent_id = 'ctx_root_system';
      continue;
    }
    const projectNode = node.project_id ? nodeLookup.get(`projects:${node.project_id}`) : null;
    const category = collectionCategory(node.source_collection);
    const baseParent = projectNode?.id || 'ctx_root_system';
    const categoryKey = `${baseParent}:${category}`;
    if (!categoryNodes.has(categoryKey)) {
      const categoryNode = directoryNode(baseParent, category, node.project_id, timestamp);
      categoryNodes.set(categoryKey, categoryNode);
    }
    node.parent_id = categoryNodes.get(categoryKey).id;
  }
  desired.push(...categoryNodes.values());
  const desiredIds = new Set(desired.map((node) => node.id));
  for (const node of desired) if (node.parent_id && !desiredIds.has(node.parent_id)) node.parent_id = 'ctx_root_system';
  return desired.sort(compareContextNodes);
}

function systemRoot(timestamp) {
  const sourceHash = contextHash({ type: 'system', protocol: CONTEXT_PROTOCOL_VERSION });
  return {
    id: 'ctx_root_system',
    uri: 'aiws://context/map/global',
    kind: 'system',
    source_type: 'projection',
    source_collection: null,
    source_id: null,
    source_version: 1,
    project_id: null,
    parent_id: null,
    title: '系统',
    deterministic_summary: 'AI 工作空间系统上下文地图根目录。',
    sort: { type_order: TYPE_ORDER.system, order_index: 0, stable_id: 'ctx_root_system' },
    scope: { type: 'system', id: 'system', project_id: null },
    sensitivity: 'internal',
    required_scopes: ['context:read'],
    freshness: { status: 'current', source_updated_at: null },
    authority: 'authoritative',
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp
  };
}

function sourceNode(state, collection, record, timestamp) {
  const sourceId = contextSourceRecordId(collection, record),
    id = contextNodeId(collection, sourceId),
    projectId = resolveRecordProjectId(state, collection, record),
    kind = sourceKind(collection, record),
    title = sourceTitle(collection, record),
    sourceHash = contextSourceHash(collection, record),
    freshnessStatus = sourceFreshness(record),
    sensitivity = sourceSensitivity(collection, record);
  return {
    id,
    uri: contextNodeUri(id),
    kind,
    source_type: 'state',
    source_collection: collection,
    source_id: sourceId,
    source_version: Number(record.version || record.revision || record.workflow_revision || 1),
    project_id: projectId,
    parent_id: null,
    title,
    deterministic_summary: deterministicSummary(collection, record, title),
    sort: {
      type_order: TYPE_ORDER[kind] ?? TYPE_ORDER.record,
      order_index: Number(record.order_index || record.sequence || record.position || 0),
      stable_id: sourceId
    },
    scope: { type: projectId ? 'project' : 'system', id: projectId || 'system', project_id: projectId },
    sensitivity,
    required_scopes: [
      'context:read',
      CONTEXT_STATE_ADAPTERS[collection]?.scope || (projectId ? 'project:read' : 'system:read')
    ],
    freshness: {
      status: freshnessStatus,
      source_updated_at: record.updated_at || record.created_at || null,
      checked_at: timestamp
    },
    authority: sourceAuthority(collection, record),
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp
  };
}

function directoryNode(parentId, category, projectId, timestamp) {
  const id = contextDirectoryId(parentId, category),
    sourceHash = contextHash({ parentId, category, protocol: CONTEXT_PROTOCOL_VERSION });
  return {
    id,
    uri: `aiws://context/directories/${id}`,
    kind: category,
    source_type: 'projection',
    source_collection: null,
    source_id: null,
    source_version: 1,
    project_id: projectId || null,
    parent_id: parentId,
    title: CATEGORY_LABELS[category],
    deterministic_summary: `${CATEGORY_LABELS[category]}上下文的有序目录。`,
    sort: { type_order: TYPE_ORDER[category], order_index: 0, stable_id: id },
    scope: { type: projectId ? 'project' : 'system', id: projectId || 'system', project_id: projectId || null },
    sensitivity: 'internal',
    required_scopes: ['context:read', projectId ? 'project:read' : 'system:read'],
    freshness: { status: 'current', source_updated_at: null },
    authority: 'authoritative',
    source_record_hash: sourceHash,
    source_hash: sourceHash,
    current_version_id: null,
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp
  };
}

function directParentNode(state, node, lookup) {
  const record = state[node.source_collection]?.find(
    (item) => contextSourceRecordId(node.source_collection, item) === node.source_id
  );
  if (!record) return null;
  const reference = directParentReference(state, node.source_collection, record);
  return reference ? lookup.get(`${reference.collection}:${reference.id}`) || null : null;
}

function directParentReference(state, collection, record) {
  if (collection === 'workflows') return ref('projects', record.project_id);
  if (collection === 'workflow_nodes') {
    if (record.parent_node_id) return ref('workflow_nodes', record.parent_node_id);
    return ref('workflows', record.workflow_id);
  }
  if (collection === 'node_contracts') return ref('workflow_nodes', record.node_id);
  if (collection === 'asset_versions') return ref('assets', record.asset_id);
  if (collection === 'asset_attestations') return ref('asset_versions', record.asset_version_id);
  if (collection === 'node_runs') return ref('workflow_nodes', record.node_id);
  if (collection === 'task_executions') return ref('workflow_nodes', record.task_id);
  if (collection === 'workflow_executions') return ref('workflows', record.workflow_id);
  if (collection === 'execution_events')
    return record.task_execution_id
      ? ref('task_executions', record.task_execution_id)
      : ref('workflow_executions', record.workflow_execution_id);
  if (collection === 'repository_lines') return ref('workflow_nodes', record.workstream_id);
  if (collection === 'repository_targets') return ref('workflow_nodes', record.task_id || record.workstream_id);
  if (collection === 'deliveries') return ref('workflow_nodes', record.task_id || record.workstream_id);
  if (collection === 'assist_turns') return ref('assist_sessions', record.session_id);
  if (collection === 'assist_messages' || collection === 'assist_events')
    return ref('assist_turns', record.turn_id) || ref('assist_sessions', record.session_id);
  if (collection === 'attachments')
    return ref('assist_turns', record.turn_id) || ref('assist_sessions', record.session_id);
  if (collection === 'workspaces' && record.workflow_node_id) return ref('workflow_nodes', record.workflow_node_id);
  if (record.node_id) return ref('workflow_nodes', record.node_id);
  if (record.task_id) return ref('workflow_nodes', record.task_id);
  if (record.workstream_id) return ref('workflow_nodes', record.workstream_id);
  if (record.workflow_id) return ref('workflows', record.workflow_id);
  return null;
}

function buildDesiredEdges(state, activeIds, timestamp, nodeById = null) {
  const edges = [];
  const allNodesById = nodeById || new Map(state.context_nodes.map((node) => [node.id, node]));
  const bySource = new Map(
    state.context_nodes
      .filter((node) => node.source_collection && node.source_id && activeIds.has(node.id))
      .map((node) => [`${node.source_collection}:${node.source_id}`, node])
  );
  const push = (type, source, target, sourceInfo = {}) => {
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
  for (const node of state.context_nodes.filter((item) => activeIds.has(item.id) && item.parent_id)) {
    const parent = allNodesById.get(node.parent_id);
    push('contains', parent, node, { type: 'projection_tree', order_index: node.sort?.order_index || 0 });
  }
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
  for (const asset of state.assets || [])
    push('produces', bySource.get(`workflow_nodes:${asset.node_id}`), bySource.get(`assets:${asset.id}`), {
      type: 'source_field',
      collection: 'assets',
      field: 'node_id'
    });
  for (const relation of state.asset_relations || [])
    push(
      contextAssetRelationType(relation),
      bySource.get(`asset_versions:${relation.target_asset_version_id}`) ||
        bySource.get(`assets:${relation.target_asset_id}`),
      bySource.get(`asset_versions:${relation.source_asset_version_id}`) ||
        bySource.get(`assets:${relation.source_asset_id}`),
      { type: 'source_record', collection: 'asset_relations', id: relation.id }
    );
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
      {
        type: 'source_field',
        collection: 'task_executions',
        field: 'task_id'
      }
    );
  for (const session of state.assist_sessions || []) {
    const scopeCollection = ['task', 'workstream'].includes(session.scope_type)
      ? 'workflow_nodes'
      : session.scope_type === 'workflow'
        ? 'workflows'
        : 'projects';
    push(
      'discussed_in',
      bySource.get(`${scopeCollection}:${session.scope_id}`),
      bySource.get(`assist_sessions:${session.id}`),
      {
        type: 'source_field',
        collection: 'assist_sessions',
        field: 'scope_id'
      }
    );
  }
  for (const collection of Object.keys(state)) {
    if (!Array.isArray(state[collection]) || CONTEXT_INTERNAL_COLLECTIONS.includes(collection)) continue;
    for (const record of state[collection]) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
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
  }
  return uniqueBy(edges, (edge) => edge.id).sort(compareEdges);
}

function contextAssetRelationType(relation) {
  return ['verified_against', 'evidenced_by'].includes(relation?.relation_type) ? 'evidenced_by' : 'derived_from';
}

function mergeCurrentEdges(existing, desired) {
  const created = new Map(existing.map((edge) => [edge.id, edge.created_at]));
  return desired.map((edge) => ({ ...edge, created_at: created.get(edge.id) || edge.created_at }));
}

export function stageContextProjectionJob(state, node, timestamp, indexes = null) {
  const id = `ctxjob_${contextHash(`${node.id}:${node.source_hash}`).slice(0, 24)}`;
  const jobsById = indexes?.jobsById || new Map(state.context_projection_jobs.map((job) => [job.id, job]));
  const versionsByNode =
    indexes?.versionsByNode ||
    state.context_document_versions.reduce((map, version) => {
      const versions = map.get(version.node_id) || [];
      versions.push(version);
      map.set(version.node_id, versions);
      return map;
    }, new Map());
  const existing = jobsById.get(id);
  if (existing?.status === 'completed') {
    const reusable = (versionsByNode.get(node.id) || [])
      .filter((version) => version.source_hash === node.source_hash)
      .sort(
        (left, right) =>
          Number(right.version || 0) - Number(left.version || 0) ||
          String(right.created_at || '').localeCompare(String(left.created_at || ''))
      )[0];
    if (reusable) {
      node.current_version_id = reusable.id;
      return;
    }
  }
  if (existing?.status === 'failed') return;
  const value = {
    id,
    node_id: node.id,
    expected_source_hash: node.source_hash,
    status: 'pending',
    attempts: Number(existing?.attempts || 0),
    error_code: null,
    next_retry_at: null,
    created_at: existing?.created_at || timestamp,
    updated_at: timestamp,
    completed_at: null
  };
  if (existing) Object.assign(existing, value);
  else {
    state.context_projection_jobs.push(value);
    jobsById.set(id, value);
  }
}

function tombstoneContextNode(state, node, timestamp, reason) {
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

function coverageWarnings(state, collections) {
  const warnings = (state.context_resource_coverage?.warnings || []).map((item) => structuredClone(item));
  for (const collection of collections) {
    if (knownCollection(collection)) continue;
    if (state[collection].length)
      warnings.push({ code: 'context_adapter_uncategorized', collection, record_count: state[collection].length });
  }
  return warnings.sort(
    (left, right) =>
      String(left.code || '').localeCompare(String(right.code || '')) ||
      String(left.project_id || left.collection || '').localeCompare(String(right.project_id || right.collection || ''))
  );
}

function sourceKind(collection, record) {
  if (collection === 'projects') return 'project';
  if (collection === 'workflows' || collection === 'workflow_drafts') return 'workflow';
  if (collection === 'workflow_nodes')
    return record.role === 'workstream' ? 'outcome' : record.role === 'task' ? 'task' : 'record';
  return 'record';
}

function sourceTitle(collection, record) {
  const title =
    record.title ||
    record.name ||
    record.display_name ||
    record.summary ||
    record.label ||
    record.event_type ||
    record.type ||
    record.key;
  return cleanInline(title ? String(title) : `${collection}/${record.id}`);
}

function deterministicSummary(collection, record, title) {
  const summary = record.summary || record.goal || record.description || record.outcome || record.message;
  const status = record.status ? `状态：${record.status}。` : '';
  return cleanInline(
    summary ? `${summary}${status ? ` ${status}` : ''}` : `${title} 的 ${collection} 权威记录。${status}`
  );
}

function sourceFreshness(record) {
  const status = String(record.status || '').toLowerCase();
  if (
    ['superseded', 'archived', 'deleted', 'revoked', 'expired'].includes(status) ||
    record.deleted_at ||
    record.superseded_at
  )
    return 'superseded';
  if (['stale', 'corrupt'].includes(status) || record.stale === true) return 'stale';
  return 'current';
}

function sourceSensitivity(collection, record) {
  if (collection === 'credential_refs' || SECRET_KEY.test(String(record.type || ''))) return 'secret';
  if (['mcp_clients', 'sessions', 'connected_accounts', 'github_app_configs', 'codex_profiles'].includes(collection))
    return 'restricted';
  return record.sensitivity && ['public', 'internal', 'restricted', 'secret'].includes(record.sensitivity)
    ? record.sensitivity
    : 'internal';
}

function sourceAuthority(collection, record) {
  if (record.authority) return record.authority;
  if (collection === 'context_summaries') return 'non_authoritative';
  if (record.status === 'draft' || collection.includes('draft')) return 'draft';
  return 'authoritative';
}

function resolveRecordProjectId(state, collection, record, seen = new Set()) {
  if (collection === 'projects' && record.id) return String(record.id);
  if (record.project_id) return String(record.project_id);
  const marker = `${collection}:${contextSourceRecordId(collection, record)}`;
  if (seen.has(marker)) return null;
  seen.add(marker);
  const parent = directParentReference(state, collection, record);
  if (parent) {
    const target = state[parent.collection]?.find((item) => String(item.id) === String(parent.id));
    if (target) return resolveRecordProjectId(state, parent.collection, target, seen);
  }
  if (record.workspace_id) {
    const workspace = state.workspaces?.find((item) => item.id === record.workspace_id);
    if (workspace) return workspace.project_id || resolveRecordProjectId(state, 'workspaces', workspace, seen);
  }
  if (record.session_id) {
    const session = state.assist_sessions?.find((item) => item.id === record.session_id);
    if (session) return session.project_id || null;
  }
  if (record.turn_id) {
    const turn = state.assist_turns?.find((item) => item.id === record.turn_id);
    if (turn) return turn.project_id || resolveRecordProjectId(state, 'assist_turns', turn, seen);
  }
  if (record.asset_id) {
    const asset = state.assets?.find((item) => item.id === record.asset_id);
    if (asset) return asset.project_id || null;
  }
  if (record.workflow_execution_id) {
    const execution = state.workflow_executions?.find((item) => item.id === record.workflow_execution_id);
    if (execution) return execution.project_id || null;
  }
  if (record.source_project_id && record.target_project_id) return String(record.target_project_id);
  return null;
}

function collectionCategory(collection) {
  return CONTEXT_STATE_ADAPTERS[collection]?.category || 'uncategorized';
}

function knownCollection(collection) {
  return Boolean(CONTEXT_STATE_ADAPTERS[collection]);
}

function exclusionReason(node, version, { projectId, excludedByUser, scopeSet, allowedProjects }) {
  if (node.project_id && allowedProjects && !allowedProjects.has(node.project_id)) return 'permission_denied';
  if (scopeSet && node.required_scopes.some((scope) => !scopeSet.has(scope))) return 'permission_denied';
  if (projectId && node.project_id !== projectId) return 'cross_scope';
  if (node.sensitivity === 'secret') return 'sensitive';
  if (
    node.freshness?.status !== 'current' ||
    node.status !== 'active' ||
    !version ||
    version.source_hash !== node.source_hash
  )
    return 'stale';
  if (excludedByUser.has(node.id)) return 'user_excluded';
  return null;
}

function compareSelectionCandidates(
  left,
  right,
  { pinned, explicit, projectId, anchorNodeId, rankByNode, nodeById, edges }
) {
  return (
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

function normalizeCandidateRanks(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) return new Map(value.map((nodeId, index) => [String(nodeId), index]));
  if (value && typeof value === 'object')
    return new Map(Object.entries(value).map(([nodeId, rank]) => [nodeId, Number(rank)]));
  return new Map();
}

function candidateRank(nodeId, ranks) {
  const rank = ranks.get(nodeId);
  return Number.isFinite(Number(rank)) ? Number(rank) : Number.MAX_SAFE_INTEGER;
}

function isExplicitNode(node, explicit) {
  return explicit.has(node.id) || explicit.has(node.uri);
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

function selectionExclusion(node, version, reason) {
  return {
    node_id: node.id,
    document_version_id: version?.id || null,
    reason,
    token_estimate: Number(version?.token_estimate || 0)
  };
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

function ref(collection, id) {
  return id ? { collection, id: String(id) } : null;
}
