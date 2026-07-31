import { cloneStateValue as structuredClone } from './state-clone.mjs';
import { id } from '../../../packages/shared/index.mjs';
import { normalizeWorkflowPlanningFields } from './workflow-quality.mjs';
import {
  clean,
  defaultExecutionMode,
  dependencyIds,
  finiteConfidence,
  hasIndependentBoundary,
  hierarchySort,
  inferTaskKind,
  normalizeBoundary,
  normalizeBriefCoverage,
  normalizeEvidenceRefs,
  normalizeRepositoryIntent,
  orderNodes,
  required,
  uniqueStrings,
  validationError,
  validPosition
} from './workflow-hierarchy-utilities.mjs';

export const WORKFLOW_NODE_ROLES = Object.freeze(['workstream', 'task']);
export const WORKSTREAM_CATEGORIES = Object.freeze(['deliverable', 'decision', 'coordination', 'operation']);
export const TASK_KINDS = Object.freeze([
  'research',
  'analysis',
  'design',
  'content',
  'code',
  'test',
  'review',
  'deploy',
  'manual',
  'integration'
]);
export const EXECUTION_MODES = Object.freeze(['manual', 'assist', 'codex', 'integration']);
export const INITIAL_WORKSTREAM_LIMIT = 6;
export const FORMAL_WORKSTREAM_LIMIT = 12;
export const TASKS_PER_WORKSTREAM_LIMIT = 12;

const ROLE_SET = new Set(WORKFLOW_NODE_ROLES);
const CATEGORY_SET = new Set(WORKSTREAM_CATEGORIES);
const TASK_KIND_SET = new Set(TASK_KINDS);
const EXECUTION_MODE_SET = new Set(EXECUTION_MODES);
const PROCESS_STAGE_TITLES = new Set([
  '\u9700\u6c42\u5206\u6790',
  '\u8bbe\u8ba1',
  '\u7f16\u7801',
  '\u6d4b\u8bd5',
  '\u590d\u76d8',
  '\u4e0a\u7ebf',
  'requirements',
  'requirements analysis',
  'analysis',
  'design',
  'coding',
  'implementation',
  'testing',
  'review',
  'retrospective',
  'deployment',
  'launch'
]);
export function normalizeWorkflowHierarchyNodes(source, { idFactory = id, strict = false } = {}) {
  const flat = flattenHierarchySource(source, idFactory, strict);
  const normalized = flat.map((raw, index) => normalizeNode(raw, index, idFactory, strict));
  for (const node of normalized) {
    node.dependency_ids = uniqueStrings(node.dependency_ids);
  }
  const workstreamOrder = new Map();
  for (const node of normalized.filter((item) => item.role === 'workstream').sort(orderNodes))
    workstreamOrder.set(node.id, workstreamOrder.size);
  const taskOrders = new Map();
  return normalizeWorkflowPlanningFields(
    normalized
      .sort((left, right) => hierarchySort(left, right, workstreamOrder))
      .map((node) => {
        if (node.role === 'workstream')
          return { ...node, order_index: workstreamOrder.get(node.id) ?? node.order_index };
        const order = taskOrders.get(node.parent_node_id) || 0;
        taskOrders.set(node.parent_node_id, order + 1);
        return { ...node, order_index: order };
      })
  );
}

export function assertWorkflowHierarchy(nodes, { mode = 'formal', allowLegacy = false, requireTasks = true } = {}) {
  if (!Array.isArray(nodes)) throw validationError('workflow_hierarchy_nodes_required');
  assertHierarchyNodeIds(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const workstreams = nodes.filter((node) => node.role === 'workstream');
  assertWorkstreamCount(workstreams, mode);
  validateHierarchyNodes(nodes, byId, allowLegacy);
  validateWorkstreamTaskCounts(nodes, workstreams, requireTasks);
  validateDependencies(nodes, byId, allowLegacy);
  validateHierarchyDags(nodes, workstreams);
  return nodes;
}

function assertHierarchyNodeIds(nodes) {
  const ids = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node))
      throw validationError('workflow_hierarchy_node_invalid');
    if (!clean(node.id, 120) || ids.has(node.id))
      throw validationError('workflow_hierarchy_node_id_invalid', { node_id: node.id || null });
    ids.add(node.id);
  }
}

function assertWorkstreamCount(workstreams, mode) {
  const limit = mode === 'initial' ? INITIAL_WORKSTREAM_LIMIT : FORMAL_WORKSTREAM_LIMIT;
  if (workstreams.length < 1 || workstreams.length > limit)
    throw validationError('workflow_workstream_count_invalid', { min: 1, max: limit, count: workstreams.length });
}

function validateHierarchyNodes(nodes, byId, allowLegacy) {
  for (const node of nodes) {
    if (allowLegacy && node.legacy_read_only && !ROLE_SET.has(node.role)) continue;
    if (!ROLE_SET.has(node.role))
      throw validationError('workflow_node_role_invalid', { node_id: node.id, role: node.role || null });
    if (node.role === 'workstream') validateWorkstream(node);
    else validateTask(node, byId, allowLegacy);
  }
}

function validateWorkstreamTaskCounts(nodes, workstreams, requireTasks) {
  for (const workstream of workstreams) {
    const tasks = nodes.filter((node) => node.role === 'task' && node.parent_node_id === workstream.id);
    if (requireTasks && !tasks.length)
      throw validationError('workflow_workstream_task_required', { workstream_id: workstream.id });
    if (tasks.length > TASKS_PER_WORKSTREAM_LIMIT)
      throw validationError('workflow_workstream_task_limit', {
        workstream_id: workstream.id,
        max: TASKS_PER_WORKSTREAM_LIMIT
      });
  }
}

function validateHierarchyDags(nodes, workstreams) {
  validateDag(workstreams, 'workflow_top_level_cycle');
  for (const workstream of workstreams)
    validateDag(
      nodes.filter((node) => node.role === 'task' && node.parent_node_id === workstream.id),
      'workflow_task_graph_cycle'
    );
}

export function normalizeWorkflowGenerationCandidate(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw validationError('workflow_generation_candidate_invalid');
  const nodes = normalizeWorkflowHierarchyNodes(value.workstreams || value.nodes || value.graph?.nodes || [], {
    ...options,
    strict: true
  });
  const candidate = {
    project_classification: required(
      value.project_classification || value.classification,
      'workflow_generation_classification_required',
      200
    ),
    decomposition_basis: required(
      value.decomposition_basis || value.rationale,
      'workflow_generation_basis_required',
      4000
    ),
    evidence_refs: normalizeEvidenceRefs(value.evidence_refs || value.brief_evidence || []),
    confidence: finiteConfidence(value.confidence),
    repository_intent: normalizeRepositoryIntent(value.repository_intent),
    brief_coverage: normalizeBriefCoverage(value.brief_coverage),
    nodes
  };
  assertWorkflowHierarchy(candidate.nodes, { mode: 'initial' });
  if (!candidate.evidence_refs.length) throw validationError('workflow_generation_evidence_required');
  return candidate;
}

export function critiqueWorkflowGenerationCandidate(candidate, { minimumConfidence = 0 } = {}) {
  const errors = [];
  critiqueCandidateHierarchy(candidate, errors);
  critiqueCandidateMetadata(candidate, minimumConfidence, errors);
  critiqueProcessStageTitles(candidate, errors);
  return { ok: errors.length === 0, errors };
}

function critiqueCandidateHierarchy(candidate, errors) {
  try {
    assertWorkflowHierarchy(candidate?.nodes, { mode: 'initial' });
  } catch (error) {
    errors.push({
      code: error.code || error.payload?.error || 'workflow_generation_candidate_invalid',
      details: error.details || error.payload || {}
    });
  }
}

function critiqueCandidateMetadata(candidate, minimumConfidence, errors) {
  if (!candidate?.project_classification) errors.push({ code: 'workflow_generation_classification_required' });
  if (!candidate?.decomposition_basis) errors.push({ code: 'workflow_generation_basis_required' });
  if (!Array.isArray(candidate?.evidence_refs) || !candidate.evidence_refs.length)
    errors.push({ code: 'workflow_generation_evidence_required' });
  if (!Number.isFinite(candidate?.confidence) || candidate.confidence < minimumConfidence)
    errors.push({
      code: 'workflow_generation_confidence_low',
      minimum_confidence: minimumConfidence,
      confidence: candidate?.confidence ?? null
    });
}

function critiqueProcessStageTitles(candidate, errors) {
  for (const node of candidate?.nodes || [])
    if (node.role === 'workstream' && isProcessStageTitle(node.title))
      errors.push({ code: 'workflow_workstream_process_stage_forbidden', node_id: node.id, title: node.title });
}

export function isProcessStageTitle(value) {
  const normalized = clean(value, 200)
    .replace(/[\s_\-/]+/g, ' ')
    .toLowerCase();
  const withoutStageSuffix = normalized
    .replace(/(?:阶段工作|工作阶段|阶段|环节)$/u, '')
    .replace(/\s+(?:phase|stage)$/u, '')
    .trim();
  return PROCESS_STAGE_TITLES.has(normalized) || PROCESS_STAGE_TITLES.has(withoutStageSuffix);
}

export function legacyNodeTypeForTaskKind(taskKind) {
  if (taskKind === 'research') return 'research';
  if (taskKind === 'analysis') return 'analysis';
  if (taskKind === 'review') return 'retrospective';
  return 'execution';
}

function flattenHierarchySource(source, idFactory, strict) {
  if (!Array.isArray(source)) return [];
  const result = [];
  for (const item of source) result.push(...flattenHierarchyItem(item, idFactory, strict));
  return result;
}

function flattenHierarchyItem(item, idFactory, strict) {
  assertHierarchySourceRole(item, strict);
  const role = hierarchySourceRole(item);
  if (role !== 'workstream') return [item];
  assertWorkstreamSourceRoot(item);
  const parentId = clean(item.id, 120) || idFactory('wfs');
  const result = [{ ...item, id: parentId, role: 'workstream', parent_node_id: null }];
  for (const task of hierarchySourceTasks(item)) {
    assertNestedTask(task, parentId, strict);
    result.push({ ...task, role: 'task', parent_node_id: parentId });
  }
  return result;
}

function assertHierarchySourceRole(item, strict) {
  if (strict && !ROLE_SET.has(item?.role))
    throw validationError('workflow_node_role_invalid', { role: item?.role || null });
}

function hierarchySourceRole(item) {
  if (item?.role) return item.role;
  return Array.isArray(item?.tasks) ? 'workstream' : null;
}

function assertWorkstreamSourceRoot(item) {
  if (item?.parent_node_id != null)
    throw validationError('workflow_workstream_parent_forbidden', { node_id: item.id || null });
}

function hierarchySourceTasks(item) {
  return Array.isArray(item.tasks) ? item.tasks : [];
}

function assertNestedTask(task, parentId, strict) {
  if (hasNestedTasks(task))
    throw validationError('workflow_hierarchy_depth_exceeded', {
      parent_node_id: parentId,
      node_id: task?.id || null,
      max_depth: 2
    });
  if (strict && task?.role !== 'task')
    throw validationError('workflow_node_role_invalid', { role: task?.role || null, node_id: task?.id || null });
}

function hasNestedTasks(task) {
  return nonEmptyArray(task?.tasks) || nonEmptyArray(task?.children);
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function normalizeNode(raw = {}, index, idFactory, strict) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validationError('workflow_hierarchy_node_invalid');
  if (strict && !ROLE_SET.has(raw.role))
    throw validationError('workflow_node_role_invalid', { role: raw.role || null, node_id: raw.id || null });
  const role = normalizedNodeRole(raw);
  const nodeId = normalizedNodeId(raw, role, idFactory);
  assertStrictNodeFields(raw, role, nodeId, strict);
  const taskKind = normalizeTaskKind(raw, role);
  const category = normalizeWorkstreamCategory(raw, role);
  const title = required(raw.title || raw.label, 'workflow_node_title_required', 160);
  const { tasks: _tasks, children: _children, ...record } = raw;
  return {
    ...record,
    id: nodeId,
    role,
    parent_node_id: normalizedParentNodeId(raw),
    title,
    goal: normalizedNodeGoal(raw, title),
    outcome: normalizedNodeOutcome(raw, role),
    category,
    task_kind: taskKind,
    execution_mode: normalizedExecutionMode(raw, taskKind),
    boundary: normalizedNodeBoundary(raw, role),
    acceptance_criteria: uniqueStrings(raw.acceptance_criteria).slice(0, 50),
    capability_tags: taskCapabilityTags(raw, role),
    input_slots: taskSlots(raw.input_slots, role),
    output_slots: taskSlots(raw.output_slots, role),
    atomic_justification: normalizedAtomicJustification(raw, role),
    dependency_ids: dependencyIds(raw),
    repository_intent: normalizeNodeRepositoryIntent(raw.repository_intent),
    position: validPosition(raw.position, index),
    order_index: normalizedOrderIndex(raw, index),
    plan_revision: normalizedPlanRevision(raw, role),
    type: normalizedLegacyNodeType(role, taskKind)
  };
}

function normalizedNodeRole(raw) {
  if (ROLE_SET.has(raw.role)) return raw.role;
  return raw.parent_node_id ? 'task' : 'workstream';
}

function normalizedNodeId(raw, role, idFactory) {
  return clean(raw.id, 120) || idFactory(role === 'workstream' ? 'wfs' : 'tsk');
}

function normalizedParentNodeId(raw) {
  return clean(raw.parent_node_id, 120) || null;
}

function normalizedNodeGoal(raw, title) {
  return clean(raw.goal || raw.outcome || title, 4000);
}

function normalizedNodeOutcome(raw, role) {
  return role === 'workstream' ? clean(raw.outcome || raw.goal, 4000) : null;
}

function normalizedExecutionMode(raw, taskKind) {
  return EXECUTION_MODE_SET.has(raw.execution_mode) ? raw.execution_mode : defaultExecutionMode(taskKind);
}

function normalizedNodeBoundary(raw, role) {
  return role === 'workstream' ? normalizeBoundary(raw.boundary) : null;
}

function normalizedAtomicJustification(raw, role) {
  return role === 'task' ? clean(raw.atomic_justification, 2000) || null : null;
}

function normalizedPlanRevision(raw, role) {
  return role === 'workstream' ? Math.max(1, Number(raw.plan_revision) || 1) : null;
}

function normalizedLegacyNodeType(role, taskKind) {
  return role === 'task' ? legacyNodeTypeForTaskKind(taskKind) : 'execution';
}

function assertStrictNodeFields(raw, role, nodeId, strict) {
  if (!strict) return;
  if (role === 'workstream' && !CATEGORY_SET.has(raw.category))
    throw validationError('workflow_workstream_category_invalid', {
      node_id: nodeId,
      category: raw.category || null
    });
  if (role === 'task' && !TASK_KIND_SET.has(raw.task_kind || raw.kind))
    throw validationError('workflow_task_kind_invalid', {
      node_id: nodeId,
      task_kind: raw.task_kind || raw.kind || null
    });
  if (role === 'task' && !EXECUTION_MODE_SET.has(raw.execution_mode))
    throw validationError('workflow_task_execution_mode_invalid', {
      node_id: nodeId,
      execution_mode: raw.execution_mode || null
    });
}

function normalizeTaskKind(raw, role) {
  if (role !== 'task') return null;
  return TASK_KIND_SET.has(raw.task_kind || raw.kind) ? raw.task_kind || raw.kind : inferTaskKind(raw.type);
}

function normalizeWorkstreamCategory(raw, role) {
  if (role !== 'workstream') return null;
  return CATEGORY_SET.has(raw.category) ? raw.category : 'deliverable';
}

function taskCapabilityTags(raw, role) {
  return role === 'task' ? uniqueStrings(raw.capability_tags).slice(0, 20) : [];
}

function taskSlots(value, role) {
  return role === 'task' && Array.isArray(value) ? structuredClone(value).slice(0, 50) : [];
}

function normalizeNodeRepositoryIntent(value) {
  return value && typeof value === 'object' ? structuredClone(value) : null;
}

function normalizedOrderIndex(raw, index) {
  if (Number.isInteger(raw.order_index)) return raw.order_index;
  return Number.isInteger(raw.order) ? raw.order : index;
}

function validateWorkstream(node) {
  if (node.parent_node_id != null) throw validationError('workflow_workstream_parent_forbidden', { node_id: node.id });
  if (!CATEGORY_SET.has(node.category))
    throw validationError('workflow_workstream_category_invalid', {
      node_id: node.id,
      category: node.category || null
    });
  if (!clean(node.outcome, 4000)) throw validationError('workflow_workstream_outcome_required', { node_id: node.id });
  if (!Array.isArray(node.acceptance_criteria) || !node.acceptance_criteria.some((item) => clean(item, 2000)))
    throw validationError('workflow_workstream_acceptance_required', { node_id: node.id });
  if (!hasIndependentBoundary(node.boundary))
    throw validationError('workflow_workstream_boundary_required', { node_id: node.id });
  if (isProcessStageTitle(node.title))
    throw validationError('workflow_workstream_process_stage_forbidden', { node_id: node.id, title: node.title });
  if (!Number.isInteger(node.plan_revision) || node.plan_revision < 1)
    throw validationError('workflow_workstream_plan_revision_invalid', { node_id: node.id });
}

function validateTask(node, byId, allowLegacy) {
  const parent = byId.get(node.parent_node_id);
  if (!parent) {
    if (allowLegacy && node.legacy_read_only) return;
    throw validationError('workflow_task_parent_required', {
      node_id: node.id,
      parent_node_id: node.parent_node_id || null
    });
  }
  if (parent.role !== 'workstream')
    throw validationError('workflow_task_parent_invalid', { node_id: node.id, parent_node_id: parent.id });
  if (!TASK_KIND_SET.has(node.task_kind))
    throw validationError('workflow_task_kind_invalid', { node_id: node.id, task_kind: node.task_kind || null });
  if (!EXECUTION_MODE_SET.has(node.execution_mode))
    throw validationError('workflow_task_execution_mode_invalid', {
      node_id: node.id,
      execution_mode: node.execution_mode || null
    });
}

function validateDependencies(nodes, byId, allowLegacy) {
  for (const node of nodes) {
    const seen = new Set();
    for (const dependencyId of dependencyIds(node)) {
      const dependency = byId.get(dependencyId);
      if (!dependency)
        throw validationError('workflow_graph_dependency_not_found', { node_id: node.id, dependency_id: dependencyId });
      if (dependencyId === node.id) throw validationError('workflow_graph_self_dependency', { node_id: node.id });
      if (seen.has(dependencyId))
        throw validationError('workflow_graph_dependency_duplicate', { node_id: node.id, dependency_id: dependencyId });
      seen.add(dependencyId);
      if (allowLegacy && (node.legacy_read_only || dependency.legacy_read_only)) continue;
      if (node.role === 'workstream' && dependency.role !== 'workstream')
        throw validationError('workflow_top_level_dependency_scope_invalid', {
          node_id: node.id,
          dependency_id: dependencyId
        });
      if (node.role === 'task' && (dependency.role !== 'task' || dependency.parent_node_id !== node.parent_node_id))
        throw validationError('workflow_task_dependency_scope_invalid', {
          node_id: node.id,
          dependency_id: dependencyId,
          parent_node_id: node.parent_node_id
        });
    }
  }
}

function validateDag(nodes, code) {
  const byId = new Map(nodes.map((node) => [node.id, node])),
    visiting = new Set(),
    visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw validationError(code);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependencyId of dependencyIds(byId.get(nodeId))) if (byId.has(dependencyId)) visit(dependencyId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
}
