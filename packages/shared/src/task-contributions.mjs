import { hashString } from './utils.mjs';

export const TASK_PROGRESSION_PROTOCOL = 'aiws.task_progression.v1';
export const INPUT_CONTRIBUTION_SCHEMA = 'aiws.input_contribution.v1';
export const CONTRIBUTION_EFFECT_TYPES = Object.freeze([
  'basis',
  'constraint',
  'comparison',
  'verification',
  'contradiction',
  'reference'
]);

export function isContributionTask(task) {
  return task?.progression_protocol === TASK_PROGRESSION_PROTOCOL;
}

export function acceptanceCriterionId(taskId, outputKey, criterion) {
  return `ac_${hashString(
    JSON.stringify({
      task_id: clean(taskId, 120),
      output_key: clean(outputKey, 120),
      criterion: clean(criterion, 2000)
    })
  ).slice(0, 24)}`;
}

export function outputCriterionRefs(taskId, outputs) {
  return (Array.isArray(outputs) ? outputs : []).flatMap((output) =>
    uniqueText(output?.acceptance_criteria).map((criterion) => ({
      id: acceptanceCriterionId(taskId, output?.key, criterion),
      output_key: clean(output?.key, 120),
      criterion
    }))
  );
}

export function withAcceptanceCriterionIds(taskId, output) {
  const criteria = uniqueText(output?.acceptance_criteria);
  return {
    ...output,
    acceptance_criteria: criteria,
    acceptance_criterion_ids: criteria.map((criterion) => acceptanceCriterionId(taskId, output?.key, criterion))
  };
}

export function normalizeInputContribution(task, input, outputs, { system = false } = {}) {
  const raw = system ? systemRepositoryContribution(input, outputs) : input?.contribution;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const refs = outputCriterionRefs(task?.id, outputs),
    targetOutputKeys = uniqueIds(raw.target_output_keys?.length ? raw.target_output_keys : input?.target_output_keys),
    selectedRefs = selectCriterionRefs(raw, refs, new Set(targetOutputKeys)),
    contribution = {
      schema_version: INPUT_CONTRIBUTION_SCHEMA,
      id: '',
      effect: CONTRIBUTION_EFFECT_TYPES.includes(raw.effect) ? raw.effect : clean(raw.effect, 80) || null,
      expected_effect: clean(raw.expected_effect, 2000) || null,
      target_output_keys: targetOutputKeys,
      target_criterion_ids: raw.target_criterion_ids?.length
        ? uniqueIds(raw.target_criterion_ids)
        : uniqueIds(selectedRefs.map((item) => item.id)),
      target_criteria: uniqueText(raw.target_criteria),
      origin: system ? 'system' : clean(raw.origin, 80) || 'declared'
    };
  contribution.id = contributionId(task, input, contribution);
  return contribution;
}

export function contributionValidationErrors(task, input, outputs) {
  if (!isContributionTask(task)) return [];
  const contribution = input?.contribution,
    refs = outputCriterionRefs(task?.id, outputs),
    refIds = new Set(refs.map((item) => item.id)),
    outputKeys = new Set((outputs || []).map((item) => item.key)),
    errors = [];
  if (!contribution || contribution.schema_version !== INPUT_CONTRIBUTION_SCHEMA) return ['contribution_required'];
  if (!/^ic_[a-f0-9]{24}$/.test(String(contribution.id || ''))) errors.push('contribution_id_invalid');
  if (!CONTRIBUTION_EFFECT_TYPES.includes(contribution.effect)) errors.push('contribution_effect_invalid');
  if (clean(contribution.expected_effect, 2000).length < 12) errors.push('contribution_expected_effect_invalid');
  if (!contribution.target_output_keys?.length) errors.push('contribution_output_required');
  else if (contribution.target_output_keys.some((key) => !outputKeys.has(key)))
    errors.push('contribution_output_invalid');
  if (!contribution.target_criterion_ids?.length) errors.push('contribution_criterion_required');
  else if (contribution.target_criterion_ids.some((criterionId) => !refIds.has(criterionId)))
    errors.push('contribution_criterion_invalid');
  if (
    contribution.target_criterion_ids?.some((criterionId) => {
      const ref = refs.find((item) => item.id === criterionId);
      return ref && !contribution.target_output_keys.includes(ref.output_key);
    })
  )
    errors.push('contribution_criterion_output_mismatch');
  if (
    contribution.target_criteria?.some(
      (criterion) =>
        !refs.some((ref) => contribution.target_output_keys.includes(ref.output_key) && ref.criterion === criterion)
    )
  )
    errors.push('contribution_criterion_text_invalid');
  if (!['declared', 'system'].includes(contribution.origin)) errors.push('contribution_origin_invalid');
  if (contribution.origin === 'system' && input.source !== 'repository_workspace')
    errors.push('contribution_origin_invalid');
  if (
    input.application_policy === 'required' &&
    (contribution.effect === 'reference' || !contribution.target_criterion_ids?.length)
  )
    errors.push('required_contribution_not_enforceable');
  if (contribution.id !== contributionId(task, input, contribution)) errors.push('contribution_id_stale');
  return [...new Set(errors)];
}

export function contributionRouteId(route) {
  return `cr_${hashString(JSON.stringify(contributionRouteIdentity(route))).slice(0, 24)}`;
}

export function contributionRouteHash(route) {
  return hashString(JSON.stringify(contributionRouteIdentity(route)));
}

function selectCriterionRefs(raw, refs, targetOutputs) {
  const ids = new Set(uniqueIds(raw.target_criterion_ids)),
    criteria = new Set(uniqueText(raw.target_criteria));
  return refs.filter(
    (ref) => targetOutputs.has(ref.output_key) && (ids.has(ref.id) || (!ids.size && criteria.has(ref.criterion)))
  );
}

function systemRepositoryContribution(input, outputs) {
  const targets = uniqueIds(
    input?.target_output_keys?.length ? input.target_output_keys : outputs.map((item) => item.key)
  );
  return {
    effect: 'verification',
    expected_effect: '固定仓库快照决定实现与验证所针对的唯一代码基线。',
    target_output_keys: targets,
    target_criteria: (outputs || [])
      .filter((item) => targets.includes(item.key))
      .flatMap((item) => item.acceptance_criteria || []),
    origin: 'system'
  };
}

function contributionId(task, input, contribution) {
  return `ic_${hashString(
    JSON.stringify({
      task_id: clean(task?.id, 120),
      input_key: clean(input?.key, 120),
      source: clean(input?.source, 80),
      selector: input?.selector ?? null,
      ref_id: input?.ref_id ?? null,
      effect: contribution.effect,
      expected_effect: contribution.expected_effect,
      target_output_keys: uniqueIds(contribution.target_output_keys),
      target_criterion_ids: uniqueIds(contribution.target_criterion_ids),
      origin: contribution.origin
    })
  ).slice(0, 24)}`;
}

function contributionRouteIdentity(route) {
  return {
    producer_task_id: clean(route?.producer_task_id, 120) || null,
    output_key: clean(route?.output_key, 120) || null,
    consumer_task_id: clean(route?.consumer_task_id, 120) || null,
    input_key: clean(route?.input_key, 120) || null,
    contribution_id: clean(route?.contribution_id, 120) || null,
    effect: clean(route?.effect, 80) || null,
    expected_effect: clean(route?.expected_effect, 2000) || null,
    target_output_keys: uniqueIds(route?.target_output_keys),
    target_criterion_ids: uniqueIds(route?.target_criterion_ids)
  };
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, 200)).filter(Boolean))].sort();
}

function uniqueText(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, 2000)).filter(Boolean))];
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
