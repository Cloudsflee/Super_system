import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { hashString } from '../../../packages/shared/index.mjs';
import {
  INPUT_CONTRIBUTION_SCHEMA,
  contributionRouteHash,
  contributionRouteId
} from '../../../packages/shared/src/task-contributions.mjs';

export const TASK_HANDOFF_SCHEMA = 'aiws.task_handoff.v4';
export const LEGACY_CONTRIBUTION_TASK_HANDOFF_SCHEMA = 'aiws.task_handoff.v3';
export const EFFECT_TASK_HANDOFF_SCHEMA = 'aiws.task_handoff.v2';
export const LEGACY_TASK_HANDOFF_SCHEMA = 'aiws.task_handoff.v1';
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
  inputEffects,
  contextEffects,
  routes,
  unresolvedQuestions = [],
  limitations = []
} = {}) {
  const inputs = normalizeIdList(consumedInputVersions),
    contexts = normalizeIdList(consumedContextDocumentVersions),
    normalizedInputDispositions = normalizeDispositions(inputDispositions, 'version_id'),
    normalizedContextDispositions = normalizeDispositions(contextDispositions, 'document_version_id'),
    effectAware = Array.isArray(inputEffects) || Array.isArray(contextEffects) || Array.isArray(routes),
    contributionAware =
      (inputEffects || []).some((item) => item?.contribution_id) ||
      (routes || []).some((item) => item?.contribution_id),
    claimedRelations = handoffRelations(output, inputs, contexts),
    manifest = {
      schema_version: contributionAware
        ? TASK_HANDOFF_SCHEMA
        : effectAware
          ? EFFECT_TASK_HANDOFF_SCHEMA
          : LEGACY_TASK_HANDOFF_SCHEMA,
      producer: handoffProducer(taskExecution, task),
      output: handoffOutput(output, slot, asset, version),
      source_snapshot: handoffSourceSnapshot(taskExecution, contextSelectionId, inputs, contexts, contributionAware),
      input_dispositions: contributionAware ? [] : normalizedInputDispositions,
      context_dispositions: contributionAware ? [] : normalizedContextDispositions,
      relations: contributionAware ? [] : claimedRelations,
      ...(contributionAware
        ? {
            authority_status: 'structurally_verified',
            structurally_verified_input_dispositions: normalizedInputDispositions,
            structurally_verified_context_dispositions: normalizedContextDispositions,
            claimed_relations: claimedRelations
          }
        : {}),
      unresolved_questions: normalizeTextList(unresolvedQuestions),
      limitations: normalizeTextList(limitations),
      created_at: version?.created_at || taskExecution?.updated_at || taskExecution?.created_at || null
    };
  if (effectAware) {
    manifest.effects = {
      inputs: normalizeEffects(inputEffects, 'input_key'),
      context: normalizeEffects(contextEffects, 'document_version_id')
    };
    manifest.delivery = { routes: normalizeRoutes(routes) };
  }
  return {
    ...manifest,
    manifest_sha256: hashString(JSON.stringify(manifest))
  };
}

export function taskHandoffRoutes(state, task, slot) {
  if (!task || !slot || slot.handoff === false) return [];
  const nodes = state.workflow_nodes?.filter((item) => item.workflow_id === task.workflow_id) || [],
    tasks = nodes.filter((item) => item.role === 'task'),
    routes = [];
  for (const consumer of tasks) {
    for (const input of consumer.input_slots || []) {
      const internal = input.source === 'dependency' && input.ref_id === task.id,
        crossWorkstream =
          input.source === 'workstream_dependency' &&
          input.ref_id === task.parent_node_id &&
          consumer.parent_node_id !== task.parent_node_id;
      if ((!internal && !crossWorkstream) || !selectorIncludesOutput(task, input.selector, slot.key)) continue;
      const route = {
        route_type: internal ? 'task_input' : 'workstream_input',
        producer_task_id: task.id,
        output_key: slot.key,
        consumer_task_id: consumer.id,
        consumer_task_title: clean(consumer.title, 200) || null,
        input_key: input.key,
        purpose: clean(input.purpose, 1000) || null,
        application_policy:
          input.application_policy === 'required' || input.consumption_policy === 'must_use' ? 'required' : 'optional',
        target_output_keys: normalizeIdList(input.target_output_keys)
      };
      if (input.contribution?.schema_version === INPUT_CONTRIBUTION_SCHEMA) {
        Object.assign(route, {
          contribution_schema_version: INPUT_CONTRIBUTION_SCHEMA,
          contribution_id: input.contribution.id,
          effect: input.contribution.effect,
          expected_effect: input.contribution.expected_effect,
          target_output_keys: normalizeIdList(input.contribution.target_output_keys),
          target_criterion_ids: normalizeIdList(input.contribution.target_criterion_ids)
        });
        route.route_id = contributionRouteId(route);
        route.route_contract_hash = contributionRouteHash(route);
      }
      routes.push(route);
    }
  }
  const siblings = tasks.filter((item) => item.parent_node_id === task.parent_node_id),
    terminal = !siblings.some((candidate) => dependencyIds(candidate).includes(task.id));
  if (!routes.length && terminal)
    routes.push({
      route_type: 'workstream_boundary',
      producer_task_id: task.id,
      output_key: slot.key,
      workstream_id: task.parent_node_id || null
    });
  return normalizeRoutes(routes);
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

function handoffSourceSnapshot(taskExecution, contextSelectionId, inputs, contexts, contributionAware) {
  return {
    input_snapshot_hash: taskExecution?.input_snapshot_hash || null,
    context_selection_id: contextSelectionId || null,
    consumed_input_versions: contributionAware ? [] : inputs,
    consumed_context_document_versions: contributionAware ? [] : contexts,
    ...(contributionAware
      ? {
          structurally_verified_input_versions: inputs,
          structurally_verified_context_document_versions: contexts
        }
      : {})
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
    contextSchema = execution?.context_snapshot?.schema_version,
    contributionAware = contextSchema === 'aiws.task_execution_context.v5',
    effectAware = contributionAware || contextSchema === 'aiws.task_execution_context.v4',
    inputDiagnostics = handoffInputDiagnostics(execution, contract),
    effectDiagnostics = handoffEffectDiagnostics(execution),
    exportedOutputs = handoffExportedOutputs(state, execution, contract),
    semanticGaps = handoffSemanticGaps({
      execution,
      contract,
      effectAware,
      contributionAware,
      inputDiagnostics,
      effectDiagnostics,
      exportedOutputs
    });
  return {
    schema_version: contributionAware
      ? 'aiws.task_handoff_diagnostics.v4'
      : effectAware
        ? 'aiws.task_handoff_diagnostics.v2'
        : 'aiws.task_handoff_diagnostics.v1',
    handoff_status:
      execution?.status !== 'completed' ? 'awaiting_execution' : semanticGaps.length ? 'incomplete' : 'ready',
    required_inputs: inputDiagnostics.requiredInputs,
    used_inputs: normalizeIdList(execution?.consumed_inputs),
    not_used_inputs: inputDiagnostics.inputDispositions.filter((item) => item.disposition === 'not_used'),
    missing_dispositions: effectAware ? [] : inputDiagnostics.missingDispositions,
    input_effect_obligations: effectDiagnostics.obligations,
    input_effects: effectDiagnostics.inputEffects,
    context_effects: effectDiagnostics.contextEffects,
    contribution_statuses: structuredClone(execution?.contribution_statuses || []),
    effect_claim_statuses: structuredClone(execution?.effect_claim_statuses || []),
    exported_outputs: exportedOutputs,
    context_used: normalizeIdList(execution?.consumed_context_document_versions),
    context_not_used: inputDiagnostics.contextDispositions.filter((item) => item.disposition === 'not_used'),
    semantic_gaps: semanticGaps
  };
}

function handoffInputDiagnostics(execution, contract) {
  const inputs = execution?.context_snapshot?.inputs || contract?.expected_inputs || [],
    inputDispositions = normalizeDispositions(execution?.input_dispositions, 'version_id'),
    contextDispositions = normalizeDispositions(execution?.context_dispositions, 'document_version_id'),
    dispositionByVersion = new Map(inputDispositions.map((item) => [item.version_id, item])),
    requiredInputs = inputs.map(handoffRequiredInput),
    explicitVersionIds = requiredInputs
      .filter((item) => !item.consumption_policy.startsWith('legacy_'))
      .flatMap((item) => item.version_ids),
    missingDispositions = normalizeIdList(explicitVersionIds).filter((value) => !dispositionByVersion.has(value));
  return { requiredInputs, inputDispositions, contextDispositions, missingDispositions };
}

function handoffRequiredInput(input) {
  return {
    slot_key: input.key,
    required: input.required !== false,
    consumption_policy: input.consumption_policy || (input.required !== false ? 'legacy_must_use' : 'legacy_available'),
    application_policy:
      input.application_policy === 'required' || input.consumption_policy === 'must_use' ? 'required' : 'optional',
    purpose: clean(input.purpose, 1000) || null,
    target_output_keys: normalizeIdList(input.target_output_keys),
    contribution: input.contribution ? structuredClone(input.contribution) : null,
    version_ids: normalizeIdList((input.asset_versions || []).map((item) => item.version_id))
  };
}

function handoffEffectDiagnostics(execution) {
  const inputEffects = normalizeEffects(execution?.input_effects, 'input_key'),
    contextEffects = normalizeEffects(execution?.context_effects, 'document_version_id'),
    accepted = new Set(execution?.accepted_contribution_ids || []),
    obligations = (execution?.context_snapshot?.input_effect_obligations || []).map((item) => ({
      ...item,
      satisfied: inputEffects.some((effect) => effect.input_key === item.input_key && effect.effect !== 'reference'),
      accepted: item.contribution?.id ? accepted.has(item.contribution.id) : null
    }));
  return { inputEffects, contextEffects, obligations };
}

function handoffExportedOutputs(state, execution, contract) {
  return (contract?.expected_outputs || [])
    .filter((slot) => slot.handoff !== false)
    .map((slot) => handoffExportedOutput(state, execution, slot));
}

function handoffExportedOutput(state, execution, slot) {
  const binding = (execution?.output_bindings || []).find((item) => item.key === slot.key),
    version = state.asset_versions?.find((item) => item.id === binding?.version_id),
    manifest = version?.provenance?.handoff_manifest,
    routes = manifest?.delivery?.routes || [];
  return {
    output_key: slot.key,
    required: slot.required !== false,
    consumer_hint: slot.consumer_hint || null,
    asset_id: binding?.asset_id || null,
    version_id: binding?.version_id || null,
    handoff_manifest_sha256: binding?.handoff_manifest_sha256 || null,
    route_count: routes.length,
    routes,
    effect_count: (manifest?.effects?.inputs || []).length + (manifest?.effects?.context || []).length
  };
}

function handoffSemanticGaps({
  execution,
  contract,
  effectAware,
  contributionAware,
  inputDiagnostics,
  effectDiagnostics,
  exportedOutputs
}) {
  return [
    ...legacyInputGaps(execution, effectAware, inputDiagnostics.missingDispositions),
    ...requiredEffectGaps(execution, effectAware, contributionAware, effectDiagnostics.obligations),
    ...handoffOutputGaps(execution, contract?.expected_outputs || [], exportedOutputs, effectAware)
  ];
}

function legacyInputGaps(execution, effectAware, missingDispositions) {
  const terminal = ['completed', 'failed', 'cancelled', 'superseded'].includes(execution?.status);
  return !effectAware && terminal && missingDispositions.length
    ? [{ code: 'input_disposition_missing', version_ids: missingDispositions }]
    : [];
}

function requiredEffectGaps(execution, effectAware, contributionAware, obligations) {
  if (!effectAware || execution?.status !== 'completed') return [];
  return obligations
    .filter(
      (item) =>
        item.application_policy === 'required' && (!item.satisfied || (contributionAware && item.accepted !== true))
    )
    .map((item) => ({
      code:
        contributionAware && item.satisfied && item.accepted !== true
          ? 'required_contribution_not_accepted'
          : 'required_input_effect_missing',
      input_key: item.input_key,
      contribution_id: item.contribution?.id || null
    }));
}

function handoffOutputGaps(execution, outputSlots, exportedOutputs, effectAware) {
  if (execution?.status !== 'completed') return [];
  return [
    ...(outputSlots.length && !exportedOutputs.length ? [{ code: 'handoff_output_missing' }] : []),
    ...exportedOutputs
      .filter((output) => output.required && !output.version_id)
      .map((output) => ({ code: 'handoff_output_unbound', output_key: output.output_key })),
    ...exportedOutputs
      .filter((output) => effectAware && output.version_id && !output.route_count)
      .map((output) => ({ code: 'handoff_output_unrouted', output_key: output.output_key }))
  ];
}

function selectorIncludesOutput(task, selector, outputKey) {
  if (selector === outputKey) return true;
  if (selector !== 'required_outputs') return false;
  const required = (task.output_slots || []).filter((item) => item.required !== false);
  return required.length === 1 && required[0].key === outputKey;
}

function dependencyIds(node) {
  const source = Array.isArray(node?.dependency_ids) ? node.dependency_ids : node?.dependencies || [];
  return source.map((item) => (typeof item === 'string' ? item : item?.node_id || item?.id)).filter(Boolean);
}

function normalizeEffects(values, identityKey) {
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object' && clean(item[identityKey], 200))
    .map((item) => ({
      ...structuredClone(item),
      [identityKey]: clean(item[identityKey], 200),
      ...(identityKey === 'input_key' ? { version_ids: normalizeIdList(item.version_ids) } : {}),
      output_keys: normalizeIdList(item.output_keys),
      ...(item.criterion_ids ? { criterion_ids: normalizeIdList(item.criterion_ids) } : {}),
      statement: clean(item.statement, 2000),
      evidence_refs: normalizeTextList(item.evidence_refs),
      ...(item.source_receipts ? { source_receipts: normalizeTextList(item.source_receipts) } : {})
    }))
    .sort(
      (left, right) =>
        left[identityKey].localeCompare(right[identityKey]) ||
        String(left.effect).localeCompare(String(right.effect)) ||
        left.output_keys.join(',').localeCompare(right.output_keys.join(','))
    );
}

function normalizeRoutes(values) {
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object' && clean(item.route_type, 80))
    .map((item) => ({
      ...structuredClone(item),
      target_output_keys: normalizeIdList(item.target_output_keys),
      ...(item.contribution_id ? { target_criterion_ids: normalizeIdList(item.target_criterion_ids) } : {})
    }))
    .sort(
      (left, right) =>
        String(left.route_type).localeCompare(String(right.route_type)) ||
        String(left.consumer_task_id || '').localeCompare(String(right.consumer_task_id || '')) ||
        String(left.input_key || '').localeCompare(String(right.input_key || ''))
    );
}

export function verifyContributionRoutes(task, input, bindings) {
  const contribution = input?.contribution;
  if (
    contribution?.schema_version !== INPUT_CONTRIBUTION_SCHEMA ||
    !['dependency', 'workstream_dependency'].includes(input?.source)
  )
    return { ok: true, routes: [] };
  const verified = [];
  for (const binding of bindings || []) {
    const manifest = binding?.handoff_manifest,
      { manifest_sha256: declaredManifestHash, ...manifestBody } = manifest || {},
      actualManifestHash = manifest ? hashString(JSON.stringify(manifestBody)) : null,
      routes = manifest?.delivery?.routes || [],
      sameConsumer = routes.filter(
        (route) =>
          route.consumer_task_id === task?.id &&
          route.input_key === input.key &&
          route.output_key === binding.output_key
      ),
      route = sameConsumer.find((item) => item.contribution_id === contribution.id);
    if (
      ![TASK_HANDOFF_SCHEMA, LEGACY_CONTRIBUTION_TASK_HANDOFF_SCHEMA].includes(manifest?.schema_version) ||
      !declaredManifestHash ||
      actualManifestHash !== declaredManifestHash ||
      (binding.handoff_manifest_sha256 && binding.handoff_manifest_sha256 !== declaredManifestHash)
    )
      return {
        ok: false,
        code: 'dependency_contribution_manifest_invalid',
        input_key: input.key,
        contribution_id: contribution.id,
        version_id: binding.version_id || null
      };
    if (!route)
      return {
        ok: false,
        code: sameConsumer.length ? 'dependency_contribution_route_stale' : 'dependency_contribution_route_missing',
        input_key: input.key,
        contribution_id: contribution.id,
        producer_task_id: manifest?.producer?.task_id || binding?.producer_task_id || null,
        output_key: binding.output_key || null,
        available_contribution_ids: normalizeIdList(sameConsumer.map((item) => item.contribution_id))
      };
    const expected = {
      ...route,
      producer_task_id: manifest?.producer?.task_id || route.producer_task_id,
      output_key: binding.output_key,
      consumer_task_id: task.id,
      input_key: input.key,
      contribution_id: contribution.id,
      effect: contribution.effect,
      expected_effect: contribution.expected_effect,
      target_output_keys: contribution.target_output_keys,
      target_criterion_ids: contribution.target_criterion_ids
    };
    if (
      route.route_id !== contributionRouteId(expected) ||
      route.route_contract_hash !== contributionRouteHash(expected)
    )
      return {
        ok: false,
        code: 'dependency_contribution_route_stale',
        input_key: input.key,
        contribution_id: contribution.id,
        producer_task_id: manifest?.producer?.task_id || null,
        output_key: binding.output_key || null
      };
    verified.push({
      route_id: route.route_id,
      route_contract_hash: route.route_contract_hash,
      contribution_id: contribution.id,
      version_id: binding.version_id
    });
  }
  return { ok: true, routes: verified };
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
