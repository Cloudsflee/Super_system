import { id } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';

export const WORKFLOW_NODE_ROLES = Object.freeze(['workstream', 'task']);
export const WORKSTREAM_CATEGORIES = Object.freeze(['deliverable', 'decision', 'coordination', 'operation']);
export const TASK_KINDS = Object.freeze(['research', 'analysis', 'design', 'content', 'code', 'test', 'review', 'deploy', 'manual', 'integration']);
export const EXECUTION_MODES = Object.freeze(['manual', 'assist', 'codex', 'integration']);
export const INITIAL_WORKSTREAM_LIMIT = 6;
export const FORMAL_WORKSTREAM_LIMIT = 12;
export const TASKS_PER_WORKSTREAM_LIMIT = 12;

const ROLE_SET = new Set(WORKFLOW_NODE_ROLES);
const CATEGORY_SET = new Set(WORKSTREAM_CATEGORIES);
const TASK_KIND_SET = new Set(TASK_KINDS);
const EXECUTION_MODE_SET = new Set(EXECUTION_MODES);
const PROCESS_STAGE_TITLES = new Set([
  '\u9700\u6c42\u5206\u6790', '\u8bbe\u8ba1', '\u7f16\u7801', '\u6d4b\u8bd5', '\u590d\u76d8', '\u4e0a\u7ebf',
  'requirements', 'requirements analysis', 'analysis', 'design', 'coding', 'implementation', 'testing', 'review', 'retrospective', 'deployment', 'launch'
]);
const BOUNDARY_KEYS = Object.freeze([
  'owner', 'owner_id', 'permissions', 'permission_boundary', 'repository', 'repository_id', 'repository_target_ids',
  'external_dependency', 'external_dependencies', 'deliverable', 'deliverables', 'delivery_boundary'
]);

export function normalizeWorkflowHierarchyNodes(source, { idFactory = id, strict = false } = {}) {
  const flat = flattenHierarchySource(source, idFactory, strict);
  const normalized = flat.map((raw, index) => normalizeNode(raw, index, idFactory, strict));
  for (const node of normalized) {
    node.dependency_ids = uniqueStrings(node.dependency_ids);
  }
  const workstreamOrder = new Map();
  for (const node of normalized.filter((item) => item.role === 'workstream').sort(orderNodes)) workstreamOrder.set(node.id, workstreamOrder.size);
  const taskOrders = new Map();
  return normalized
    .sort((left, right) => hierarchySort(left, right, workstreamOrder))
    .map((node) => {
      if (node.role === 'workstream') return { ...node, order_index: workstreamOrder.get(node.id) ?? node.order_index };
      const order = taskOrders.get(node.parent_node_id) || 0;
      taskOrders.set(node.parent_node_id, order + 1);
      return { ...node, order_index: order };
    });
}

export function assertWorkflowHierarchy(nodes, { mode = 'formal', allowLegacy = false, requireTasks = true } = {}) {
  if (!Array.isArray(nodes)) throw validationError('workflow_hierarchy_nodes_required');
  const ids = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw validationError('workflow_hierarchy_node_invalid');
    if (!clean(node.id, 120) || ids.has(node.id)) throw validationError('workflow_hierarchy_node_id_invalid', { node_id: node.id || null });
    ids.add(node.id);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const workstreams = nodes.filter((node) => node.role === 'workstream');
  const limit = mode === 'initial' ? INITIAL_WORKSTREAM_LIMIT : FORMAL_WORKSTREAM_LIMIT;
  if (workstreams.length < 1 || workstreams.length > limit) throw validationError('workflow_workstream_count_invalid', { min: 1, max: limit, count: workstreams.length });

  for (const node of nodes) {
    if (allowLegacy && node.legacy_read_only && !ROLE_SET.has(node.role)) continue;
    if (!ROLE_SET.has(node.role)) throw validationError('workflow_node_role_invalid', { node_id: node.id, role: node.role || null });
    if (node.role === 'workstream') validateWorkstream(node);
    else validateTask(node, byId, allowLegacy);
  }

  for (const workstream of workstreams) {
    const tasks = nodes.filter((node) => node.role === 'task' && node.parent_node_id === workstream.id);
    if (requireTasks && !tasks.length) throw validationError('workflow_workstream_task_required', { workstream_id: workstream.id });
    if (tasks.length > TASKS_PER_WORKSTREAM_LIMIT) throw validationError('workflow_workstream_task_limit', { workstream_id: workstream.id, max: TASKS_PER_WORKSTREAM_LIMIT });
  }

  validateDependencies(nodes, byId, allowLegacy);
  validateDag(workstreams, 'workflow_top_level_cycle');
  for (const workstream of workstreams) validateDag(nodes.filter((node) => node.role === 'task' && node.parent_node_id === workstream.id), 'workflow_task_graph_cycle');
  return nodes;
}

export function normalizeWorkflowGenerationCandidate(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('workflow_generation_candidate_invalid');
  const nodes = normalizeWorkflowHierarchyNodes(value.workstreams || value.nodes || value.graph?.nodes || [], { ...options, strict: true });
  const candidate = {
    project_classification: required(value.project_classification || value.classification, 'workflow_generation_classification_required', 200),
    decomposition_basis: required(value.decomposition_basis || value.rationale, 'workflow_generation_basis_required', 4000),
    evidence_refs: normalizeEvidenceRefs(value.evidence_refs || value.brief_evidence || []),
    confidence: finiteConfidence(value.confidence),
    repository_intent: normalizeRepositoryIntent(value.repository_intent),
    nodes
  };
  assertWorkflowHierarchy(candidate.nodes, { mode: 'initial' });
  if (!candidate.evidence_refs.length) throw validationError('workflow_generation_evidence_required');
  return candidate;
}

export function critiqueWorkflowGenerationCandidate(candidate, { minimumConfidence = 0 } = {}) {
  const errors = [];
  try { assertWorkflowHierarchy(candidate?.nodes, { mode: 'initial' }); }
  catch (error) { errors.push({ code: error.code || error.payload?.error || 'workflow_generation_candidate_invalid', details: error.details || error.payload || {} }); }
  if (!candidate?.project_classification) errors.push({ code: 'workflow_generation_classification_required' });
  if (!candidate?.decomposition_basis) errors.push({ code: 'workflow_generation_basis_required' });
  if (!Array.isArray(candidate?.evidence_refs) || !candidate.evidence_refs.length) errors.push({ code: 'workflow_generation_evidence_required' });
  if (!Number.isFinite(candidate?.confidence) || candidate.confidence < minimumConfidence) errors.push({ code: 'workflow_generation_confidence_low', minimum_confidence: minimumConfidence, confidence: candidate?.confidence ?? null });
  for (const node of candidate?.nodes || []) if (node.role === 'workstream' && isProcessStageTitle(node.title)) errors.push({ code: 'workflow_workstream_process_stage_forbidden', node_id: node.id, title: node.title });
  return { ok: errors.length === 0, errors };
}

export function isProcessStageTitle(value) {
  const normalized = clean(value, 200).replace(/[\s_\-/]+/g, ' ').toLowerCase();
  const withoutStageSuffix = normalized.replace(/(?:阶段工作|工作阶段|阶段|环节)$/u, '').replace(/\s+(?:phase|stage)$/u, '').trim();
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
  for (const item of source) {
    if (strict && !ROLE_SET.has(item?.role)) throw validationError('workflow_node_role_invalid', { role: item?.role || null });
    const role = item?.role || (Array.isArray(item?.tasks) ? 'workstream' : null);
    if (role === 'workstream') {
      if (item?.parent_node_id != null) throw validationError('workflow_workstream_parent_forbidden', { node_id: item.id || null });
      const parentId = clean(item.id, 120) || idFactory('wfs');
      result.push({ ...item, id: parentId, role: 'workstream', parent_node_id: null });
      for (const task of Array.isArray(item.tasks) ? item.tasks : []) {
        if (Array.isArray(task?.tasks) && task.tasks.length || Array.isArray(task?.children) && task.children.length) throw validationError('workflow_hierarchy_depth_exceeded', { parent_node_id: parentId, node_id: task?.id || null, max_depth: 2 });
        if (strict && task?.role !== 'task') throw validationError('workflow_node_role_invalid', { role: task?.role || null, node_id: task?.id || null });
        result.push({ ...task, role: 'task', parent_node_id: parentId });
      }
    } else result.push(item);
  }
  return result;
}

function normalizeNode(raw = {}, index, idFactory, strict) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validationError('workflow_hierarchy_node_invalid');
  if (strict && !ROLE_SET.has(raw.role)) throw validationError('workflow_node_role_invalid', { role: raw.role || null, node_id: raw.id || null });
  const role = ROLE_SET.has(raw.role) ? raw.role : raw.parent_node_id ? 'task' : 'workstream';
  const nodeId = clean(raw.id, 120) || idFactory(role === 'workstream' ? 'wfs' : 'tsk');
  if (strict && role === 'workstream' && !CATEGORY_SET.has(raw.category)) throw validationError('workflow_workstream_category_invalid', { node_id: nodeId, category: raw.category || null });
  if (strict && role === 'task' && !TASK_KIND_SET.has(raw.task_kind || raw.kind)) throw validationError('workflow_task_kind_invalid', { node_id: nodeId, task_kind: raw.task_kind || raw.kind || null });
  if (strict && role === 'task' && !EXECUTION_MODE_SET.has(raw.execution_mode)) throw validationError('workflow_task_execution_mode_invalid', { node_id: nodeId, execution_mode: raw.execution_mode || null });
  const taskKind = role === 'task' && TASK_KIND_SET.has(raw.task_kind || raw.kind) ? raw.task_kind || raw.kind : role === 'task' ? inferTaskKind(raw.type) : null;
  const category = role === 'workstream' && CATEGORY_SET.has(raw.category) ? raw.category : role === 'workstream' ? 'deliverable' : null;
  const title = required(raw.title || raw.label, 'workflow_node_title_required', 160);
  const { tasks: _tasks, children: _children, ...record } = raw;
  return {
    ...record,
    id: nodeId,
    role,
    parent_node_id: clean(raw.parent_node_id, 120) || null,
    title,
    goal: clean(raw.goal || raw.outcome || title, 4000),
    outcome: role === 'workstream' ? clean(raw.outcome || raw.goal, 4000) : null,
    category,
    task_kind: taskKind,
    execution_mode: EXECUTION_MODE_SET.has(raw.execution_mode) ? raw.execution_mode : defaultExecutionMode(taskKind),
    boundary: role === 'workstream' ? normalizeBoundary(raw.boundary) : null,
    acceptance_criteria: uniqueStrings(raw.acceptance_criteria).slice(0, 50),
    dependency_ids: dependencyIds(raw),
    repository_intent: raw.repository_intent && typeof raw.repository_intent === 'object' ? structuredClone(raw.repository_intent) : null,
    position: validPosition(raw.position, index),
    order_index: Number.isInteger(raw.order_index) ? raw.order_index : Number.isInteger(raw.order) ? raw.order : index,
    plan_revision: role === 'workstream' ? Math.max(1, Number(raw.plan_revision) || 1) : null,
    type: role === 'task' ? legacyNodeTypeForTaskKind(taskKind) : 'execution'
  };
}

function validateWorkstream(node) {
  if (node.parent_node_id != null) throw validationError('workflow_workstream_parent_forbidden', { node_id: node.id });
  if (!CATEGORY_SET.has(node.category)) throw validationError('workflow_workstream_category_invalid', { node_id: node.id, category: node.category || null });
  if (!clean(node.outcome, 4000)) throw validationError('workflow_workstream_outcome_required', { node_id: node.id });
  if (!Array.isArray(node.acceptance_criteria) || !node.acceptance_criteria.some((item) => clean(item, 2000))) throw validationError('workflow_workstream_acceptance_required', { node_id: node.id });
  if (!hasIndependentBoundary(node.boundary)) throw validationError('workflow_workstream_boundary_required', { node_id: node.id });
  if (isProcessStageTitle(node.title)) throw validationError('workflow_workstream_process_stage_forbidden', { node_id: node.id, title: node.title });
  if (!Number.isInteger(node.plan_revision) || node.plan_revision < 1) throw validationError('workflow_workstream_plan_revision_invalid', { node_id: node.id });
}

function validateTask(node, byId, allowLegacy) {
  const parent = byId.get(node.parent_node_id);
  if (!parent) {
    if (allowLegacy && node.legacy_read_only) return;
    throw validationError('workflow_task_parent_required', { node_id: node.id, parent_node_id: node.parent_node_id || null });
  }
  if (parent.role !== 'workstream') throw validationError('workflow_task_parent_invalid', { node_id: node.id, parent_node_id: parent.id });
  if (!TASK_KIND_SET.has(node.task_kind)) throw validationError('workflow_task_kind_invalid', { node_id: node.id, task_kind: node.task_kind || null });
  if (!EXECUTION_MODE_SET.has(node.execution_mode)) throw validationError('workflow_task_execution_mode_invalid', { node_id: node.id, execution_mode: node.execution_mode || null });
}

function validateDependencies(nodes, byId, allowLegacy) {
  for (const node of nodes) {
    const seen = new Set();
    for (const dependencyId of dependencyIds(node)) {
      const dependency = byId.get(dependencyId);
      if (!dependency) throw validationError('workflow_graph_dependency_not_found', { node_id: node.id, dependency_id: dependencyId });
      if (dependencyId === node.id) throw validationError('workflow_graph_self_dependency', { node_id: node.id });
      if (seen.has(dependencyId)) throw validationError('workflow_graph_dependency_duplicate', { node_id: node.id, dependency_id: dependencyId });
      seen.add(dependencyId);
      if (allowLegacy && (node.legacy_read_only || dependency.legacy_read_only)) continue;
      if (node.role === 'workstream' && dependency.role !== 'workstream') throw validationError('workflow_top_level_dependency_scope_invalid', { node_id: node.id, dependency_id: dependencyId });
      if (node.role === 'task' && (dependency.role !== 'task' || dependency.parent_node_id !== node.parent_node_id)) throw validationError('workflow_task_dependency_scope_invalid', { node_id: node.id, dependency_id: dependencyId, parent_node_id: node.parent_node_id });
    }
  }
}

function validateDag(nodes, code) {
  const byId = new Map(nodes.map((node) => [node.id, node])), visiting = new Set(), visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw validationError(code);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependencyId of dependencyIds(byId.get(nodeId))) if (byId.has(dependencyId)) visit(dependencyId);
    visiting.delete(nodeId); visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
}

function hierarchySort(left, right, workstreamOrder) {
  const leftRoot = left.role === 'workstream' ? left.id : left.parent_node_id;
  const rightRoot = right.role === 'workstream' ? right.id : right.parent_node_id;
  const rootDiff = (workstreamOrder.get(leftRoot) ?? 10000) - (workstreamOrder.get(rightRoot) ?? 10000);
  if (rootDiff) return rootDiff;
  if (left.role !== right.role) return left.role === 'workstream' ? -1 : 1;
  return orderNodes(left, right);
}

function orderNodes(left, right) { return Number(left.order_index || left.order || 0) - Number(right.order_index || right.order || 0); }
function dependencyIds(node) { return uniqueStrings(Array.isArray(node?.dependency_ids) ? node.dependency_ids : (node?.dependencies || []).map((item) => typeof item === 'string' ? item : item?.node_id)); }
function inferTaskKind(type) { return TASK_KIND_SET.has(type) ? type : ({ goal_definition: 'analysis', execution: 'code', retrospective: 'review' })[type] || 'manual'; }
function defaultExecutionMode(taskKind) { return ['code', 'test', 'deploy'].includes(taskKind) ? 'codex' : taskKind === 'integration' ? 'integration' : taskKind === 'manual' ? 'manual' : 'assist'; }
function normalizeBoundary(value) { return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {}; }
function hasIndependentBoundary(value) { return value && typeof value === 'object' && BOUNDARY_KEYS.some((key) => nonEmpty(value[key])); }
function nonEmpty(value) { return Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(clean(value, 2000)); }
function normalizeEvidenceRefs(value) { return (Array.isArray(value) ? value : []).slice(0, 100).map((item) => typeof item === 'string' ? { section_id: clean(item, 200), quote: '' } : { section_id: clean(item?.section_id || item?.brief_section_id, 200), quote: clean(item?.quote || item?.evidence, 2000) }).filter((item) => item.section_id); }
function normalizeRepositoryIntent(value) { if (value == null) return []; if (Array.isArray(value)) return structuredClone(value).slice(0, 50); if (typeof value === 'object') return structuredClone(value); throw validationError('workflow_generation_repository_intent_invalid'); }
function finiteConfidence(value) { const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) throw validationError('workflow_generation_confidence_invalid'); return number; }
function uniqueStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 2000)).filter(Boolean))]; }
function validPosition(value, index) { const x = Number(value?.x), y = Number(value?.y); return { x: Number.isFinite(x) ? Math.max(-10000, Math.min(10000, x)) : 100 + (index % 3) * 300, y: Number.isFinite(y) ? Math.max(-10000, Math.min(10000, y)) : 120 + Math.floor(index / 3) * 220 }; }
function required(value, code, max) { const result = clean(value, max); if (!result) throw validationError(code); return result; }
function clean(value, max = 120) { return String(value ?? '').replace(/\0/g, '').trim().slice(0, max); }
function validationError(code, details = {}) { const error = new HttpError(409, { error: code, ...details }); error.code = code; error.details = details; return error; }
