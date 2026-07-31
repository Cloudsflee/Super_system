import {
  compactContextMap,
  compareContextNodes,
  contextDocumentRelationSnapshot,
  contextHash,
  createContextSelection,
  findContextPolicy,
  reconcileContextProjectionState,
  searchContextSearchIndex,
  upsertContextPolicy
} from '../../../packages/system-context/src/index.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { readCasBlob } from './asset-cas.mjs';
import {
  actorForRequest,
  accessibleProjectIds,
  assertProjectRead,
  instanceOwnerId
} from './project-governance-v19.mjs';
import { collectProjectionFailures, materializeContextDocumentsInState } from './context-projection.mjs';
import { refreshContextResourcesInState, upsertBrowserSemanticResourceInState } from './context-resource-adapters.mjs';
import {
  contextRequestProjectAllowlist,
  createRuntimeReadReceipt,
  createRuntimeReadSelection,
  createRuntimeSearchSelection,
  runtimeContextBinding
} from './context-runtime-selection.mjs';
import {
  contextProjectionReusable,
  contextProjectionScopeKey,
  contextSourceCollections,
  markContextProjectionScopeVerified
} from './context-projection-cache.mjs';
import { semanticFilters, semanticLabel, semanticRoute } from './context-semantic-state.mjs';
import { mutate, readStateSnapshot } from './state.mjs';
import { contextProjectorRuntimeStatus } from './context-projector-coordinator.mjs';
import { contextStatusSnapshot } from './context-status-v21.mjs';
import { waitForProjectionLeaseSettlement } from './context-projection-wait.mjs';
import {
  contextIndexRuntimeStatus,
  ensureContextSearchIndex,
  invalidateContextIndexRuntime
} from './context-index-runtime.mjs';
import {
  assertContextAnchor,
  assertDomainScopes,
  assertNodeVisible,
  contextRequestScopes,
  nodeCanBeMaterialized,
  nodeIsVisible,
  projectionProjectIds,
  projectionSystemNodeIds,
  requireContextAdmin,
  visibleContextNodes
} from './context-service-access.mjs';
import {
  bounded,
  compareSearchResults,
  latestSelection,
  mapSnapshotHash,
  normalizeArray,
  optionalString,
  publicContextCoverage,
  publicNode,
  publicPolicy,
  publicSelection,
  publicVersion,
  searchRanking,
  selectionScore,
  sourceFacts,
  subtree
} from './context-service-presentation.mjs';

export { compactRuntimeMap, loadContextSelectionDocumentsInState } from './context-runtime-selection.mjs';

export async function ensureContextProjection({
  projectId = null,
  nodeIds = null,
  allowedProjectIds = null,
  allowedSystemNodeIds = null,
  force = false
} = {}) {
  const projectIds = allowedProjectIds == null ? null : [...allowedProjectIds].map(String),
    systemNodeIds = allowedSystemNodeIds == null ? null : [...allowedSystemNodeIds].map(String),
    scope = contextProjectionScopeKey({ projectId, nodeIds, projectIds, systemNodeIds }),
    snapshot = await readStateSnapshot({ refresh: true });
  if (
    !force &&
    contextProjectionReusable(
      snapshot,
      scope,
      collectProjectionFailures(snapshot, {
        projectId,
        nodeIds,
        allowedProjectIds: projectIds,
        allowedSystemNodeIds: systemNodeIds
      })
    )
  )
    return { attempted: 0, materialized: 0, reused: 0, failed: 0, failures: [], cached: true };
  const outcome = await mutate(async (state) => {
    await refreshContextResourcesInState(state, { projectId, projectIds });
    reconcileContextProjectionState(state, {
      sourceCollections: contextSourceCollections(state),
      timestamp: now(),
      force
    });
    return materializeContextDocumentsInState(state, {
      projectId,
      nodeIds,
      allowedProjectIds: projectIds,
      allowedSystemNodeIds: systemNodeIds,
      force
    });
  });
  const failureOptions = {
    projectId,
    nodeIds,
    allowedProjectIds: projectIds,
    allowedSystemNodeIds: systemNodeIds
  };
  let state = await readStateSnapshot(),
    failures = collectProjectionFailures(state, failureOptions);
  ({ state, failures } = await waitForProjectionLeaseSettlement({
    readState: readStateSnapshot,
    collectFailures: collectProjectionFailures,
    failureOptions,
    state,
    failures
  }));
  if (failures.length)
    throw new HttpError(503, {
      error: 'context_projection_unavailable',
      retryable: failures.some((item) => Number(item.job?.attempts || 0) < 3),
      nodes: failures.slice(0, 50)
    });
  markContextProjectionScopeVerified(state, scope);
  return outcome;
}

export async function getContextMap(input = {}, request = {}) {
  const projectId = await contextProjectId(input, request),
    initialActorContext = await contextActor(request, projectId);
  await ensureContextProjection({
    projectId,
    allowedProjectIds: projectionProjectIds(initialActorContext, projectId),
    allowedSystemNodeIds: projectionSystemNodeIds(initialActorContext, projectId)
  });
  const state = await readStateSnapshot(),
    actorContext = await contextActor(request, projectId, state),
    nodes = visibleContextNodes(state, actorContext, projectId),
    nodeIds = new Set(nodes.map((node) => node.id)),
    edges = state.context_edges.filter((edge) => nodeIds.has(edge.source_node_id) && nodeIds.has(edge.target_node_id)),
    projectNode = projectId
      ? nodes.find((node) => node.source_collection === 'projects' && node.source_id === projectId)
      : null,
    rootId = optionalString(input.root_id) || projectNode?.id || 'ctx_root_system',
    depth = bounded(input.depth, 4, 1, 12),
    limit = bounded(input.limit, 1000, 1, 10_000),
    ordered = subtree(nodes, rootId, depth).slice(0, limit),
    selectedIds = new Set(ordered.map((node) => node.id)),
    selection = latestSelection(state, actorContext.actor.id, projectId);
  return {
    schema_version: 'aiws.context_map.v1',
    uri: projectId ? `aiws://context/map/projects/${encodeURIComponent(projectId)}` : 'aiws://context/map/global',
    project_id: projectId,
    root_id: rootId,
    snapshot_hash: mapSnapshotHash(ordered),
    nodes: ordered.map(publicNode),
    edges: edges.filter((edge) => selectedIds.has(edge.source_node_id) && selectedIds.has(edge.target_node_id)),
    compact_markdown: compactContextMap(nodes, { rootId, maxDepth: depth, maxNodes: limit }),
    policy: publicPolicy(findContextPolicy(state, { actorId: actorContext.actor.id, projectId })),
    latest_selection: selection ? publicSelection(selection) : null,
    coverage: publicContextCoverage(state, actorContext, projectId, nodes)
  };
}

export async function searchContext(input = {}, request = {}) {
  const projectId = await contextProjectId(input, request),
    initialActorContext = await contextActor(request, projectId);
  await ensureContextProjection({
    projectId,
    allowedProjectIds: projectionProjectIds(initialActorContext, projectId),
    allowedSystemNodeIds: projectionSystemNodeIds(initialActorContext, projectId)
  });
  const state = await readStateSnapshot(),
    actorContext = await contextActor(request, projectId, state),
    visible = visibleContextNodes(state, actorContext, projectId).filter((node) => node.status === 'active'),
    index = await contextIndex(state),
    query = String(input.query || '').trim(),
    limit = bounded(input.limit, 30, 1, 200),
    explicitRefs = new Set(normalizeArray(input.explicit_refs)),
    anchorNodeId = optionalString(input.anchor_node_id),
    policy = findContextPolicy(state, { actorId: actorContext.actor.id, sessionId: input.session_id, projectId }),
    pinned = new Set(policy?.pinned_node_ids || []),
    visibleById = new Map(visible.map((node) => [node.id, node]));
  assertContextAnchor(state, actorContext, projectId, anchorNodeId);
  const raw = query
    ? searchContextSearchIndex(index, query)
    : visible.map((node) => ({ id: node.id, node_id: node.id, score: 0 }));
  const ranked = raw
      .map((item) => {
        const node = visibleById.get(String(item.node_id || item.id));
        if (!node) return null;
        const fulltext = Number(item.score || 0),
          ranking = searchRanking(node, fulltext, {
            pinned,
            explicitRefs,
            projectId,
            anchorNodeId,
            state
          });
        return {
          ...publicNode(node),
          score: selectionScore(node, fulltext, {
            pinned,
            explicitRefs,
            projectId,
            anchorNodeId,
            state
          }),
          match: item.match || null,
          terms: item.terms || [],
          _ranking: ranking
        };
      })
      .filter(Boolean)
      .sort(compareSearchResults)
      .slice(0, limit),
    results = ranked.map(({ _ranking, ...item }) => item);
  const response = {
    schema_version: 'aiws.context_search.v1',
    query,
    project_id: projectId,
    snapshot_hash: contextIndexRuntimeStatus().snapshot_hash,
    results,
    candidate_node_ids: results.map((item) => item.id)
  };
  const runtimeBinding = runtimeContextBinding(state, request);
  if (!runtimeBinding || request.skipRuntimeSelection === true) return response;
  const selection = await createRuntimeSearchSelection({
    request,
    binding: runtimeBinding,
    projectId,
    candidateNodeIds: response.candidate_node_ids,
    explicitRefs: normalizeArray(input.explicit_refs),
    candidateRanks: new Map(response.candidate_node_ids.map((nodeId, index) => [nodeId, index])),
    requestedTokenBudget: input.token_budget
  });
  return {
    ...response,
    context_selection_id: selection.id,
    context_selection: publicSelection(selection),
    approved_document_versions: (selection.included || []).map((item) => ({
      node_id: item.node_id,
      document_version_id: item.document_version_id,
      content_sha256: item.content_sha256,
      token_estimate: item.token_estimate
    }))
  };
}

export async function readContextNode(nodeId, input = {}, request = {}) {
  const initial = await readStateSnapshot(),
    initialNode = initial.context_nodes.find((node) => node.id === nodeId);
  if (!initialNode) throw new HttpError(404, { error: 'context_node_not_found' });
  const initialActorContext = await contextActor(request, initialNode.project_id, initial);
  assertNodeVisible(initialNode, initialActorContext);
  if (initialNode.sensitivity === 'secret') throw new HttpError(403, { error: 'context_node_sensitive' });
  assertDomainScopes(initialNode, initialActorContext.scopes);
  await ensureContextProjection({
    nodeIds: [nodeId],
    allowedProjectIds: projectionProjectIds(initialActorContext, initialNode.project_id),
    allowedSystemNodeIds: projectionSystemNodeIds(initialActorContext, initialNode.project_id)
  });
  let state = await readStateSnapshot();
  const runtimeBinding = runtimeContextBinding(state, request),
    runtimeApproval = runtimeBinding
      ? await createRuntimeReadSelection({
          request,
          binding: runtimeBinding,
          nodeId,
          requestedVersionId: optionalString(input.version_id),
          approvedSelectionId: optionalString(input.selection_id)
        })
      : null;
  state = runtimeApproval ? await readStateSnapshot() : state;
  const node = state.context_nodes.find((item) => item.id === nodeId),
    actorContext = await contextActor(request, node.project_id, state);
  assertNodeVisible(node, actorContext);
  if (node.sensitivity === 'secret') throw new HttpError(403, { error: 'context_node_sensitive' });
  assertDomainScopes(node, actorContext.scopes);
  const versionId = runtimeApproval?.document_version_id || optionalString(input.version_id) || node.current_version_id,
    version = state.context_document_versions.find((item) => item.id === versionId && item.node_id === node.id);
  if (!version) throw new HttpError(404, { error: 'context_document_version_not_found' });
  if (!input.version_id && (version.source_hash !== node.source_hash || version.id !== node.current_version_id))
    throw new HttpError(503, { error: 'context_projection_unavailable', node_id: node.id });
  let markdown;
  try {
    markdown = (await readCasBlob(version.cas_ref)).toString('utf8');
  } catch (error) {
    throw new HttpError(503, {
      error: 'context_projection_unavailable',
      node_id: node.id,
      reason: error.code || error.message
    });
  }
  if (contextHash(Buffer.from(markdown, 'utf8')) !== version.content_sha256)
    throw new HttpError(503, { error: 'context_projection_unavailable', node_id: node.id, reason: 'hash_mismatch' });
  const adjacentEdges = state.context_edges.filter(
      (edge) => edge.source_node_id === node.id || edge.target_node_id === node.id
    ),
    adjacentNodeIds = new Set(
      adjacentEdges.flatMap((edge) => [edge.source_node_id, edge.target_node_id]).filter((id) => id !== node.id)
    ),
    adjacentNodes = state.context_nodes.filter((item) => adjacentNodeIds.has(item.id)),
    documentEdgeIds = new Set(
      contextDocumentRelationSnapshot(node, adjacentEdges, adjacentNodes).map((relation) => relation.edge_id)
    ),
    edges = adjacentEdges.filter((edge) => {
      if (!documentEdgeIds.has(edge.id)) return false;
      const relatedId = edge.source_node_id === node.id ? edge.target_node_id : edge.source_node_id,
        related = state.context_nodes.find((item) => item.id === relatedId);
      return related && nodeIsVisible(related, actorContext, null);
    }),
    relatedIds = new Set(
      edges.flatMap((edge) => [edge.source_node_id, edge.target_node_id]).filter((id) => id !== node.id)
    ),
    history = state.context_document_versions
      .filter((item) => item.node_id === node.id)
      .sort((left, right) => Number(right.version) - Number(left.version))
      .map(publicVersion);
  const response = {
    schema_version: 'aiws.context_document.v1',
    node: publicNode(node),
    version: publicVersion(version),
    markdown,
    facts: await sourceFacts(state, node),
    edges,
    related_nodes: state.context_nodes.filter((item) => relatedIds.has(item.id)).map(publicNode),
    history
  };
  if (!runtimeApproval) return response;
  const runtimeReceipt = await createRuntimeReadReceipt({
    request,
    binding: runtimeBinding,
    approvalSelectionId: runtimeApproval.selection.id,
    nodeId: node.id,
    documentVersionId: version.id
  });
  return {
    ...response,
    context_selection_id: runtimeReceipt.id,
    context_selection_ids: [runtimeReceipt.id],
    provenance_claim: {
      document_version_id: version.id,
      context_selection_id: runtimeReceipt.id,
      instruction: '仅在该文档实际用于输出时声明 document_version_id；服务端将核对本次读取收据。'
    }
  };
}

export async function createSelection(input = {}, request = {}) {
  const projectId = await contextProjectId(input, request),
    actorContext = await contextActor(request, projectId),
    search = input.query
      ? await searchContext(input, { ...request, skipRuntimeSelection: true })
      : { candidate_node_ids: normalizeArray(input.candidate_node_ids) };
  const projectionState = await readStateSnapshot(),
    policy = findContextPolicy(projectionState, {
      actorId: actorContext.actor.id,
      sessionId: optionalString(input.session_id),
      projectId
    }),
    requestedNodeIds = [...new Set([...(policy?.pinned_node_ids || []), ...search.candidate_node_ids])],
    materializableNodeIds = requestedNodeIds.filter((nodeId) => {
      const node = projectionState.context_nodes.find((item) => item.id === nodeId);
      return node && nodeCanBeMaterialized(node, actorContext, projectId);
    });
  assertContextAnchor(projectionState, actorContext, projectId, optionalString(input.anchor_node_id));
  await ensureContextProjection({
    projectId,
    nodeIds: materializableNodeIds,
    allowedProjectIds: projectionProjectIds(actorContext, projectId),
    allowedSystemNodeIds: projectionSystemNodeIds(actorContext, projectId)
  });
  return mutate((state) => {
    if (projectId) assertProjectRead(state, projectId, actorContext.actor.id);
    const selection = createContextSelection(state, {
      id: id('csel'),
      actorId: actorContext.actor.id,
      sessionId: optionalString(input.session_id),
      projectId,
      anchorNodeId: optionalString(input.anchor_node_id),
      candidateNodeIds: search.candidate_node_ids,
      tokenBudget: bounded(input.token_budget, 4000, 1, 200_000),
      scopes: actorContext.scopes,
      allowedProjectIds: accessibleProjectIds(state, actorContext.actor.id),
      explicitRefs: normalizeArray(input.explicit_refs),
      candidateRanks: input.query ? new Map(search.candidate_node_ids.map((nodeId, index) => [nodeId, index])) : null,
      timestamp: now()
    });
    state.context_selections.push(selection);
    return publicSelection(selection);
  });
}

export async function getSelection(selectionId, request = {}) {
  const state = await readStateSnapshot({ refresh: true }),
    selection = state.context_selections.find((item) => item.id === selectionId);
  if (!selection) throw new HttpError(404, { error: 'context_selection_not_found' });
  const actorContext = await contextActor(request, selection.project_id, state);
  if (selection.actor_id !== actorContext.actor.id && actorContext.actor.id !== instanceOwnerId(state))
    throw new HttpError(403, { error: 'context_selection_access_denied' });
  const currentlyVisible = new Set(
    visibleContextNodes(state, actorContext, selection.project_id).map((node) => node.id)
  );
  return {
    ...publicSelection(selection),
    included_nodes: (selection.included || []).map((item) => ({
      ...item,
      node: currentlyVisible.has(item.node_id)
        ? publicNode(state.context_nodes.find((node) => node.id === item.node_id))
        : null
    })),
    excluded_nodes: (selection.excluded || []).map((item) => ({
      ...item,
      node: currentlyVisible.has(item.node_id)
        ? publicNode(state.context_nodes.find((node) => node.id === item.node_id))
        : null
    }))
  };
}

export async function getContextPolicy(input = {}, request = {}) {
  const projectId = optionalString(input.project_id),
    actorContext = await contextActor(request, projectId),
    state = await readStateSnapshot();
  return publicPolicy(
    findContextPolicy(state, {
      actorId: actorContext.actor.id,
      sessionId: optionalString(input.session_id),
      projectId
    })
  );
}

export async function putContextPolicy(input = {}, request = {}) {
  const projectId = optionalString(input.project_id),
    actorContext = await contextActor(request, projectId),
    requestedNodeIds = [...normalizeArray(input.pinned_node_ids), ...normalizeArray(input.excluded_node_ids)];
  return mutate((state) => {
    const currentActor = actorForRequest(state, request.req || request, { strict: false }),
      currentContext = {
        actor: currentActor,
        scopes: actorContext.scopes,
        accessible: accessibleProjectIds(state, currentActor.id),
        state
      };
    if (projectId) assertProjectRead(state, projectId, currentActor.id);
    for (const nodeId of requestedNodeIds) {
      const node = state.context_nodes.find((item) => item.id === nodeId);
      assertNodeVisible(node, currentContext);
      if (projectId && String(node.project_id || '') !== projectId)
        throw new HttpError(403, { error: 'context_node_cross_scope', node_id: nodeId });
      if (node.sensitivity === 'secret') throw new HttpError(403, { error: 'context_node_sensitive', node_id: nodeId });
      assertDomainScopes(node, currentContext.scopes);
    }
    return publicPolicy(
      upsertContextPolicy(state, {
        id: id('cpol'),
        actorId: actorContext.actor.id,
        sessionId: optionalString(input.session_id),
        projectId,
        pinnedNodeIds: normalizeArray(input.pinned_node_ids),
        excludedNodeIds: normalizeArray(input.excluded_node_ids),
        timestamp: now()
      })
    );
  });
}

export async function contextStatus(request = {}) {
  const state = await readStateSnapshot(),
    actorContext = await contextActor(request, null, state);
  requireContextAdmin(state, actorContext);
  return contextStatusSnapshot(state, contextIndexRuntimeStatus(), contextProjectorRuntimeStatus());
}

export async function rebuildContext(request = {}) {
  const state = await readStateSnapshot(),
    actorContext = await contextActor(request, null, state);
  requireContextAdmin(state, actorContext);
  invalidateContextIndexRuntime();
  const projection = await ensureContextProjection({ force: true });
  const rebuiltState = await readStateSnapshot();
  await contextIndex(rebuiltState, { force: true });
  return { rebuilt: true, projection, index: contextIndexRuntimeStatus(), completed_at: now() };
}

export async function reportBrowserSemanticState(input = {}, request = {}) {
  const projectId = optionalString(input.project_id),
    actorContext = await contextActor(request, projectId),
    selectedNodeId = optionalString(input.selected_node_id),
    state = await readStateSnapshot();
  if (selectedNodeId) {
    const selected = state.context_nodes.find((node) => node.id === selectedNodeId);
    assertNodeVisible(selected, actorContext);
    if (projectId && String(selected.project_id || '') !== projectId)
      throw new HttpError(403, { error: 'context_node_cross_scope', node_id: selectedNodeId });
  }
  const semanticState = {
    route: semanticRoute(input.route),
    current_project_id: projectId,
    selected_node_id: selectedNodeId,
    tab: semanticLabel(input.tab, 80),
    filters: semanticFilters(input.filters)
  };
  const browserId =
    semanticLabel(
      input.browser_id || request.req?.headers?.['x-aiws-browser-id'] || request.headers?.['x-aiws-browser-id'],
      120
    ) || 'default';
  return mutate((data) => {
    const currentActor = actorForRequest(data, request.req || request, { strict: false }),
      currentContext = {
        actor: currentActor,
        scopes: actorContext.scopes,
        accessible: accessibleProjectIds(data, currentActor.id),
        state: data
      };
    if (projectId) assertProjectRead(data, projectId, currentActor.id);
    if (selectedNodeId) {
      const selected = data.context_nodes.find((node) => node.id === selectedNodeId);
      assertNodeVisible(selected, currentContext);
      if (projectId && String(selected.project_id || '') !== projectId)
        throw new HttpError(403, { error: 'context_node_cross_scope', node_id: selectedNodeId });
    }
    return publicNode(
      upsertBrowserSemanticResourceInState(data, {
        actorId: currentActor.id,
        projectId,
        browserId,
        semanticState,
        timestamp: now()
      })
    );
  });
}

export function createSelectionForRuntimeInState(
  state,
  {
    actorId,
    sessionId = null,
    projectId,
    anchorSourceCollection = null,
    anchorSourceId = null,
    explicitSourceRefs = [],
    candidateLimit = 80,
    tokenBudget = 4000,
    retrievalPlan = null,
    rubricHash = null,
    outcomeContractHash = null,
    mandatoryEvidenceNodeIds = [],
    selectionSchema = null
  }
) {
  state.context_nodes ||= [];
  state.context_document_versions ||= [];
  state.context_selections ||= [];
  state.context_policies ||= [];
  const anchor = state.context_nodes.find(
    (node) => node.source_collection === anchorSourceCollection && node.source_id === anchorSourceId
  );
  const eligible = state.context_nodes.filter(
      (node) =>
        node.current_version_id &&
        node.status === 'active' &&
        node.project_id === projectId &&
        node.sensitivity !== 'secret'
    ),
    explicitNodeIds = explicitSourceRefs
      .map((ref) => eligible.find((node) => node.source_collection === ref?.collection && node.source_id === ref?.id))
      .filter(Boolean)
      .map((node) => node.id),
    candidates = [
      ...new Set([
        ...explicitNodeIds,
        ...eligible
          .sort(compareContextNodes)
          .slice(0, candidateLimit)
          .map((node) => node.id)
      ])
    ];
  const selection = createContextSelection(state, {
    id: id('csel'),
    actorId,
    sessionId,
    projectId,
    anchorNodeId: anchor?.id || null,
    candidateNodeIds: anchor ? [anchor.id, ...candidates] : candidates,
    explicitRefs: explicitNodeIds,
    tokenBudget,
    scopes: null,
    allowedProjectIds: [projectId],
    retrievalPlan,
    rubricHash,
    outcomeContractHash,
    mandatoryEvidenceNodeIds,
    ...(selectionSchema ? { schemaVersion: selectionSchema } : {}),
    timestamp: now()
  });
  state.context_selections.push(selection);
  return selection;
}

async function contextIndex(state) {
  try {
    return (await ensureContextSearchIndex(state)).index;
  } catch (error) {
    const reason = /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || ''))
      ? String(error.code)
      : 'context_index_rebuild_failed';
    throw new HttpError(503, { error: 'context_projection_unavailable', reason });
  }
}

async function contextProjectId(input, request) {
  const explicit = optionalString(input?.project_id),
    state = await readStateSnapshot(),
    binding = runtimeContextBinding(state, request),
    allowlist = contextRequestProjectAllowlist(request);
  if (binding) {
    if (explicit && explicit !== binding.project_id)
      throw new HttpError(403, {
        error: 'context_runtime_project_mismatch',
        project_id: explicit,
        expected_project_id: binding.project_id
      });
    return binding.project_id;
  }
  if (explicit && allowlist.length && !allowlist.includes(explicit))
    throw new HttpError(403, { error: 'mcp_project_access_denied', project_id: explicit });
  return explicit || (allowlist.length === 1 ? allowlist[0] : null);
}

async function contextActor(request, projectId = null, suppliedState = null) {
  const state = suppliedState || (await readStateSnapshot()),
    actor = actorForRequest(state, request.req || request, { strict: false }),
    scopes = contextRequestScopes(request),
    allowlist = contextRequestProjectAllowlist(request),
    accessible = accessibleProjectIds(state, actor.id);
  if (allowlist.length)
    for (const accessibleProjectId of [...accessible])
      if (!allowlist.includes(String(accessibleProjectId))) accessible.delete(accessibleProjectId);
  if (projectId && allowlist.length && !allowlist.includes(String(projectId)))
    throw new HttpError(403, { error: 'mcp_project_access_denied', project_id: projectId });
  if (projectId) assertProjectRead(state, projectId, actor.id);
  return { actor, scopes, accessible, state };
}
