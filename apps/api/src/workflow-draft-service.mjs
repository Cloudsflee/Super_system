import { HttpError } from './http.mjs';
import { id, now } from '../../../packages/shared/index.mjs';
import { assertWorkflowAcyclic, MAX_WORKFLOW_DRAFT_NODES, normalizeWorkflowNodes, WORKFLOW_NODE_TYPES } from './brief-workflow-domain.mjs';
import { assertProjectLifecycleIdle } from './project-lifecycle-operations.mjs';

export function patchWorkflowDraftInState(state, projectId, body, actorId) {
  const project = state.projects.find((item) => item.id === projectId && !item.deleted_at);
  if (!project) throw new HttpError(404, { error: 'project_not_found' });
  assertProjectLifecycleIdle(project);
  const draft = state.workflow_drafts.find((item) => item.project_id === projectId);
  if (!draft) throw new HttpError(404, { error: 'workflow_draft_not_found' });
  if (draft.status === 'activated') throw new HttpError(409, { error: 'workflow_draft_activated', action: 'create_change_proposal' });
  if (!Number.isInteger(body.expected_revision)) throw new HttpError(400, { error: 'expected_revision_required', current_revision: draft.revision });
  if (body.expected_revision !== draft.revision) throw new HttpError(409, { error: 'workflow_draft_revision_conflict', expected_revision: body.expected_revision, current_revision: draft.revision });
  let nodes = normalizeWorkflowNodes(draft.nodes);
  if (Array.isArray(body.nodes)) { assertNodeCount(body.nodes); assertRawNodes(body.nodes); nodes = normalizeWorkflowNodes(body.nodes); }
  else {
    if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 100) throw new HttpError(400, { error: 'workflow_draft_operations_required' });
    for (const operation of body.operations) nodes = applyOperation(nodes, operation);
  }
  assertNodeCount(nodes); assertReferences(nodes); assertAcyclic(nodes);
  const updatedAt = now();
  Object.assign(draft, { nodes: normalizeOrder(nodes), revision: draft.revision + 1, user_modified_at: updatedAt, updated_by_user_id: actorId, updated_at: updatedAt });
  return draft;
}

function applyOperation(nodes, operation) {
  if (!operation || typeof operation !== 'object') throw new HttpError(400, { error: 'workflow_draft_operation_invalid' });
  const type = String(operation.type || operation.op || ''), next = nodes.map((node) => ({ ...node, dependency_ids: [...node.dependency_ids] }));
  if (type === 'add_node') {
    if (next.length >= MAX_WORKFLOW_DRAFT_NODES) throw new HttpError(409, { error: 'workflow_draft_node_limit', max_nodes: MAX_WORKFLOW_DRAFT_NODES });
    const source = operation.node || {}, node = normalizeWorkflowNodes([{ ...source, id: source.id || id('wfdn'), order: Number.isInteger(operation.to_index) ? operation.to_index : next.length }])[0];
    node.dependency_ids = [...new Set((Array.isArray(source.dependency_ids) ? source.dependency_ids : []).map((value) => clean(value)).filter(Boolean))];
    if (next.some((item) => item.id === node.id)) throw new HttpError(409, { error: 'workflow_draft_node_id_conflict', node_id: node.id });
    next.splice(targetIndex(operation, next.length), 0, node); return normalizeOrder(next);
  }
  const nodeId = clean(operation.node_id || operation.id), index = next.findIndex((node) => node.id === nodeId);
  if (type === 'reorder_nodes') return reorder(next, operation.node_ids);
  if (index < 0) throw new HttpError(404, { error: 'workflow_draft_node_not_found', node_id: nodeId });
  if (type === 'update_node') {
    const patch = operation.patch || operation.node || {};
    next[index] = { ...next[index], ...(patch.title !== undefined ? { title: required(patch.title, 'workflow_node_title_required', 100) } : {}), ...(patch.goal !== undefined ? { goal: clean(patch.goal, 4000) } : {}), ...(patch.type !== undefined ? { type: validType(patch.type) } : {}), ...(patch.position !== undefined ? { position: validPosition(patch.position) } : {}) };
  } else if (type === 'delete_node') {
    if (operation.confirmed !== true) throw new HttpError(409, { error: 'workflow_node_delete_confirmation_required', node_id: nodeId });
    next.splice(index, 1); for (const node of next) node.dependency_ids = node.dependency_ids.filter((item) => item !== nodeId);
  } else if (type === 'move_node') { const [node] = next.splice(index, 1); next.splice(targetIndex(operation, next.length), 0, node); }
  else if (type === 'connect') {
    const dependencyId = clean(operation.dependency_id || operation.source_id);
    if (!next.some((node) => node.id === dependencyId)) throw new HttpError(404, { error: 'workflow_draft_dependency_not_found', dependency_id: dependencyId });
    if (dependencyId === nodeId) throw new HttpError(409, { error: 'workflow_draft_self_dependency' });
    next[index].dependency_ids = [...new Set([...next[index].dependency_ids, dependencyId])];
  } else if (type === 'disconnect') {
    const dependencyId = clean(operation.dependency_id || operation.source_id); next[index].dependency_ids = next[index].dependency_ids.filter((item) => item !== dependencyId);
  } else throw new HttpError(400, { error: 'workflow_draft_operation_unsupported', operation: type });
  const ordered = normalizeOrder(next); assertReferences(ordered); assertAcyclic(ordered); return ordered;
}

function reorder(nodes, ids) { if (!Array.isArray(ids) || ids.length !== nodes.length || new Set(ids).size !== nodes.length || ids.some((idValue) => !nodes.some((node) => node.id === idValue))) throw new HttpError(400, { error: 'workflow_draft_reorder_invalid' }); const byId = new Map(nodes.map((node) => [node.id, node])); return ids.map((idValue, index) => ({ ...byId.get(idValue), order: index })); }
function assertReferences(nodes) { const ids = new Set(nodes.map((node) => node.id)); if (ids.size !== nodes.length) throw new HttpError(409, { error: 'workflow_draft_node_id_duplicate' }); for (const node of nodes) for (const dependencyId of node.dependency_ids) { if (!ids.has(dependencyId)) throw new HttpError(409, { error: 'workflow_draft_dependency_not_found', node_id: node.id, dependency_id: dependencyId }); if (dependencyId === node.id) throw new HttpError(409, { error: 'workflow_draft_self_dependency', node_id: node.id }); } }
function assertRawNodes(nodes) { const ids = new Set(nodes.map((node) => clean(node?.id))); if (ids.size !== nodes.length || ids.has('')) throw new HttpError(409, { error: 'workflow_draft_node_id_duplicate' }); for (const node of nodes) for (const dependencyId of Array.isArray(node?.dependency_ids) ? node.dependency_ids : []) { if (!ids.has(clean(dependencyId))) throw new HttpError(409, { error: 'workflow_draft_dependency_not_found', node_id: node.id, dependency_id: dependencyId }); if (clean(dependencyId) === clean(node.id)) throw new HttpError(409, { error: 'workflow_draft_self_dependency', node_id: node.id }); } }
function assertNodeCount(nodes) { if (!nodes.length) throw new HttpError(409, { error: 'workflow_draft_requires_node' }); if (nodes.length > MAX_WORKFLOW_DRAFT_NODES) throw new HttpError(409, { error: 'workflow_draft_node_limit', max_nodes: MAX_WORKFLOW_DRAFT_NODES }); }
function assertAcyclic(nodes) { try { assertWorkflowAcyclic(nodes); } catch (error) { if (error?.code === 'workflow_draft_cycle') throw new HttpError(409, { error: 'workflow_draft_cycle' }); throw error; } }
function normalizeOrder(nodes) { return nodes.map((node, order) => ({ ...node, order })); }
function targetIndex(operation, length) { const value = Number(operation.to_index ?? operation.index ?? length); return Number.isInteger(value) ? Math.max(0, Math.min(length, value)) : length; }
function validType(value) { if (!WORKFLOW_NODE_TYPES.includes(value)) throw new HttpError(400, { error: 'workflow_node_type_invalid' }); return value; }
function validPosition(value) { const x = Number(value?.x), y = Number(value?.y); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, { error: 'workflow_node_position_invalid' }); return { x: Math.max(-10000, Math.min(10000, x)), y: Math.max(-10000, Math.min(10000, y)) }; }
function required(value, code, max) { const result = clean(value, max); if (!result) throw new HttpError(400, { error: code }); return result; }
function clean(value, max = 120) { return String(value ?? '').replace(/\0/g, '').trim().slice(0, max); }
