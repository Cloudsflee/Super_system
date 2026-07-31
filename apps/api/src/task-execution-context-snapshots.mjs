import { hashString } from '../../../packages/shared/index.mjs';
import { cloneStateValue as structuredClone } from './state-clone.mjs';

export function legacyAcceptedDependencySnapshot(state, dependencyId) {
  const dependency = acceptedLegacyDependency(state, dependencyId);
  if (!dependency) return null;
  const submission = latestLegacySubmission(state, dependency.id);
  const delivery = latestLegacyDelivery(state, dependency.id);
  if (!submission || !delivery) return null;
  const snapshot = buildLegacyDependencySnapshot(dependency, submission, delivery);
  snapshot.snapshot_hash = hashString(JSON.stringify(snapshot));
  return snapshot;
}

export function validExecutionBindings(state, projectId, bindings, strict = false) {
  return uniqueAssets(
    (bindings || []).map((item) => validExecutionBinding(state, projectId, item, strict)).filter(Boolean)
  );
}

export function confirmedNodeAssets(state, projectId, nodeId) {
  return state.assets
    .filter((item) => item.project_id === projectId && item.node_id === nodeId && item.status === 'confirmed')
    .map((asset) => {
      const version = state.asset_versions.find((item) => item.id === asset.current_version_id);
      return version ? assetVersionSnapshot(asset, version, asset.output_key || version.output_key || null) : null;
    })
    .filter(Boolean);
}

export function runtimeContextSourceRefs(snapshot) {
  const refs = [];
  for (const input of snapshot.inputs || []) appendInputContextSourceRefs(refs, input);
  if (snapshot.workstream_digest?.id) refs.push({ collection: 'digests', id: snapshot.workstream_digest.id });
  return refs;
}

export function requiredContextSourceRefs(snapshot) {
  const refs = new Set();
  for (const input of snapshot.inputs || []) {
    if (input.required === false || !input.context?.id) continue;
    if (input.source === 'brief') refs.add(`project_briefs:${input.context.id}`);
    if (input.source === 'decision') refs.add(`decisions:${input.context.id}`);
  }
  if (snapshot.workstream_digest?.id) refs.add(`digests:${snapshot.workstream_digest.id}`);
  return refs;
}

export function uniqueBindingCount(bindings) {
  return new Set((bindings || []).map((item) => `${item.asset_id}:${item.version_id}`)).size;
}

export function handoffNotReady(code, detail = {}) {
  return { ready: false, reason: { code, ...detail } };
}

export function assetVersionSnapshot(asset, version, outputKey = null, origin = null) {
  return {
    output_key: outputKey,
    asset_id: asset.id,
    version_id: version.id,
    asset_type: asset.asset_type,
    repository_sha: version.repository_sha || asset.repository_sha || null,
    title: version.title,
    summary: version.summary,
    ...assetVersionPayload(version),
    evidence_refs: version.evidence_refs || [],
    verification_status: version.verification_status || 'legacy_unverified',
    handoff_manifest: version.provenance?.handoff_manifest
      ? structuredClone(version.provenance.handoff_manifest)
      : null,
    handoff_manifest_sha256: origin?.handoff_manifest_sha256 || version.provenance?.handoff_manifest_sha256 || null,
    ...producerSnapshot(origin)
  };
}

export function legacyRepositorySnapshot(project, strict) {
  if (strict || !project.repo_path) return null;
  return {
    repository_workspace_id: null,
    legacy: true,
    managed_path: project.repo_path,
    ref: null,
    fixed_sha: project.source_hash || null,
    snapshot_hash: hashString(
      JSON.stringify({ project_id: project.id, repo_path: project.repo_path, source_hash: project.source_hash || null })
    )
  };
}

export function repositoryLineSnapshot(line, task) {
  return {
    repository_line_id: line.id,
    connection_id: line.connection_id,
    ref: line.branch,
    fixed_sha: line.head_sha,
    current_sha: line.head_sha,
    mode: task?.task_kind === 'test' ? 'read_only' : 'read_write',
    managed_path: line.checkout_path,
    snapshot_hash: hashString(
      JSON.stringify({ id: line.id, branch: line.branch, head_sha: line.head_sha, base_sha: line.base_sha })
    )
  };
}

export function dependencySnapshot(state, task, workflowExecutionId = null) {
  return dependencyIds(task).map((id) => {
    const node = state.workflow_nodes.find((item) => item.id === id);
    const execution = workflowExecutionId ? currentExecutionForTask(state, workflowExecutionId, id) : null;
    return {
      id,
      status: execution?.status || node?.status || 'missing',
      execution_revision: Number(node?.execution_revision || 1),
      task_execution_id: execution?.id || null,
      latest_submission_id: node?.latest_submission_id || null
    };
  });
}

export function dependencyIds(task) {
  return [
    ...new Set(
      (task.dependencies || []).map((item) => (typeof item === 'string' ? item : item.node_id)).filter(Boolean)
    )
  ];
}

export function taskSnapshot(task) {
  return {
    id: task.id,
    workflow_id: task.workflow_id,
    parent_node_id: task.parent_node_id || null,
    title: task.title,
    goal: task.goal,
    task_kind: task.task_kind,
    execution_mode: task.execution_mode,
    capability_tags: task.capability_tags || [],
    acceptance_criteria: task.acceptance_criteria || [],
    progression_protocol: task.progression_protocol || null,
    execution_revision: Number(task.execution_revision || 1)
  };
}

export function briefSnapshot(brief) {
  const snapshot = {
    id: brief.id,
    version: brief.version,
    revision: brief.revision,
    content: structuredClone(brief.content)
  };
  return { ...snapshot, content_sha256: hashString(JSON.stringify(snapshot)) };
}

export function digestSnapshot(digest) {
  const snapshot = {
    id: digest.id,
    version: digest.version,
    summary: digest.summary,
    body: digest.body,
    evidence_refs: digest.evidence_refs || []
  };
  return { ...snapshot, content_sha256: hashString(JSON.stringify(snapshot)) };
}

export function decisionSnapshot(item) {
  const snapshot = {
    id: item.id,
    title: item.title,
    summary: item.summary,
    rationale: item.rationale,
    evidence_refs: item.evidence_refs || []
  };
  return { ...snapshot, content_sha256: hashString(JSON.stringify(snapshot)) };
}

export function currentExecutionForTask(state, workflowExecutionId, taskId) {
  return (
    state.task_executions
      .filter((item) => item.workflow_execution_id === workflowExecutionId && item.task_id === taskId)
      .sort((a, b) => Number(b.attempt) - Number(a.attempt))[0] || null
  );
}

export function uniqueAssets(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.asset_id}:${item.version_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function missingExecutionInput(errors, slot, code, detail = {}) {
  errors.push({ code, slot_key: slot.key, ...detail });
  return null;
}

export function byNewest(a, b) {
  return String(b.reviewed_at || b.created_at || '').localeCompare(String(a.reviewed_at || a.created_at || ''));
}

export function cleanExecutionText(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

function acceptedLegacyDependency(state, dependencyId) {
  return state.workflow_nodes.find(
    (item) =>
      item.id === dependencyId &&
      item.role === 'task' &&
      item.status === 'completed' &&
      item.review?.decision === 'approve'
  );
}

function latestLegacySubmission(state, dependencyId) {
  return state.submissions
    .filter(
      (item) => item.node_id === dependencyId && item.status === 'accepted' && !(item.output_bindings || []).length
    )
    .sort(byNewest)[0];
}

function latestLegacyDelivery(state, dependencyId) {
  return state.deliveries
    .filter(
      (item) =>
        item.task_id === dependencyId &&
        item.status === 'completed' &&
        (item.commit_sha || item.result_json?.commit_sha)
    )
    .sort(byNewest)[0];
}

function buildLegacyDependencySnapshot(dependency, submission, delivery) {
  return {
    schema_version: 'aiws.legacy_accepted_dependency.v1',
    dependency_id: dependency.id,
    execution_revision: Number(dependency.execution_revision || 1),
    reviewed_at: dependency.reviewed_at || submission.reviewed_at || null,
    submission: {
      id: submission.id,
      title: submission.title || '',
      summary: submission.summary || '',
      evidence_refs: [...(submission.evidence_refs || [])],
      reviewed_at: submission.reviewed_at || null
    },
    delivery: legacyDeliverySnapshot(delivery)
  };
}

function legacyDeliverySnapshot(delivery) {
  return {
    id: delivery.id,
    commit_sha: delivery.commit_sha || delivery.result_json?.commit_sha || null,
    pr_url: delivery.pr_url || delivery.result_json?.pr_url || null,
    pr_state: delivery.pr_state || delivery.result_json?.pr_state || null,
    completed_at: delivery.completed_at || null,
    test_results: (delivery.test_results || delivery.result_json?.test_results || []).map((item) => ({
      command: item.command || item.name || '',
      status: item.status || '',
      exit_code: item.exit_code ?? null
    }))
  };
}

function validExecutionBinding(state, projectId, binding, strict) {
  const asset = state.assets.find(
    (item) =>
      item.id === binding.asset_id &&
      item.project_id === projectId &&
      item.status === 'confirmed' &&
      item.current_version_id === binding.version_id
  );
  const version = state.asset_versions.find(
    (item) =>
      item.id === binding.version_id &&
      item.asset_id === asset?.id &&
      (!strict || (item.verification_status === 'verified' && item.immutable === true))
  );
  return asset && version ? assetVersionSnapshot(asset, version, binding.key, binding) : null;
}

function appendInputContextSourceRefs(refs, input) {
  if (input.ref_id && ['dependency', 'workstream_dependency'].includes(input.source))
    refs.push({ collection: 'workflow_nodes', id: input.ref_id });
  if (input.context?.id && input.source === 'brief') refs.push({ collection: 'project_briefs', id: input.context.id });
  if (input.context?.id && input.source === 'decision') refs.push({ collection: 'decisions', id: input.context.id });
  for (const binding of input.asset_versions || []) {
    refs.push({ collection: 'assets', id: binding.asset_id });
    refs.push({ collection: 'asset_versions', id: binding.version_id });
  }
}

function assetVersionPayload(version) {
  if (version.verification_status !== 'verified') return { body: version.body };
  return {
    payload_kind: version.payload_kind,
    media_type: version.media_type,
    content_sha256: version.content_sha256,
    size_bytes: version.size_bytes,
    blob_refs: structuredClone(version.blob_refs || []),
    manifest: structuredClone(version.manifest || {})
  };
}

function producerSnapshot(origin) {
  if (!origin?.producer_task_id) return {};
  return {
    producer_task_id: origin.producer_task_id,
    producer_task_execution_id: origin.producer_task_execution_id || null
  };
}
