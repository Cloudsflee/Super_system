import { now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { normalizeIdList } from './task-handoff.mjs';

export function applyExecutionOutputUsage(taskExecution, consumption, contextConsumption, effects) {
  const contributionAware = effects?.schema_version === 'aiws.task_effects.v2';
  Object.assign(taskExecution, {
    consumed_inputs: contributionAware ? [] : consumption.aggregate,
    input_dispositions: contributionAware ? [] : consumption.dispositions,
    context_selection_id: contextConsumption.selectionId,
    context_selection_ids: contextConsumption.selectionIds,
    consumed_context_document_versions: contributionAware ? [] : contextConsumption.aggregate,
    context_dispositions: contributionAware ? [] : contextConsumption.dispositions,
    status: 'verifying',
    updated_at: now()
  });
  if (!effects) return;
  Object.assign(taskExecution, {
    effects_schema_version: effects.schema_version,
    input_effects: effects.inputEffects,
    context_effects: effects.contextEffects,
    ...(contributionAware
      ? {
          declared_consumed_inputs: consumption.aggregate,
          structurally_verified_inputs: consumption.aggregate,
          declared_context_document_versions: contextConsumption.aggregate,
          structurally_verified_context_document_versions: contextConsumption.aggregate,
          accepted_effect_claim_ids: [],
          effect_claim_statuses: effectClaimStatuses([...effects.inputEffects, ...effects.contextEffects], new Set()),
          contribution_statuses: contributionStatuses(
            effects.inputEffects,
            taskExecution.context_snapshot?.input_effect_obligations,
            emptyAuthority()
          )
        }
      : {})
  });
}

export function updateAcceptedContributions(execution) {
  if (execution.effects_schema_version !== 'aiws.task_effects.v2') return;
  const authority = executionAcceptanceAuthority(execution),
    acceptedInputEffects = (execution.input_effects || []).filter((effect) => effectAccepted(effect, authority)),
    acceptedContextEffects = (execution.context_effects || []).filter((effect) => effectAccepted(effect, authority)),
    acceptedEffectClaimIds = normalizeIdList([
      ...acceptedInputEffects.map((effect) => effect.claim_id),
      ...acceptedContextEffects.map((effect) => effect.claim_id)
    ]),
    statuses = contributionStatuses(
      execution.input_effects || [],
      execution.context_snapshot?.input_effect_obligations,
      authority
    ),
    acceptedContributionIds = statuses.filter((item) => item.status === 'accepted').map((item) => item.contribution_id);
  Object.assign(execution, {
    consumed_inputs: normalizeIdList(acceptedInputEffects.flatMap((effect) => effect.version_ids || [])),
    input_dispositions: acceptedEffectDispositions(acceptedInputEffects, 'version_id'),
    consumed_context_document_versions: normalizeIdList(
      acceptedContextEffects.map((effect) => effect.document_version_id)
    ),
    context_dispositions: acceptedEffectDispositions(acceptedContextEffects, 'document_version_id'),
    accepted_effect_claim_ids: acceptedEffectClaimIds,
    accepted_contribution_ids: acceptedContributionIds,
    contribution_statuses: statuses,
    effect_claim_statuses: effectClaimStatuses(
      [...(execution.input_effects || []), ...(execution.context_effects || [])],
      new Set(acceptedEffectClaimIds)
    )
  });
}

export function contributionStatuses(effects, obligations = [], authority = emptyAuthority()) {
  const grouped = new Map(),
    obligationById = new Map(
      (obligations || []).filter((item) => item?.contribution?.id).map((item) => [item.contribution.id, item])
    );
  for (const effect of effects || []) {
    if (!effect.contribution_id) continue;
    const current = grouped.get(effect.contribution_id) || {
      contribution_id: effect.contribution_id,
      status: 'structurally_verified',
      output_keys: [],
      criterion_ids: [],
      version_ids: [],
      claim_ids: [],
      source_receipts: [],
      evidence_refs: []
    };
    current.output_keys.push(...(effect.output_keys || []));
    current.criterion_ids.push(...(effect.criterion_ids || []));
    current.version_ids.push(...(effect.version_ids || []));
    current.claim_ids.push(effect.claim_id);
    current.source_receipts.push(...(effect.source_receipts || []));
    current.evidence_refs.push(...(effect.evidence_refs || []));
    grouped.set(effect.contribution_id, current);
  }
  return [...grouped.values()]
    .map((item) => contributionStatus(item, obligationById.get(item.contribution_id), authority))
    .sort((left, right) => left.contribution_id.localeCompare(right.contribution_id));
}

export function requiredContributionAuthorityGaps(execution) {
  if (execution?.effects_schema_version !== 'aiws.task_effects.v2') return [];
  const accepted = new Set(execution.accepted_contribution_ids || []);
  return (execution.context_snapshot?.input_effect_obligations || [])
    .filter(
      (item) => item.application_policy === 'required' && item.contribution?.id && !accepted.has(item.contribution.id)
    )
    .map((item) => ({
      code: 'required_contribution_not_accepted',
      input_key: item.input_key,
      contribution_id: item.contribution.id
    }));
}

export function assertRequiredContributionAuthority(execution) {
  const reasons = requiredContributionAuthorityGaps(execution);
  if (reasons.length) throw new HttpError(409, { error: 'task_contribution_authority_incomplete', reasons });
}

function contributionStatus(item, obligation, authority) {
  const outputKeys = normalizeIdList(item.output_keys),
    criterionIds = normalizeIdList(obligation?.contribution?.target_criterion_ids || item.criterion_ids),
    claimIds = normalizeIdList(item.claim_ids),
    acceptedClaimIds = claimIds.filter((claimId) => authority.acceptedClaimIds.has(claimId)),
    acceptedCriterionIds = criterionIds.filter((criterionId) => authority.acceptedCriterionIds.has(criterionId)),
    missingCriterionIds = criterionIds.filter((criterionId) => !authority.acceptedCriterionIds.has(criterionId)),
    accepted =
      claimIds.length > 0 &&
      acceptedClaimIds.length === claimIds.length &&
      outputKeys.every((outputKey) => authority.acceptedOutputKeys.has(outputKey)) &&
      !missingCriterionIds.length;
  return {
    ...item,
    output_keys: outputKeys,
    criterion_ids: normalizeIdList(item.criterion_ids),
    version_ids: normalizeIdList(item.version_ids),
    claim_ids: claimIds,
    accepted_claim_ids: acceptedClaimIds,
    accepted_criterion_ids: acceptedCriterionIds,
    missing_criterion_ids: missingCriterionIds,
    source_receipts: normalizeIdList(item.source_receipts),
    evidence_refs: normalizeIdList(item.evidence_refs),
    status: accepted ? 'accepted' : 'structurally_verified'
  };
}

function executionAcceptanceAuthority(execution) {
  const acceptedOutputKeys = new Set((execution.output_bindings || []).map((item) => item.key)),
    acceptedCriterionIds = new Set(
      (execution.acceptance_results || [])
        .filter((item) => item.status === 'accepted' && acceptedOutputKeys.has(item.output_key))
        .map((item) => item.acceptance_criterion_id)
        .filter(Boolean)
    ),
    acceptedClaimIds = new Set(
      (execution.output_bindings || []).flatMap((item) => item.accepted_effect_claim_ids || [])
    );
  return { acceptedOutputKeys, acceptedCriterionIds, acceptedClaimIds };
}

function effectAccepted(effect, authority) {
  return (
    Boolean(effect?.claim_id) &&
    authority.acceptedClaimIds.has(effect.claim_id) &&
    (effect.output_keys || []).every((key) => authority.acceptedOutputKeys.has(key)) &&
    (effect.criterion_ids || []).every((id) => authority.acceptedCriterionIds.has(id))
  );
}

function effectClaimStatuses(effects, accepted) {
  return (effects || [])
    .filter((effect) => effect?.claim_id)
    .map((effect) => ({
      claim_id: effect.claim_id,
      source_type: effect.input_key ? 'input' : 'context',
      input_key: effect.input_key || null,
      document_version_id: effect.document_version_id || null,
      contribution_id: effect.contribution_id || null,
      output_keys: normalizeIdList(effect.output_keys),
      criterion_ids: normalizeIdList(effect.criterion_ids),
      status: accepted.has(effect.claim_id) ? 'accepted' : 'structurally_verified'
    }))
    .sort((left, right) => left.claim_id.localeCompare(right.claim_id));
}

function acceptedEffectDispositions(effects, idKey) {
  const byId = new Map();
  for (const effect of effects || []) {
    const ids = idKey === 'version_id' ? effect.version_ids || [] : [effect.document_version_id];
    for (const value of ids)
      if (value && !byId.has(value)) byId.set(value, { [idKey]: value, disposition: 'used', reason: effect.statement });
  }
  return [...byId.values()].sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

function emptyAuthority() {
  return { acceptedOutputKeys: new Set(), acceptedCriterionIds: new Set(), acceptedClaimIds: new Set() };
}
