import { now } from '../../../packages/shared/index.mjs';
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
  if (effects)
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
            contribution_statuses: contributionStatuses(effects.inputEffects, [])
          }
        : {})
    });
}

export function updateAcceptedContributions(execution) {
  if (execution.effects_schema_version !== 'aiws.task_effects.v2') return;
  const acceptedOutputKeys = new Set((execution.output_bindings || []).map((item) => item.key)),
    statuses = contributionStatuses(execution.input_effects || [], acceptedOutputKeys),
    acceptedContributionIds = new Set(
      statuses.filter((item) => item.status === 'accepted').map((item) => item.contribution_id)
    ),
    acceptedInputEffects = (execution.input_effects || []).filter((effect) =>
      acceptedContributionIds.has(effect.contribution_id)
    ),
    acceptedContextEffects = (execution.context_effects || []).filter((effect) =>
      (effect.output_keys || []).every((key) => acceptedOutputKeys.has(key))
    );
  Object.assign(execution, {
    consumed_inputs: normalizeIdList(acceptedInputEffects.flatMap((effect) => effect.version_ids || [])),
    input_dispositions: acceptedEffectDispositions(acceptedInputEffects, 'version_id'),
    consumed_context_document_versions: normalizeIdList(
      acceptedContextEffects.map((effect) => effect.document_version_id)
    ),
    context_dispositions: acceptedEffectDispositions(acceptedContextEffects, 'document_version_id'),
    accepted_contribution_ids: [...acceptedContributionIds].sort(),
    contribution_statuses: statuses
  });
}

export function contributionStatuses(effects, acceptedOutputKeys) {
  const accepted = acceptedOutputKeys instanceof Set ? acceptedOutputKeys : new Set(acceptedOutputKeys),
    grouped = new Map();
  for (const effect of effects || []) {
    if (!effect.contribution_id) continue;
    const current = grouped.get(effect.contribution_id) || {
      contribution_id: effect.contribution_id,
      status: 'structurally_verified',
      output_keys: [],
      criterion_ids: [],
      version_ids: []
    };
    current.output_keys.push(...(effect.output_keys || []));
    current.criterion_ids.push(...(effect.criterion_ids || []));
    current.version_ids.push(...(effect.version_ids || []));
    grouped.set(effect.contribution_id, current);
  }
  return [...grouped.values()]
    .map((item) => ({
      ...item,
      output_keys: normalizeIdList(item.output_keys),
      criterion_ids: normalizeIdList(item.criterion_ids),
      version_ids: normalizeIdList(item.version_ids),
      status:
        item.output_keys.length && item.output_keys.every((outputKey) => accepted.has(outputKey))
          ? 'accepted'
          : 'structurally_verified'
    }))
    .sort((left, right) => left.contribution_id.localeCompare(right.contribution_id));
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
