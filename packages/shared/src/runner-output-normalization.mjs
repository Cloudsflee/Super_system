import { RunnerStatus } from './enums.mjs';
import {
  invalidDispositions,
  invalidIdList,
  normalizedDispositionList,
  normalizedIdList
} from './runner-context-utils.mjs';
import { invalidEffectList, normalizedEffectList } from './task-effects.mjs';

export function normalizeRunnerOutput(raw, fallback = {}) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const variant = runnerOutputVariant(parsed);
    const missing = requiredRunnerFields(variant).filter((key) => !(key in parsed));
    if (missing.length) return missingFieldsResult(parsed, fallback, missing);
    const malformed = normalizeTypedRunnerOutput(parsed, variant);
    if (malformed) return malformed;
    return { status: parsed.status || RunnerStatus.Succeeded, result: parsed, parse_error: null };
  } catch (error) {
    return invalidJsonResult(fallback, error);
  }
}

function runnerOutputVariant(parsed) {
  if (parsed.schema_version === 'aiws.task_runner_result.v4') return 'v4';
  if (parsed.schema_version === 'aiws.task_runner_result.v3') return 'v3';
  return parsed.schema_version === 'aiws.task_runner_result.v2' ? 'v2' : 'legacy';
}

function requiredRunnerFields(variant) {
  if (variant === 'v4' || variant === 'v3') return ['status', 'summary', 'outputs', 'input_effects', 'context_effects'];
  if (variant === 'v2')
    return ['status', 'summary', 'outputs', 'consumed_input_versions', 'consumed_context_document_versions'];
  return ['status', 'summary', 'changed_files', 'asset_candidates', 'test_results', 'next_actions'];
}

function missingFieldsResult(parsed, fallback, missing) {
  return {
    status: RunnerStatus.Partial,
    result: { ...fallback, ...parsed, warnings: [`missing fields: ${missing.join(', ')}`] },
    parse_error: null
  };
}

function normalizeTypedRunnerOutput(parsed, variant) {
  if (variant === 'v4' || variant === 'v3') return normalizeEffectAwareOutput(parsed, variant);
  return variant === 'v2' ? normalizeSlotAwareOutput(parsed) : null;
}

function normalizeEffectAwareOutput(parsed, variant) {
  const contributionAware = variant === 'v4';
  if (effectAwareOutputMalformed(parsed, contributionAware))
    return malformedOutputResult(
      parsed,
      `${contributionAware ? 'contribution-aware v4' : 'effect-aware v3'} output malformed`,
      'effect_aware_output_malformed'
    );
  parsed.input_effects = normalizedEffectList(parsed.input_effects, 'input_key');
  parsed.context_effects = normalizedEffectList(parsed.context_effects, 'document_version_id');
  return null;
}

function effectAwareOutputMalformed(parsed, contributionAware) {
  if (!Array.isArray(parsed.outputs) || !Array.isArray(parsed.input_effects) || !Array.isArray(parsed.context_effects))
    return true;
  if (parsed.outputs.some(effectAwareOutputItemMalformed)) return true;
  return (
    invalidEffectList(parsed.input_effects, 'input_key', true, contributionAware) ||
    invalidEffectList(parsed.context_effects, 'document_version_id', false, contributionAware)
  );
}

function effectAwareOutputItemMalformed(item) {
  if (!basicTypedOutputValid(item)) return true;
  return (
    !Array.isArray(item.evidence_refs) || !Array.isArray(item.unresolved_questions) || !Array.isArray(item.limitations)
  );
}

function normalizeSlotAwareOutput(parsed) {
  if (slotAwareOutputMalformed(parsed))
    return malformedOutputResult(parsed, 'slot-aware v2 output malformed', 'slot_aware_output_malformed');
  parsed.consumed_input_versions = normalizedIdList(parsed.consumed_input_versions);
  parsed.consumed_context_document_versions = normalizedIdList(parsed.consumed_context_document_versions);
  parsed.input_dispositions = normalizedDispositionList(parsed.input_dispositions, 'version_id');
  parsed.context_dispositions = normalizedDispositionList(parsed.context_dispositions, 'document_version_id');
  for (const item of parsed.outputs) normalizeSlotAwareOutputItem(item);
  return null;
}

function slotAwareOutputMalformed(parsed) {
  if (!Array.isArray(parsed.outputs)) return true;
  if (!Array.isArray(parsed.consumed_input_versions) || !Array.isArray(parsed.consumed_context_document_versions))
    return true;
  if (parsed.outputs.some(slotAwareOutputItemMalformed)) return true;
  return (
    invalidIdList(parsed.consumed_input_versions) ||
    invalidIdList(parsed.consumed_context_document_versions) ||
    invalidDispositions(parsed.input_dispositions, 'version_id') ||
    invalidDispositions(parsed.context_dispositions, 'document_version_id')
  );
}

function slotAwareOutputItemMalformed(item) {
  if (!basicTypedOutputValid(item)) return true;
  if (!Array.isArray(item.consumed_input_versions) || !Array.isArray(item.consumed_context_document_versions))
    return true;
  if (!Array.isArray(item.evidence_refs)) return true;
  return (
    invalidIdList(item.consumed_input_versions) ||
    invalidIdList(item.consumed_context_document_versions) ||
    invalidDispositions(item.input_dispositions, 'version_id') ||
    invalidDispositions(item.context_dispositions, 'document_version_id')
  );
}

function basicTypedOutputValid(item) {
  if (!item?.output_key || !item?.asset_type) return false;
  return typedPayloadValid(item.payload);
}

function typedPayloadValid(payload) {
  if (!payload?.payload_kind || !payload?.media_type) return false;
  return typeof payload.content === 'string' && Array.isArray(payload.files);
}

function normalizeSlotAwareOutputItem(item) {
  item.consumed_input_versions = normalizedIdList(item.consumed_input_versions);
  item.consumed_context_document_versions = normalizedIdList(item.consumed_context_document_versions);
  item.input_dispositions = normalizedDispositionList(item.input_dispositions, 'version_id');
  item.context_dispositions = normalizedDispositionList(item.context_dispositions, 'document_version_id');
}

function malformedOutputResult(parsed, warning, parseError) {
  return {
    status: RunnerStatus.Partial,
    result: {
      ...parsed,
      status: RunnerStatus.Partial,
      warnings: [...(parsed.warnings || []), warning]
    },
    parse_error: parseError
  };
}

function invalidJsonResult(fallback, error) {
  return {
    status: RunnerStatus.Partial,
    result: {
      ...fallback,
      status: RunnerStatus.Partial,
      summary: 'Runner 输出不是合法 JSON，已保留 raw output。',
      changed_files: [],
      asset_candidates: [],
      test_results: [],
      next_actions: ['查看 raw output'],
      warnings: [String(error.message)]
    },
    parse_error: error.message
  };
}
