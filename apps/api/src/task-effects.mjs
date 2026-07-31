import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { HttpError } from './http.mjs';
import { contextReadReceiptsForExecution } from './task-context-consumption.mjs';
import { normalizeIdList } from './task-handoff.mjs';
import { effectClaimId } from '../../../packages/shared/src/task-effects.mjs';

export const TASK_EFFECT_SCHEMA = 'aiws.task_effects.v1';
export const CONTRIBUTION_TASK_EFFECT_SCHEMA = 'aiws.task_effects.v2';
export const APPLICATION_POLICIES = Object.freeze(['required', 'optional']);
export const EFFECT_TYPES = Object.freeze([
  'basis',
  'constraint',
  'comparison',
  'verification',
  'contradiction',
  'reference'
]);

export function applicationPolicy(slot) {
  if (APPLICATION_POLICIES.includes(slot?.application_policy)) return slot.application_policy;
  return slot?.consumption_policy === 'must_use' ? 'required' : 'optional';
}

export function inputEffectObligations(execution) {
  const outputKeys = new Set(
    (execution?.context_snapshot?.contract?.expected_outputs || []).map((item) => clean(item?.key, 120)).filter(Boolean)
  );
  return (execution?.context_snapshot?.inputs || []).map((input) => ({
    input_key: input.key,
    source: input.source,
    required: input.required !== false,
    application_policy: applicationPolicy(input),
    purpose: clean(input.purpose, 1000) || null,
    target_output_keys: normalizedOutputKeys(
      input.contribution?.target_output_keys || input.target_output_keys,
      outputKeys,
      { defaultToAll: !input.contribution }
    ),
    coverage_policy: input.coverage_policy === 'any' ? 'any' : 'all',
    version_ids: normalizeIdList((input.asset_versions || []).map((item) => item?.version_id)),
    contribution: input.contribution ? structuredClone(input.contribution) : null
  }));
}

export function normalizeTaskEffects(
  state,
  execution,
  outputs,
  declaredInputEffects = null,
  declaredContextEffects = null,
  nodeRunId = null
) {
  const outputKeys = new Set((outputs || []).map((item) => clean(item?.output_key, 120)).filter(Boolean)),
    inputs = execution?.context_snapshot?.inputs || [],
    inputByKey = new Map(inputs.map((item) => [item.key, item])),
    contributionAware = execution?.context_snapshot?.schema_version === 'aiws.task_execution_context.v5',
    criteria = criterionScope(execution, outputKeys),
    inputEffects = normalizeInputEffects(declaredInputEffects, inputByKey, outputKeys, {
      contributionAware,
      criteria,
      execution
    }),
    contextReceipts = contextReadReceiptsForExecution(state, execution, nodeRunId),
    contextEffects = normalizeContextEffects(declaredContextEffects, contextReceipts, outputKeys, {
      contributionAware,
      criteria
    });

  assertRequiredEffects(inputs, inputEffects, outputKeys, contributionAware);

  const byOutput = new Map([...outputKeys].map((key) => [key, []])),
    byOutputContext = new Map([...outputKeys].map((key) => [key, []])),
    inputEffectsByOutput = new Map([...outputKeys].map((key) => [key, []])),
    contextEffectsByOutput = new Map([...outputKeys].map((key) => [key, []]));
  for (const effect of inputEffects)
    for (const outputKey of effect.output_keys) {
      byOutput.get(outputKey).push(...effect.version_ids);
      inputEffectsByOutput.get(outputKey).push(effect);
    }
  for (const effect of contextEffects)
    for (const outputKey of effect.output_keys) {
      byOutputContext.get(outputKey).push(effect.document_version_id);
      contextEffectsByOutput.get(outputKey).push(effect);
    }
  for (const values of byOutput.values()) replaceWithNormalizedIds(values);
  for (const values of byOutputContext.values()) replaceWithNormalizedIds(values);

  const aggregate = normalizeIdList(inputEffects.flatMap((item) => item.version_ids)),
    aggregateContext = normalizeIdList(contextEffects.map((item) => item.document_version_id)),
    selectionId = execution?.context_snapshot?.system_context?.context_selection_id || null,
    selectionIds = normalizeIdList([
      selectionId,
      ...aggregateContext.flatMap((versionId) => contextReceipts.get(versionId)?.selection_ids || [])
    ]);
  const byOutputDispositions = new Map(
      [...outputKeys].map((key) => [key, usedDispositions(inputEffectsByOutput.get(key), 'version_id')])
    ),
    byOutputContextDispositions = new Map(
      [...outputKeys].map((key) => [key, usedDispositions(contextEffectsByOutput.get(key), 'document_version_id')])
    );
  return {
    schema_version: contributionAware ? CONTRIBUTION_TASK_EFFECT_SCHEMA : TASK_EFFECT_SCHEMA,
    authority_status: contributionAware ? 'structurally_verified' : 'declared',
    inputEffects,
    contextEffects,
    inputEffectsByOutput,
    contextEffectsByOutput,
    aggregate,
    aggregateContext,
    byOutput,
    byOutputContext,
    byOutputDispositions,
    byOutputContextDispositions,
    inputDispositions: usedDispositions(inputEffects, 'version_id'),
    contextDispositions: usedDispositions(contextEffects, 'document_version_id'),
    selectionId,
    selectionIds,
    selectionIdsByOutput: new Map(
      [...outputKeys].map((key) => [
        key,
        normalizeIdList([
          selectionId,
          ...(contextEffectsByOutput.get(key) || []).flatMap(
            (effect) => contextReceipts.get(effect.document_version_id)?.selection_ids || []
          )
        ])
      ])
    )
  };
}

export function deterministicInputEffects(
  execution,
  outputKeys,
  {
    effect = 'verification',
    statement = 'The deterministic executor applied this exact input to the verified output.'
  } = {}
) {
  const targets = normalizeIdList(outputKeys),
    inputs = execution?.context_snapshot?.inputs || [];
  return inputs
    .filter(
      (input) =>
        (input.asset_versions || []).length ||
        input.repository_snapshot ||
        input.source === 'repository_workspace' ||
        applicationPolicy(input) === 'required'
    )
    .map((input) => {
      const contribution = input.contribution;
      return {
        input_key: input.key,
        version_ids: normalizeIdList((input.asset_versions || []).map((item) => item?.version_id)),
        ...(contribution ? { contribution_id: contribution.id } : {}),
        effect: contribution?.effect || effect,
        output_keys: contribution?.target_output_keys || targets,
        ...(contribution ? { criterion_ids: contribution.target_criterion_ids } : {}),
        statement: clean(statement, 2000),
        evidence_refs: []
      };
    });
}

function normalizeInputEffects(values, inputByKey, outputKeys, options) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw effectError('runner_input_effects_invalid');
  const result = [],
    seen = new Set();
  for (const raw of values) {
    const inputKey = clean(raw?.input_key, 120),
      input = inputByKey.get(inputKey);
    if (!input) throw effectError('runner_input_effect_scope_invalid', { input_key: inputKey || null });
    const effect = normalizeEffect(raw, outputKeys, 'runner_input_effects_invalid', options),
      availableVersions = normalizeIdList((input.asset_versions || []).map((item) => item?.version_id)),
      availableSet = new Set(availableVersions),
      versionIds = normalizeIdList(raw.version_ids);
    if (availableVersions.length && !versionIds.length)
      throw effectError('runner_input_effect_versions_required', { input_key: inputKey });
    const invalidVersions = versionIds.filter((value) => !availableSet.has(value));
    if (invalidVersions.length)
      throw effectError('runner_input_effect_scope_invalid', {
        input_key: inputKey,
        invalid_version_ids: invalidVersions,
        available_version_ids: availableVersions
      });
    const contribution = input.contribution,
      allowedTargets = normalizedOutputKeys(
        options.contributionAware ? contribution?.target_output_keys : input.target_output_keys,
        outputKeys,
        { defaultToAll: !options.contributionAware }
      ),
      invalidTargets = effect.output_keys.filter((key) => !allowedTargets.includes(key));
    if (invalidTargets.length)
      throw effectError('runner_input_effect_output_scope_invalid', {
        input_key: inputKey,
        invalid_output_keys: invalidTargets,
        allowed_output_keys: allowedTargets
      });
    if (options.contributionAware) {
      if (!contribution || raw?.contribution_id !== contribution.id)
        throw effectError('runner_input_effect_contribution_invalid', {
          input_key: inputKey,
          expected_contribution_id: contribution?.id || null,
          actual_contribution_id: clean(raw?.contribution_id, 200) || null
        });
      if (effect.effect !== contribution.effect)
        throw effectError('runner_input_effect_type_mismatch', {
          input_key: inputKey,
          contribution_id: contribution.id,
          expected_effect: contribution.effect,
          actual_effect: effect.effect
        });
      const invalidCriteria = effect.criterion_ids.filter(
        (criterionId) => !contribution.target_criterion_ids.includes(criterionId)
      );
      if (invalidCriteria.length)
        throw effectError('runner_input_effect_criterion_scope_invalid', {
          input_key: inputKey,
          contribution_id: contribution.id,
          invalid_criterion_ids: invalidCriteria,
          allowed_criterion_ids: contribution.target_criterion_ids
        });
      Object.assign(effect, {
        contribution_id: contribution.id,
        verification_status: 'structurally_verified',
        source_receipts: inputSourceReceipts(options.execution, input, versionIds)
      });
      effect.claim_id = effectClaimId({ input_key: inputKey, version_ids: versionIds, ...effect });
    }
    const key = `${inputKey}:${effect.contribution_id || ''}:${effect.effect}:${effect.output_keys.join(',')}:${(
      effect.criterion_ids || []
    ).join(',')}:${versionIds.join(',')}`;
    if (seen.has(key)) throw effectError('runner_input_effect_duplicate', { input_key: inputKey });
    seen.add(key);
    result.push({ input_key: inputKey, version_ids: versionIds, ...effect });
  }
  return result.sort(compareEffects);
}

function normalizeContextEffects(values, receipts, outputKeys, options) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw effectError('runner_context_effects_invalid');
  const result = [],
    seen = new Set();
  for (const raw of values) {
    const documentVersionId = clean(raw?.document_version_id, 200),
      receipt = receipts.get(documentVersionId);
    if (!receipt)
      throw effectError('runner_context_effect_read_receipt_required', {
        document_version_id: documentVersionId || null
      });
    const effect = normalizeEffect(raw, outputKeys, 'runner_context_effects_invalid', options),
      key = `${documentVersionId}:${effect.effect}:${effect.output_keys.join(',')}:${(effect.criterion_ids || []).join(
        ','
      )}`;
    if (seen.has(key)) throw effectError('runner_context_effect_duplicate', { document_version_id: documentVersionId });
    seen.add(key);
    const normalized = {
      document_version_id: documentVersionId,
      ...effect,
      ...(options.contributionAware
        ? {
            verification_status: 'structurally_verified',
            source_receipts: normalizeIdList(
              (receipt?.selection_ids || []).map((selectionId) => `context_read:${selectionId}:${documentVersionId}`)
            )
          }
        : {})
    };
    if (options.contributionAware) normalized.claim_id = effectClaimId(normalized);
    result.push(normalized);
  }
  return result.sort(compareEffects);
}

function normalizeEffect(raw, outputKeys, errorCode, options) {
  const effect = EFFECT_TYPES.includes(raw?.effect) ? raw.effect : null,
    statement = clean(raw?.statement, 2000),
    targets = normalizedOutputKeys(raw?.output_keys, outputKeys),
    evidenceRefs = normalizeTextList(raw?.evidence_refs, 500),
    criterionIds = options.contributionAware ? normalizeIdList(raw?.criterion_ids) : [];
  if (!effect || statement.length < 12 || !targets.length || (options.contributionAware && !criterionIds.length))
    throw effectError(errorCode, {
      effect: effect || null,
      output_keys: targets,
      statement_required: statement.length < 12,
      criterion_ids_required: options.contributionAware && !criterionIds.length
    });
  if (options.contributionAware) {
    const invalidCriteria = criterionIds.filter((criterionId) => !options.criteria.ids.has(criterionId)),
      mismatchedCriteria = criterionIds.filter((criterionId) => {
        const outputKey = options.criteria.outputById.get(criterionId);
        return outputKey && !targets.includes(outputKey);
      });
    if (invalidCriteria.length || mismatchedCriteria.length)
      throw effectError('runner_effect_criterion_invalid', {
        invalid_criterion_ids: invalidCriteria,
        criterion_output_mismatch_ids: mismatchedCriteria
      });
  }
  return {
    effect,
    output_keys: targets,
    ...(options.contributionAware ? { criterion_ids: criterionIds } : {}),
    statement,
    evidence_refs: evidenceRefs
  };
}

function assertRequiredEffects(inputs, effects, outputKeys, contributionAware) {
  for (const input of inputs) {
    if (applicationPolicy(input) !== 'required') continue;
    const candidates = effects.filter((item) => item.input_key === input.key && item.effect !== 'reference');
    if (!candidates.length)
      throw effectError('runner_required_input_effect_missing', {
        input_key: input.key,
        purpose: clean(input.purpose, 1000) || null
      });
    const targets = normalizedOutputKeys(
        contributionAware ? input.contribution?.target_output_keys : input.target_output_keys,
        outputKeys,
        { defaultToAll: !contributionAware }
      ),
      coveredTargets = new Set(candidates.flatMap((item) => item.output_keys)),
      missingTargets = targets.filter((key) => !coveredTargets.has(key));
    if (missingTargets.length)
      throw effectError('runner_required_input_effect_output_missing', {
        input_key: input.key,
        missing_output_keys: missingTargets
      });
    if (contributionAware) {
      const contribution = input.contribution,
        coveredCriteria = new Set(candidates.flatMap((item) => item.criterion_ids || [])),
        missingCriteria = (contribution?.target_criterion_ids || []).filter(
          (criterionId) => !coveredCriteria.has(criterionId)
        );
      if (missingCriteria.length)
        throw effectError('runner_required_input_effect_criterion_missing', {
          input_key: input.key,
          contribution_id: contribution?.id || null,
          missing_criterion_ids: missingCriteria
        });
    }
    const versions = normalizeIdList((input.asset_versions || []).map((item) => item?.version_id));
    if (!versions.length) continue;
    const coveredVersions = new Set(candidates.flatMap((item) => item.version_ids));
    const enough =
      input.coverage_policy === 'any'
        ? versions.some((versionId) => coveredVersions.has(versionId))
        : versions.every((versionId) => coveredVersions.has(versionId));
    if (!enough)
      throw effectError('runner_required_input_effect_coverage_missing', {
        input_key: input.key,
        coverage_policy: input.coverage_policy === 'any' ? 'any' : 'all',
        missing_version_ids: versions.filter((versionId) => !coveredVersions.has(versionId))
      });
  }
}

function usedDispositions(effects, idKey) {
  const byId = new Map();
  for (const effect of effects) {
    const ids = idKey === 'version_id' ? effect.version_ids : [effect.document_version_id];
    for (const value of ids)
      if (!byId.has(value))
        byId.set(value, {
          [idKey]: value,
          disposition: 'used',
          reason: effect.statement
        });
  }
  return [...byId.values()].sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

function criterionScope(execution, outputKeys) {
  const outputById = new Map();
  for (const output of execution?.context_snapshot?.contract?.expected_outputs || []) {
    if (!outputKeys.has(output.key)) continue;
    for (const criterionId of normalizeIdList(output.acceptance_criterion_ids)) outputById.set(criterionId, output.key);
  }
  return { ids: new Set(outputById.keys()), outputById };
}

function inputSourceReceipts(execution, input, versionIds) {
  return normalizeIdList([
    ...(input.resolved_from?.contribution_routes || []).map(
      (route) => `handoff_route:${route.route_id}:${route.route_contract_hash}`
    ),
    ...versionIds.map((versionId) => `asset_version:${versionId}`),
    ...(input.repository_snapshot?.snapshot_hash
      ? [`repository_snapshot:${input.repository_snapshot.snapshot_hash}`]
      : []),
    ...(!versionIds.length && !input.repository_snapshot?.snapshot_hash
      ? [`input_snapshot:${execution?.input_snapshot_hash || 'unavailable'}:${input.key}`]
      : [])
  ]);
}

function normalizedOutputKeys(values, available, { defaultToAll = false } = {}) {
  const normalized = normalizeIdList(values),
    selected = normalized.length || !defaultToAll ? normalized : [...available].sort(),
    invalid = selected.filter((value) => !available.has(value));
  if (invalid.length) throw effectError('runner_effect_output_invalid', { invalid_output_keys: invalid });
  return selected;
}

function replaceWithNormalizedIds(values) {
  const normalized = normalizeIdList(values);
  values.splice(0, values.length, ...normalized);
}

function normalizeTextList(values, max) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, max)).filter(Boolean))].sort();
}

function compareEffects(left, right) {
  return (
    String(left.input_key || left.document_version_id).localeCompare(
      String(right.input_key || right.document_version_id)
    ) ||
    left.effect.localeCompare(right.effect) ||
    left.output_keys.join(',').localeCompare(right.output_keys.join(','))
  );
}

function effectError(error, detail = {}) {
  return new HttpError(409, { error, ...detail });
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
