import { HttpError } from './http.mjs';
import { normalizeDispositions, normalizeIdList } from './task-handoff.mjs';

export function normalizeConsumedContextDocuments(
  state,
  execution,
  outputs,
  declaredAggregate = null,
  declaredDispositions = null,
  nodeRunId = null
) {
  const context = execution.context_snapshot || {},
    selectionId = context.system_context?.context_selection_id || null,
    entries = (context.system_context?.document_versions || []).filter(
      (item) => typeof item?.document_version_id === 'string' && item.document_version_id.trim()
    ),
    declarationProvided =
      declaredAggregate !== null ||
      declaredDispositions !== null ||
      outputs.some(
        (output) =>
          Object.hasOwn(output || {}, 'consumed_context_document_versions') ||
          Object.hasOwn(output || {}, 'context_dispositions')
      ),
    byOutput = new Map(outputs.map((output) => [clean(output?.output_key), []])),
    byOutputDispositions = new Map(outputs.map((output) => [clean(output?.output_key), []])),
    selectionIdsByOutput = new Map(outputs.map((output) => [clean(output?.output_key), []]));
  if (!declarationProvided)
    return {
      aggregate: [],
      byOutput,
      dispositions: [],
      byOutputDispositions,
      selectionId,
      selectionIds: [],
      selectionIdsByOutput,
      semanticGaps: []
    };
  const { availableByVersion, staleDynamicVersions } = availableContextDocumentVersions(
      state,
      execution,
      nodeRunId,
      selectionId,
      entries
    ),
    aggregate = normalizeOutputContextConsumption({
      state,
      outputs,
      selectionId,
      availableByVersion,
      staleDynamicVersions,
      byOutput,
      byOutputDispositions,
      selectionIdsByOutput
    });
  const policies = contextPolicies(entries),
    mustUse = [...availableByVersion.keys()].filter((versionId) => policies.get(versionId)?.mustUse);
  assertRequiredContextConsumption(mustUse, aggregate);
  assertDeclaredContextAggregate(aggregate, declaredAggregate);
  const topDispositions = validatedDispositions(
      declaredDispositions,
      'document_version_id',
      'runner_context_disposition_invalid',
      'aggregate'
    ),
    availableSet = new Set(availableByVersion.keys());
  assertDispositionScope(
    topDispositions,
    'document_version_id',
    availableSet,
    'runner_context_disposition_mismatch',
    'aggregate'
  );
  assertUsedDispositionConsistency(
    topDispositions,
    'document_version_id',
    aggregate,
    'runner_context_disposition_mismatch',
    'aggregate'
  );
  const aggregateSet = new Set(aggregate),
    dispositions = aggregateDispositions({
      ids: [...availableByVersion.keys()],
      usedIds: aggregateSet,
      explicit: topDispositions,
      perOutput: byOutputDispositions,
      idKey: 'document_version_id'
    }),
    dispositionByVersion = new Map(dispositions.map((item) => [item.document_version_id, item])),
    acknowledged = [...availableByVersion.keys()].filter((versionId) => policies.get(versionId)?.explicit),
    missingDispositions = acknowledged.filter((versionId) => !dispositionByVersion.has(versionId));
  if (missingDispositions.length)
    throw new HttpError(409, {
      error: 'runner_context_disposition_required',
      missing_document_version_ids: missingDispositions
    });
  const selectionIds = orderedContextSelectionIds(
    state,
    new Set([...selectionIdsByOutput.values()].flat()),
    selectionId
  );
  return {
    aggregate,
    byOutput,
    dispositions,
    byOutputDispositions,
    selectionId,
    selectionIds,
    selectionIdsByOutput,
    missingDispositions,
    semanticGaps: dispositions
      .filter((item) => item.disposition === 'not_used' && policies.get(item.document_version_id)?.mustUse)
      .map((item) => ({ code: 'must_use_context_not_used', document_version_id: item.document_version_id }))
  };
}

function availableContextDocumentVersions(state, execution, nodeRunId, selectionId, entries) {
  const selection = state.context_selections.find((item) => item.id === selectionId);
  if (!selection || (selection.project_id && selection.project_id !== execution.project_id))
    throw new HttpError(409, { error: 'runner_context_selection_invalid', context_selection_id: selectionId });
  const includedByVersion = new Map((selection.included || []).map((item) => [item.document_version_id, item])),
    availableByVersion = new Map(),
    staleDynamicVersions = new Map();
  addInitialContextDocumentVersions(state, entries, selectionId, includedByVersion, availableByVersion);
  addRuntimeContextDocumentVersions(state, execution, nodeRunId, selectionId, availableByVersion, staleDynamicVersions);
  return { availableByVersion, staleDynamicVersions };
}

function addInitialContextDocumentVersions(state, entries, selectionId, includedByVersion, availableByVersion) {
  for (const entry of entries) {
    const included = includedByVersion.get(entry.document_version_id),
      version = state.context_document_versions.find((item) => item.id === entry.document_version_id),
      node = state.context_nodes.find((item) => item.id === entry.node_id);
    if (
      !included ||
      !version ||
      included.node_id !== entry.node_id ||
      version.node_id !== entry.node_id ||
      included.content_sha256 !== entry.content_sha256 ||
      version.content_sha256 !== entry.content_sha256
    )
      throw new HttpError(409, {
        error: 'runner_context_selection_invalid',
        context_selection_id: selectionId,
        document_version_id: entry.document_version_id
      });
    if (
      entry.required === true &&
      (!node || node.current_version_id !== version.id || node.source_hash !== version.source_hash)
    )
      throw new HttpError(409, {
        error: 'runner_required_context_stale',
        node_id: entry.node_id,
        document_version_id: entry.document_version_id,
        current_document_version_id: node?.current_version_id || null
      });
    availableByVersion.set(entry.document_version_id, {
      node_id: entry.node_id,
      content_sha256: entry.content_sha256,
      selection_ids: [selectionId],
      source: 'initial'
    });
  }
}

function addRuntimeContextDocumentVersions(
  state,
  execution,
  nodeRunId,
  selectionId,
  availableByVersion,
  staleDynamicVersions
) {
  for (const runtimeSelection of runtimeReadSelections(state, execution, nodeRunId, selectionId)) {
    const runtime = runtimeSelection.runtime_context,
      version = state.context_document_versions.find(
        (item) => item.id === runtime.read_document_version_id && item.node_id === runtime.read_node_id
      ),
      node = state.context_nodes.find((item) => item.id === runtime.read_node_id),
      included = runtimeSelection.included?.find(
        (item) => item.node_id === runtime.read_node_id && item.document_version_id === runtime.read_document_version_id
      );
    if (!version || !node || !included || included.content_sha256 !== version.content_sha256) continue;
    if (node.current_version_id !== version.id || node.source_hash !== version.source_hash) {
      staleDynamicVersions.set(version.id, {
        node_id: node.id,
        current_document_version_id: node.current_version_id || null
      });
      continue;
    }
    const existing = availableByVersion.get(version.id);
    if (existing?.source === 'initial') continue;
    if (existing) existing.selection_ids.push(runtimeSelection.id);
    else
      availableByVersion.set(version.id, {
        node_id: node.id,
        content_sha256: version.content_sha256,
        selection_ids: [runtimeSelection.id],
        source: 'runtime_read'
      });
  }
}

function normalizeOutputContextConsumption({
  state,
  outputs,
  selectionId,
  availableByVersion,
  staleDynamicVersions,
  byOutput,
  byOutputDispositions,
  selectionIdsByOutput
}) {
  const available = [...availableByVersion.keys()].sort(),
    availableSet = new Set(available);
  for (const output of outputs) {
    const key = clean(output?.output_key);
    if (!Array.isArray(output?.consumed_context_document_versions))
      throw new HttpError(409, { error: 'runner_consumed_context_declaration_required', output_key: key || null });
    const declared = validatedIdList(output.consumed_context_document_versions, 'runner_consumed_context_invalid', {
        source: `output:${key || 'unknown'}`
      }),
      invalid = declared.filter((versionId) => !availableSet.has(versionId));
    const stale = invalid.find((versionId) => staleDynamicVersions.has(versionId));
    if (stale) {
      const detail = staleDynamicVersions.get(stale);
      throw new HttpError(409, {
        error: 'runner_context_document_stale',
        node_id: detail.node_id,
        document_version_id: stale,
        current_document_version_id: detail.current_document_version_id
      });
    }
    if (invalid.length)
      throw new HttpError(409, {
        error: 'runner_consumed_context_mismatch',
        source: `output:${key || 'unknown'}`,
        available_document_version_ids: available,
        invalid_document_version_ids: invalid
      });
    const outputDispositions = validatedDispositions(
      output.context_dispositions,
      'document_version_id',
      'runner_context_disposition_invalid',
      `output:${key || 'unknown'}`
    );
    assertDispositionScope(
      outputDispositions,
      'document_version_id',
      availableSet,
      'runner_context_disposition_mismatch',
      key
    );
    assertUsedDispositionConsistency(
      outputDispositions,
      'document_version_id',
      declared,
      'runner_context_disposition_mismatch',
      key
    );
    byOutput.set(key, declared);
    byOutputDispositions.set(key, mergeUsedDispositions(declared, outputDispositions, 'document_version_id'));
    selectionIdsByOutput.set(
      key,
      orderedContextSelectionIds(
        state,
        new Set(declared.flatMap((versionId) => availableByVersion.get(versionId)?.selection_ids || [])),
        selectionId
      )
    );
  }
  return [...new Set([...byOutput.values()].flat())].sort();
}

function contextPolicies(entries) {
  const result = new Map();
  for (const entry of entries || []) {
    const explicit = ['must_use', 'must_acknowledge', 'available'].includes(entry.consumption_policy),
      policy = explicit ? entry.consumption_policy : entry.required === true ? 'must_use' : 'available',
      current = result.get(entry.document_version_id);
    result.set(entry.document_version_id, {
      explicit: Boolean(current?.explicit || explicit),
      mustUse: Boolean(current?.mustUse || policy === 'must_use')
    });
  }
  return result;
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
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item[idKey] !== 'string' ||
      !item[idKey].trim() ||
      !['used', 'not_used'].includes(item.disposition) ||
      (item.disposition === 'not_used' && !clean(item.reason, 1000)) ||
      seen.has(item[idKey].trim())
    )
      throw new HttpError(400, { error, source });
    seen.add(item[idKey].trim());
  }
  return normalizeDispositions(values, idKey);
}

function assertDispositionScope(dispositions, idKey, availableSet, error, source) {
  const invalid = dispositions.map((item) => item[idKey]).filter((value) => !availableSet.has(value));
  if (invalid.length) throw new HttpError(409, { error, source: source || 'aggregate', invalid_ids: invalid });
}

function assertUsedDispositionConsistency(dispositions, idKey, usedIds, error, source) {
  const used = new Set(usedIds),
    invalid = dispositions.filter((item) => (item.disposition === 'used') !== used.has(item[idKey]));
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
  const explicitById = new Map(explicit.map((item) => [item[idKey], item])),
    outputValues = [...perOutput.values()].flat(),
    outputById = new Map();
  for (const item of outputValues) {
    const values = outputById.get(item[idKey]) || [];
    values.push(item);
    outputById.set(item[idKey], values);
  }
  const result = [];
  for (const value of ids) {
    if (usedIds.has(value)) {
      const declaration = explicitById.get(value) || outputById.get(value)?.find((item) => item.disposition === 'used');
      result.push({
        [idKey]: value,
        disposition: 'used',
        reason: declaration?.reason || 'Declared as used by at least one output.'
      });
      continue;
    }
    const declaration =
      explicitById.get(value) || outputById.get(value)?.find((item) => item.disposition === 'not_used');
    if (declaration) result.push(declaration);
  }
  return result.sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

function assertRequiredContextConsumption(required, aggregate) {
  const missingRequired = required.filter((versionId) => !aggregate.includes(versionId));
  if (missingRequired.length)
    throw new HttpError(409, {
      error: 'runner_required_context_unconsumed',
      required_document_version_ids: required,
      missing_document_version_ids: missingRequired
    });
}

function assertDeclaredContextAggregate(aggregate, declaredAggregate) {
  if (declaredAggregate === null) return;
  const actual = validatedIdList(declaredAggregate, 'runner_consumed_context_invalid', { source: 'aggregate' });
  if (actual.length !== aggregate.length || actual.some((item, index) => item !== aggregate[index]))
    throw new HttpError(409, {
      error: 'runner_consumed_context_mismatch',
      source: 'aggregate',
      expected_document_version_ids: aggregate,
      actual_document_version_ids: actual
    });
}

function runtimeReadSelections(state, execution, nodeRunId, initialSelectionId) {
  if (!nodeRunId) return [];
  const run = state.node_runs.find(
    (item) =>
      item.id === nodeRunId && item.task_execution_id === execution.id && item.project_id === execution.project_id
  );
  if (!run) throw new HttpError(409, { error: 'runner_context_run_invalid', node_run_id: nodeRunId });
  return state.context_selections.filter((selection) => {
    const runtime = selection.runtime_context;
    if (
      runtime?.schema_version !== 'aiws.context_runtime_selection.v1' ||
      runtime.purpose !== 'mcp_read' ||
      runtime.run_id !== nodeRunId ||
      runtime.task_execution_id !== execution.id ||
      runtime.initial_context_selection_id !== initialSelectionId ||
      selection.project_id !== execution.project_id ||
      !runtime.read_document_version_id
    )
      return false;
    const client = state.mcp_clients.find((item) => item.id === runtime.mcp_client_id),
      binding = client?.context_binding;
    return (
      client?.kind === 'internal_codex' &&
      binding?.schema_version === 'aiws.mcp_context_binding.v1' &&
      binding.project_id === execution.project_id &&
      binding.session_id === runtime.session_id &&
      binding.run_id === nodeRunId &&
      binding.task_execution_id === execution.id &&
      binding.context_selection_id === initialSelectionId
    );
  });
}

function orderedContextSelectionIds(state, values, initialSelectionId) {
  return [...values].sort((left, right) => {
    if (left === initialSelectionId) return -1;
    if (right === initialSelectionId) return 1;
    const leftSelection = state.context_selections.find((item) => item.id === left),
      rightSelection = state.context_selections.find((item) => item.id === right);
    return (
      String(leftSelection?.created_at || '').localeCompare(String(rightSelection?.created_at || '')) ||
      String(left).localeCompare(String(right))
    );
  });
}

function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
