import { hashString } from '../../../packages/shared/index.mjs';

export const TASK_HANDOFF_SCHEMA = 'aiws.task_handoff.v1';
export const INPUT_DISPOSITIONS = Object.freeze(['used', 'not_used']);

/**
 * Build the immutable receipt carried by every verified task output.  The
 * receipt is deliberately metadata-only: payload bytes remain in CAS.
 */
export function buildTaskHandoffManifest({
  taskExecution,
  task,
  output,
  asset,
  version,
  slot,
  consumedInputVersions = [],
  inputDispositions = [],
  consumedContextDocumentVersions = [],
  contextDispositions = [],
  contextSelectionId = null,
  unresolvedQuestions = [],
  limitations = []
} = {}) {
  const inputs = normalizeIdList(consumedInputVersions),
    contexts = normalizeIdList(consumedContextDocumentVersions),
    normalizedInputDispositions = normalizeDispositions(inputDispositions, 'version_id'),
    normalizedContextDispositions = normalizeDispositions(contextDispositions, 'document_version_id'),
    manifest = {
      schema_version: TASK_HANDOFF_SCHEMA,
      producer: handoffProducer(taskExecution, task),
      output: handoffOutput(output, slot, asset, version),
      source_snapshot: handoffSourceSnapshot(taskExecution, contextSelectionId, inputs, contexts),
      input_dispositions: normalizedInputDispositions,
      context_dispositions: normalizedContextDispositions,
      relations: handoffRelations(output, inputs, contexts),
      unresolved_questions: normalizeTextList(unresolvedQuestions),
      limitations: normalizeTextList(limitations),
      created_at: version?.created_at || taskExecution?.updated_at || taskExecution?.created_at || null
    };
  return {
    ...manifest,
    manifest_sha256: hashString(JSON.stringify(manifest))
  };
}

function handoffProducer(taskExecution, task) {
  return {
    task_id: task?.id || taskExecution?.task_id || null,
    task_title: task?.title || null,
    task_execution_id: taskExecution?.id || null,
    attempt: Number(taskExecution?.attempt || 1)
  };
}

function handoffOutput(output, slot, asset, version) {
  return {
    output_key: output?.output_key || slot?.key || version?.output_key || null,
    asset_id: asset?.id || null,
    version_id: version?.id || null,
    asset_type: asset?.asset_type || slot?.asset_type || output?.asset_type || null,
    purpose: clean(output?.purpose || slot?.purpose, 500) || null,
    consumer_hint: clean(output?.consumer_hint || slot?.consumer_hint, 200) || null
  };
}

function handoffSourceSnapshot(taskExecution, contextSelectionId, inputs, contexts) {
  return {
    input_snapshot_hash: taskExecution?.input_snapshot_hash || null,
    context_selection_id: contextSelectionId || null,
    consumed_input_versions: inputs,
    consumed_context_document_versions: contexts
  };
}

function handoffRelations(output, inputs, contexts) {
  const declared = Array.isArray(output?.input_relations) ? output.input_relations : [],
    allowed = new Set(['derived_from', 'verified_against', 'informed_by']);
  return [
    ...inputs.map((versionId) => {
      const relation = declared.find((item) => item?.version_id === versionId && allowed.has(item.type));
      return { type: relation?.type || 'derived_from', version_id: versionId };
    }),
    ...contexts.map((documentVersionId) => {
      const relation = declared.find(
        (item) => item?.document_version_id === documentVersionId && allowed.has(item.type)
      );
      return { type: relation?.type || 'informed_by', document_version_id: documentVersionId };
    })
  ];
}

export function normalizeIdList(values, { rejectInvalid = false } = {}) {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    if (rejectInvalid) throw new TypeError('id_list_must_be_array');
    return [];
  }
  const result = [],
    seen = new Set();
  for (const value of values) {
    if (value == null || value === '') continue;
    if (typeof value !== 'string') {
      if (rejectInvalid) throw new TypeError('id_must_be_string');
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.sort();
}

export function normalizeDispositions(values, idKey = 'version_id') {
  if (!Array.isArray(values)) return [];
  const result = [],
    seen = new Set();
  for (const item of values) {
    if (!item || typeof item !== 'object') continue;
    const idValue = typeof item[idKey] === 'string' ? item[idKey].trim() : '';
    if (!idValue || seen.has(idValue)) continue;
    const disposition = item.disposition === 'not_used' ? 'not_used' : item.disposition === 'used' ? 'used' : null;
    if (!disposition) continue;
    const reason = clean(item.reason, 1000);
    if (disposition === 'not_used' && !reason) continue;
    seen.add(idValue);
    result.push({ [idKey]: idValue, disposition, reason: reason || null });
  }
  return result.sort((left, right) => left[idKey].localeCompare(right[idKey]));
}

export function dispositionMap(values, idKey = 'version_id') {
  return new Map(normalizeDispositions(values, idKey).map((item) => [item[idKey], item]));
}

export function notUsedContextDispositions(execution, reason) {
  return normalizeIdList(
    (execution?.context_snapshot?.system_context?.document_versions || []).map((item) => item?.document_version_id)
  ).map((documentVersionId) => ({
    document_version_id: documentVersionId,
    disposition: 'not_used',
    reason: clean(reason, 1000) || 'This deterministic operation did not use semantic context.'
  }));
}

export function taskHandoffDiagnostics(state, execution) {
  const contract = state.node_contracts?.find((item) => item.id === execution?.contract_id),
    inputs = execution?.context_snapshot?.inputs || contract?.expected_inputs || [],
    inputDispositions = normalizeDispositions(execution?.input_dispositions, 'version_id'),
    contextDispositions = normalizeDispositions(execution?.context_dispositions, 'document_version_id'),
    dispositionByVersion = new Map(inputDispositions.map((item) => [item.version_id, item])),
    requiredInputs = inputs.map((input) => ({
      slot_key: input.key,
      required: input.required !== false,
      consumption_policy:
        input.consumption_policy || (input.required !== false ? 'legacy_must_use' : 'legacy_available'),
      version_ids: normalizeIdList((input.asset_versions || []).map((item) => item.version_id))
    })),
    explicitVersionIds = requiredInputs
      .filter((item) => !item.consumption_policy.startsWith('legacy_'))
      .flatMap((item) => item.version_ids),
    missingDispositions = normalizeIdList(explicitVersionIds).filter((value) => !dispositionByVersion.has(value)),
    outputSlots = contract?.expected_outputs || [],
    exportedOutputs = outputSlots
      .filter((slot) => slot.handoff !== false)
      .map((slot) => {
        const binding = (execution?.output_bindings || []).find((item) => item.key === slot.key);
        return {
          output_key: slot.key,
          required: slot.required !== false,
          consumer_hint: slot.consumer_hint || null,
          asset_id: binding?.asset_id || null,
          version_id: binding?.version_id || null,
          handoff_manifest_sha256: binding?.handoff_manifest_sha256 || null
        };
      }),
    terminal = ['completed', 'failed', 'cancelled', 'superseded'].includes(execution?.status),
    semanticGaps = [];
  if (terminal && missingDispositions.length)
    semanticGaps.push({ code: 'input_disposition_missing', version_ids: missingDispositions });
  if (execution?.status === 'completed' && outputSlots.length && !exportedOutputs.length)
    semanticGaps.push({ code: 'handoff_output_missing' });
  for (const output of exportedOutputs)
    if (execution?.status === 'completed' && output.required && !output.version_id)
      semanticGaps.push({ code: 'handoff_output_unbound', output_key: output.output_key });
  return {
    schema_version: 'aiws.task_handoff_diagnostics.v1',
    handoff_status:
      execution?.status !== 'completed' ? 'awaiting_execution' : semanticGaps.length ? 'incomplete' : 'ready',
    required_inputs: requiredInputs,
    used_inputs: normalizeIdList(execution?.consumed_inputs),
    not_used_inputs: inputDispositions.filter((item) => item.disposition === 'not_used'),
    missing_dispositions: missingDispositions,
    exported_outputs: exportedOutputs,
    context_used: normalizeIdList(execution?.consumed_context_document_versions),
    context_not_used: contextDispositions.filter((item) => item.disposition === 'not_used'),
    semantic_gaps: semanticGaps
  };
}

function normalizeTextList(values) {
  return (Array.isArray(values) ? values : []).map((value) => clean(value, 1000)).filter(Boolean);
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
