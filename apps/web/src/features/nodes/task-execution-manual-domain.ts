import type { TaskExecutionDetails } from '../../api/types';
import type { EffectClaimReviewItem } from './TaskEffectClaimReview';
import { effectLabel, executionInputSource, short } from './task-execution-labels';

export type ManualUsageOption = {
  id: string;
  kind: 'input' | 'context';
  inputKey: string;
  versionIds: string[];
  label: string;
  required: boolean;
  consumptionPolicy: 'must_use' | 'must_acknowledge' | 'available';
  applicationPolicy: 'required' | 'optional';
  targetOutputKeys: string[];
  explicitPolicy: boolean;
  effectAware: boolean;
  contributionId: string | null;
  criterionIds: string[];
  effect: 'basis' | 'constraint' | 'comparison' | 'verification' | 'contradiction' | 'reference';
  expectedEffect: string | null;
};

export function buildManualSubmission(
  value: TaskExecutionDetails,
  manualValues: Record<string, string>,
  manualUsage: Record<string, string[]>,
  manualReasons: Record<string, string>,
  usageOptions: ManualUsageOption[]
) {
  if (isEffectAware(value))
    return buildEffectManualSubmission(value, manualValues, manualUsage, manualReasons, usageOptions);
  return buildLegacyManualSubmission(value, manualValues, manualUsage, manualReasons, usageOptions);
}

function buildLegacyManualSubmission(
  value: TaskExecutionDetails,
  manualValues: Record<string, string>,
  manualUsage: Record<string, string[]>,
  manualReasons: Record<string, string>,
  usageOptions: ManualUsageOption[]
) {
  const globallyUsed = new Set(Object.values(manualUsage).flat()),
    dispositions = usageOptions
      .filter((option) => globallyUsed.has(option.id) || option.explicitPolicy)
      .map((option) => ({
        id: option.id,
        disposition: globallyUsed.has(option.id) ? ('used' as const) : ('not_used' as const),
        reason: globallyUsed.has(option.id) ? '人工输出明确使用该输入。' : (manualReasons[option.id] || '').trim()
      })),
    outputs = value.contract.expected_outputs.map((slot) =>
      buildLegacyOutput(value, slot, manualValues[slot.key] || '', manualUsage[slot.key] || [], dispositions)
    );
  return {
    outputs,
    consumed_input_versions: [...new Set(outputs.flatMap((item) => item.consumed_input_versions))],
    input_dispositions: dispositions
      .filter((item) => item.id.startsWith('asset:'))
      .map((item) => ({
        version_id: item.id.slice('asset:'.length),
        disposition: item.disposition,
        reason: item.reason
      })),
    consumed_context_document_versions: [
      ...new Set(outputs.flatMap((item) => item.consumed_context_document_versions))
    ],
    context_dispositions: dispositions
      .filter((item) => item.id.startsWith('context:'))
      .map((item) => ({
        document_version_id: item.id.slice('context:'.length),
        disposition: item.disposition,
        reason: item.reason
      }))
  };
}

function buildLegacyOutput(
  value: TaskExecutionDetails,
  slot: TaskExecutionDetails['contract']['expected_outputs'][number],
  content: string,
  outputUsage: string[],
  dispositions: Array<{ id: string; disposition: 'used' | 'not_used'; reason: string }>
) {
  return {
    output_key: slot.key,
    asset_type: slot.asset_type,
    title: `${value.task.title} ${slot.key}`,
    summary: content,
    payload: { payload_kind: 'text', media_type: 'text/plain; charset=utf-8', content },
    evidence_refs: [],
    consumed_input_versions: outputUsage.filter((item) => item.startsWith('asset:')).map((item) => item.slice(6)),
    consumed_context_document_versions: outputUsage
      .filter((item) => item.startsWith('context:'))
      .map((item) => item.slice(8)),
    input_dispositions: outputDispositions(dispositions, outputUsage, 'asset'),
    context_dispositions: outputDispositions(dispositions, outputUsage, 'context'),
    purpose: slot.purpose || `交付 ${slot.key}`,
    consumer_hint: slot.consumer_hint || '',
    unresolved_questions: [],
    limitations: []
  };
}

function outputDispositions(
  dispositions: Array<{ id: string; disposition: 'used' | 'not_used'; reason: string }>,
  outputUsage: string[],
  kind: 'asset' | 'context'
) {
  const prefix = `${kind}:`;
  return dispositions
    .filter((item) => item.id.startsWith(prefix))
    .map((item) => ({
      [kind === 'asset' ? 'version_id' : 'document_version_id']: item.id.slice(prefix.length),
      disposition: outputUsage.includes(item.id) ? ('used' as const) : ('not_used' as const),
      reason: outputDispositionReason(item, outputUsage, kind)
    }));
}

function buildEffectManualSubmission(
  value: TaskExecutionDetails,
  manualValues: Record<string, string>,
  manualUsage: Record<string, string[]>,
  manualStatements: Record<string, string>,
  usageOptions: ManualUsageOption[]
) {
  const outputs = value.contract.expected_outputs.map((slot) => ({
      output_key: slot.key,
      asset_type: slot.asset_type,
      title: `${value.task.title} ${slot.key}`,
      summary: manualValues[slot.key] || '',
      payload: {
        payload_kind: 'text',
        media_type: 'text/plain; charset=utf-8',
        content: manualValues[slot.key] || '',
        files: []
      },
      evidence_refs: [],
      purpose: slot.purpose || `交付 ${slot.key}`,
      consumer_hint: slot.consumer_hint || '',
      unresolved_questions: [],
      limitations: []
    })),
    inputEffects = usageOptions
      .filter((option) => option.kind === 'input')
      .map((option) => {
        const outputKeys = value.contract.expected_outputs
            .map((slot) => slot.key)
            .filter((key) => (manualUsage[key] || []).includes(option.id)),
          criterionIds = value.contract.expected_outputs
            .filter((slot) => outputKeys.includes(slot.key))
            .flatMap((slot) => slot.acceptance_criterion_ids || [])
            .filter((criterionId) => option.criterionIds.includes(criterionId));
        return {
          input_key: option.inputKey,
          version_ids: option.versionIds,
          ...(option.contributionId ? { contribution_id: option.contributionId, criterion_ids: criterionIds } : {}),
          effect: option.effect,
          output_keys: outputKeys,
          statement: (manualStatements[option.id] || '').trim(),
          evidence_refs: []
        };
      })
      .filter((effect) => effect.output_keys.length > 0);
  return { outputs, input_effects: inputEffects, context_effects: [] };
}

function outputDispositionReason(
  item: { id: string; disposition: 'used' | 'not_used'; reason: string },
  outputUsage: string[],
  kind: 'asset' | 'context'
) {
  if (outputUsage.includes(item.id))
    return kind === 'asset' ? '该输出明确使用此资产版本。' : '该输出明确使用此上下文版本。';
  if (item.disposition === 'used') return '该输入用于其他输出，本输出未使用。';
  return item.reason;
}

export function effectClaimsForReview(
  value: TaskExecutionDetails | undefined,
  candidates: TaskExecutionDetails['outputs']
): EffectClaimReviewItem[] {
  if (!value || value.task_execution.context_snapshot?.schema_version !== 'aiws.task_execution_context.v5') return [];
  const candidateKeys = new Set(candidates.map((item) => item.key)),
    claims = new Map<string, EffectClaimReviewItem>();
  collectInputEffectClaims(value, candidateKeys, claims);
  collectContextEffectClaims(value, candidateKeys, claims);
  return [...claims.values()].sort(
    (left, right) => Number(right.required) - Number(left.required) || left.claimId.localeCompare(right.claimId)
  );
}

function collectInputEffectClaims(
  value: TaskExecutionDetails,
  candidateKeys: Set<string>,
  claims: Map<string, EffectClaimReviewItem>
) {
  for (const effect of value.task_execution.input_effects || value.handoff.input_effects || []) {
    if (!isRelevantClaim(effect.claim_id, effect.output_keys, candidateKeys)) continue;
    const input = value.inputs.find((item) => item.key === effect.input_key),
      contributionMatches = !effect.contribution_id || effect.contribution_id === input?.contribution?.id;
    claims.set(effect.claim_id!, {
      claimId: effect.claim_id!,
      effectLabel: effectLabel(effect.effect),
      sourceLabel: `${effect.input_key} · ${executionInputSource(input?.source || 'input')}`,
      statement: effect.statement,
      outputKeys: effect.output_keys.filter((key) => candidateKeys.has(key)),
      criterionIds: effect.criterion_ids || [],
      required:
        contributionMatches && (input?.application_policy === 'required' || input?.consumption_policy === 'must_use')
    });
  }
}

function collectContextEffectClaims(
  value: TaskExecutionDetails,
  candidateKeys: Set<string>,
  claims: Map<string, EffectClaimReviewItem>
) {
  for (const effect of value.task_execution.context_effects || value.handoff.context_effects || []) {
    if (!isRelevantClaim(effect.claim_id, effect.output_keys, candidateKeys)) continue;
    const document = value.context_documents?.find((item) => item.document_version_id === effect.document_version_id);
    claims.set(effect.claim_id!, {
      claimId: effect.claim_id!,
      effectLabel: effectLabel(effect.effect),
      sourceLabel: `${document?.title || document?.source_collection || '上下文'} · ${short(effect.document_version_id)}`,
      statement: effect.statement,
      outputKeys: effect.output_keys.filter((key) => candidateKeys.has(key)),
      criterionIds: effect.criterion_ids || [],
      required: document?.required === true || document?.consumption_policy === 'must_use'
    });
  }
}

function isRelevantClaim(claimId: string | undefined, outputKeys: string[], candidateKeys: Set<string>) {
  return Boolean(claimId && outputKeys.some((key) => candidateKeys.has(key)));
}

export function manualUsageOptions(value?: TaskExecutionDetails): ManualUsageOption[] {
  if (!value) return [];
  return isEffectAware(value) ? effectAwareUsageOptions(value) : legacyUsageOptions(value);
}

function effectAwareUsageOptions(value: TaskExecutionDetails): ManualUsageOption[] {
  return value.inputs.map((input) => effectAwareUsageOption(value, input));
}

function effectAwareUsageOption(
  value: TaskExecutionDetails,
  input: TaskExecutionDetails['inputs'][number]
): ManualUsageOption {
  const contribution = normalizedContribution(input);
  return {
    id: `input:${input.key}`,
    kind: 'input',
    inputKey: input.key,
    versionIds: (input.asset_versions || []).map((version) => version.version_id),
    label: `${input.key} · ${firstTruthy(contribution.expectedEffect, input.purpose, input.source)}`,
    required: input.required !== false,
    consumptionPolicy: input.consumption_policy || 'available',
    applicationPolicy: input.application_policy || 'optional',
    targetOutputKeys: usageTargetOutputKeys(value, input),
    explicitPolicy: Boolean(input.application_policy),
    effectAware: true,
    contributionId: contribution.id,
    criterionIds: contribution.criterionIds,
    effect: contribution.effect,
    expectedEffect: contribution.expectedEffect
  };
}

function normalizedContribution(input: TaskExecutionDetails['inputs'][number]): {
  id: string | null;
  criterionIds: string[];
  effect: ManualUsageOption['effect'];
  expectedEffect: string | null;
} {
  const contribution = input.contribution;
  if (!contribution) return { id: null, criterionIds: [], effect: 'basis', expectedEffect: null };
  return {
    id: contribution.id || null,
    criterionIds: contribution.target_criterion_ids || [],
    effect: contribution.effect || 'basis',
    expectedEffect: contribution.expected_effect || null
  };
}

function usageTargetOutputKeys(value: TaskExecutionDetails, input: TaskExecutionDetails['inputs'][number]) {
  if (input.contribution?.target_output_keys?.length) return input.contribution.target_output_keys;
  if (input.target_output_keys?.length) return input.target_output_keys;
  return value.contract.expected_outputs.map((slot) => slot.key);
}

function firstTruthy<T>(...values: Array<T | null | undefined | ''>): T {
  return values.find(Boolean) as T;
}

function legacyUsageOptions(value: TaskExecutionDetails) {
  const options: ManualUsageOption[] = value.inputs.flatMap((input) =>
    (input.asset_versions || []).map((version) => ({
      id: `asset:${version.version_id}`,
      label: `${input.key} · ${version.title || short(version.version_id)}`,
      required: input.required !== false,
      consumptionPolicy: input.consumption_policy || (input.required !== false ? 'must_use' : 'available'),
      applicationPolicy: input.consumption_policy === 'must_use' ? 'required' : 'optional',
      targetOutputKeys: value.contract.expected_outputs.map((slot) => slot.key),
      versionIds: [version.version_id],
      inputKey: input.key,
      kind: 'input',
      explicitPolicy: Boolean(input.consumption_policy),
      effectAware: false,
      contributionId: null,
      criterionIds: [],
      effect: 'basis',
      expectedEffect: null
    }))
  );
  for (const document of value.context_documents || []) options.push(contextUsageOption(value, document));
  return mergeUsageOptions(options);
}

function contextUsageOption(
  value: TaskExecutionDetails,
  document: NonNullable<TaskExecutionDetails['context_documents']>[number]
): ManualUsageOption {
  return {
    id: `context:${document.document_version_id}`,
    label: `${document.title || document.source_collection || '上下文'} · ${short(document.document_version_id)}`,
    required: document.required === true,
    consumptionPolicy: document.consumption_policy || (document.required === true ? 'must_use' : 'available'),
    applicationPolicy: document.consumption_policy === 'must_use' ? 'required' : 'optional',
    targetOutputKeys: value.contract.expected_outputs.map((slot) => slot.key),
    versionIds: [],
    inputKey: '',
    kind: 'context',
    explicitPolicy: Boolean(document.consumption_policy),
    effectAware: false,
    contributionId: null,
    criterionIds: [],
    effect: 'basis',
    expectedEffect: null
  };
}

function mergeUsageOptions(options: ManualUsageOption[]) {
  const unique = new Map<string, ManualUsageOption>();
  for (const option of options) {
    const previous = unique.get(option.id);
    unique.set(option.id, {
      ...option,
      required: option.required || previous?.required === true,
      consumptionPolicy:
        option.consumptionPolicy === 'must_use' || previous?.consumptionPolicy === 'must_use'
          ? 'must_use'
          : option.consumptionPolicy,
      explicitPolicy: option.explicitPolicy || previous?.explicitPolicy === true
    });
  }
  return [...unique.values()];
}

function isEffectAware(value: TaskExecutionDetails) {
  return ['aiws.task_execution_context.v4', 'aiws.task_execution_context.v5'].includes(
    value.task_execution.context_snapshot?.schema_version || ''
  );
}
