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
import { leaseOwnedBy, nodeMatchesProjectionScope } from './context-projection-domain.mjs';

export {
  collectContextVersions,
  collectProjectionFailures,
  releaseContextProjectionLeasesInState
} from './context-projection-maintenance.mjs';

export async function materializeContextDocumentsInState(
  state,
  {
    nodeIds = null,
    projectId = null,
    allowedProjectIds = null,
    allowedSystemNodeIds = null,
    force = false,
    maxJobs = 10_000,
    casRoot = CAS_DIR,
    leaseHolder = null,
    leaseMs = 30_000,
    renderer = null
  } = {}
) {
  const scope = projectionScope({ nodeIds, projectId, allowedProjectIds, allowedSystemNodeIds });
  recoverInterruptedProjectionJobs(state, scope);
  const jobs = selectProjectionJobs(state, scope, { force, maxJobs, leaseHolder });
  const result = emptyProjectionResult();
  for (const job of jobs)
    await materializeProjectionJob(state, job, result, { casRoot, leaseHolder, leaseMs, renderer });
  return result;
}

function projectionScope({ nodeIds, projectId, allowedProjectIds, allowedSystemNodeIds }) {
  return {
    selectedIds: nodeIds ? new Set(nodeIds) : null,
    projectId,
    allowedProjects: allowedProjectIds == null ? null : new Set(allowedProjectIds),
    allowedSystemNodes: allowedSystemNodeIds == null ? null : new Set(allowedSystemNodeIds)
  };
}

function recoverInterruptedProjectionJobs(state, scope) {
  for (const job of state.context_projection_jobs.filter((item) => item.status === 'running')) {
    const node = state.context_nodes.find((item) => item.id === job.node_id);
    if (!node || !nodeMatchesProjectionScope(node, scope)) continue;
    const leaseExpiresAt = Date.parse(job.lease?.expires_at || '');
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now()) continue;
    Object.assign(job, {
      status: 'pending',
      error_code: 'context_projection_interrupted',
      next_retry_at: null,
      updated_at: now(),
      completed_at: null,
      lease: null
    });
  }
}

function selectProjectionJobs(state, scope, { force, maxJobs, leaseHolder }) {
  return state.context_projection_jobs
    .filter((job) => projectionJobEligible(state, job, scope, { force, leaseHolder }))
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
    .slice(0, maxJobs);
}

function projectionJobEligible(state, job, scope, { force, leaseHolder }) {
  const node = state.context_nodes.find((item) => item.id === job.node_id);
  if (!node || (scope.selectedIds && !scope.selectedIds.has(node.id))) return false;
  if (!nodeMatchesProjectionScope(node, scope)) return false;
  if (job.status === 'pending') return true;
  if (job.status === 'running') return Boolean(leaseHolder && job.lease?.holder === leaseHolder);
  return job.status === 'failed' && failedProjectionJobRetryable(job, force);
}

function failedProjectionJobRetryable(job, force) {
  if (force) return true;
  const retryAt = Date.parse(job.next_retry_at || '');
  const retryReady = !Number.isFinite(retryAt) || retryAt <= Date.now();
  return Number(job.attempts || 0) < 3 && retryReady;
}

function emptyProjectionResult() {
  return { attempted: 0, materialized: 0, reused: 0, failed: 0, failures: [] };
}

async function materializeProjectionJob(state, job, result, options) {
  const node = state.context_nodes.find((item) => item.id === job.node_id);
  if (!node || node.source_hash !== job.expected_source_hash) {
    supersedeInlineProjectionJob(job);
    return;
  }
  result.attempted += 1;
  claimInlineProjectionJob(job, options);
  try {
    const content = await renderProjectionContent(state, node, options);
    if (node.source_hash !== job.expected_source_hash)
      throw projectionError('context_projection_source_changed_before_commit');
    const version = await persistInlineProjectionVersion(state, node, content, options.casRoot, result);
    completeInlineProjectionJob(node, job, version);
  } catch (error) {
    failInlineProjectionJob(job, result, error);
  }
}

function supersedeInlineProjectionJob(job) {
  Object.assign(job, {
    status: 'superseded',
    error_code: 'context_projection_job_superseded',
    updated_at: now(),
    completed_at: now()
  });
}

function claimInlineProjectionJob(job, { leaseHolder, leaseMs }) {
  job.status = 'running';
  job.attempts = Number(job.attempts || 0) + 1;
  job.updated_at = now();
  job.lease = {
    holder: leaseHolder || `inline:${process.pid}`,
    acquired_at: now(),
    expires_at: new Date(Date.now() + Math.max(1_000, Number(leaseMs) || 30_000)).toISOString()
  };
}

async function renderProjectionContent(state, node, { casRoot, renderer }) {
  const sourceRecord = projectionSourceRecord(state, node);
  assertProjectionSourceAvailable(node, sourceRecord);
  const record = await resolveContextProjectionRecord(state, node, sourceRecord, { casRoot });
  const { edges, relatedNodes } = projectionRelations(state, node.id);
  const rendered = renderer
    ? await renderer({ node, record, edges, relatedNodes })
    : { markdown: renderContextMarkdown({ node, record, edges, relatedNodes }) };
  const markdown = await redactKnownSecrets(rendered.markdown);
  const contentSha256 = contextHash(Buffer.from(markdown, 'utf8'));
  const versionId = `ctxver_${contextHash(`${node.id}:${node.source_hash}:${contentSha256}`).slice(0, 24)}`;
  return { record, markdown, contentSha256, versionId };
}

function projectionSourceRecord(state, node) {
  if (!node.source_collection) return null;
  return (
    state[node.source_collection]?.find(
      (item) => contextSourceRecordId(node.source_collection, item) === String(node.source_id)
    ) || null
  );
}

function assertProjectionSourceAvailable(node, sourceRecord) {
  if (node.status !== 'tombstone' && node.source_collection && !sourceRecord)
    throw projectionError('context_projection_source_missing');
}

function projectionRelations(state, nodeId) {
  const edges = state.context_edges.filter((edge) => edge.source_node_id === nodeId || edge.target_node_id === nodeId);
  const relatedIds = new Set(
    edges.flatMap((edge) => [edge.source_node_id, edge.target_node_id]).filter((id) => id !== nodeId)
  );
  const relatedNodes = state.context_nodes.filter((item) => relatedIds.has(item.id));
  return { edges, relatedNodes };
}

async function persistInlineProjectionVersion(state, node, content, casRoot, result) {
  const existing = state.context_document_versions.find((item) => item.id === content.versionId);
  if (existing) {
    result.reused += 1;
    return existing;
  }
  const blob = await writeProjectionBlob(content, casRoot);
  const version = inlineProjectionVersion(state, node, content, blob);
  state.context_document_versions.push(version);
  result.materialized += 1;
  return version;
}

function writeProjectionBlob(content, casRoot) {
  return writeCasBlob(Buffer.from(content.markdown, 'utf8'), {
    casRoot,
    mediaType: 'text/markdown; charset=utf-8',
    expectedSha256: content.contentSha256
  });
}

function inlineProjectionVersion(state, node, content, blob) {
  const sanitized = sanitizeContextFacts(content.record || {});
  const versionNumber = nextProjectionVersionNumber(state, node.id);
  return {
    id: content.versionId,
    node_id: node.id,
    version: versionNumber,
    renderer_version: CONTEXT_RENDERER_VERSION,
    source_hash: node.source_hash,
    markdown_hash: content.contentSha256,
    content_sha256: content.contentSha256,
    cas_ref: blob,
    size_bytes: blob.size_bytes,
    media_type: blob.media_type,
    token_estimate: estimateTokens(content.markdown),
    deterministic_summary: node.deterministic_summary,
    redactions: sanitized.redactions,
    immutable: true,
    retained_until: null,
    created_at: now()
  };
}

function nextProjectionVersionNumber(state, nodeId) {
  return (
    state.context_document_versions
      .filter((item) => item.node_id === nodeId)
      .reduce((maximum, item) => Math.max(maximum, Number(item.version || 0)), 0) + 1
  );
}

function completeInlineProjectionJob(node, job, version) {
  node.current_version_id = version.id;
  node.updated_at = now();
  Object.assign(job, {
    status: 'completed',
    error_code: null,
    next_retry_at: null,
    updated_at: now(),
    completed_at: now(),
    lease: null
  });
}

function failInlineProjectionJob(job, result, error) {
  const code = safeErrorCode(error);
  Object.assign(job, {
    status: 'failed',
    error_code: code,
    next_retry_at: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Number(job.attempts || 1))).toISOString(),
    updated_at: now(),
    completed_at: null,
    lease: null
  });
  result.failed += 1;
  result.failures.push({ job_id: job.id, node_id: job.node_id, error_code: code });
}

export async function prepareClaimedContextProjection(state, claim, { casRoot = CAS_DIR, renderer = null } = {}) {
  const node = state.context_nodes.find((item) => item.id === claim.node_id);
  assertClaimProjectionSource(node, claim);
  const content = await renderProjectionContent(state, node, { casRoot, renderer });
  const blob = await writeProjectionBlob(content, casRoot);
  return {
    job_id: claim.job_id,
    node_id: node.id,
    expected_source_hash: claim.expected_source_hash,
    expected_source_generation: Number(claim.expected_source_generation || 0),
    version: claimedProjectionVersion(node, content, blob)
  };
}

function assertClaimProjectionSource(node, claim) {
  const current =
    node &&
    node.source_hash === claim.expected_source_hash &&
    Number(node.source_generation || 0) === Number(claim.expected_source_generation || 0);
  if (!current) throw projectionError('context_projection_source_changed_before_render');
}

function claimedProjectionVersion(node, content, blob) {
  const sanitized = sanitizeContextFacts(content.record || {});
  return {
    id: content.versionId,
    node_id: node.id,
    renderer_version: CONTEXT_RENDERER_VERSION,
    source_hash: node.source_hash,
    source_generation: Number(node.source_generation || 0),
    markdown_hash: content.contentSha256,
    content_sha256: content.contentSha256,
    cas_ref: blob,
    size_bytes: blob.size_bytes,
    media_type: blob.media_type,
    token_estimate: estimateTokens(content.markdown),
    deterministic_summary: node.deterministic_summary,
    redactions: sanitized.redactions,
    immutable: true,
    retained_until: null
  };
}

export function finalizeClaimedContextProjectionsInState(
  state,
  { holder, artifacts = [], failures = [], timestamp = now() }
) {
  const result = {
    attempted: artifacts.length + failures.length,
    materialized: 0,
    reused: 0,
    failed: 0,
    superseded: 0,
    failures: []
  };
  for (const artifact of artifacts) finalizeProjectionArtifact(state, artifact, holder, timestamp, result);
  for (const failure of failures) finalizeProjectionFailure(state, failure, holder, timestamp, result);
  return result;
}

function finalizeProjectionArtifact(state, artifact, holder, timestamp, result) {
  const job = state.context_projection_jobs.find((item) => item.id === artifact.job_id);
  const node = state.context_nodes.find((item) => item.id === artifact.node_id);
  if (!leaseOwnedBy(job, holder)) return;
  if (!projectionArtifactCurrent(job, node, artifact)) {
    supersedeClaimedProjectionJob(job, timestamp);
    result.superseded += 1;
    return;
  }
  const version = persistClaimedProjectionVersion(state, node, artifact, timestamp, result);
  node.current_version_id = version.id;
  node.updated_at = timestamp;
  completeClaimedProjectionJob(job, timestamp);
}

function projectionArtifactCurrent(job, node, artifact) {
  if (!node || node.source_hash !== artifact.expected_source_hash) return false;
  const generation = Number(artifact.expected_source_generation || 0);
  return (
    Number(node.source_generation || 0) === generation &&
    job.expected_source_hash === artifact.expected_source_hash &&
    Number(job.expected_source_generation || 0) === generation
  );
}

function supersedeClaimedProjectionJob(job, timestamp) {
  Object.assign(job, {
    status: 'superseded',
    error_code: 'context_projection_job_superseded',
    updated_at: timestamp,
    completed_at: timestamp,
    lease: null
  });
}

function persistClaimedProjectionVersion(state, node, artifact, timestamp, result) {
  const existing = state.context_document_versions.find((item) => item.id === artifact.version.id);
  if (existing) {
    result.reused += 1;
    return existing;
  }
  const version = {
    ...artifact.version,
    version: nextProjectionVersionNumber(state, node.id),
    created_at: timestamp
  };
  state.context_document_versions.push(version);
  result.materialized += 1;
  return version;
}

function completeClaimedProjectionJob(job, timestamp) {
  Object.assign(job, {
    status: 'completed',
    error_code: null,
    next_retry_at: null,
    updated_at: timestamp,
    completed_at: timestamp,
    lease: null
  });
}

function finalizeProjectionFailure(state, failure, holder, timestamp, result) {
  const job = state.context_projection_jobs.find((item) => item.id === failure.job_id);
  if (!leaseOwnedBy(job, holder)) return;
  const errorCode = safeErrorCode(failure.error);
  Object.assign(job, {
    status: 'failed',
    error_code: errorCode,
    next_retry_at: projectionRetryAt(job, timestamp),
    updated_at: timestamp,
    completed_at: null,
    lease: null
  });
  result.failed += 1;
  result.failures.push({ job_id: job.id, node_id: job.node_id, error_code: errorCode });
}

function projectionRetryAt(job, timestamp) {
  return new Date(Date.parse(timestamp) + Math.min(60_000, 1000 * 2 ** Number(job.attempts || 1))).toISOString();
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
