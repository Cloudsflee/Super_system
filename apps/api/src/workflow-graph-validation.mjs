import { hashString, id } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { MAX_WORKFLOW_DRAFT_NODES, WORKFLOW_NODE_TYPES } from './brief-workflow-domain.mjs';
import { assertWorkflowHierarchy, normalizeWorkflowHierarchyNodes } from './workflow-hierarchy-domain.mjs';
import { assertWorkflowPlanningQuality } from './workflow-quality.mjs';

const ACTIVE_RUN_STATUSES = new Set(['queued', 'starting', 'running', 'waiting_approval', 'stopping']);
const NODE_TYPES = new Set(WORKFLOW_NODE_TYPES);

export function workflowGraphSnapshot(state, workflowOrId, parentNodeId = null) {
  const workflow =
    typeof workflowOrId === 'string' ? state.workflows.find((item) => item.id === workflowOrId) : workflowOrId;
  if (!workflow) return null;
  if (isHierarchyWorkflow(state, workflow))
    return hierarchySnapshotFor(
      workflow,
      hierarchyNodes(state, workflow.id),
      parentNodeId,
      graphRevision(workflow, hierarchyNodes(state, workflow.id), parentNodeId)
    );
  return snapshotFor(workflow, workflowNodes(state, workflow.id), Number(workflow.version || 1));
}

export function workflowGraphHash(snapshot) {
  return hashString(JSON.stringify(snapshot ?? null));
}

export function workflowVisualGraph(nodes, parentNodeId = null) {
  if (nodes.some((node) => node.role === 'workstream' || node.role === 'task'))
    return hierarchyVisualGraph(nodes, parentNodeId);
  const ordered = [...nodes].sort((left, right) => Number(left.order_index || 0) - Number(right.order_index || 0));
  return {
    nodes: ordered.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.title,
      position: validPosition(node.position, node.order_index)
    })),
    edges: ordered.flatMap((node) =>
      dependencyIds(node).map((dependencyId, index) => ({
        id: `${dependencyId}-${node.id}-${index}`,
        source: dependencyId,
        target: node.id
      }))
    )
  };
}

export function prepareWorkflowGraphPatch(state, workflowId, input = {}) {
  const workflow = state.workflows.find((item) => item.id === workflowId);
  if (!workflow) throw new HttpError(404, { error: 'workflow_not_found' });
  if (workflow.hierarchy_mode === 'legacy' || workflow.legacy_read_only)
    throw new HttpError(409, {
      error: 'legacy_workflow_read_only',
      workflow_id: workflow.id,
      migration_status: workflow.semantic_migration_status || 'pending'
    });
  if (isHierarchyWorkflow(state, workflow)) return prepareHierarchyGraphPatch(state, workflow, input);
  const expectedRevision = input.expected_revision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new HttpError(400, { error: 'expected_revision_required', current_revision: Number(workflow.version || 1) });
  if (expectedRevision !== Number(workflow.version || 1))
    throw new HttpError(409, {
      error: 'workflow_graph_revision_conflict',
      expected_revision: expectedRevision,
      current_revision: Number(workflow.version || 1)
    });
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 100)
    throw new HttpError(400, { error: 'workflow_graph_operations_required', max_operations: 100 });

  const beforeNodes = workflowNodes(state, workflow.id),
    usedIds = new Set(beforeNodes.map((node) => node.id));
  let candidate = beforeNodes.map(candidateNode);
  const normalized = [],
    deletedIds = new Set();
  for (const source of input.operations) {
    const result = normalizeAndApply(candidate, source, usedIds);
    candidate = result.nodes;
    normalized.push(result.operation);
    if (result.deleted_id) deletedIds.add(result.deleted_id);
  }
  candidate = candidate.map((node, orderIndex) => ({ ...node, order_index: orderIndex }));
  validateCandidate(candidate);
  assertDeletedNodesIdle(state, workflow.id, deletedIds);
  const before = snapshotFor(workflow, beforeNodes, expectedRevision),
    after = snapshotFor(workflow, candidate, expectedRevision + 1);
  return {
    workflow,
    expected_revision: expectedRevision,
    operations: normalized,
    candidate,
    before,
    after,
    before_hash: workflowGraphHash(before),
    after_hash: workflowGraphHash(after),
    destructive: normalized.some((item) => item.type === 'delete_node')
  };
}

function prepareHierarchyGraphPatch(state, workflow, input) {
  const parentNodeId = clean(input.parent_node_id, 120) || null;
  const currentNodes = hierarchyNodes(state, workflow.id);
  const parent = parentNodeId
    ? currentNodes.find((node) => node.id === parentNodeId && node.role === 'workstream')
    : null;
  if (parentNodeId && !parent)
    throw new HttpError(404, { error: 'workflow_workstream_not_found', parent_node_id: parentNodeId });
  const currentRevision = graphRevision(workflow, currentNodes, parentNodeId),
    expectedRevision = input.expected_revision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new HttpError(400, { error: 'expected_revision_required', current_revision: currentRevision });
  if (expectedRevision !== currentRevision)
    throw new HttpError(409, {
      error: parentNodeId ? 'workstream_plan_revision_conflict' : 'workflow_graph_revision_conflict',
      expected_revision: expectedRevision,
      current_revision: currentRevision,
      parent_node_id: parentNodeId
    });
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 100)
    throw new HttpError(400, { error: 'workflow_graph_operations_required', max_operations: 100 });
  let candidate = currentNodes.map(hierarchyClone),
    normalized = [],
    deletedIds = new Set();
  for (const source of input.operations) {
    const result = applyHierarchyOperation(candidate, source, parentNodeId);
    candidate = result.nodes;
    normalized.push(result.operation);
    for (const deletedId of result.deleted_ids || []) deletedIds.add(deletedId);
  }
  candidate = normalizeWorkflowHierarchyNodes(candidate);
  assertWorkflowHierarchy(candidate, { mode: 'formal', requireTasks: true });
  assertCompletedTaskDefinitions(currentNodes, candidate, normalized);
  if (workflow.planning_quality === 'verified')
    assertFormalPlanningQuality(state, workflow, candidate, input.brief_coverage || workflow.brief_coverage);
  assertDeletedNodesIdle(state, workflow.id, deletedIds);
  const before = hierarchySnapshotFor(workflow, currentNodes, parentNodeId, expectedRevision);
  const after = hierarchySnapshotFor(workflow, candidate, parentNodeId, expectedRevision + 1);
  return {
    workflow,
    parent_node_id: parentNodeId,
    expected_revision: expectedRevision,
    operations: normalized,
    candidate,
    before,
    after,
    before_hash: workflowGraphHash(before),
    after_hash: workflowGraphHash(after),
    destructive: deletedIds.size > 0,
    deleted_ids: [...deletedIds]
  };
}

function applyHierarchyOperation(nodes, source, parentNodeId) {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new HttpError(400, { error: 'workflow_graph_operation_invalid' });
  const type = clean(source.type || source.op, 80),
    next = nodes.map(hierarchyClone),
    scoped = hierarchyScope(next, parentNodeId);
  if (type === 'add_node') {
    const raw = object(source.node, 'workflow_node_required'),
      role = parentNodeId ? 'task' : 'workstream';
    if (raw.role && raw.role !== role)
      throw new HttpError(409, {
        error: 'workflow_graph_role_scope_invalid',
        role: raw.role,
        parent_node_id: parentNodeId
      });
    const sourceNode = {
      ...raw,
      role,
      parent_node_id: parentNodeId,
      id: clean(raw.id, 120) || id(role === 'workstream' ? 'wfs' : 'tsk')
    };
    if (next.some((node) => node.id === sourceNode.id))
      throw new HttpError(409, { error: 'workflow_graph_node_id_conflict', node_id: sourceNode.id });
    const additions = normalizeWorkflowHierarchyNodes(
      role === 'workstream' && Array.isArray(raw.tasks) ? [{ ...sourceNode, tasks: raw.tasks }] : [sourceNode]
    );
    for (const addition of additions)
      if (next.some((node) => node.id === addition.id))
        throw new HttpError(409, { error: 'workflow_graph_node_id_conflict', node_id: addition.id });
    next.push(...additions);
    const root = additions.find((item) => item.id === sourceNode.id) || additions[0];
    const persisted =
      role === 'workstream'
        ? { ...root, tasks: additions.filter((item) => item.role === 'task' && item.parent_node_id === root.id) }
        : root;
    return { nodes: next, operation: { type, node: structuredClone(persisted) } };
  }
  if (type === 'reorder_nodes') {
    const ids = uniqueIds(source.ids ?? source.node_ids);
    if (ids.length !== scoped.length || ids.some((nodeId) => !scoped.some((node) => node.id === nodeId)))
      throw new HttpError(400, { error: 'workflow_graph_reorder_invalid', parent_node_id: parentNodeId });
    const order = new Map(ids.map((nodeId, index) => [nodeId, index]));
    return {
      nodes: next.map((node) => (order.has(node.id) ? { ...node, order_index: order.get(node.id) } : node)),
      operation: { type, ids }
    };
  }
  const nodeId = clean(source.node_id || source.target_id || source.id, 120),
    index = next.findIndex((node) => node.id === nodeId);
  if (index < 0 || !scoped.some((node) => node.id === nodeId))
    throw new HttpError(404, { error: 'workflow_graph_node_not_found', node_id: nodeId, parent_node_id: parentNodeId });
  if (type === 'reopen_task') {
    if (!parentNodeId || next[index].role !== 'task')
      throw new HttpError(409, { error: 'workflow_reopen_task_scope_invalid', node_id: nodeId });
    if (next[index].status !== 'completed')
      throw new HttpError(409, {
        error: 'workflow_reopen_task_not_completed',
        node_id: nodeId,
        status: next[index].status
      });
    const reason = required(source.reason || source.justification, 'workflow_reopen_reason_required', 2000);
    next[index] = {
      ...next[index],
      status: 'ready',
      execution_revision: Number(next[index].execution_revision || 1) + 1,
      reopened_from_revision: Number(next[index].execution_revision || 1),
      reopen_reason: reason
    };
    return { nodes: next, operation: { type, node_id: nodeId, reason } };
  }
  if (type === 'update_node') {
    const patch = object(source.patch || source.node, 'workflow_node_patch_required');
    if (patch.role !== undefined || patch.parent_node_id !== undefined)
      throw new HttpError(409, { error: 'workflow_node_scope_immutable', node_id: nodeId });
    const allowed =
      next[index].role === 'workstream'
        ? ['title', 'goal', 'outcome', 'category', 'boundary', 'acceptance_criteria', 'position']
        : [
            'title',
            'goal',
            'task_kind',
            'execution_mode',
            'required',
            'repository_intent',
            'capability_tags',
            'acceptance_criteria',
            'input_slots',
            'output_slots',
            'atomic_justification',
            'position'
          ];
    const normalizedPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
    if (!Object.keys(normalizedPatch).length) throw new HttpError(400, { error: 'workflow_node_patch_empty' });
    next[index] = { ...next[index], ...structuredClone(normalizedPatch) };
    return { nodes: next, operation: { type, node_id: nodeId, patch: normalizedPatch } };
  }
  if (type === 'delete_node') {
    const deleted = new Set([nodeId]);
    if (next[index].role === 'workstream')
      for (const task of next.filter((node) => node.parent_node_id === nodeId)) deleted.add(task.id);
    const retained = next.filter((node) => !deleted.has(node.id));
    for (const node of retained)
      node.dependency_ids = node.dependency_ids.filter((dependencyId) => !deleted.has(dependencyId));
    return { nodes: retained, operation: { type, node_id: nodeId }, deleted_ids: [...deleted] };
  }
  if (type === 'connect' || type === 'disconnect') {
    const dependencyId = clean(source.dependency_id || source.source_id, 120),
      dependency = scoped.find((node) => node.id === dependencyId);
    if (!dependency)
      throw new HttpError(409, {
        error: parentNodeId ? 'workflow_task_dependency_scope_invalid' : 'workflow_top_level_dependency_scope_invalid',
        node_id: nodeId,
        dependency_id: dependencyId,
        parent_node_id: parentNodeId
      });
    if (dependencyId === nodeId) throw new HttpError(409, { error: 'workflow_graph_self_dependency', node_id: nodeId });
    next[index].dependency_ids =
      type === 'connect'
        ? [...new Set([...next[index].dependency_ids, dependencyId])]
        : next[index].dependency_ids.filter((item) => item !== dependencyId);
    return { nodes: next, operation: { type, node_id: nodeId, dependency_id: dependencyId } };
  }
  throw new HttpError(400, { error: 'workflow_graph_operation_unsupported', operation: type || null });
}

function hierarchySnapshotFor(workflow, nodes, parentNodeId, revision) {
  const scoped = hierarchyScope(nodes, parentNodeId).sort((a, b) => a.order_index - b.order_index);
  return {
    workflow_id: workflow.id,
    parent_node_id: parentNodeId,
    revision,
    nodes: scoped.map((node) => ({
      id: node.id,
      role: node.role,
      parent_node_id: node.parent_node_id,
      title: node.title,
      goal: node.goal,
      outcome: node.outcome,
      category: node.category,
      task_kind: node.task_kind,
      execution_mode: node.execution_mode,
      boundary: node.boundary,
      acceptance_criteria: node.acceptance_criteria,
      required: node.required,
      repository_intent: node.repository_intent,
      capability_tags: node.capability_tags,
      input_slots: node.input_slots,
      output_slots: node.output_slots,
      atomic_justification: node.atomic_justification,
      status: node.status,
      execution_revision: Number(node.execution_revision || 1),
      order_index: node.order_index,
      dependency_ids: [...node.dependency_ids].sort()
    }))
  };
}

function hierarchyVisualGraph(nodes, parentNodeId) {
  const scoped = hierarchyScope(normalizeWorkflowHierarchyNodes(nodes), parentNodeId).sort(
      (a, b) => a.order_index - b.order_index
    ),
    ids = new Set(scoped.map((node) => node.id));
  return {
    parent_node_id: parentNodeId,
    nodes: scoped.map((node) => ({
      id: node.id,
      type: node.role,
      label: node.title,
      position: validPosition(node.position, node.order_index)
    })),
    edges: scoped.flatMap((node) =>
      node.dependency_ids
        .filter((dependencyId) => ids.has(dependencyId))
        .map((dependencyId, index) => ({
          id: `${dependencyId}-${node.id}-${index}`,
          source: dependencyId,
          target: node.id
        }))
    )
  };
}

function hierarchyNodes(state, workflowId) {
  return normalizeWorkflowHierarchyNodes(
    state.workflow_nodes
      .filter((item) => item.workflow_id === workflowId)
      .map((node) => ({ ...node, dependency_ids: dependencyIds(node) }))
  );
}
function hierarchyScope(nodes, parentNodeId) {
  return nodes.filter((node) =>
    parentNodeId ? node.role === 'task' && node.parent_node_id === parentNodeId : node.role === 'workstream'
  );
}
function hierarchyClone(node) {
  return {
    ...node,
    dependency_ids: [...(node.dependency_ids || [])],
    position: { ...(node.position || {}) },
    boundary: node.boundary ? structuredClone(node.boundary) : null,
    acceptance_criteria: [...(node.acceptance_criteria || [])],
    capability_tags: [...(node.capability_tags || [])],
    input_slots: structuredClone(node.input_slots || []),
    output_slots: structuredClone(node.output_slots || [])
  };
}
function isHierarchyWorkflow(state, workflow) {
  const nodes = state.workflow_nodes.filter((item) => item.workflow_id === workflow.id);
  return workflow.hierarchy_mode === 'two_level' || nodes.some((node) => node.role === 'workstream');
}
function graphRevision(workflow, nodes, parentNodeId) {
  return parentNodeId
    ? Number(nodes.find((node) => node.id === parentNodeId)?.plan_revision || 1)
    : Number(workflow.workflow_revision || workflow.version || 1);
}

function normalizeAndApply(nodes, source, usedIds) {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new HttpError(400, { error: 'workflow_graph_operation_invalid' });
  const type = clean(source.type || source.op, 80),
    next = nodes.map(cloneCandidate);
  if (type === 'add_node') {
    const input = object(source.node, 'workflow_node_required'),
      nodeId = clean(input.id, 120) || id('wfn');
    if (usedIds.has(nodeId) || next.some((item) => item.id === nodeId))
      throw new HttpError(409, { error: 'workflow_graph_node_id_conflict', node_id: nodeId });
    usedIds.add(nodeId);
    const title = clean(input.title || '新节点', 100),
      index = insertionIndex(source.to_index ?? input.order_index, next.length);
    const node = {
      id: nodeId,
      type: validType(input.type || 'execution'),
      title,
      goal: clean(input.goal || title, 2000) || title,
      order_index: next.length,
      dependency_ids: uniqueIds(input.dependency_ids || dependencyIds(input)),
      position: validPosition(input.position, next.length),
      status: clean(input.status, 50) || 'ready'
    };
    next.splice(index, 0, node);
    return {
      nodes: normalizeOrder(next),
      operation: {
        type,
        node: {
          id: node.id,
          type: node.type,
          title: node.title,
          goal: node.goal,
          dependency_ids: node.dependency_ids,
          position: node.position
        },
        ...(index === next.length - 1 ? {} : { to_index: index })
      }
    };
  }
  if (type === 'reorder_nodes') {
    const ids = uniqueIds(source.ids ?? source.node_ids);
    if (ids.length !== next.length || ids.some((nodeId) => !next.some((node) => node.id === nodeId)))
      throw new HttpError(400, { error: 'workflow_graph_reorder_invalid' });
    const byId = new Map(next.map((node) => [node.id, node]));
    return {
      nodes: ids.map((nodeId, orderIndex) => ({ ...byId.get(nodeId), order_index: orderIndex })),
      operation: { type, ids }
    };
  }
  const nodeId = clean(source.node_id || source.target_id || source.id, 120),
    index = next.findIndex((node) => node.id === nodeId);
  if (index < 0) throw new HttpError(404, { error: 'workflow_graph_node_not_found', node_id: nodeId });
  if (type === 'update_node') {
    const patch = object(source.patch || source.node, 'workflow_node_patch_required'),
      normalized = {};
    if (Object.hasOwn(patch, 'title')) normalized.title = required(patch.title, 'workflow_node_title_required', 100);
    if (Object.hasOwn(patch, 'goal'))
      normalized.goal = clean(patch.goal, 2000) || normalized.title || next[index].title;
    if (Object.hasOwn(patch, 'type')) normalized.type = validType(patch.type);
    if (!Object.keys(normalized).length) throw new HttpError(400, { error: 'workflow_node_patch_empty' });
    next[index] = { ...next[index], ...normalized };
    return { nodes: next, operation: { type, node_id: nodeId, patch: normalized } };
  }
  if (type === 'delete_node') {
    next.splice(index, 1);
    for (const node of next)
      node.dependency_ids = node.dependency_ids.filter((dependencyId) => dependencyId !== nodeId);
    return { nodes: normalizeOrder(next), operation: { type, node_id: nodeId }, deleted_id: nodeId };
  }
  if (type === 'connect' || type === 'disconnect') {
    const dependencyId = clean(source.dependency_id || source.source_id, 120);
    if (!next.some((node) => node.id === dependencyId))
      throw new HttpError(404, { error: 'workflow_graph_dependency_not_found', dependency_id: dependencyId });
    if (dependencyId === nodeId) throw new HttpError(409, { error: 'workflow_graph_self_dependency', node_id: nodeId });
    next[index].dependency_ids =
      type === 'connect'
        ? [...new Set([...next[index].dependency_ids, dependencyId])]
        : next[index].dependency_ids.filter((item) => item !== dependencyId);
    return { nodes: next, operation: { type, node_id: nodeId, dependency_id: dependencyId } };
  }
  throw new HttpError(400, { error: 'workflow_graph_operation_unsupported', operation: type || null });
}

function validateCandidate(nodes) {
  if (!nodes.length) throw new HttpError(409, { error: 'workflow_graph_requires_node' });
  if (nodes.length > MAX_WORKFLOW_DRAFT_NODES)
    throw new HttpError(409, { error: 'workflow_graph_node_limit', max_nodes: MAX_WORKFLOW_DRAFT_NODES });
  const ids = new Set(nodes.map((node) => node.id)),
    orders = new Set(nodes.map((node) => node.order_index));
  if (ids.size !== nodes.length || ids.has('')) throw new HttpError(409, { error: 'workflow_graph_node_id_duplicate' });
  if (
    orders.size !== nodes.length ||
    nodes.some(
      (node) => !Number.isInteger(node.order_index) || node.order_index < 0 || node.order_index >= nodes.length
    )
  )
    throw new HttpError(409, { error: 'workflow_graph_order_invalid' });
  for (const node of nodes) {
    if (!NODE_TYPES.has(node.type)) throw new HttpError(400, { error: 'workflow_node_type_invalid', node_id: node.id });
    if (!node.title) throw new HttpError(400, { error: 'workflow_node_title_required', node_id: node.id });
    const dependencies = new Set();
    for (const dependencyId of node.dependency_ids) {
      if (!ids.has(dependencyId))
        throw new HttpError(409, {
          error: 'workflow_graph_dependency_not_found',
          node_id: node.id,
          dependency_id: dependencyId
        });
      if (dependencyId === node.id)
        throw new HttpError(409, { error: 'workflow_graph_self_dependency', node_id: node.id });
      if (dependencies.has(dependencyId))
        throw new HttpError(409, {
          error: 'workflow_graph_dependency_duplicate',
          node_id: node.id,
          dependency_id: dependencyId
        });
      dependencies.add(dependencyId);
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node])),
    visiting = new Set(),
    visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw new HttpError(409, { error: 'workflow_graph_cycle' });
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const dependencyId of byId.get(nodeId).dependency_ids) visit(dependencyId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
}

function assertDeletedNodesIdle(state, workflowId, deletedIds) {
  for (const nodeId of deletedIds) {
    const active = state.node_runs.find((item) => item.node_id === nodeId && ACTIVE_RUN_STATUSES.has(item.status));
    if (active)
      throw new HttpError(409, {
        error: 'workflow_graph_active_node_run',
        workflow_id: workflowId,
        node_id: nodeId,
        run_id: active.id
      });
  }
}
export function assertCompletedTaskDefinitions(before, after, operations = []) {
  const next = new Map(after.map((node) => [node.id, node])),
    reopened = new Set(operations.filter((item) => item.type === 'reopen_task').map((item) => item.node_id));
  for (const task of before.filter((node) => node.role === 'task' && node.status === 'completed')) {
    const candidate = next.get(task.id);
    if (!candidate)
      throw new HttpError(409, {
        error: 'completed_task_immutable',
        node_id: task.id,
        action: 'create_follow_up_task_or_reopen_revision'
      });
    if (reopened.has(task.id)) continue;
    if (JSON.stringify(taskDefinition(task)) !== JSON.stringify(taskDefinition(candidate)))
      throw new HttpError(409, {
        error: 'completed_task_immutable',
        node_id: task.id,
        action: 'create_follow_up_task_or_reopen_revision'
      });
  }
}
function assertFormalPlanningQuality(state, workflow, nodes, briefCoverage) {
  const project = state.projects.find((item) => item.id === workflow.project_id),
    brief = state.project_briefs
      .filter((item) => item.project_id === workflow.project_id && item.status !== 'superseded')
      .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  assertWorkflowPlanningQuality({
    nodes,
    project,
    brief,
    projectClassification: workflow.project_classification,
    briefCoverage
  });
}
function taskDefinition(node) {
  return {
    parent_node_id: node.parent_node_id,
    title: node.title,
    goal: node.goal,
    task_kind: node.task_kind,
    execution_mode: node.execution_mode,
    required: node.required !== false,
    repository_intent: node.repository_intent || null,
    capability_tags: node.capability_tags || [],
    acceptance_criteria: node.acceptance_criteria || [],
    input_slots: node.input_slots || [],
    output_slots: node.output_slots || [],
    atomic_justification: node.atomic_justification || null,
    dependency_ids: dependencyIds(node)
  };
}
function snapshotFor(workflow, nodes, revision) {
  const ordered = [...nodes].map(candidateNode).sort((left, right) => left.order_index - right.order_index);
  return {
    workflow_id: workflow.id,
    revision,
    nodes: ordered.map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      goal: node.goal,
      order_index: node.order_index,
      dependency_ids: [...node.dependency_ids].sort()
    }))
  };
}
function workflowNodes(state, workflowId) {
  return state.workflow_nodes
    .filter((item) => item.workflow_id === workflowId)
    .sort((left, right) => Number(left.order_index || 0) - Number(right.order_index || 0));
}
function candidateNode(node, index = 0) {
  return {
    id: clean(node.id, 120),
    type: node.type,
    title: clean(node.title, 100),
    goal: clean(node.goal || node.title, 2000),
    status: node.status || 'ready',
    order_index: Number.isInteger(node.order_index) ? node.order_index : index,
    dependency_ids: dependencyIds(node),
    position: validPosition(node.position, Number.isInteger(node.order_index) ? node.order_index : index)
  };
}
function cloneCandidate(node) {
  return { ...node, dependency_ids: [...node.dependency_ids], position: { ...node.position } };
}
function dependencyIds(node) {
  return uniqueIds(
    Array.isArray(node.dependency_ids)
      ? node.dependency_ids
      : (node.dependencies || []).map((item) => (typeof item === 'string' ? item : item?.node_id))
  );
}
function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, 120)).filter(Boolean))];
}
function normalizeOrder(nodes) {
  return nodes.map((node, orderIndex) => ({ ...node, order_index: orderIndex }));
}
function insertionIndex(value, length) {
  const index = Number(value);
  return Number.isInteger(index) ? Math.max(0, Math.min(length, index)) : length;
}
function validPosition(value, index = 0) {
  const fallbackX = 100 + (index % 3) * 280,
    fallbackY = 110 + Math.floor(index / 3) * 220,
    x = Number(value?.x),
    y = Number(value?.y);
  return {
    x: Math.max(-10000, Math.min(10000, Number.isFinite(x) ? x : fallbackX)),
    y: Math.max(-10000, Math.min(10000, Number.isFinite(y) ? y : fallbackY))
  };
}
function validType(value) {
  if (!NODE_TYPES.has(value)) throw new HttpError(400, { error: 'workflow_node_type_invalid', type: value || null });
  return value;
}
function required(value, error, max) {
  const result = clean(value, max);
  if (!result) throw new HttpError(400, { error });
  return result;
}
function object(value, error) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, { error });
  return value;
}
function clean(value, max = 120) {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}
