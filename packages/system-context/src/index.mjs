import { CONTEXT_INTERNAL_COLLECTIONS } from './protocol.mjs';
import {
  buildProjectionIndexes,
  captureProjectionSources,
  mergeDesiredProjectionNodes,
  retireDetachedProjectionNodes,
  stableProjectionCoverage,
  stageChangedProjectionNodes,
  tombstoneMissingSourceNodes
} from './projection-reconciliation.mjs';
import { buildDesiredEdges, mergeCurrentEdges } from './projection-edges.mjs';
import { compactContextProjectionJobs, stageContextProjectionJob } from './projection-jobs.mjs';
import { buildDesiredNodes, coverageWarnings } from './projection-nodes.mjs';

export * from './search-index.mjs';
export { compactContextMap, contextDocumentRelationSnapshot, renderContextMarkdown } from './rendering.mjs';
export { createContextSelection, findContextPolicy, upsertContextPolicy } from './selection.mjs';
export { assertContextImmutability, validateContextState } from './state-validation.mjs';
export { compactContextProjectionJobs, stageContextProjectionJob } from './projection-jobs.mjs';

export {
  CONTEXT_CATEGORY_ORDER,
  CONTEXT_EDGE_TYPES,
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_INTERNAL_COLLECTIONS,
  CONTEXT_PACK_SCHEMA,
  CONTEXT_PACK_LEGACY_SCHEMAS,
  CONTEXT_PROTOCOL_VERSION,
  CONTEXT_RENDERER_VERSION,
  CONTEXT_SELECTION_SCHEMA,
  CONTEXT_SELECTION_LEGACY_SCHEMAS,
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
  const priorNodeSources = captureProjectionSources(state.context_nodes);
  const desiredNodes = buildDesiredNodes(state, collections, timestamp);
  const activeSourceKeys = mergeDesiredProjectionNodes(state, desiredNodes);
  tombstoneMissingSourceNodes(state, activeSourceKeys, timestamp);
  retireDetachedProjectionNodes(state, desiredNodes, timestamp);
  const activeIds = new Set(state.context_nodes.filter((node) => node.status !== 'tombstone').map((node) => node.id));
  const nodeById = new Map(state.context_nodes.map((node) => [node.id, node]));
  state.context_edges = mergeCurrentEdges(
    state.context_edges,
    buildDesiredEdges(state, activeIds, timestamp, nodeById)
  );
  const indexes = buildProjectionIndexes(state, nodeById);
  const dirty = stageChangedProjectionNodes({
    state,
    indexes,
    priorNodeSources,
    timestamp,
    force,
    stageJob: stageContextProjectionJob
  });
  const prunedJobs = compactContextProjectionJobs(state);
  const warnings = coverageWarnings(state, collections);
  state.context_projection_coverage = stableProjectionCoverage(state, collections, warnings, timestamp);
  return {
    dirty,
    pruned_jobs: prunedJobs,
    warnings,
    nodes: state.context_nodes.length,
    edges: state.context_edges.length
  };
}

export function ensureContextCollections(state) {
  for (const name of CONTEXT_INTERNAL_COLLECTIONS) if (!Array.isArray(state[name])) state[name] = [];
  return state;
}
