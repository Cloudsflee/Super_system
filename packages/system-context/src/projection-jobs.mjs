import { CONTEXT_INTERNAL_COLLECTIONS, contextHash } from './protocol.mjs';

export function stageContextProjectionJob(state, node, timestamp, indexes = null) {
  const generation = Number(node.source_generation || 1);
  const id = `ctxjob_${contextHash(`${node.id}:${node.source_hash}:${generation}`).slice(0, 24)}`;
  const jobsById = indexes?.jobsById || new Map(state.context_projection_jobs.map((job) => [job.id, job]));
  const versionsByNode = indexes?.versionsByNode || indexVersionsByNode(state.context_document_versions);
  const reusable = reusableDocumentVersion(versionsByNode.get(node.id), node.source_hash);
  if (reusable) {
    node.current_version_id = reusable.id;
    return;
  }
  const existing = jobsById.get(id);
  if (retainExistingProjectionJob(existing, generation, timestamp)) return;
  const value = projectionJobValue(id, node, generation, existing, timestamp);
  if (existing) Object.assign(existing, value);
  else {
    state.context_projection_jobs.push(value);
    jobsById.set(id, value);
  }
}

export function compactContextProjectionJobs(state) {
  ensureContextCollections(state);
  const nodeById = new Map(state.context_nodes.map((node) => [node.id, node]));
  const completedByNode = new Map();
  const activeByProjection = new Map();
  for (const job of state.context_projection_jobs) {
    const current = currentProjectionJob(job, nodeById);
    if (!current) continue;
    if (job.status === 'completed') retainLatestCompletedJob(completedByNode, job);
    else retainHighestPriorityActiveJob(activeByProjection, job, current.generation);
  }
  const keep = new Set([...activeByProjection.values(), ...completedByNode.values()].map((job) => job.id));
  const before = state.context_projection_jobs.length;
  state.context_projection_jobs = state.context_projection_jobs.filter((job) => keep.has(job.id));
  return before - state.context_projection_jobs.length;
}

function indexVersionsByNode(versions) {
  return versions.reduce((map, version) => {
    const values = map.get(version.node_id) || [];
    values.push(version);
    map.set(version.node_id, values);
    return map;
  }, new Map());
}

function reusableDocumentVersion(versions, sourceHash) {
  return (versions || [])
    .filter((version) => version.source_hash === sourceHash)
    .sort(
      (left, right) =>
        Number(right.version || 0) - Number(left.version || 0) ||
        String(right.created_at || '').localeCompare(String(left.created_at || ''))
    )[0];
}

function retainExistingProjectionJob(existing, generation, timestamp) {
  if (existing?.status === 'failed') return true;
  if (existing?.status === 'pending') {
    if (!Number.isInteger(existing.expected_source_generation)) existing.expected_source_generation = generation;
    return true;
  }
  return existing?.status === 'running' && Date.parse(existing.lease?.expires_at || '') > Date.parse(timestamp);
}

function projectionJobValue(id, node, generation, existing, timestamp) {
  return {
    id,
    node_id: node.id,
    expected_source_hash: node.source_hash,
    expected_source_generation: generation,
    status: 'pending',
    attempts: Number(existing?.attempts || 0),
    error_code: null,
    next_retry_at: null,
    created_at: existing?.created_at || timestamp,
    updated_at: timestamp,
    completed_at: null
  };
}

function currentProjectionJob(job, nodeById) {
  const node = nodeById.get(job.node_id);
  if (!node || job.expected_source_hash !== node.source_hash || job.status === 'superseded') return null;
  const generation = Number.isInteger(job.expected_source_generation)
    ? Number(job.expected_source_generation)
    : Number(node.source_generation || 0);
  if (!Number.isInteger(job.expected_source_generation)) job.expected_source_generation = generation;
  return generation === Number(node.source_generation || 0) ? { node, generation } : null;
}

function retainHighestPriorityActiveJob(activeByProjection, job, generation) {
  const key = `${job.node_id}:${job.expected_source_hash}:${generation}`;
  const prior = activeByProjection.get(key);
  if (!prior || compareProjectionJobPriority(job, prior) < 0) activeByProjection.set(key, job);
}

function retainLatestCompletedJob(completedByNode, job) {
  const prior = completedByNode.get(job.node_id);
  if (!prior || projectionJobTimestamp(job).localeCompare(projectionJobTimestamp(prior)) > 0)
    completedByNode.set(job.node_id, job);
}

function projectionJobTimestamp(job) {
  return String(job.updated_at || job.completed_at || '');
}

function compareProjectionJobPriority(left, right) {
  const priority = { running: 0, pending: 1, failed: 2 };
  return (
    (priority[left.status] ?? 9) - (priority[right.status] ?? 9) ||
    String(right.updated_at || right.created_at || '').localeCompare(
      String(left.updated_at || left.created_at || '')
    ) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function ensureContextCollections(state) {
  for (const name of CONTEXT_INTERNAL_COLLECTIONS) if (!Array.isArray(state[name])) state[name] = [];
}
