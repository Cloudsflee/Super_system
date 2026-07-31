import { HttpError } from './http.mjs';

export function assetVersionDetails(state, versionId) {
  const version = state.asset_versions.find((item) => item.id === versionId);
  const asset = state.assets.find((item) => item.id === version?.asset_id);
  if (!asset || !version) throw new HttpError(404, { error: 'asset_version_not_found' });
  return {
    asset,
    version,
    attestations: state.asset_attestations.filter((item) => item.asset_version_id === version.id),
    lineage: assetVersionLineage(state, version.id),
    consumers: assetVersionConsumers(state, version.id)
  };
}

export function assetVersionConsumers(state, versionId) {
  const consumers = [];
  for (const execution of state.task_executions) {
    const consumer = taskExecutionConsumer(execution, versionId);
    if (consumer) consumers.push(consumer);
  }
  for (const relation of assetVersionLineage(state, versionId).downstream) {
    const consumer = workstreamOutcomeConsumer(state, relation, consumers);
    if (consumer) consumers.push(consumer);
  }
  return consumers;
}

export function assetVersionLineage(state, versionId) {
  const relations = (state.asset_relations || []).map((relation) => normalizeOutcomeEvidenceRelation(state, relation));
  const known = new Set(relations.map(relationKey));
  for (const relation of inferredWorkstreamOutcomeRelations(state)) {
    const key = relationKey(relation);
    if (!known.has(key)) {
      known.add(key);
      relations.push(relation);
    }
  }
  return {
    upstream: relations.filter((item) => item.target_asset_version_id === versionId),
    downstream: relations.filter((item) => item.source_asset_version_id === versionId)
  };
}

function taskExecutionConsumer(execution, versionId) {
  const inputs = execution.context_snapshot?.inputs || [];
  const matched = inputs.flatMap((item) => item.asset_versions || []).filter((item) => item.version_id === versionId);
  if (!matched.length) return null;
  const effects = (execution.input_effects || []).filter((item) => (item.version_ids || []).includes(versionId));
  const acceptedEffects = acceptedExecutionEffects(execution, effects);
  const contributionAware = execution.effects_schema_version === 'aiws.task_effects.v2';
  const consumed = executionInputWasConsumed(execution, versionId, effects, acceptedEffects, contributionAware);
  return {
    type: consumed ? 'task_execution' : 'task_execution_input',
    id: execution.id,
    workflow_execution_id: execution.workflow_execution_id,
    task_id: execution.task_id,
    status: execution.status,
    consumption_status: executionConsumptionStatus(contributionAware, effects, acceptedEffects, consumed),
    effects,
    input_keys: inputs
      .filter((item) => (item.asset_versions || []).some((version) => version.version_id === versionId))
      .map((item) => item.key)
  };
}

function acceptedExecutionEffects(execution, effects) {
  const acceptedClaimIds = new Set(execution.accepted_effect_claim_ids || []);
  const acceptedContributionIds = new Set(execution.accepted_contribution_ids || []);
  return effects.filter((effect) => {
    if (effect.claim_id) return acceptedClaimIds.has(effect.claim_id);
    return Boolean(effect.contribution_id && acceptedContributionIds.has(effect.contribution_id));
  });
}

function executionInputWasConsumed(execution, versionId, effects, acceptedEffects, contributionAware) {
  if (contributionAware) return acceptedEffects.length > 0;
  return effects.length > 0 || (execution.consumed_inputs || []).includes(versionId);
}

function executionConsumptionStatus(contributionAware, effects, acceptedEffects, consumed) {
  if (contributionAware) {
    if (acceptedEffects.length) return 'accepted_contribution';
    return effects.length ? 'structurally_verified' : 'prepared';
  }
  if (effects.length) return 'applied';
  return consumed ? 'consumed' : 'prepared';
}

function workstreamOutcomeConsumer(state, relation, existing) {
  const targetVersion = state.asset_versions.find((item) => item.id === relation.target_asset_version_id);
  const targetAsset = state.assets.find((item) => item.id === targetVersion?.asset_id);
  if (!targetAsset || !/WorkstreamOutcome/i.test(targetAsset.asset_type)) return null;
  if (existing.some((item) => item.type === 'workstream_outcome' && item.asset_version_id === targetVersion.id))
    return null;
  return {
    type: 'workstream_outcome',
    id: targetAsset.id,
    asset_id: targetAsset.id,
    asset_version_id: targetVersion.id,
    workflow_execution_id:
      targetAsset.provenance_workflow_execution_id || targetVersion.provenance?.workflow_execution_id || null,
    workstream_id: targetAsset.node_id || targetVersion.provenance?.workstream_id || null,
    status: targetAsset.status,
    consumption_status: 'evidenced',
    input_keys: ['terminal_output_bindings']
  };
}

function inferredWorkstreamOutcomeRelations(state) {
  const relations = [];
  for (const attestation of state.asset_attestations || []) {
    const target = attestedWorkstreamOutcome(state, attestation);
    if (!target) continue;
    for (const binding of attestation.evidence?.terminal_output_bindings || []) {
      const relation = inferredOutcomeRelation(state, attestation, target, binding);
      if (relation) relations.push(relation);
    }
  }
  return relations;
}

function attestedWorkstreamOutcome(state, attestation) {
  if (attestation.decision !== 'accepted' || attestation.attestor_type !== 'trusted_verifier') return null;
  const version = state.asset_versions.find((item) => item.id === attestation.asset_version_id);
  const asset = state.assets.find((item) => item.id === version?.asset_id);
  return asset && /WorkstreamOutcome/i.test(asset.asset_type) ? { asset, version } : null;
}

function inferredOutcomeRelation(state, attestation, target, binding) {
  const sourceVersion = state.asset_versions.find(
    (item) => item.id === binding.version_id && item.asset_id === binding.asset_id
  );
  const sourceAsset = state.assets.find((item) => item.id === sourceVersion?.asset_id);
  if (!sourceAsset || sourceVersion.id === target.version.id) return null;
  return {
    id: `arl_inferred_${sourceVersion.id}_${target.version.id}`,
    relation_type: 'evidenced_by',
    source_asset_id: sourceAsset.id,
    source_asset_version_id: sourceVersion.id,
    target_asset_id: target.asset.id,
    target_asset_version_id: target.version.id,
    input_snapshot_hash: null,
    execution_id: null,
    workflow_execution_id:
      attestation.evidence.workflow_execution_id || target.asset.provenance_workflow_execution_id || null,
    inferred: true,
    created_at: attestation.created_at
  };
}

function normalizeOutcomeEvidenceRelation(state, relation) {
  if (relation.relation_type !== 'derived_from') return relation;
  const targetVersion = state.asset_versions.find((item) => item.id === relation.target_asset_version_id);
  const targetAsset = state.assets.find((item) => item.id === targetVersion?.asset_id);
  return targetAsset && /WorkstreamOutcome/i.test(targetAsset.asset_type)
    ? { ...relation, relation_type: 'evidenced_by', legacy_relation_type: 'derived_from' }
    : relation;
}

function relationKey(item) {
  return `${item.relation_type}:${item.source_asset_version_id}:${item.target_asset_version_id}`;
}
