import { now } from '../../../packages/shared/index.mjs';
import { leaseOwnedBy, nodeMatchesProjectionScope } from './context-projection-domain.mjs';

export function releaseContextProjectionLeasesInState(
  state,
  { holder, jobIds = null, timestamp = now(), errorCode = 'context_projection_shutdown_interrupted' }
) {
  const selected = jobIds ? new Set(jobIds) : null;
  let released = 0;
  for (const job of state.context_projection_jobs) {
    if (!leaseOwnedBy(job, holder) || (selected && !selected.has(job.id))) continue;
    Object.assign(job, {
      status: 'pending',
      lease: null,
      error_code: errorCode,
      next_retry_at: null,
      completed_at: null,
      updated_at: timestamp
    });
    released += 1;
  }
  return released;
}

export function collectProjectionFailures(
  state,
  { nodeIds = null, projectId = null, allowedProjectIds = null, allowedSystemNodeIds = null } = {}
) {
  const selectedIds = nodeIds ? new Set(nodeIds) : null,
    allowedProjects = allowedProjectIds == null ? null : new Set(allowedProjectIds),
    allowedSystemNodes = allowedSystemNodeIds == null ? null : new Set(allowedSystemNodeIds);
  return state.context_nodes
    .filter(
      (node) =>
        (!selectedIds || selectedIds.has(node.id)) &&
        nodeMatchesProjectionScope(node, { projectId, allowedProjects, allowedSystemNodes }) &&
        (!node.current_version_id ||
          !state.context_document_versions.some(
            (version) => version.id === node.current_version_id && version.source_hash === node.source_hash
          ))
    )
    .map((node) => {
      const version = state.context_document_versions.find((item) => item.id === node.current_version_id);
      return {
        node_id: node.id,
        source_collection: node.source_collection || null,
        source_id: node.source_id || null,
        source_hash: node.source_hash,
        current_version_id: node.current_version_id || null,
        current_version_source_hash: version?.source_hash || null,
        job:
          state.context_projection_jobs
            .filter((job) => job.node_id === node.id && job.expected_source_hash === node.source_hash)
            .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0] || null
      };
    });
}

export function collectContextVersions(state, { timestamp = Date.now(), retentionMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const referenced = referencedContextVersionIds(state);
  const current = new Set((state.context_nodes || []).map((node) => node.current_version_id).filter(Boolean));
  const instant = contextRetentionInstant(timestamp);
  const cutoff = instant - retentionMs;
  return (state.context_document_versions || []).filter((version) =>
    contextVersionRetained(version, { current, referenced, instant, cutoff })
  );
}

function referencedContextVersionIds(state) {
  const referenced = new Set();
  addSelectionVersionReferences(referenced, state.context_selections || []);
  const executedPackSelections = addPackVersionReferences(referenced, state.context_packs || []);
  addExecutedSelectionVersionReferences(referenced, state.context_selections || [], executedPackSelections);
  addSummaryVersionReferences(referenced, state.context_summaries || []);
  addAssetVersionReferences(referenced, state.asset_versions || []);
  return referenced;
}

function addSelectionVersionReferences(referenced, selections) {
  for (const selection of selections)
    for (const item of selection.included || []) referenced.add(item.document_version_id);
}

function addPackVersionReferences(referenced, packs) {
  const selectionIds = new Set();
  for (const pack of packs) {
    if (pack.context_selection_id) selectionIds.add(pack.context_selection_id);
    const values = [...(pack.context_document_versions || []), ...(pack.content_json?.document_versions || [])];
    for (const value of values) {
      const versionId = typeof value === 'string' ? value : value?.document_version_id;
      if (versionId) referenced.add(versionId);
    }
  }
  return selectionIds;
}

function addExecutedSelectionVersionReferences(referenced, selections, executedPackSelections) {
  for (const selection of selections) {
    if (!executedPackSelections.has(selection.id)) continue;
    for (const item of selection.included || []) referenced.add(item.document_version_id);
  }
}

function addSummaryVersionReferences(referenced, summaries) {
  for (const summary of summaries) if (summary.document_version_id) referenced.add(summary.document_version_id);
}

function addAssetVersionReferences(referenced, assetVersions) {
  for (const assetVersion of assetVersions)
    for (const versionId of assetVersion.provenance?.consumed_context_document_versions || [])
      referenced.add(versionId);
}

function contextRetentionInstant(timestamp) {
  if (timestamp instanceof Date) return timestamp.getTime();
  return Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.parse(timestamp);
}

function contextVersionRetained(version, { current, referenced, instant, cutoff }) {
  if (current.has(version.id) || referenced.has(version.id)) return true;
  if (Date.parse(version.retained_until || '') > instant) return true;
  return Date.parse(version.created_at || '') >= cutoff;
}
