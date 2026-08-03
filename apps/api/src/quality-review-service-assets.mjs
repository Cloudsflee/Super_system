import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { qualityReviewMediaKind } from './quality-review-media.mjs';
import { currentQualityReviewTaskExecutions } from './quality-review-task-scope.mjs';

export function collectCandidateAssets(state, execution) {
  const taskExecutions = currentQualityReviewTaskExecutions(state, execution.id),
    taskIds = new Set(taskExecutions.map((item) => item.id)),
    candidates = [];
  for (const asset of state.assets.filter((item) => taskIds.has(item.task_execution_id))) {
    const version = state.asset_versions.find(
      (item) => item.id === asset.current_version_id && item.asset_id === asset.id
    );
    if (!version) continue;
    candidates.push(buildCandidate(asset, version, taskExecutions, state));
  }
  return {
    all: candidates,
    in_scope: candidates.filter((item) => item.supported),
    out_of_scope: candidates.filter((item) => !item.supported)
  };
}

function buildCandidate(asset, version, taskExecutions, state) {
  const taskExecution = taskExecutions.find((item) => item.id === asset.task_execution_id),
    task = state.workflow_nodes.find((item) => item.id === taskExecution?.task_id);
  return {
    asset,
    version,
    asset_id: asset.id,
    asset_version_id: version.id,
    title: asset.title || version.title || version.id,
    required: requiredOutput(task, asset.output_key || version.output_key),
    supported: supportedMedia(version),
    out_of_scope_entries: unsupportedManifestEntries(version),
    task_execution_id: taskExecution?.id || null
  };
}

export function candidateAssetsByVersion(state, execution, versionIds) {
  const byId = new Map(collectCandidateAssets(state, execution).all.map((item) => [item.asset_version_id, item]));
  return versionIds.map((versionId) => byId.get(versionId)).filter(Boolean);
}

export function outputBindingCheck(state, _execution, candidates) {
  const missing = candidates.filter((candidate) => !hasOutputBinding(state, candidate));
  return check(
    'output_bindings',
    missing.length ? 'blocked' : 'passed',
    missing.length ? '存在未被当前 task output binding 覆盖的资产。' : '当前 task output binding 覆盖检查通过。',
    { asset_version_ids: missing.map((item) => item.asset_version_id) }
  );
}

function hasOutputBinding(state, candidate) {
  const taskExecution = state.task_executions.find((item) => item.id === candidate.task_execution_id);
  return Boolean(
    taskExecution &&
    (taskExecution.output_bindings || []).some((binding) => binding.version_id === candidate.version.id)
  );
}

export function requiredOutputCoverageCheck(state, execution, _candidates) {
  const current = collectCandidateAssets(state, execution).all,
    missing = [];
  for (const taskExecution of currentQualityReviewTaskExecutions(state, execution.id)) {
    const task = state.workflow_nodes.find((item) => item.id === taskExecution.task_id);
    for (const slot of task?.output_slots || []) {
      if (slot.required === false) continue;
      const outputKey = slot.key || null;
      if (!hasRequiredOutput(current, taskExecution.id, outputKey))
        missing.push({ task_execution_id: taskExecution.id, output_key: outputKey });
    }
  }
  return check(
    'required_outputs',
    missing.length ? 'blocked' : 'passed',
    missing.length ? '存在未生成的必需输出，不能启动内容质量评审。' : '必需输出覆盖检查通过。',
    { missing }
  );
}

function hasRequiredOutput(candidates, taskExecutionId, outputKey) {
  return candidates.some(
    (candidate) =>
      candidate.task_execution_id === taskExecutionId &&
      (candidate.asset.output_key || candidate.version.output_key || null) === outputKey
  );
}

export function supportedMedia(version) {
  const entries = version.manifest?.entries || [];
  return entries.length
    ? entries.some((entry) => isSupportedMediaType(entry.path, entry.media_type))
    : isSupportedMediaType(version.title, version.media_type, version.body != null);
}

export function unsupportedManifestEntries(version) {
  const entries = (version.manifest?.entries || []).filter(
    (item) => item?.role !== 'manifest' && item?.path !== 'manifest.json'
  );
  if (entries.length)
    return entries.filter((entry) => !isSupportedMediaType(entry.path, entry.media_type)).map(publicOutOfScopeEntry);
  if (isSupportedMediaType(version.title, version.media_type, version.body != null)) return [];
  return [
    publicOutOfScopeEntry({
      path: version.title || version.id || 'payload',
      media_type: version.media_type || 'application/octet-stream'
    })
  ];
}

function publicOutOfScopeEntry(entry) {
  return {
    path: String(entry.path || 'unknown'),
    media_type: String(entry.media_type || 'application/octet-stream'),
    reason: 'format_not_supported'
  };
}

export function isSupportedMediaType(filePath, mediaType, hasBody = false) {
  return qualityReviewMediaKind(filePath, mediaType, { hasBody }) !== 'out_of_scope';
}

export function requiredOutput(task, outputKey) {
  const slot = (task?.output_slots || []).find((item) => item.key === outputKey);
  return slot ? slot.required !== false : true;
}

export function publicCandidateAsset(candidate) {
  return {
    asset_id: candidate.asset_id,
    asset_version_id: candidate.asset_version_id,
    title: candidate.title,
    asset_type: candidate.asset.asset_type,
    output_key: candidate.asset.output_key || candidate.version.output_key || null,
    media_type: candidate.version.media_type || null,
    size_bytes: Number(candidate.version.size_bytes || 0),
    content_sha256: candidate.version.content_sha256,
    required: candidate.required,
    verification_status: candidate.version.verification_status,
    immutable: candidate.version.immutable === true,
    status: candidate.asset.status,
    task_execution_id: candidate.task_execution_id,
    scope: candidate.supported ? (candidate.out_of_scope_entries.length ? 'mixed' : 'in_scope') : 'out_of_scope',
    out_of_scope_entries: structuredClone(candidate.out_of_scope_entries)
  };
}

function check(idValue, status, message, details = {}) {
  return { id: idValue, status, message, details };
}
