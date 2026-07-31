import { HttpError } from './http.mjs';
import { normalizeDispositions, normalizeIdList } from './task-handoff.mjs';

export function normalizeConsumedInputs(execution, outputs, declaredAggregate = null, declaredDispositions = null) {
  const scope = inputConsumptionScope(execution);
  const byOutput = new Map();
  const byOutputDispositions = new Map();
  for (const output of outputs) recordOutputConsumption(output, scope, byOutput, byOutputDispositions);
  const aggregate = normalizeIdList([...byOutput.values()].flat());
  const aggregateSet = new Set(aggregate);
  const topDispositions = validatedDispositions(
    declaredDispositions,
    'version_id',
    'runner_input_disposition_invalid',
    'aggregate'
  );
  validateAggregateDispositions(scope, aggregate, topDispositions);
  const dispositions = aggregateDispositions({
    ids: scope.available,
    usedIds: aggregateSet,
    explicit: topDispositions,
    perOutput: byOutputDispositions,
    idKey: 'version_id'
  });
  const missingDispositions = validateInputConsumptionRequirements(scope, aggregateSet, dispositions);
  validateDeclaredAggregate(declaredAggregate, aggregate);
  return consumptionResult(scope, aggregate, byOutput, dispositions, byOutputDispositions, missingDispositions);
}

function inputConsumptionScope(execution) {
  const inputs = execution.context_snapshot?.inputs || [];
  const available = normalizeIdList(inputs.flatMap((item) => item.asset_versions || []).map((item) => item.version_id));
  const policies = inputPolicies(inputs);
  return {
    available,
    availableSet: new Set(available),
    policies,
    required: available.filter((versionId) => policies.get(versionId)?.required)
  };
}

function recordOutputConsumption(output, scope, byOutput, byOutputDispositions) {
  const key = clean(output?.output_key);
  const source = `output:${key || 'unknown'}`;
  const declared = validatedIdList(output?.consumed_input_versions, 'runner_consumed_inputs_invalid', { source });
  const invalid = declared.filter((versionId) => !scope.availableSet.has(versionId));
  if (invalid.length)
    throw new HttpError(409, {
      error: 'runner_consumed_inputs_mismatch',
      source,
      available_version_ids: scope.available,
      invalid_version_ids: invalid
    });
  const dispositions = validatedDispositions(
    output?.input_dispositions,
    'version_id',
    'runner_input_disposition_invalid',
    source
  );
  assertDispositionScope(dispositions, 'version_id', scope.availableSet, 'runner_input_disposition_mismatch', key);
  assertUsedDispositionConsistency(dispositions, 'version_id', declared, 'runner_input_disposition_mismatch', key);
  byOutput.set(key, declared);
  byOutputDispositions.set(key, mergeUsedDispositions(declared, dispositions, 'version_id'));
}

function validateAggregateDispositions(scope, aggregate, dispositions) {
  assertDispositionScope(
    dispositions,
    'version_id',
    scope.availableSet,
    'runner_input_disposition_mismatch',
    'aggregate'
  );
  assertUsedDispositionConsistency(
    dispositions,
    'version_id',
    aggregate,
    'runner_input_disposition_mismatch',
    'aggregate'
  );
}

function validateInputConsumptionRequirements(scope, aggregateSet, dispositions) {
  const dispositionByVersion = new Map(dispositions.map((item) => [item.version_id, item]));
  const mustUse = scope.available.filter((versionId) => scope.policies.get(versionId)?.mustUse);
  const missingRequired = mustUse.filter((versionId) => !aggregateSet.has(versionId));
  if (missingRequired.length)
    throw new HttpError(409, {
      error: 'runner_required_inputs_unconsumed',
      required_version_ids: mustUse,
      missing_version_ids: missingRequired
    });
  const acknowledged = scope.available.filter((versionId) => scope.policies.get(versionId)?.explicit);
  const missingDispositions = acknowledged.filter((versionId) => !dispositionByVersion.has(versionId));
  if (missingDispositions.length)
    throw new HttpError(409, {
      error: 'runner_input_disposition_required',
      missing_version_ids: missingDispositions
    });
  return missingDispositions;
}

function validateDeclaredAggregate(declaredAggregate, aggregate) {
  if (declaredAggregate === null) return;
  const declared = validatedIdList(declaredAggregate, 'runner_consumed_inputs_invalid', { source: 'aggregate' });
  assertConsumedSet(aggregate, declared, 'aggregate');
}

function consumptionResult(scope, aggregate, byOutput, dispositions, byOutputDispositions, missingDispositions) {
  return {
    aggregate,
    byOutput,
    dispositions,
    byOutputDispositions,
    required: scope.required,
    missingDispositions,
    semanticGaps: dispositions
      .filter((item) => item.disposition === 'not_used' && scope.policies.get(item.version_id)?.mustUse)
      .map((item) => ({ code: 'must_use_input_not_used', version_id: item.version_id }))
  };
}

function assertConsumedSet(expected, actual, source) {
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index]))
    throw new HttpError(409, {
      error: 'runner_consumed_inputs_mismatch',
      source,
      expected_version_ids: expected,
      actual_version_ids: actual
    });
}

function inputPolicies(inputs) {
  const result = new Map();
  for (const input of inputs || []) {
    const policy = normalizedInputPolicy(input);
    for (const version of input.asset_versions || []) mergeInputPolicy(result, input, version, policy);
  }
  return result;
}

function normalizedInputPolicy(input) {
  const explicit = ['must_use', 'must_acknowledge', 'available'].includes(input?.consumption_policy);
  return {
    explicit,
    value: explicit ? input.consumption_policy : input.required !== false ? 'must_use' : 'available'
  };
}

function mergeInputPolicy(result, input, version, policy) {
  if (typeof version?.version_id !== 'string' || !version.version_id.trim()) return;
  const versionId = version.version_id.trim();
  const current = result.get(versionId);
  const mustUse = Boolean(current?.mustUse || policy.value === 'must_use');
  result.set(versionId, {
    policy: mustUse ? 'must_use' : policy.value,
    required: Boolean(current?.required || input.required !== false),
    explicit: Boolean(current?.explicit || policy.explicit),
    mustUse
  });
}

function validatedIdList(values, error, detail = {}) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new HttpError(400, { error, ...detail });
  if (values.some((value) => value != null && value !== '' && typeof value !== 'string'))
    throw new HttpError(400, { error, ...detail });
  return normalizeIdList(values);
}

function validatedDispositions(values, idKey, error, source) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new HttpError(400, { error, source });
  const seen = new Set();
  for (const item of values) {
    if (!validDisposition(item, idKey, seen)) throw new HttpError(400, { error, source });
    seen.add(item[idKey].trim());
  }
  return normalizeDispositions(values, idKey);
}

function validDisposition(item, idKey, seen) {
  if (!item || typeof item !== 'object' || typeof item[idKey] !== 'string' || !item[idKey].trim()) return false;
  if (!['used', 'not_used'].includes(item.disposition) || seen.has(item[idKey].trim())) return false;
  return item.disposition !== 'not_used' || Boolean(clean(item.reason, 1000));
}

function assertDispositionScope(dispositions, idKey, availableSet, error, source) {
  const invalid = dispositions.map((item) => item[idKey]).filter((value) => !availableSet.has(value));
  if (invalid.length) throw new HttpError(409, { error, source: source || 'aggregate', invalid_ids: invalid });
}

function assertUsedDispositionConsistency(dispositions, idKey, usedIds, error, source) {
  const used = new Set(usedIds);
  const invalid = dispositions.filter((item) => (item.disposition === 'used') !== used.has(item[idKey]));
  if (invalid.length)
    throw new HttpError(409, {
      error,
      source: source || 'aggregate',
      inconsistent_ids: invalid.map((item) => item[idKey])
    });
}

function mergeUsedDispositions(usedIds, dispositions, idKey) {
  const byId = new Map(dispositions.map((item) => [item[idKey], item]));
  for (const value of usedIds)
    if (!byId.has(value))
      byId.set(value, {
        [idKey]: value,
        disposition: 'used',
        reason: 'Declared as used by this output.'
      });
  return [...byId.values()].sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

function aggregateDispositions({ ids, usedIds, explicit, perOutput, idKey }) {
  const explicitById = new Map(explicit.map((item) => [item[idKey], item]));
  const outputById = groupDispositionsById([...perOutput.values()].flat(), idKey);
  const result = [];
  for (const value of ids) {
    const declaration = aggregateDisposition(value, usedIds, explicitById, outputById);
    if (declaration) result.push({ ...declaration, [idKey]: value });
  }
  return result.sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

function groupDispositionsById(items, idKey) {
  const result = new Map();
  for (const item of items) {
    const values = result.get(item[idKey]) || [];
    values.push(item);
    result.set(item[idKey], values);
  }
  return result;
}

function aggregateDisposition(value, usedIds, explicitById, outputById) {
  if (usedIds.has(value)) {
    const declaration = explicitById.get(value) || outputById.get(value)?.find((item) => item.disposition === 'used');
    return { disposition: 'used', reason: declaration?.reason || 'Declared as used by at least one output.' };
  }
  return explicitById.get(value) || outputById.get(value)?.find((item) => item.disposition === 'not_used') || null;
}

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
