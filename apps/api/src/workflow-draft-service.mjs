import { HttpError } from './http.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { MAX_WORKFLOW_DRAFT_NODES } from './brief-workflow-domain.mjs';
import {
  assertWorkflowHierarchy, EXECUTION_MODES, FORMAL_WORKSTREAM_LIMIT,
  normalizeWorkflowHierarchyNodes, TASK_KINDS, WORKSTREAM_CATEGORIES
} from './workflow-hierarchy-domain.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';
import { assertWorkflowPlanningQuality } from './workflow-quality.mjs';

const CATEGORIES = new Set(WORKSTREAM_CATEGORIES);
const KINDS = new Set(TASK_KINDS);
const MODES = new Set(EXECUTION_MODES);

export function patchWorkflowDraftInState(state, projectId, body, actorId) {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  assertProjectLifecycleIdle(project);
  const draft = state.workflow_drafts.find((item) => item.project_id === projectId);
  if (!draft) throw new HttpError(404, { error: 'workflow_draft_not_found' });
  if (draft.status === 'activated') throw new HttpError(409, { error: 'workflow_draft_activated', action: 'create_change_proposal' });
  if (!Number.isInteger(body.expected_revision)) throw new HttpError(400, { error: 'expected_revision_required', current_revision: draft.revision });
  if (body.expected_revision !== draft.revision) throw new HttpError(409, { error: 'workflow_draft_revision_conflict', expected_revision: body.expected_revision, current_revision: draft.revision });

  let nodes = normalizeWorkflowHierarchyNodes(draft.nodes || []), briefCoverage = body.brief_coverage ?? draft.brief_coverage ?? {};
  if (Array.isArray(body.nodes)) {
    assertRawNodes(body.nodes);
    nodes = normalizeWorkflowHierarchyNodes(body.nodes);
  } else {
    if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 200) throw new HttpError(400, { error: 'workflow_draft_operations_required', max_operations: 200 });
    for (const operation of body.operations) nodes = applyOperation(nodes, operation);
  }
  validateDraft(nodes);
  if (Array.isArray(body.nodes)) {
    const brief = state.project_briefs.filter((item) => item.project_id === projectId && item.status !== 'superseded').sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
    const quality = assertWorkflowPlanningQuality({ nodes, project, brief, projectClassification: body.project_classification || draft.project_classification, briefCoverage });
    nodes = quality.nodes; briefCoverage = quality.brief_coverage;
  }
  const updatedAt = now();
  Object.assign(draft, {
    nodes, brief_coverage: structuredClone(briefCoverage), project_classification: clean(body.project_classification || draft.project_classification, 200) || null,
    revision: Number(draft.revision || 1) + 1, user_modified_at: updatedAt,
    updated_by_user_id: actorId, generation_status: draft.generation_status === 'running' ? 'running_user_modified' : draft.generation_status,
    updated_at: updatedAt
  });
  return draft;
}

function applyOperation(nodes, operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new HttpError(400, { error: 'workflow_draft_operation_invalid' });
  const type = operationType(operation), next = nodes.map(cloneNode);
  if (type === 'add_node') {
    if (next.length >= MAX_WORKFLOW_DRAFT_NODES) throw new HttpError(409, { error: 'workflow_draft_node_limit', max_nodes: MAX_WORKFLOW_DRAFT_NODES });
    const source = { ...(operation.node || {}) };
    if (operation.role) source.role = operation.role;
    if (operation.type === 'add_workstream') source.role = 'workstream';
    if (operation.type === 'add_task') { source.role = 'task'; source.parent_node_id ||= operation.parent_node_id; }
    source.id ||= id(source.role === 'task' ? 'tsk' : 'wfs');
    if (next.some((item) => item.id === source.id)) throw new HttpError(409, { error: 'workflow_draft_node_id_conflict', node_id: source.id });
    if (source.position == null) {
      const task = source.role === 'task' || Boolean(source.parent_node_id);
      const siblingIndex = next.filter((item) => task ? item.role === 'task' && item.parent_node_id === source.parent_node_id : item.role === 'workstream').length;
      source.position = defaultNodePosition(siblingIndex);
    }
    const normalized = normalizeWorkflowHierarchyNodes([source])[0];
    if (normalized.role === 'task' && !next.some((item) => item.id === normalized.parent_node_id && item.role === 'workstream')) throw new HttpError(404, { error: 'workflow_task_parent_required', parent_node_id: normalized.parent_node_id });
    next.push(normalized);
    return renormalize(next);
  }

  const nodeId = clean(operation.node_id || operation.id), index = next.findIndex((node) => node.id === nodeId);
  if (type === 'reorder_nodes') return reorder(next, operation.node_ids || operation.ids, operation.parent_node_id ?? null);
  if (index < 0) throw new HttpError(404, { error: 'workflow_draft_node_not_found', node_id: nodeId });
  if (type === 'update_node') {
    const patch = operation.patch || operation.node || {};
    if (patch.role !== undefined && patch.role !== next[index].role) throw new HttpError(409, { error: 'workflow_node_role_immutable', node_id: nodeId });
    if (patch.parent_node_id !== undefined && patch.parent_node_id !== next[index].parent_node_id) throw new HttpError(409, { error: 'workflow_node_parent_immutable', node_id: nodeId });
    next[index] = patchNode(next[index], patch);
  } else if (type === 'delete_node') {
    if (operation.confirmed !== true) throw new HttpError(409, { error: 'workflow_node_delete_confirmation_required', node_id: nodeId });
    const removed = new Set([nodeId]);
    if (next[index].role === 'workstream') for (const task of next.filter((item) => item.parent_node_id === nodeId)) removed.add(task.id);
    const retained = next.filter((item) => !removed.has(item.id));
    for (const node of retained) node.dependency_ids = node.dependency_ids.filter((item) => !removed.has(item));
    return renormalize(retained);
  } else if (type === 'move_node') {
    const siblings = next.filter((item) => item.role === next[index].role && item.parent_node_id === next[index].parent_node_id);
    const ordered = moveWithinSiblings(siblings, nodeId, targetIndex(operation, siblings.length));
    return replaceSiblingOrder(next, ordered);
  } else if (type === 'connect' || type === 'disconnect') {
    const dependencyId = clean(operation.dependency_id || operation.source_id);
    const dependency = next.find((node) => node.id === dependencyId);
    if (!dependency) throw new HttpError(404, { error: 'workflow_draft_dependency_not_found', dependency_id: dependencyId });
    assertSameGraphScope(next[index], dependency);
    next[index].dependency_ids = type === 'connect' ? [...new Set([...next[index].dependency_ids, dependencyId])] : next[index].dependency_ids.filter((item) => item !== dependencyId);
  } else throw new HttpError(400, { error: 'workflow_draft_operation_unsupported', operation: type });
  const normalized = renormalize(next); validateDraft(normalized); return normalized;
}

function patchNode(node, patch) {
  const next = { ...node };
  if (patch.title !== undefined) next.title = required(patch.title, 'workflow_node_title_required', 160);
  if (patch.goal !== undefined) next.goal = clean(patch.goal, 4000) || next.title;
  if (node.role === 'workstream') {
    if (patch.outcome !== undefined) next.outcome = required(patch.outcome, 'workflow_workstream_outcome_required', 4000);
    if (patch.category !== undefined) next.category = enumValue(patch.category, CATEGORIES, 'workflow_workstream_category_invalid');
    if (patch.boundary !== undefined) next.boundary = plainObject(patch.boundary, 'workflow_workstream_boundary_invalid');
    if (patch.acceptance_criteria !== undefined) next.acceptance_criteria = cleanList(patch.acceptance_criteria, 50, 2000);
  } else {
    if (patch.task_kind !== undefined) next.task_kind = enumValue(patch.task_kind, KINDS, 'workflow_task_kind_invalid');
    if (patch.execution_mode !== undefined) next.execution_mode = enumValue(patch.execution_mode, MODES, 'workflow_task_execution_mode_invalid');
    if (patch.required !== undefined) next.required = Boolean(patch.required);
    if (patch.repository_intent !== undefined) next.repository_intent = patch.repository_intent == null ? null : plainObject(patch.repository_intent, 'workflow_task_repository_intent_invalid');
    if (patch.acceptance_criteria !== undefined) next.acceptance_criteria = cleanList(patch.acceptance_criteria, 50, 2000);
    if (patch.capability_tags !== undefined) next.capability_tags = cleanList(patch.capability_tags, 20, 200);
    if (patch.input_slots !== undefined) next.input_slots = objectList(patch.input_slots, 'workflow_task_input_slots_invalid');
    if (patch.output_slots !== undefined) next.output_slots = objectList(patch.output_slots, 'workflow_task_output_slots_invalid');
    if (patch.atomic_justification !== undefined) next.atomic_justification = clean(patch.atomic_justification, 2000) || null;
  }
  if (patch.position !== undefined) next.position = validPosition(patch.position);
  return next;
}

function validateDraft(nodes) {
  if (!nodes.length) return nodes;
  if (nodes.length > MAX_WORKFLOW_DRAFT_NODES) throw new HttpError(409, { error: 'workflow_draft_node_limit', max_nodes: MAX_WORKFLOW_DRAFT_NODES });
  const workstreams = nodes.filter((item) => item.role === 'workstream');
  if (workstreams.length > FORMAL_WORKSTREAM_LIMIT) throw new HttpError(409, { error: 'workflow_workstream_count_invalid', max: FORMAL_WORKSTREAM_LIMIT });
  assertWorkflowHierarchy(nodes, { mode: 'formal', requireTasks: false });
  return nodes;
}

function assertRawNodes(source) {
  const flattened = [];
  for (const node of source) {
    flattened.push(node);
    if (Array.isArray(node?.tasks)) for (const task of node.tasks) flattened.push({ ...task, parent_node_id: node.id });
  }
  const ids = flattened.map((node) => clean(node?.id)).filter(Boolean);
  if (ids.length !== flattened.length || new Set(ids).size !== ids.length) throw new HttpError(409, { error: 'workflow_draft_node_id_duplicate' });
  const known = new Set(ids);
  for (const node of flattened) for (const dependencyId of dependencyIds(node)) {
    if (!known.has(dependencyId)) throw new HttpError(409, { error: 'workflow_draft_dependency_not_found', node_id: node.id, dependency_id: dependencyId });
    if (dependencyId === node.id) throw new HttpError(409, { error: 'workflow_draft_self_dependency', node_id: node.id });
  }
}

function reorder(nodes, ids, parentNodeId) {
  const role = parentNodeId ? 'task' : 'workstream';
  const siblings = nodes.filter((node) => node.role === role && node.parent_node_id === parentNodeId);
  if (!Array.isArray(ids) || ids.length !== siblings.length || new Set(ids).size !== siblings.length || ids.some((idValue) => !siblings.some((node) => node.id === idValue))) throw new HttpError(400, { error: 'workflow_draft_reorder_invalid', parent_node_id: parentNodeId });
  const byId = new Map(siblings.map((node) => [node.id, node]));
  return replaceSiblingOrder(nodes, ids.map((idValue, index) => ({ ...byId.get(idValue), order_index: index })));
}

function replaceSiblingOrder(nodes, ordered) { const order = new Map(ordered.map((item, index) => [item.id, index])); return renormalize(nodes.map((node) => order.has(node.id) ? { ...node, order_index: order.get(node.id) } : node)); }
function moveWithinSiblings(nodes, idValue, index) { const next = [...nodes].sort((a, b) => a.order_index - b.order_index), current = next.findIndex((item) => item.id === idValue); const [node] = next.splice(current, 1); next.splice(index, 0, node); return next.map((item, order_index) => ({ ...item, order_index })); }
function assertSameGraphScope(node, dependency) { if (node.id === dependency.id) throw new HttpError(409, { error: 'workflow_draft_self_dependency' }); if (node.role !== dependency.role || node.parent_node_id !== dependency.parent_node_id) throw new HttpError(409, { error: node.role === 'task' ? 'workflow_task_dependency_scope_invalid' : 'workflow_top_level_dependency_scope_invalid', node_id: node.id, dependency_id: dependency.id }); }
function renormalize(nodes) { return normalizeWorkflowHierarchyNodes(nodes); }
function operationType(operation) { const type = String(operation.type || operation.op || ''); return ({ add_workstream: 'add_node', add_task: 'add_node' })[type] || type; }
function targetIndex(operation, length) { const value = Number(operation.to_index ?? operation.index ?? length); return Number.isInteger(value) ? Math.max(0, Math.min(length, value)) : length; }
function defaultNodePosition(index) { return { x: 80 + (index % 4) * 310, y: 120 + Math.floor(index / 4) * 230 }; }
function dependencyIds(node) { return [...new Set((Array.isArray(node?.dependency_ids) ? node.dependency_ids : (node?.dependencies || []).map((item) => typeof item === 'string' ? item : item?.node_id)).map((item) => clean(item)).filter(Boolean))]; }
function cloneNode(node) { return { ...node, dependency_ids: [...(node.dependency_ids || [])], position: { ...(node.position || {}) }, boundary: node.boundary ? structuredClone(node.boundary) : null, acceptance_criteria: [...(node.acceptance_criteria || [])], capability_tags: [...(node.capability_tags || [])], input_slots: structuredClone(node.input_slots || []), output_slots: structuredClone(node.output_slots || []) }; }
function enumValue(value, allowed, error) { if (!allowed.has(value)) throw new HttpError(400, { error, value }); return value; }
function plainObject(value, error) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, { error }); return structuredClone(value); }
function cleanList(value, maxItems, maxLength) { if (!Array.isArray(value)) throw new HttpError(400, { error: 'workflow_list_invalid' }); return [...new Set(value.map((item) => clean(item, maxLength)).filter(Boolean))].slice(0, maxItems); }
function objectList(value, error) { if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new HttpError(400, { error }); return structuredClone(value).slice(0, 50); }
function validPosition(value) { const x = Number(value?.x), y = Number(value?.y); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, { error: 'workflow_node_position_invalid' }); return { x: Math.max(-10000, Math.min(10000, x)), y: Math.max(-10000, Math.min(10000, y)) }; }
function required(value, code, max) { const result = clean(value, max); if (!result) throw new HttpError(400, { error: code }); return result; }
function clean(value, max = 120) { return String(value ?? '').replace(/\0/g, '').trim().slice(0, max); }
