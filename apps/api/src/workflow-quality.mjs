import { HttpError } from './http.mjs';

export const WORKFLOW_PHASE_TAGS = Object.freeze([
  'research_evidence',
  'constraint_analysis',
  'solution_decision',
  'execution',
  'acceptance',
  'integration_delivery'
]);
const SOFTWARE_KINDS = new Set(['code', 'test', 'deploy', 'integration']);
const HUMAN_CONFIRM_KINDS = new Set(['research', 'analysis', 'design', 'content', 'review', 'manual']);

export function normalizeWorkflowPlanningFields(nodes) {
  const source = Array.isArray(nodes) ? nodes : [];
  const normalized = source.map((node) => {
    if (node.role !== 'task') return { ...node };
    const dependencyIds = deps(node),
      tags = unique([...(node.capability_tags || []), ...inferredTags(node)]);
    const acceptance = unique(
      node.acceptance_criteria?.length ? node.acceptance_criteria : [`完成并验证：${node.goal || node.title}`]
    );
    const inputs = normalizeInputs(node.input_slots, dependencyIds, node);
    const outputs = normalizeOutputs(node.output_slots, acceptance, node);
    return {
      ...node,
      capability_tags: tags,
      acceptance_criteria: acceptance,
      input_slots: inputs,
      output_slots: outputs,
      atomic_justification: clean(node.atomic_justification, 2000) || null
    };
  });
  return normalized;
}

export function validateWorkflowPlanningQuality({
  nodes,
  project = null,
  brief = null,
  projectClassification = '',
  briefCoverage = null,
  allowAtomic = true
} = {}) {
  const errors = [],
    normalized = normalizeWorkflowPlanningFields(nodes),
    byId = new Map(normalized.map((item) => [item.id, item])),
    taskIds = new Set(normalized.filter((item) => item.role === 'task').map((item) => item.id));
  const hasRepository = Boolean(
    project?.repo_path ||
    project?.workspace_root ||
    normalized.some((item) => item.repository_intent) ||
    /software|code|repository/i.test(String(projectClassification || ''))
  );
  const hasExternalMaterials = Boolean(brief?.content?.material_references?.length);
  const context = { normalized, byId, errors, hasRepository, hasExternalMaterials, allowAtomic };
  for (const workstream of normalized.filter((item) => item.role === 'workstream'))
    validateWorkstreamPlanning(workstream, context);
  validateBriefCoverage(brief, briefCoverage, taskIds, errors);
  return { ok: errors.length === 0, errors, nodes: normalized, brief_coverage: normalizeCoverage(briefCoverage) };
}

function validateWorkstreamPlanning(workstream, context) {
  const tasks = context.normalized.filter((item) => item.role === 'task' && item.parent_node_id === workstream.id);
  const software = context.hasRepository || tasks.some((item) => SOFTWARE_KINDS.has(item.task_kind));
  const atomic = isAtomicWorkstream(workstream, tasks, software, context);
  if (!atomic && tasks.length < 3)
    context.errors.push(
      issue('workflow_workstream_task_quality_minimum', workstream.id, { minimum: 3, count: tasks.length })
    );
  if (tasks.length === 1 && !atomic)
    context.errors.push(issue('workflow_atomic_task_justification_required', tasks[0]?.id || workstream.id));
  if (!atomic) validateWorkstreamPhaseCoverage(workstream, tasks, software, context.errors);
  validateWorkstreamDependencyInputs(workstream, tasks, context);
  for (const [index, task] of tasks.entries()) validateTaskPlanning(task, index, context);
}

function validateWorkstreamDependencyInputs(workstream, tasks, context) {
  const dependencyIds = deps(workstream);
  for (const task of tasks) {
    const bindings = (task.input_slots || []).filter((slot) => slot.source === 'workstream_dependency');
    for (const binding of bindings) {
      const dependencyId = binding.ref_id,
        upstream = context.byId.get(dependencyId),
        outputs = terminalWorkstreamOutputs(context.normalized, dependencyId);
      if (!dependencyId || !dependencyIds.includes(dependencyId)) {
        context.errors.push(
          issue('workflow_workstream_dependency_input_scope_invalid', task.id, {
            dependency_workstream_id: dependencyId || null,
            workstream_id: workstream.id,
            slot_key: binding.key
          })
        );
        continue;
      }
      if (!upstream || upstream.role !== 'workstream') {
        context.errors.push(
          issue('workflow_workstream_dependency_invalid', workstream.id, { dependency_workstream_id: dependencyId })
        );
        continue;
      }
      if (!outputs.length) {
        context.errors.push(
          issue('workflow_workstream_dependency_exports_missing', workstream.id, {
            dependency_workstream_id: dependencyId
          })
        );
        continue;
      }
      validateWorkstreamDependencySelector(task, dependencyId, binding, outputs, context.errors);
    }
  }
  for (const dependencyId of dependencyIds) {
    const upstream = context.byId.get(dependencyId);
    if (!upstream || upstream.role !== 'workstream') {
      context.errors.push(
        issue('workflow_workstream_dependency_invalid', workstream.id, { dependency_workstream_id: dependencyId })
      );
    }
  }
}

function validateWorkstreamDependencySelector(task, dependencyId, binding, outputs, errors) {
  if (binding.selector === 'workstream_outcome') {
    errors.push(
      issue('workflow_workstream_outcome_not_consumable', task.id, {
        dependency_workstream_id: dependencyId,
        slot_key: binding.key
      })
    );
    return;
  }
  const matching = outputs.filter((item) => item.key === binding.selector),
    requiredOutputs = outputs.filter((item) => item.required !== false);
  if (binding.selector === 'required_outputs' && requiredOutputs.length === 1) return;
  if (binding.selector === 'required_outputs') {
    errors.push(
      issue('workflow_workstream_dependency_output_selector_required', task.id, {
        dependency_workstream_id: dependencyId,
        slot_key: binding.key,
        output_keys: requiredOutputs.map((item) => item.key)
      })
    );
    return;
  }
  if (matching.length === 1) return;
  errors.push(
    issue(
      matching.length > 1
        ? 'workflow_workstream_dependency_output_selector_ambiguous'
        : 'workflow_workstream_dependency_output_selector_invalid',
      task.id,
      {
        dependency_workstream_id: dependencyId,
        slot_key: binding.key,
        selector: binding.selector,
        output_keys: outputs.map((item) => item.key)
      }
    )
  );
}

function terminalWorkstreamOutputs(nodes, workstreamId) {
  const tasks = nodes.filter((item) => item.role === 'task' && item.parent_node_id === workstreamId),
    terminal = tasks.filter((task) => !tasks.some((candidate) => deps(candidate).includes(task.id)));
  return terminal.flatMap((task) =>
    (task.output_slots || [])
      .filter((slot) => slot.handoff !== false)
      .map((slot) => ({
        key: slot.key,
        asset_type: slot.asset_type,
        required: slot.required !== false,
        producer_task_id: task.id
      }))
  );
}

function isAtomicWorkstream(workstream, tasks, software, context) {
  return (
    tasks.length === 1 &&
    context.allowAtomic &&
    !software &&
    !context.hasExternalMaterials &&
    (workstream.acceptance_criteria || []).length === 1 &&
    tasks[0]?.task_kind === 'manual' &&
    Boolean(tasks[0]?.atomic_justification)
  );
}

function validateWorkstreamPhaseCoverage(workstream, tasks, software, errors) {
  const tags = new Set(tasks.flatMap((item) => item.capability_tags || []));
  if (!hasAny(tags, ['research_evidence', 'constraint_analysis']))
    errors.push(issue('workflow_evidence_preparation_task_required', workstream.id));
  if (!hasAny(tags, ['solution_decision', 'execution']))
    errors.push(issue('workflow_execution_task_required', workstream.id));
  if (!hasAny(tags, ['acceptance', 'integration_delivery']))
    errors.push(issue('workflow_acceptance_task_required', workstream.id));
  if (software && tasks.length >= 6)
    for (const tag of WORKFLOW_PHASE_TAGS)
      if (!tags.has(tag))
        errors.push(issue('workflow_default_phase_coverage_missing', workstream.id, { capability_tag: tag }));
}

function validateTaskPlanning(task, index, context) {
  if (!task.acceptance_criteria?.length) context.errors.push(issue('workflow_task_acceptance_required', task.id));
  if (!task.capability_tags?.length) context.errors.push(issue('workflow_task_capability_tags_required', task.id));
  if (typedInputsInvalid(task)) context.errors.push(issue('workflow_task_typed_inputs_invalid', task.id));
  if (typedOutputsInvalid(task)) context.errors.push(issue('workflow_task_typed_outputs_invalid', task.id));
  if (outputAcceptanceCoverageMissing(task))
    context.errors.push(issue('workflow_task_output_acceptance_coverage_required', task.id));
  const siblings = context.normalized.filter(
      (item) => item.role === 'task' && item.parent_node_id === task.parent_node_id
    ),
    terminal = !siblings.some((candidate) => deps(candidate).includes(task.id));
  if (terminal && !(task.output_slots || []).some((slot) => slot.handoff !== false))
    context.errors.push(issue('workflow_task_handoff_output_required', task.id));
  const dependencyIds = deps(task);
  if (index > 0 && !dependencyIds.length) context.errors.push(issue('workflow_task_dependency_flow_required', task.id));
  validateTaskDependencyInputs(task, dependencyIds, context);
}

function typedInputsInvalid(task) {
  return (
    !Array.isArray(task.input_slots) ||
    task.input_slots.some(
      (slot) =>
        !slot.key ||
        !slot.kind ||
        !slot.source ||
        !['must_use', 'must_acknowledge', 'available'].includes(slot.consumption_policy || 'must_acknowledge')
    )
  );
}

function typedOutputsInvalid(task) {
  return (
    !task.output_slots?.length ||
    task.output_slots.some(
      (slot) =>
        !slot.key || !slot.kind || !slot.asset_type || !slot.acceptance_criteria?.length || !slot.confirmation_policy
    )
  );
}

function outputAcceptanceCoverageMissing(task) {
  const coveredCriteria = new Set(task.output_slots?.flatMap((slot) => slot.acceptance_criteria || []) || []);
  return (task.acceptance_criteria || []).some((criterion) => !coveredCriteria.has(criterion));
}

function validateTaskDependencyInputs(task, dependencyIds, context) {
  for (const binding of (task.input_slots || []).filter((slot) => slot.source === 'dependency')) {
    const dependencyId = binding.ref_id,
      dependency = context.byId.get(dependencyId);
    if (!dependencyId || !dependencyIds.includes(dependencyId)) {
      context.errors.push(
        issue('workflow_task_dependency_input_scope_invalid', task.id, {
          dependency_id: dependencyId || null,
          slot_key: binding.key
        })
      );
      continue;
    }
    if (!dependency || dependency.role !== 'task' || dependency.parent_node_id !== task.parent_node_id) {
      context.errors.push(
        issue('workflow_task_dependency_invalid', task.id, { dependency_id: dependencyId, slot_key: binding.key })
      );
      continue;
    }
    validateDependencySelectors(task, dependency, [binding], context.errors);
  }
  for (const dependencyId of dependencyIds) {
    const dependency = context.byId.get(dependencyId);
    if (!dependency || dependency.role !== 'task' || dependency.parent_node_id !== task.parent_node_id)
      context.errors.push(issue('workflow_task_dependency_invalid', task.id, { dependency_id: dependencyId }));
  }
}

export function assertWorkflowPlanningQuality(input) {
  const result = validateWorkflowPlanningQuality(input);
  if (!result.ok) throw new HttpError(409, { error: 'workflow_planning_quality_failed', errors: result.errors });
  return result;
}

export function defaultBriefCoverage(brief, taskIds) {
  const ids = unique(taskIds),
    last = ids.at(-1),
    first = ids[0];
  return Object.fromEntries(
    requiredBriefKeys(brief).map((key) => [
      key,
      key === 'risks' ? [first || last].filter(Boolean) : [last || first].filter(Boolean)
    ])
  );
}

function normalizeInputs(source, _dependencyIds, node) {
  const slots = (Array.isArray(source) ? source : []).map((slot, index) => ({
    key: clean(slot?.key || `input_${index + 1}`, 120),
    kind: clean(slot?.kind || 'asset_version', 80),
    required: slot?.required !== false,
    source: clean(slot?.source || 'explicit', 80),
    selector: slot?.selector ?? null,
    ref_id: slot?.ref_id ?? null,
    version_id: slot?.version_id ?? null,
    consumption_policy: ['must_use', 'must_acknowledge', 'available'].includes(slot?.consumption_policy)
      ? slot.consumption_policy
      : 'must_acknowledge'
  }));
  if (SOFTWARE_KINDS.has(node.task_kind) && !slots.some((slot) => slot.source === 'repository_workspace'))
    slots.push({
      key: uniqueSlotKey(slots, 'repository_snapshot'),
      kind: 'repository',
      required: true,
      source: 'repository_workspace',
      selector: 'fixed_sha',
      ref_id: null,
      version_id: null,
      consumption_policy: 'must_acknowledge'
    });
  return slots;
}
function normalizeOutputs(source, acceptance, node) {
  const policy = HUMAN_CONFIRM_KINDS.has(node.task_kind) ? 'human' : 'system_evidence';
  const slots =
    Array.isArray(source) && source.length
      ? source.map((slot, index) => ({
          key: clean(slot?.key || `output_${index + 1}`, 120),
          kind: clean(slot?.kind || 'asset', 80),
          required: slot?.required !== false,
          asset_type: clean(slot?.asset_type || assetType(node), 120),
          acceptance_criteria: unique(slot?.acceptance_criteria?.length ? slot.acceptance_criteria : acceptance),
          confirmation_policy: clean(slot?.confirmation_policy || policy, 80),
          handoff: slot?.handoff !== false,
          consumer_hint: clean(slot?.consumer_hint, 200) || null,
          purpose: clean(slot?.purpose, 500) || null
        }))
      : [
          {
            key: `${node.task_kind || 'task'}_result`,
            kind: 'asset',
            required: true,
            asset_type: assetType(node),
            acceptance_criteria: [...acceptance],
            confirmation_policy: policy,
            handoff: true,
            consumer_hint: null,
            purpose: null
          }
        ];
  const covered = new Set(slots.flatMap((slot) => slot.acceptance_criteria));
  slots[0].acceptance_criteria = unique([
    ...slots[0].acceptance_criteria,
    ...acceptance.filter((criterion) => !covered.has(criterion))
  ]);
  return slots;
}
function validateDependencySelectors(task, dependency, bindings, errors) {
  const outputs = dependency?.output_slots || [],
    requiredOutputs = outputs.filter((slot) => slot.required !== false);
  for (const binding of bindings) {
    if (binding.selector === 'required_outputs') {
      if (requiredOutputs.length !== 1)
        errors.push(
          issue('workflow_task_dependency_output_selector_required', task.id, {
            dependency_id: dependency?.id,
            slot_key: binding.key,
            output_keys: requiredOutputs.map((slot) => slot.key)
          })
        );
      continue;
    }
    const exact = outputs.some((slot) => slot.key === binding.selector);
    if (outputs.length > 1 && !exact)
      errors.push(
        issue('workflow_task_dependency_output_selector_required', task.id, {
          dependency_id: dependency?.id,
          slot_key: binding.key,
          output_keys: outputs.map((slot) => slot.key)
        })
      );
    else if (outputs.length && !exact)
      errors.push(
        issue('workflow_task_dependency_output_selector_invalid', task.id, {
          dependency_id: dependency?.id,
          slot_key: binding.key,
          selector: binding.selector
        })
      );
  }
}
function inferredTags(node) {
  return (
    {
      research: ['research_evidence'],
      analysis: ['constraint_analysis'],
      design: ['solution_decision'],
      content: ['execution'],
      code: ['execution'],
      test: ['acceptance'],
      review: ['acceptance'],
      deploy: ['integration_delivery'],
      integration: ['integration_delivery'],
      manual: ['execution']
    }[node.task_kind] || ['execution']
  );
}
function assetType(node) {
  return (
    {
      research: 'ResearchEvidenceAsset',
      analysis: 'DecisionAsset',
      design: 'DesignAsset',
      code: 'CodeChangeAsset',
      test: 'TestEvidenceAsset',
      review: 'AcceptanceAsset',
      deploy: 'DeliveryEvidenceAsset',
      integration: 'DeliveryEvidenceAsset'
    }[node.task_kind] || 'ResultAsset'
  );
}
function validateBriefCoverage(brief, coverage, taskIds, errors) {
  const required = requiredBriefKeys(brief),
    normalized = normalizeCoverage(coverage);
  for (const key of required) {
    const ids = normalized[key] || [];
    if (!ids.length) errors.push(issue('workflow_brief_coverage_missing', null, { brief_key: key }));
    for (const taskId of ids)
      if (!taskIds.has(taskId)) errors.push(issue('workflow_brief_coverage_task_invalid', taskId, { brief_key: key }));
  }
}
function requiredBriefKeys(brief) {
  const derived = brief?.content?.derived || brief?.content || {};
  return [
    ['features', derived.features],
    ['acceptance_criteria', derived.acceptance_criteria],
    ['milestones', derived.milestones],
    ['risks', derived.risks]
  ]
    .filter(([, value]) => Array.isArray(value) && value.length)
    .map(([key]) => key);
}
function normalizeCoverage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, ids]) => [key, unique(ids)]));
}
function deps(node) {
  return unique(
    Array.isArray(node?.dependency_ids)
      ? node.dependency_ids
      : (node?.dependencies || []).map((item) => (typeof item === 'string' ? item : item?.node_id))
  );
}
function hasAny(values, options) {
  return options.some((item) => values.has(item));
}
function issue(code, nodeId, detail = {}) {
  return { code, ...(nodeId ? { node_id: nodeId } : {}), ...detail };
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
