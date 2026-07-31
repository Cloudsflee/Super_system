import {
  assetVersionSnapshot,
  byNewest,
  handoffNotReady,
  uniqueAssets,
  uniqueBindingCount,
  validExecutionBindings
} from './task-execution-context-snapshots.mjs';

export function inspectWorkstreamDependencyHandoff(
  state,
  {
    projectId,
    workflowId,
    workflowExecutionId = null,
    workstreamId,
    selector = 'required_outputs',
    strict = true,
    receiptOnly = false
  }
) {
  const workstream = findDependencyWorkstream(state, workstreamId, workflowId);
  if (!workstream)
    return handoffNotReady('workstream_dependency_scope_invalid', { dependency_workstream_id: workstreamId || null });
  const outcome = findWorkstreamOutcome(state, { projectId, workflowExecutionId, workstream, strict });
  if (!outcome.ready) return outcome;
  const selected = selectHandoffBindings(outcome.attestation, {
    selector,
    strict,
    receiptOnly,
    workstream,
    workflowExecutionId
  });
  if (!selected.ready) return selected;
  const selectedVersions = validExecutionBindings(state, projectId, selected.bindings, strict);
  if (strict && selectedVersions.length !== uniqueBindingCount(selected.bindings))
    return handoffNotReady('workstream_dependency_binding_invalid', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId,
      selector
    });
  return buildReadyHandoff(state, {
    workstream,
    ...outcome,
    selectedVersions,
    selector,
    receiptOnly,
    workflowExecutionId
  });
}

export function selectTaskOutputBindings(state, task, execution, selector, bindings = null) {
  const source = bindings || execution?.output_bindings || [];
  const contract = state.node_contracts.find(
    (item) => item.id === (execution?.contract_id || task?.current_contract_id)
  );
  if (selector && selector !== 'required_outputs') return source.filter((item) => item.key === selector);
  if (!contract) return source;
  const requiredKeys = new Set(
    (contract.expected_outputs || []).filter((item) => item.required !== false).map((item) => item.key)
  );
  return source.filter((item) => requiredKeys.has(item.key));
}

function findDependencyWorkstream(state, workstreamId, workflowId) {
  return state.workflow_nodes.find(
    (item) => item.id === workstreamId && item.role === 'workstream' && item.workflow_id === workflowId
  );
}

function findWorkstreamOutcome(state, options) {
  const { projectId, workflowExecutionId, workstream, strict } = options;
  const asset = latestWorkstreamOutcomeAsset(state, projectId, workflowExecutionId, workstream.id);
  const version = matchingOutcomeVersion(state, asset, strict);
  const attestation = matchingOutcomeAttestation(state, version, workflowExecutionId, strict);
  if (!asset || !version || (strict && !attestation))
    return handoffNotReady('workstream_dependency_output_missing', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId
    });
  return { ready: true, asset, version, attestation };
}

function latestWorkstreamOutcomeAsset(state, projectId, workflowExecutionId, workstreamId) {
  return state.assets
    .filter(
      (item) =>
        item.node_id === workstreamId &&
        item.project_id === projectId &&
        item.asset_type === 'WorkstreamOutcomeAsset' &&
        item.status === 'confirmed' &&
        (!workflowExecutionId || item.provenance_workflow_execution_id === workflowExecutionId)
    )
    .sort(byNewest)[0];
}

function matchingOutcomeVersion(state, asset, strict) {
  return state.asset_versions.find(
    (item) =>
      item.id === asset?.current_version_id &&
      item.asset_id === asset?.id &&
      (!strict || (item.verification_status === 'verified' && item.immutable === true))
  );
}

function matchingOutcomeAttestation(state, version, workflowExecutionId, strict) {
  return state.asset_attestations.find(
    (item) =>
      item.asset_version_id === version?.id &&
      item.decision === 'accepted' &&
      (!strict || item.attestor_type === 'trusted_verifier') &&
      (!workflowExecutionId || item.evidence?.workflow_execution_id === workflowExecutionId)
  );
}

function selectHandoffBindings(attestation, options) {
  const { selector, strict, receiptOnly, workstream, workflowExecutionId } = options;
  if (!receiptOnly && selector === 'workstream_outcome')
    return handoffNotReady('workstream_outcome_not_consumable', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId
    });
  const declared =
    attestation?.evidence?.handoff_output_bindings || attestation?.evidence?.terminal_output_bindings || [];
  const bindings = filterHandoffBindings(declared, selector, receiptOnly);
  const validation = validateSelectedHandoffBindings(bindings, options);
  return validation || { ready: true, bindings };
}

function filterHandoffBindings(bindings, selector, receiptOnly) {
  if (receiptOnly) return [];
  if (selector === 'required_outputs') return bindings.filter((item) => item.required !== false);
  return bindings.filter((item) => item.key === selector);
}

function validateSelectedHandoffBindings(bindings, options) {
  const { selector, strict, receiptOnly, workstream, workflowExecutionId } = options;
  if (!receiptOnly && !bindings.length && (strict || selector !== 'required_outputs'))
    return handoffNotReady('workstream_dependency_binding_missing', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId,
      selector
    });
  if (!receiptOnly && selector !== 'required_outputs' && bindings.length > 1)
    return handoffNotReady('workstream_dependency_selector_ambiguous', {
      dependency_workstream_id: workstream.id,
      workflow_execution_id: workflowExecutionId,
      selector,
      producer_task_ids: [...new Set(bindings.map((item) => item.producer_task_id).filter(Boolean))]
    });
  return null;
}

function buildReadyHandoff(state, options) {
  const { workstream, asset, version, attestation, selectedVersions, selector, receiptOnly, workflowExecutionId } =
    options;
  const selectedOutputs = selectedVersions.map((item) => selectedOutputSnapshot(state, item));
  return {
    ready: true,
    workstream,
    asset,
    version,
    attestation,
    receipt: assetVersionSnapshot(asset, version, 'workstream_outcome'),
    asset_versions: receiptOnly ? [] : uniqueAssets(selectedVersions),
    resolved_from: {
      kind: 'workstream_outcome',
      workflow_execution_id: asset.provenance_workflow_execution_id || workflowExecutionId || null,
      workstream_id: workstream.id,
      workstream_title: workstream.title,
      outcome_asset_id: asset.id,
      outcome_version_id: version.id,
      outcome_attestation_id: attestation?.id || null,
      selector,
      selected_output_keys: selectedOutputs.map((item) => item.output_key).filter(Boolean),
      selected_outputs: selectedOutputs
    }
  };
}

function selectedOutputSnapshot(state, item) {
  return {
    output_key: item.output_key,
    asset_id: item.asset_id,
    version_id: item.version_id,
    asset_type: item.asset_type,
    producer_task_id: item.producer_task_id || null,
    producer_task_title:
      state.workflow_nodes.find((node) => node.id === item.producer_task_id)?.title || item.producer_task_id || null,
    producer_task_execution_id: item.producer_task_execution_id || null
  };
}
