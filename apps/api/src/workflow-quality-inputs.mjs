import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { isContributionTask, normalizeInputContribution } from '../../../packages/shared/src/task-contributions.mjs';

const SOFTWARE_KINDS = new Set(['code', 'test', 'deploy', 'integration']);

export function normalizeInputs(source, _dependencyIds, node, outputs) {
  const outputKeys = outputs.map((slot) => slot.key);
  const inputSlots = Array.isArray(source) ? source : [];
  const slots = inputSlots.map((slot, index) => normalizeInputSlot(slot, index, node, outputs, outputKeys));
  if (SOFTWARE_KINDS.has(node.task_kind) && !slots.some((slot) => slot.source === 'repository_workspace')) {
    const repository = repositoryInputSlot(slots, node, outputs, outputKeys);
    slots.push(repository);
  }
  return slots;
}

function normalizeInputSlot(slot, index, node, outputs, outputKeys) {
  const normalized = {
    ...inputSlotIdentity(slot, index),
    ...inputSlotPolicy(slot),
    purpose: inputSlotPurpose(slot, node, outputKeys),
    ...inputSlotTargets(slot, outputKeys)
  };
  attachInputContribution(normalized, slot, node, outputs);
  return normalized;
}

function inputSlotIdentity(slot, index) {
  return {
    key: clean(slot?.key || `input_${index + 1}`, 120),
    kind: clean(slot?.kind || 'asset_version', 80),
    required: slot?.required !== false,
    source: clean(slot?.source || 'explicit', 80),
    selector: slot?.selector ?? null,
    ref_id: slot?.ref_id ?? null,
    version_id: slot?.version_id ?? null
  };
}

function inputSlotPolicy(slot) {
  return {
    consumption_policy: validConsumptionPolicy(slot?.consumption_policy),
    application_policy: inputApplicationPolicy(slot)
  };
}

function inputSlotTargets(slot, outputKeys) {
  return {
    target_output_keys: unique(slot?.target_output_keys?.length ? slot.target_output_keys : outputKeys),
    coverage_policy: slot?.coverage_policy === 'any' ? 'any' : 'all'
  };
}

function validConsumptionPolicy(value) {
  return ['must_use', 'must_acknowledge', 'available'].includes(value) ? value : null;
}

function inputApplicationPolicy(slot) {
  if (['required', 'optional'].includes(slot?.application_policy)) return slot.application_policy;
  return slot?.consumption_policy === 'must_use' ? 'required' : 'optional';
}

function inputSlotPurpose(slot, node, outputKeys) {
  const declared = clean(slot?.purpose, 1000);
  if (declared || isContributionTask(node)) return declared || null;
  const source = clean(slot?.source || '该输入', 80);
  return `使用 ${source} 输入影响 ${outputKeys.join('、') || '任务输出'}。`;
}

function attachInputContribution(normalized, slot, node, outputs) {
  if (isContributionTask(node)) {
    normalized.contribution = normalizeInputContribution(node, { ...slot, ...normalized }, outputs, {
      system: normalized.source === 'repository_workspace'
    });
    return;
  }
  if (slot?.contribution && typeof slot.contribution === 'object')
    normalized.contribution = structuredClone(slot.contribution);
}

function repositoryInputSlot(slots, node, outputs, outputKeys) {
  const repository = {
    key: uniqueSlotKey(slots, 'repository_snapshot'),
    kind: 'repository',
    required: true,
    source: 'repository_workspace',
    selector: 'fixed_sha',
    ref_id: null,
    version_id: null,
    consumption_policy: null,
    application_policy: 'required',
    purpose: `以固定仓库快照作为 ${outputKeys.join('、')} 的唯一代码与验证基线。`,
    target_output_keys: outputKeys,
    coverage_policy: 'all'
  };
  if (isContributionTask(node))
    repository.contribution = normalizeInputContribution(node, repository, outputs, { system: true });
  return repository;
}

function unique(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 2000)).filter(Boolean))];
}

function uniqueSlotKey(slots, preferred) {
  let key = preferred,
    suffix = 2;
  while (slots.some((slot) => slot.key === key)) key = `${preferred}_${suffix++}`;
  return key;
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
