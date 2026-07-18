import { assistCapability, assistCapabilityToolName, now } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { requireTurn } from './assist-v3-domain.mjs';
import { patchBriefInState } from './project-brief-service.mjs';
import { patchWorkflowDraftInState } from './workflow-draft-service.mjs';
import { createWorkflowGraphProposalInState } from './workflow-graph-service.mjs';
import {
  nodeIndex, plainObject, requireResource, requiredIndex, requiredText, resourceSnapshot, resourceValue, sectionIndex,
  sectionPatch, stringArray, targetLabel, targetValue
} from './assist-project-tool-context.mjs';

export function executeProjectCapabilityInState(state, operation, actorId) {
  const request = operation.domain_request;
  if (!request) throw new HttpError(409, { error: 'assist_domain_operation_request_missing' });
  const turn = requireTurn(state, operation.turn_id);
  if (turn.collaboration_mode === 'plan' || turn.mode === 'plan') throw new HttpError(409, { error: 'assist_plan_capability_write_forbidden' });
  assertStoredScope(turn, operation, request);
  if (request.resource_type === 'workflow') return createWorkflowProposalOutcome(state, operation, actorId);
  const beforeResource = resourceSnapshot(requireResource(state, request));
  const operations = request.operations.map((item) => confirmedOperation(item, operation));
  const updated = applyOperations(state, request, request.expected_revision, operations, actorId);
  const afterResource = resourceSnapshot(updated), outcome = mutationOutcome(request, beforeResource, afterResource);
  return { ...outcome, resourceRevisionBefore: beforeResource.revision, resourceRevisionAfter: afterResource.revision, resourceBeforeHashSource: resourceValue(request.resource_type, beforeResource), resourceAfterHashSource: resourceValue(request.resource_type, afterResource), committedAt: now() };
}

export function currentProjectCapabilityValue(state, operation) {
  const request = operation.domain_request;
  if (!request) throw new HttpError(409, { error: 'assist_domain_operation_request_missing' });
  const resource = resourceSnapshot(requireResource(state, request));
  return { value: targetValue(request.resource_type, operation.domain_value_kind || request.value_kind, operation.target_id, resource), resource };
}

export function undoProjectCapabilityInState(state, original, actorId) {
  if (original.domain_request?.resource_type === 'workflow') throw new HttpError(409, { error: 'assist_change_proposal_operation_not_undoable' });
  if (!original.domain_inverse?.operations?.length) throw new HttpError(409, { error: 'assist_domain_operation_not_undoable' });
  const request = original.domain_request, current = resourceSnapshot(requireResource(state, request));
  const beforeValue = targetValue(request.resource_type, original.domain_value_kind || request.value_kind, original.target_id, current);
  const operations = original.domain_inverse.operations.map((item) => ({ ...structuredClone(item), ...(item.type === 'delete_node' ? { confirmed: true } : {}) }));
  const updated = applyOperations(state, request, current.revision, operations, actorId), afterResource = resourceSnapshot(updated);
  return { beforeValue, afterValue: targetValue(request.resource_type, original.domain_value_kind || request.value_kind, original.target_id, afterResource), resourceRevisionBefore: current.revision, resourceRevisionAfter: afterResource.revision, resource: afterResource };
}

export function prepareProjectCapabilityRevision(state, original, value) {
  const request = original.domain_request;
  if (!request) throw new HttpError(409, { error: 'assist_domain_operation_request_missing' });
  const resource = resourceSnapshot(requireResource(state, request)), kind = original.domain_value_kind || request.value_kind, targetId = original.target_id;
  const operations = revisionOperations(request.resource_type, kind, targetId, value, resource);
  if (!operations.length) throw new HttpError(400, { error: 'assist_operation_revision_value_invalid' });
  const descriptor = assistCapability(revisionCapability(request.resource_type, kind, resource, targetId)) || assistCapability(original.capability_id);
  return {
    descriptor, tool: assistCapabilityToolName(descriptor), targetId,
    targetLabel: targetLabel(request.resource_type, targetId, resource) || original.target_label || targetId,
    inputSchema: descriptor?.input_schema || original.input_schema || null,
    request: { ...request, expected_revision: resource.revision, operations, primary_type: operations[0].type, target_id: targetId, value_kind: kind, replaces_proposal_id: request.resource_type === 'workflow' && original.proposal_id ? original.proposal_id : request.replaces_proposal_id || null }
  };
}

function createWorkflowProposalOutcome(state, operation, actorId) {
  const request = operation.domain_request, beforeResource = resourceSnapshot(requireResource(state, request));
  const created = createWorkflowGraphProposalInState(state, request.resource_id, {
    expected_revision: request.expected_revision, operations: request.operations
  }, actorId, {
    project_id: request.project_id, target_id: request.target_id,
    title: operation.summary?.split(' · ')[0] || '工作流变更提案', summary: '由 Codex Assist 创建，用户批准前不会修改正式工作流',
    replaces_proposal_id: request.replaces_proposal_id || null
  });
  const before = { ...beforeResource, revision: created.before.revision, nodes: created.before.nodes }, after = { ...beforeResource, revision: created.after.revision, nodes: created.after.nodes };
  const kind = operation.domain_value_kind || request.value_kind, targetId = request.target_id;
  const beforeValue = targetValue('workflow', kind, targetId, before), afterValue = targetValue('workflow', kind, targetId, after);
  return {
    targetId, targetLabel: created.target.label || operation.target_label || targetId, valueKind: kind,
    beforeValue, afterValue, currentValue: beforeValue, inverse: { operations: [] },
    resourceRevisionBefore: created.expected_revision, resourceRevisionAfter: created.expected_revision,
    resourceBeforeHashSource: created.before, resourceAfterHashSource: created.after,
    resultKind: 'change_proposal', proposalId: created.proposal.id, proposalStatus: created.proposal.status,
    committedAt: now()
  };
}

function mutationOutcome(request, beforeResource, afterResource) {
  let targetId = request.target_id;
  if (request.primary_type === 'duplicate_section') {
    const beforeIds = new Set(beforeResource.content.sections.map((item) => item.id));
    targetId = afterResource.content.sections.find((item) => !beforeIds.has(item.id))?.id || targetId;
  }
  const kind = request.value_kind, beforeValue = targetValue(request.resource_type, kind, targetId, beforeResource), afterValue = targetValue(request.resource_type, kind, targetId, afterResource);
  return { targetId, targetLabel: targetLabel(request.resource_type, targetId, afterResource) || targetLabel(request.resource_type, targetId, beforeResource) || targetId, valueKind: kind, beforeValue, afterValue, currentValue: afterValue, inverse: { operations: inverseOperations(request.resource_type, kind, targetId, beforeValue, afterValue, beforeResource) } };
}

function inverseOperations(resourceType, kind, targetId, beforeValue, afterValue, beforeResource) {
  if (resourceType === 'brief') {
    if (kind === 'brief_section') {
      if (beforeValue == null && afterValue != null) return [{ type: 'delete_section', section_id: targetId }];
      if (beforeValue != null && afterValue == null) return [{ type: 'add_section', section: beforeValue, to_index: sectionIndex(beforeResource, targetId) }];
      return [{ type: 'update_section', section_id: targetId, patch: beforeValue }];
    }
    if (kind === 'brief_section_title') return [{ type: 'rename_section', section_id: targetId, title: beforeValue }];
    if (kind === 'brief_section_index') return [{ type: 'move_section', section_id: targetId, to_index: beforeValue }];
  }
  if (kind === 'workflow_node') {
    if (beforeValue == null && afterValue != null) return [{ type: 'delete_node', node_id: targetId, confirmed: true }];
    if (beforeValue != null && afterValue == null) return [{ type: 'add_node', node: beforeValue, to_index: nodeIndex(beforeResource, targetId) }, ...beforeResource.nodes.filter((node) => node.id !== targetId && node.dependency_ids.includes(targetId)).map((node) => ({ type: 'connect', node_id: node.id, dependency_id: targetId }))];
    return [{ type: 'update_node', node_id: targetId, patch: beforeValue }];
  }
  if (kind === 'workflow_order') return [{ type: 'reorder_nodes', node_ids: beforeValue }];
  if (kind === 'workflow_dependencies') return dependencySyncOperations(targetId, afterValue || [], beforeValue || []);
  throw new HttpError(409, { error: 'assist_domain_operation_not_undoable' });
}

function revisionOperations(resourceType, kind, targetId, value, resource) {
  if (resourceType === 'brief') {
    const section = resource.content.sections.find((item) => item.id === targetId);
    if (kind === 'brief_section') { const patch = sectionPatch(value, section); return section ? [{ type: 'update_section', section_id: targetId, patch }] : [{ type: 'add_section', section: { ...patch, id: targetId } }]; }
    if (kind === 'brief_section_title') return [{ type: 'rename_section', section_id: targetId, title: requiredText(value) }];
    if (kind === 'brief_section_index') return [{ type: 'move_section', section_id: targetId, to_index: requiredIndex(value) }];
  }
  if (kind === 'workflow_graph' && resourceType === 'workflow') { if (!Array.isArray(value) || !value.length) throw new HttpError(400, { error: 'assist_operation_revision_value_invalid' }); return structuredClone(value); }
  if (kind === 'workflow_node') { const node = resource.nodes.find((item) => item.id === targetId), patch = plainObject(value, 'assist_operation_revision_value_invalid'); return node ? [{ type: 'update_node', node_id: targetId, patch }] : [{ type: 'add_node', node: { ...patch, id: targetId } }]; }
  if (kind === 'workflow_order') return [{ type: 'reorder_nodes', node_ids: stringArray(value) }];
  if (kind === 'workflow_dependencies') { const node = resource.nodes.find((item) => item.id === targetId); if (!node) throw new HttpError(404, { error: 'workflow_draft_node_not_found', node_id: targetId }); return dependencySyncOperations(targetId, node.dependency_ids, stringArray(value)); }
  return [];
}

function revisionCapability(resourceType, kind, resource, targetId) {
  if (resourceType === 'brief') {
    if (kind === 'brief_section_title') return 'project.brief.section.rename';
    if (kind === 'brief_section_index') return 'project.brief.section.move';
    return resource.content.sections.some((item) => item.id === targetId) ? 'project.brief.section.update' : 'project.brief.section.add';
  }
  const prefix = resourceType === 'workflow' ? 'project.workflow' : 'project.workflow_draft';
  if (kind === 'workflow_graph') return 'project.workflow.graph.patch';
  if (kind === 'workflow_order') return `${prefix}.node.reorder`;
  if (kind === 'workflow_dependencies') return `${prefix}.node.update`;
  return resource.nodes.some((item) => item.id === targetId) ? `${prefix}.node.update` : `${prefix}.node.add`;
}

function dependencySyncOperations(nodeId, current, desired) { const currentSet = new Set(current), desiredSet = new Set(desired); return [...current.filter((dependencyId) => !desiredSet.has(dependencyId)).map((dependencyId) => ({ type: 'disconnect', node_id: nodeId, dependency_id: dependencyId })), ...desired.filter((dependencyId) => !currentSet.has(dependencyId)).map((dependencyId) => ({ type: 'connect', node_id: nodeId, dependency_id: dependencyId }))]; }
function confirmedOperation(source, operation) { const value = structuredClone(source); if (value.type === 'delete_node') value.confirmed = Boolean(operation.approved_at); return value; }
function applyOperations(state, request, revision, operations, actorId) { return request.resource_type === 'brief' ? patchBriefInState(state, request.project_id, request.resource_id, { expected_revision: revision, operations }, actorId) : patchWorkflowDraftInState(state, request.project_id, { expected_revision: revision, operations }, actorId); }
function assertStoredScope(turn, operation, request) { const page = { route: turn.view_context?.route, surfaceId: turn.view_context?.surface?.id || turn.view_context?.surface?.surface_id, revision: turn.view_context?.surface?.revision, browserInstanceId: turn.view_context?.browser_instance_id || turn.view_context?.surface?.browser_instance_id }; if (turn.project_id !== request.project_id || operation.project_id !== request.project_id) throw new HttpError(409, { error: 'assist_capability_project_scope_mismatch' }); if (page.route !== request.route || operation.route !== request.route) throw new HttpError(409, { error: 'assist_capability_route_mismatch' }); if (page.surfaceId !== request.surface_id || operation.surface_id !== request.surface_id) throw new HttpError(409, { error: 'assist_capability_surface_mismatch' }); if (page.revision !== request.surface_revision || operation.surface_revision !== request.surface_revision) throw new HttpError(409, { error: 'assist_capability_surface_revision_mismatch' }); if (page.browserInstanceId !== request.browser_instance_id || operation.browser_instance_id !== request.browser_instance_id) throw new HttpError(409, { error: 'assist_capability_browser_mismatch' }); }
