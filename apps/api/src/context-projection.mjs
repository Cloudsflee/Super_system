import {
  CONTEXT_RENDERER_VERSION,
  contextHash,
  contextSourceRecordId,
  renderContextMarkdown,
  sanitizeContextFacts
} from '../../../packages/system-context/src/index.mjs';
import { estimateTokens, now } from '../../../packages/shared/index.mjs';
import { writeCasBlob } from './asset-cas.mjs';
import { CAS_DIR } from './config.mjs';
import { resolveContextProjectionRecord } from './context-resource-adapters.mjs';
import { redactKnownSecrets } from './vault.mjs';

export async function materializeContextDocumentsInState(
  state,
  {
    nodeIds = null,
    projectId = null,
    allowedProjectIds = null,
    allowedSystemNodeIds = null,
    force = false,
    maxJobs = 10_000,
    casRoot = CAS_DIR
  } = {}
) {
  const selectedIds = nodeIds ? new Set(nodeIds) : null,
    allowedProjects = allowedProjectIds == null ? null : new Set(allowedProjectIds),
    allowedSystemNodes = allowedSystemNodeIds == null ? null : new Set(allowedSystemNodeIds);
  for (const job of state.context_projection_jobs.filter((item) => item.status === 'running')) {
    const node = state.context_nodes.find((item) => item.id === job.node_id);
    if (!node || !nodeMatchesProjectionScope(node, { projectId, allowedProjects, allowedSystemNodes })) continue;
    Object.assign(job, {
      status: 'pending',
      error_code: 'context_projection_interrupted',
      next_retry_at: null,
      updated_at: now(),
      completed_at: null
    });
  }
  const jobs = state.context_projection_jobs
    .filter((job) => {
      const node = state.context_nodes.find((item) => item.id === job.node_id);
      return (
        node &&
        (!selectedIds || selectedIds.has(node.id)) &&
        nodeMatchesProjectionScope(node, { projectId, allowedProjects, allowedSystemNodes }) &&
        (job.status === 'pending' || (job.status === 'failed' && (force || Number(job.attempts || 0) < 3)))
      );
    })
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
    .slice(0, maxJobs);
  const result = { attempted: 0, materialized: 0, reused: 0, failed: 0, failures: [] };
  for (const job of jobs) {
    const node = state.context_nodes.find((item) => item.id === job.node_id);
    if (!node || node.source_hash !== job.expected_source_hash) {
      Object.assign(job, {
        status: 'superseded',
        error_code: 'context_projection_job_superseded',
        updated_at: now(),
        completed_at: now()
      });
      continue;
    }
    result.attempted += 1;
    job.status = 'running';
    job.attempts = Number(job.attempts || 0) + 1;
    job.updated_at = now();
    try {
      const sourceRecord = node.source_collection
        ? state[node.source_collection]?.find(
            (item) => contextSourceRecordId(node.source_collection, item) === String(node.source_id)
          ) || null
        : null;
      if (node.status !== 'tombstone' && node.source_collection && !sourceRecord)
        throw projectionError('context_projection_source_missing');
      const record = await resolveContextProjectionRecord(state, node, sourceRecord, { casRoot });
      const edges = state.context_edges.filter(
          (edge) => edge.source_node_id === node.id || edge.target_node_id === node.id
        ),
        relatedIds = new Set(
          edges.flatMap((edge) => [edge.source_node_id, edge.target_node_id]).filter((id) => id !== node.id)
        ),
        relatedNodes = state.context_nodes.filter((item) => relatedIds.has(item.id));
      const markdown = await redactKnownSecrets(renderContextMarkdown({ node, record, edges, relatedNodes })),
        contentSha256 = contextHash(Buffer.from(markdown, 'utf8')),
        versionId = `ctxver_${contextHash(`${node.id}:${node.source_hash}:${contentSha256}`).slice(0, 24)}`;
      let version = state.context_document_versions.find((item) => item.id === versionId);
      if (!version) {
        const blob = await writeCasBlob(Buffer.from(markdown, 'utf8'), {
            casRoot,
            mediaType: 'text/markdown; charset=utf-8',
            expectedSha256: contentSha256
          }),
          sanitized = sanitizeContextFacts(record || {}),
          versionNumber =
            state.context_document_versions
              .filter((item) => item.node_id === node.id)
              .reduce((maximum, item) => Math.max(maximum, Number(item.version || 0)), 0) + 1;
        version = {
          id: versionId,
          node_id: node.id,
          version: versionNumber,
          renderer_version: CONTEXT_RENDERER_VERSION,
          source_hash: node.source_hash,
          markdown_hash: contentSha256,
          content_sha256: contentSha256,
          cas_ref: blob,
          size_bytes: blob.size_bytes,
          media_type: blob.media_type,
          token_estimate: estimateTokens(markdown),
          deterministic_summary: node.deterministic_summary,
          redactions: sanitized.redactions,
          immutable: true,
          retained_until: null,
          created_at: now()
        };
        state.context_document_versions.push(version);
        result.materialized += 1;
      } else result.reused += 1;
      node.current_version_id = version.id;
      node.updated_at = now();
      Object.assign(job, {
        status: 'completed',
        error_code: null,
        next_retry_at: null,
        updated_at: now(),
        completed_at: now()
      });
    } catch (error) {
      const code = safeErrorCode(error);
      Object.assign(job, {
        status: 'failed',
        error_code: code,
        next_retry_at: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Number(job.attempts || 1))).toISOString(),
        updated_at: now(),
        completed_at: null
      });
      result.failed += 1;
      result.failures.push({ job_id: job.id, node_id: job.node_id, error_code: code });
    }
  }
  return result;
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
  const referenced = new Set(
    (state.context_selections || []).flatMap((selection) =>
      (selection.included || []).map((item) => item.document_version_id)
    )
  );
  const executedPackSelections = new Set(
    (state.context_packs || []).map((pack) => pack.context_selection_id).filter(Boolean)
  );
  for (const pack of state.context_packs || [])
    for (const value of [...(pack.context_document_versions || []), ...(pack.content_json?.document_versions || [])]) {
      const versionId = typeof value === 'string' ? value : value?.document_version_id;
      if (versionId) referenced.add(versionId);
    }
  for (const selection of (state.context_selections || []).filter((item) => executedPackSelections.has(item.id)))
    for (const item of selection.included || []) referenced.add(item.document_version_id);
  for (const summary of state.context_summaries || [])
    if (summary.document_version_id) referenced.add(summary.document_version_id);
  const current = new Set((state.context_nodes || []).map((node) => node.current_version_id).filter(Boolean)),
    instant =
      timestamp instanceof Date
        ? timestamp.getTime()
        : Number.isFinite(Number(timestamp))
          ? Number(timestamp)
          : Date.parse(timestamp),
    cutoff = instant - retentionMs;
  return (state.context_document_versions || []).filter(
    (version) =>
      current.has(version.id) ||
      referenced.has(version.id) ||
      Date.parse(version.retained_until || '') > instant ||
      Date.parse(version.created_at || '') >= cutoff
  );
}

function projectionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  return /^[a-z0-9_.-]{1,120}$/i.test(String(error?.code || ''))
    ? String(error.code)
    : 'context_projection_materialization_failed';
}

function nodeMatchesProjectionScope(node, { projectId, allowedProjects, allowedSystemNodes }) {
  if (projectId) return String(node.project_id || '') === String(projectId);
  if (!node.project_id) return !allowedSystemNodes || allowedSystemNodes.has(node.id);
  return !allowedProjects || allowedProjects.has(String(node.project_id));
}
