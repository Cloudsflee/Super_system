import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  CONTEXT_INTERNAL_COLLECTIONS,
  buildContextSearchIndex,
  compactContextMap,
  compareContextNodes,
  contextDocumentRelationSnapshot,
  contextIndexableNodes,
  contextHash,
  contextSearchIndexSnapshotHash,
  contextSourceRecordId,
  createContextSelection,
  findContextPolicy,
  loadContextSearchIndex,
  reconcileContextProjectionState,
  sanitizeContextFacts,
  searchContextSearchIndex,
  serializeContextSearchIndex,
  upsertContextPolicy
} from '../../../packages/system-context/src/index.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { collections as STATE_COLLECTIONS, CONTEXT_INDEX_DIR } from './config.mjs';
import { HttpError } from './http.mjs';
import { readCasBlob } from './asset-cas.mjs';
import {
  actorForRequest,
  accessibleProjectIds,
  assertProjectRead,
  instanceOwnerId
} from './project-governance-v19.mjs';
import { collectProjectionFailures, materializeContextDocumentsInState } from './context-projection.mjs';
import {
  refreshContextResourcesInState,
  resolveContextProjectionRecord,
  upsertBrowserSemanticResourceInState
} from './context-resource-adapters.mjs';
import {
  contextRequestProjectAllowlist,
  createRuntimeReadReceipt,
  createRuntimeReadSelection,
  createRuntimeSearchSelection,
  runtimeContextBinding
} from './context-runtime-selection.mjs';
import { mutate, readState } from './state.mjs';

export { compactRuntimeMap, loadContextSelectionDocumentsInState } from './context-runtime-selection.mjs';

const INDEX_FILE = path.join(CONTEXT_INDEX_DIR, 'minisearch-v1.json');
let indexCache = null;
let indexStatus = { state: 'empty', snapshot_hash: null, node_count: 0, rebuilt_at: null, error_code: null };

export async function ensureContextProjection({
  projectId = null,
  nodeIds = null,
  allowedProjectIds = null,
  allowedSystemNodeIds = null,
  force = false
} = {}) {
  const projectIds = allowedProjectIds == null ? null : [...allowedProjectIds].map(String),
    systemNodeIds = allowedSystemNodeIds == null ? null : [...allowedSystemNodeIds].map(String);
  const outcome = await mutate(async (state) => {
    await refreshContextResourcesInState(state, { projectId, projectIds });
    reconcileContextProjectionState(state, {
      sourceCollections: sourceCollections(state),
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
  const state = await readState(),
    failures = collectProjectionFailures(state, {
      projectId,
      nodeIds,
      allowedProjectIds: projectIds,
      allowedSystemNodeIds: systemNodeIds
    });
  if (failures.length)
    throw new HttpError(503, {
      error: 'context_projection_unavailable',
      retryable: failures.some((item) => Number(item.job?.attempts || 0) < 3),
      nodes: failures.slice(0, 50)
    });
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
  const state = await readState(),
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
  const state = await readState(),
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
    snapshot_hash: indexStatus.snapshot_hash,
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
  const initial = await readState(),
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
  let state = await readState();
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
  state = runtimeApproval ? await readState() : state;
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
  const projectionState = await readState(),
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
  const state = await readState(),
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
    state = await readState();
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
  const state = await readState(),
    actorContext = await contextActor(request, null, state);
  requireContextAdmin(state, actorContext);
  const jobsByStatus = Object.fromEntries(
    ['pending', 'running', 'completed', 'failed', 'superseded'].map((status) => [
      status,
      state.context_projection_jobs.filter((job) => job.status === status).length
    ])
  );
  return {
    schema_version: 20,
    protocol_version: 'aiws.system-context.v1',
    nodes: state.context_nodes.length,
    document_versions: state.context_document_versions.length,
    edges: state.context_edges.length,
    selections: state.context_selections.length,
    jobs: jobsByStatus,
    coverage: state.context_projection_coverage || null,
    index: indexStatus
  };
}

export async function rebuildContext(request = {}) {
  const state = await readState(),
    actorContext = await contextActor(request, null, state);
  requireContextAdmin(state, actorContext);
  indexCache = null;
  await fsp.rm(INDEX_FILE, { force: true }).catch(() => undefined);
  const projection = await ensureContextProjection({ force: true });
  const rebuiltState = await readState();
  await contextIndex(rebuiltState, { force: true });
  return { rebuilt: true, projection, index: indexStatus, completed_at: now() };
}

export async function reportBrowserSemanticState(input = {}, request = {}) {
  const projectId = optionalString(input.project_id),
    actorContext = await contextActor(request, projectId),
    selectedNodeId = optionalString(input.selected_node_id),
    state = await readState();
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
    tokenBudget = 4000
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
    timestamp: now()
  });
  state.context_selections.push(selection);
  return selection;
}

async function contextIndex(state, { force = false } = {}) {
  const nodes = contextIndexableNodes(state.context_nodes),
    snapshotHash = contextSearchIndexSnapshotHash(nodes);
  if (!force && indexCache?.snapshot_hash === snapshotHash) return indexCache.index;
  if (!force) {
    try {
      const stored = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8'));
      if (stored.snapshot_hash === snapshotHash) {
        const index = loadContextSearchIndex(stored);
        indexCache = { snapshot_hash: snapshotHash, index };
        indexStatus = {
          state: 'ready',
          snapshot_hash: snapshotHash,
          node_count: nodes.length,
          rebuilt_at: stored.rebuilt_at,
          error_code: null
        };
        return index;
      }
    } catch (error) {
      indexStatus = { ...indexStatus, state: 'rebuilding', error_code: 'context_index_corrupt' };
    }
  }
  let temporary = null;
  try {
    const { index, documents } = await buildContextSearchIndex({
      nodes: state.context_nodes,
      documentVersions: state.context_document_versions,
      edges: state.context_edges,
      readDocument: async (version) => (await readCasBlob(version.cas_ref)).toString('utf8')
    });
    const rebuiltAt = now(),
      payload = serializeContextSearchIndex(index, { snapshotHash, rebuiltAt });
    await fsp.mkdir(CONTEXT_INDEX_DIR, { recursive: true, mode: 0o700 });
    temporary = `${INDEX_FILE}.${process.pid}.${id('ctxindex')}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporary, INDEX_FILE);
    indexCache = { snapshot_hash: snapshotHash, index };
    indexStatus = {
      state: 'ready',
      snapshot_hash: snapshotHash,
      node_count: documents.length,
      rebuilt_at: rebuiltAt,
      error_code: null
    };
    return index;
  } catch (error) {
    if (temporary) await fsp.rm(temporary, { force: true }).catch(() => undefined);
    const reason = /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || ''))
      ? String(error.code)
      : 'context_index_rebuild_failed';
    indexStatus = {
      state: 'failed',
      snapshot_hash: snapshotHash,
      node_count: nodes.length,
      rebuilt_at: null,
      error_code: reason
    };
    throw new HttpError(503, { error: 'context_projection_unavailable', reason });
  }
}

async function contextProjectId(input, request) {
  const explicit = optionalString(input?.project_id),
    state = await readState(),
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
  const state = suppliedState || (await readState()),
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

function contextRequestScopes(request) {
  const direct = request.scopes ?? request.req?.auth?.scopes;
  if (direct != null) return normalizeRequestScopes(direct);
  const headers = request.req?.headers || request.headers,
    header = typeof headers?.get === 'function' ? headers.get('x-aiws-scopes') : headers?.['x-aiws-scopes'];
  return header == null ? null : normalizeRequestScopes(header);
}

function normalizeRequestScopes(value) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .flatMap((item) => String(item || '').split(/[\s,]+/))
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function visibleContextNodes(state, actorContext, projectId) {
  return state.context_nodes.filter((node) => nodeIsVisible(node, actorContext, projectId)).sort(compareContextNodes);
}

function assertNodeVisible(node, actorContext) {
  if (!node) throw new HttpError(404, { error: 'context_node_not_found' });
  if (!nodeIsVisible(node, actorContext, null, { checkScopes: false }))
    throw new HttpError(403, { error: 'context_node_access_denied' });
}

function nodeIsVisible(node, actorContext, projectId, { checkScopes = true } = {}) {
  const owner = actorContext.actor.id === instanceOwnerId(actorContext.state);
  if (projectId && String(node.project_id || '') !== String(projectId)) return false;
  if (node.project_id && !actorContext.accessible.has(String(node.project_id))) return false;
  if (!node.project_id && !owner && !['system', 'project'].includes(node.kind)) return false;
  return !checkScopes || nodeScopesAllowed(node, actorContext.scopes);
}

function nodeCanBeMaterialized(node, actorContext, projectId) {
  return nodeIsVisible(node, actorContext, projectId) && node.sensitivity !== 'secret' && node.status !== 'tombstone';
}

function assertContextAnchor(state, actorContext, projectId, anchorNodeId) {
  if (!anchorNodeId) return;
  const node = state.context_nodes.find((item) => item.id === anchorNodeId);
  assertNodeVisible(node, actorContext);
  if (projectId && String(node.project_id || '') !== projectId)
    throw new HttpError(403, { error: 'context_node_cross_scope', node_id: anchorNodeId });
  if (node.sensitivity === 'secret')
    throw new HttpError(403, { error: 'context_node_sensitive', node_id: anchorNodeId });
  assertDomainScopes(node, actorContext.scopes);
}

function projectionProjectIds(actorContext, projectId) {
  if (projectId) return new Set([String(projectId)]);
  if (actorContext.actor.id === instanceOwnerId(actorContext.state)) return null;
  return new Set([...actorContext.accessible].map(String));
}

function projectionSystemNodeIds(actorContext, projectId) {
  if (projectId || actorContext.actor.id === instanceOwnerId(actorContext.state)) return null;
  return new Set(['ctx_root_system']);
}

function assertDomainScopes(node, scopes) {
  if (!scopes) return;
  const missing = node.required_scopes.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new HttpError(403, { error: 'mcp_scope_required', required_scopes: missing });
}

function nodeScopesAllowed(node, scopes) {
  return !scopes || node.required_scopes.every((scope) => scopes.includes(scope));
}

function requireContextAdmin(state, actorContext) {
  if (actorContext.actor.id !== instanceOwnerId(state))
    throw new HttpError(403, { error: 'context_admin_owner_required' });
  if (actorContext.scopes && !actorContext.scopes.includes('context:admin'))
    throw new HttpError(403, { error: 'mcp_scope_required', required_scopes: ['context:admin'] });
}

function subtree(nodes, rootId, maxDepth) {
  const byParent = new Map(),
    byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const parent = node.parent_id || '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(node);
  }
  for (const children of byParent.values()) children.sort(compareContextNodes);
  const output = [],
    seen = new Set();
  const visit = (nodeId, depth) => {
    if (depth > maxDepth || seen.has(nodeId)) return;
    const node = byId.get(nodeId);
    if (!node) return;
    seen.add(nodeId);
    output.push(node);
    for (const child of byParent.get(nodeId) || []) visit(child.id, depth + 1);
  };
  visit(rootId, 0);
  return output;
}

function selectionScore(node, fulltext, { pinned, explicitRefs, projectId, anchorNodeId, state }) {
  const relation = anchorNodeId
    ? state.context_edges.some(
        (edge) =>
          (edge.source_node_id === anchorNodeId && edge.target_node_id === node.id) ||
          (edge.target_node_id === anchorNodeId && edge.source_node_id === node.id)
      )
    : false;
  return (
    (pinned.has(node.id) ? 1_000_000 : 0) +
    (node.id === anchorNodeId ? 500_000 : 0) +
    (explicitRefs.has(node.id) || explicitRefs.has(node.uri) ? 250_000 : 0) +
    (projectId && node.project_id === projectId ? 100_000 : 0) +
    fulltext * 1_000 +
    (relation ? 500 : 0) +
    (node.authority === 'authoritative' ? 100 : 0) +
    (node.freshness?.status === 'current' ? 10 : 0)
  );
}

function searchRanking(node, fulltext, { pinned, explicitRefs, projectId, anchorNodeId, state }) {
  const anchor = anchorNodeId ? state.context_nodes.find((item) => item.id === anchorNodeId) : null;
  return {
    pinned: pinned.has(node.id),
    scope_distance:
      node.id === anchorNodeId
        ? 0
        : anchor && (node.parent_id === anchor.id || anchor.parent_id === node.id)
          ? 1
          : anchor && node.parent_id && node.parent_id === anchor.parent_id
            ? 2
            : projectId && node.project_id === projectId
              ? 3
              : !projectId
                ? 3
                : 4,
    explicit: explicitRefs.has(node.id) || explicitRefs.has(node.uri),
    fulltext,
    related: anchorNodeId
      ? state.context_edges.some(
          (edge) =>
            edge.type !== 'contains' &&
            ((edge.source_node_id === anchorNodeId && edge.target_node_id === node.id) ||
              (edge.target_node_id === anchorNodeId && edge.source_node_id === node.id))
        )
      : false,
    authoritative: node.authority === 'authoritative',
    current: node.freshness?.status === 'current'
  };
}

function compareSearchResults(left, right) {
  const leftRank = left._ranking,
    rightRank = right._ranking;
  return (
    Number(rightRank.pinned) - Number(leftRank.pinned) ||
    leftRank.scope_distance - rightRank.scope_distance ||
    Number(rightRank.explicit) - Number(leftRank.explicit) ||
    rightRank.fulltext - leftRank.fulltext ||
    Number(rightRank.related) - Number(leftRank.related) ||
    Number(rightRank.authoritative) - Number(leftRank.authoritative) ||
    Number(rightRank.current) - Number(leftRank.current) ||
    compareContextNodes(left, right)
  );
}

async function sourceFacts(state, node) {
  const record = node.source_collection
    ? state[node.source_collection]?.find(
        (item) => contextSourceRecordId(node.source_collection, item) === String(node.source_id)
      )
    : null;
  if (!record && node.source_collection)
    return { tombstone: true, source_collection: node.source_collection, source_id: node.source_id };
  const resolved = await resolveContextProjectionRecord(state, node, record);
  return sanitizeContextFacts(resolved || {}).facts;
}

function publicNode(node) {
  if (!node) return null;
  return {
    id: node.id,
    uri: node.uri,
    kind: node.kind,
    source_type: node.source_type,
    title: node.title,
    summary: node.deterministic_summary,
    project_id: node.project_id,
    parent_id: node.parent_id,
    source_collection: node.source_collection,
    source_id: node.source_id,
    source_version: node.source_version,
    status: node.status,
    sensitivity: node.sensitivity,
    authority: node.authority,
    freshness: node.freshness,
    current_version_id: node.current_version_id,
    required_scopes: node.required_scopes,
    sort: node.sort,
    resource: node.resource ? sanitizeContextFacts(node.resource).facts : null
  };
}

function publicVersion(version) {
  return {
    id: version.id,
    node_id: version.node_id,
    version: version.version,
    renderer_version: version.renderer_version,
    source_hash: version.source_hash,
    content_sha256: version.content_sha256,
    size_bytes: version.size_bytes,
    media_type: version.media_type,
    token_estimate: version.token_estimate,
    deterministic_summary: version.deterministic_summary,
    redactions: version.redactions,
    created_at: version.created_at
  };
}

function publicSelection(selection) {
  return selection ? structuredClone(selection) : null;
}

function publicContextCoverage(state, actorContext, projectId, nodes) {
  const coverage = state.context_projection_coverage;
  if (!coverage) return null;
  if (!projectId && actorContext.actor.id === instanceOwnerId(state) && !actorContext.scopes)
    return structuredClone(coverage);
  const allowedProjects = projectId ? new Set([String(projectId)]) : actorContext.accessible,
    sourceNodes = nodes.filter((node) => node.source_collection && node.status !== 'tombstone');
  return {
    source_records: sourceNodes.length,
    projected_records: sourceNodes.length,
    tombstones: nodes.filter((node) => node.status === 'tombstone').length,
    warnings: (coverage.warnings || [])
      .filter(
        (warning) =>
          warning.project_id &&
          allowedProjects.has(String(warning.project_id)) &&
          (!String(warning.code || '').startsWith('context_repository_') ||
            !actorContext.scopes ||
            actorContext.scopes.includes('files:read'))
      )
      .map((warning) => structuredClone(warning)),
    checked_at: coverage.checked_at || null
  };
}

function publicPolicy(policy) {
  return policy
    ? structuredClone(policy)
    : { pinned_node_ids: [], excluded_node_ids: [], revision: 0, session_id: null, project_id: null };
}

function latestSelection(state, actorId, projectId) {
  return state.context_selections
    .filter((item) => item.actor_id === actorId && (item.project_id || null) === (projectId || null))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0];
}

function mapSnapshotHash(nodes) {
  return contextHash(
    nodes.map((node) => [node.id, node.source_hash, node.current_version_id, node.parent_id, node.status])
  );
}

function sourceCollections(state) {
  return STATE_COLLECTIONS.filter((name) => Array.isArray(state[name]) && !CONTEXT_INTERNAL_COLLECTIONS.includes(name));
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function optionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.floor(number))) : fallback;
}

function semanticRoute(value) {
  const route = semanticLabel(value, 500);
  if (!route) return '/';
  if (!route.startsWith('/') || route.includes('://'))
    throw new HttpError(400, { error: 'context_browser_route_invalid' });
  return route.split(/[?#]/, 1)[0];
}

function semanticLabel(value, maximum) {
  const text = String(value ?? '')
    .replace(/[\u0000\r\n\t]/g, ' ')
    .trim();
  return text ? text.slice(0, maximum) : null;
}

function semanticFilters(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, { error: 'context_browser_filters_invalid' });
  const output = {};
  for (const [key, raw] of Object.entries(value).slice(0, 50)) {
    const safeKey = semanticLabel(key, 80);
    if (!safeKey || /mouse|hover|toast|pixel|layout|coordinate|geometry/i.test(safeKey)) continue;
    if (Array.isArray(raw))
      output[safeKey] = raw
        .slice(0, 100)
        .map((item) => semanticLabel(item, 300))
        .filter(Boolean);
    else if (typeof raw === 'boolean' || typeof raw === 'number') output[safeKey] = raw;
    else if (raw == null) output[safeKey] = null;
    else if (typeof raw === 'string') output[safeKey] = semanticLabel(raw, 1000);
  }
  return output;
}
