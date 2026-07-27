import { AssetStatus, makeAssetFromCandidate } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';

export function validateTaskOutputBindings(state, { task, contract, bindings, projectId, strict = true }) {
  const source = Array.isArray(bindings) ? bindings : [],
    normalized = [],
    errors = [],
    outputSlots = contract?.expected_outputs || [];
  for (const binding of source) {
    const key = clean(binding?.key, 120),
      slot = outputSlots.find((item) => item.key === key);
    const asset = state.assets.find((item) => item.id === binding?.asset_id && item.project_id === projectId),
      version = state.asset_versions.find((item) => item.id === binding?.version_id && item.asset_id === asset?.id);
    if (!slot) {
      errors.push({ code: 'output_slot_unknown', output_key: key });
      continue;
    }
    if (!asset || !version || asset.node_id !== task.id) {
      errors.push({ code: 'output_asset_version_invalid', output_key: key });
      continue;
    }
    if (asset.status !== AssetStatus.Confirmed) {
      errors.push({
        code: 'output_asset_confirmation_required',
        output_key: key,
        confirmation_policy: slot.confirmation_policy,
        asset_id: asset.id
      });
      continue;
    }
    if (slot.asset_type && asset.asset_type !== slot.asset_type) {
      errors.push({
        code: 'output_asset_type_mismatch',
        output_key: key,
        expected: slot.asset_type,
        actual: asset.asset_type
      });
      continue;
    }
    const criteria = unique(
      binding.acceptance_criteria?.length
        ? binding.acceptance_criteria
        : asset.acceptance_criteria?.length
          ? asset.acceptance_criteria
          : slot.acceptance_criteria
    );
    if ((slot.acceptance_criteria || []).some((item) => !criteria.includes(item)))
      errors.push({ code: 'output_acceptance_criteria_uncovered', output_key: key });
    normalized.push({
      key,
      asset_id: asset.id,
      version_id: version.id,
      asset_type: asset.asset_type,
      acceptance_criteria: criteria,
      confirmation_policy: slot.confirmation_policy
    });
  }
  for (const slot of outputSlots.filter((item) => item.required !== false))
    if (!normalized.some((item) => item.key === slot.key))
      errors.push({ code: 'required_output_binding_missing', output_key: slot.key });
  const covered = new Set(normalized.flatMap((item) => item.acceptance_criteria));
  for (const criterion of contract?.acceptance_criteria || [])
    if (
      !covered.has(criterion) &&
      !outputSlots.some(
        (slot) =>
          (slot.acceptance_criteria || []).includes(criterion) && normalized.some((item) => item.key === slot.key)
      )
    )
      errors.push({ code: 'task_acceptance_criterion_uncovered', criterion });
  if (strict && errors.length) throw new HttpError(409, { error: 'task_outputs_not_ready', reasons: errors });
  return { bindings: normalized, errors };
}

export function createExecutionOutputAssets(state, { actorId, project, task, workspace, execution, candidates = [] }) {
  const contract = execution.contract_snapshot || execution.task_execution_context?.contract,
    bindings = [],
    assets = [];
  for (const [index, slot] of (contract?.expected_outputs || []).entries()) {
    const candidate =
      candidates.find((item) => item.output_key === slot.key || item.asset_type === slot.asset_type) ||
      candidates[index];
    if (!candidate) continue;
    const evidence = evidenceForExecution(execution, candidate),
      systemConfirmed =
        slot.confirmation_policy === 'system_evidence' && systemEvidenceValid(execution, slot, evidence);
    const made = makeAssetFromCandidate(
      { ...candidate, asset_type: slot.asset_type, evidence_refs: evidence },
      {
        projectId: project.id,
        workspaceId: workspace?.id || task.workspace_id,
        nodeId: task.id,
        runId: execution.id,
        actorId,
        status: systemConfirmed ? AssetStatus.Confirmed : AssetStatus.Candidate
      }
    );
    const repositorySha = /RepositoryVersionAsset/i.test(slot.asset_type)
      ? execution.commit_sha || execution.result_json?.commit_sha || null
      : null;
    Object.assign(made.asset, {
      output_key: slot.key,
      repository_sha: repositorySha,
      acceptance_criteria: [...(slot.acceptance_criteria || [])],
      confirmation_policy: slot.confirmation_policy,
      execution_type: execution.operation_id ? 'delivery' : 'node_run',
      execution_id: execution.id
    });
    Object.assign(made.version, {
      output_key: slot.key,
      repository_sha: repositorySha,
      acceptance_criteria: [...(slot.acceptance_criteria || [])],
      input_snapshot_hash: execution.input_snapshot_hash || null
    });
    state.assets.push(made.asset);
    state.asset_versions.push(made.version);
    assets.push(made.asset);
    if (systemConfirmed)
      bindings.push({
        key: slot.key,
        asset_id: made.asset.id,
        version_id: made.version.id,
        asset_type: made.asset.asset_type,
        acceptance_criteria: [...(slot.acceptance_criteria || [])],
        confirmation_policy: slot.confirmation_policy
      });
  }
  execution.output_bindings = bindings;
  recordAssetLineage(state, execution.task_execution_context, bindings, execution.id);
  return { assets, bindings };
}

export function recordAssetLineage(state, context, outputBindings, executionId = null) {
  const sources = uniqueBindings((context?.inputs || []).flatMap((item) => item.asset_versions || [])),
    sourceByVersion = new Map(sources.map((item) => [item.version_id, item])),
    targets = uniqueBindings(outputBindings || []);
  for (const target of targets) {
    const targetVersion = state.asset_versions.find((item) => item.id === target.version_id),
      declared = targetVersion?.provenance?.consumed_inputs,
      consumedSources = Array.isArray(declared)
        ? uniqueBindings(declared.map((versionId) => sourceByVersion.get(versionId)).filter(Boolean))
        : sources;
    for (const source of consumedSources) {
      const duplicate = state.asset_relations.some(
        (item) =>
          item.relation_type === 'derived_from' &&
          item.source_asset_version_id === source.version_id &&
          item.target_asset_version_id === target.version_id
      );
      if (!duplicate)
        state.asset_relations.push({
          id: `arl_${cryptoId()}`,
          relation_type: 'derived_from',
          source_asset_id: source.asset_id,
          source_asset_version_id: source.version_id,
          target_asset_id: target.asset_id,
          target_asset_version_id: target.version_id,
          input_snapshot_hash: context?.input_snapshot_hash || null,
          execution_id: executionId,
          created_at: new Date().toISOString()
        });
    }
  }
}

export function latestTaskExecution(state, taskId) {
  return (
    [
      ...state.node_runs.filter((item) => item.node_id === taskId && ['succeeded', 'completed'].includes(item.status)),
      ...state.deliveries.filter((item) => item.task_id === taskId && item.status === 'completed')
    ].sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')))[0] || null
  );
}

function systemEvidenceValid(execution, slot, evidence) {
  if (!evidence.length || execution.input_superseded) return false;
  const tests = execution.test_results || execution.result_json?.test_results || [];
  if (/TestEvidence/i.test(slot.asset_type))
    return tests.length > 0 && tests.every((item) => ['passed', 'succeeded'].includes(item.status));
  if (/CodeChange|DeliveryEvidence/i.test(slot.asset_type))
    return (
      Boolean(execution.commit_sha || execution.result_json?.commit_sha) &&
      tests.every((item) => ['passed', 'succeeded'].includes(item.status))
    );
  return (
    Boolean(execution.commit_sha) ||
    (tests.length > 0 && tests.every((item) => ['passed', 'succeeded'].includes(item.status)))
  );
}
function evidenceForExecution(execution, candidate) {
  return unique([
    ...(candidate.evidence_refs || []),
    `${execution.operation_id ? 'delivery' : 'node_run'}:${execution.id}`,
    ...(execution.commit_sha ? [`commit:${execution.commit_sha}`] : []),
    ...(execution.test_results || []).map((item, index) => `test:${execution.id}:${index}:${item.status}`)
  ]);
}
function uniqueBindings(items) {
  const seen = new Set();
  return items.filter(
    (item) =>
      item?.asset_id &&
      item?.version_id &&
      !seen.has(`${item.asset_id}:${item.version_id}`) &&
      seen.add(`${item.asset_id}:${item.version_id}`)
  );
}
function unique(items) {
  return [...new Set((items || []).map((item) => clean(item, 2000)).filter(Boolean))];
}
function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
function cryptoId() {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;
}
