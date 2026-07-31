import { cloneStateValue as structuredClone } from './state-clone.mjs';
import {
  ASSIST_CAPABILITY_MANIFEST,
  assistCapabilityForToolName,
  assistCapabilityToolName
} from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { cleanText } from './assist-v3-domain.mjs';
import {
  assertArgumentKeys,
  assertSame,
  bindInputSchema,
  currentBrief,
  currentWorkflowDraft,
  initialTarget,
  matchesRoute,
  currentWorkflow,
  normalizeCreatedId,
  pageIdentity,
  plainObject,
  routeProjectId,
  valueKind,
  workflowResource
} from './assist-project-tool-context.mjs';
import { workflowAssistSurfaceId, workflowAssistSurfaceRevision } from './workflow-graph-service.mjs';
import { assertStartupWorkflowOperations, STARTUP_WORKFLOW_POLICY } from './workflow-design-policy.mjs';

export const PROJECT_TOOL_NAMESPACE = 'aiws_project';
export const PROJECT_CAPABILITIES = Object.freeze(
  ASSIST_CAPABILITY_MANIFEST.filter((item) => item.id.startsWith('project.'))
);

export function projectCapabilityToolSpec(state, projectId, viewContext) {
  const page = pageIdentity(viewContext);
  if (!projectId || !page.route || !page.surfaceId || !page.revision || !page.browserInstanceId) return null;
  const brief = currentBrief(state, projectId),
    draft = currentWorkflowDraft(state, projectId),
    workflow = currentWorkflow(state, projectId);
  const tools = PROJECT_CAPABILITIES.filter((descriptor) => matchesRoute(descriptor.route, page.route))
    .filter((descriptor) => resourceAvailable(descriptor, brief, draft, workflow))
    .filter(
      (descriptor) =>
        !descriptor.id.startsWith('project.workflow.') ||
        (page.surfaceId === workflowAssistSurfaceId(workflow.id) &&
          page.revision === workflowAssistSurfaceRevision(workflow))
    )
    .map((descriptor) => {
      const type = descriptorResourceType(descriptor),
        resource =
          type === 'brief'
            ? { key: 'brief_id', id: brief.id }
            : type === 'workflow_draft'
              ? { key: 'workflow_draft_id', id: draft.id }
              : { key: 'workflow_id', id: workflow.id };
      return {
        type: 'function',
        name: assistCapabilityToolName(descriptor),
        description: `${descriptor.label_zh}。仅操作当前页面中已登记的${descriptor.locator_label}，并使用 expected_revision 进行原子并发控制。${type === 'workflow' ? '该工具只创建 Change Proposal，用户批准前不得声称正式工作流已修改；多节点重构应优先使用 workflow_graph_patch 一次提交。' : type === 'workflow_draft' ? STARTUP_WORKFLOW_POLICY : ''}`,
        inputSchema: bindInputSchema(descriptor.input_schema, {
          project_id: projectId,
          [resource.key]: resource.id,
          route: page.route,
          surface_id: page.surfaceId,
          surface_revision: page.revision,
          browser_instance_id: page.browserInstanceId,
          expected_revision: Number(
            type === 'workflow' ? workflow.version || 1 : type === 'brief' ? brief.revision : draft.revision
          )
        })
      };
    });
  return tools.length
    ? {
        type: 'namespace',
        name: PROJECT_TOOL_NAMESPACE,
        description:
          'Versioned project Brief, initial WorkflowDraft, and formal workflow Change Proposal operations for the exact current AIWS surface.',
        tools
      }
    : null;
}

export function prepareProjectCapabilityOperation(state, session, turn, params = {}) {
  const namespace = cleanText(params.namespace, 100),
    tool = cleanText(params.tool, 100);
  const descriptor = namespace === PROJECT_TOOL_NAMESPACE ? assistCapabilityForToolName(tool) : null;
  if (!descriptor) throw new HttpError(400, { error: 'assist_dynamic_tool_not_allowed' });
  assertCapabilityTurnScope(session, turn);
  const args = capabilityArguments(params, descriptor);
  const page = requireCapabilityPage(turn);
  assertCapabilityPageScope(descriptor, args, turn, page);
  const expectedRevision = requireExpectedRevision(args);
  const resourceType = descriptorResourceType(descriptor);
  const scope = requireCapabilityResource(state, turn.project_id, resourceType);
  assertCapabilityResourceScope(args, page, resourceType, scope, expectedRevision);
  const { operations, primary } = capabilityOperations(descriptor, args, resourceType);
  if (resourceType === 'workflow_draft') assertStartupWorkflowOperations(scope.resource.nodes, operations);
  const target = initialTarget(resourceType, primary, scope.resource);
  const reference = assertOperationReference(state, turn, descriptor, target.id, page, resourceType, scope.resource.id);
  return preparedCapabilityResult({
    state,
    turn,
    descriptor,
    tool,
    page,
    expectedRevision,
    resourceType,
    resource: scope.resource,
    resourceIdKey: scope.resourceIdKey,
    operations,
    primary,
    target,
    reference
  });
}

function assertCapabilityTurnScope(session, turn) {
  if (turn.collaboration_mode === 'plan' || turn.mode === 'plan')
    throw new HttpError(409, { error: 'assist_plan_capability_write_forbidden' });
  if (turn.session_id !== session.id || turn.project_id !== session.project_id)
    throw new HttpError(409, { error: 'assist_turn_scope_mismatch' });
}

function capabilityArguments(params, descriptor) {
  const args = plainObject(params.arguments, 'assist_capability_arguments_invalid');
  assertArgumentKeys(args, descriptor.input_schema);
  return args;
}

function requireCapabilityPage(turn) {
  const page = pageIdentity(turn.view_context);
  if (!page.route || !page.surfaceId || !page.revision || !page.browserInstanceId)
    throw new HttpError(409, { error: 'assist_page_surface_revision_required' });
  return page;
}

function assertCapabilityPageScope(descriptor, args, turn, page) {
  assertSame(cleanText(args.project_id, 200), turn.project_id, 'assist_capability_project_scope_mismatch');
  assertSame(cleanText(args.route, 2_000), page.route, 'assist_capability_route_mismatch');
  assertSame(cleanText(args.surface_id, 200), page.surfaceId, 'assist_capability_surface_mismatch');
  assertSame(cleanText(args.surface_revision, 200), page.revision, 'assist_capability_surface_revision_mismatch');
  assertSame(cleanText(args.browser_instance_id, 200), page.browserInstanceId, 'assist_capability_browser_mismatch');
  if (!matchesRoute(descriptor.route, page.route) || routeProjectId(page.route) !== turn.project_id)
    throw new HttpError(409, { error: 'assist_capability_route_scope_mismatch' });
}

function requireExpectedRevision(args) {
  const expectedRevision = args.expected_revision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new HttpError(400, { error: 'expected_revision_required' });
  return expectedRevision;
}

function requireCapabilityResource(state, projectId, resourceType) {
  const rawResource =
    resourceType === 'brief'
      ? currentBrief(state, projectId)
      : resourceType === 'workflow_draft'
        ? currentWorkflowDraft(state, projectId)
        : currentWorkflow(state, projectId);
  const resource = resourceType === 'workflow' && rawResource ? workflowResource(state, rawResource) : rawResource;
  if (!resource) throw new HttpError(404, { error: capabilityResourceNotFoundCode(resourceType) });
  return { rawResource, resource, resourceIdKey: capabilityResourceIdKey(resourceType) };
}

function capabilityResourceNotFoundCode(resourceType) {
  if (resourceType === 'brief') return 'project_brief_not_found';
  return resourceType === 'workflow' ? 'workflow_not_found' : 'workflow_draft_not_found';
}

function capabilityResourceIdKey(resourceType) {
  if (resourceType === 'brief') return 'brief_id';
  return resourceType === 'workflow_draft' ? 'workflow_draft_id' : 'workflow_id';
}

function assertCapabilityResourceScope(args, page, resourceType, scope, expectedRevision) {
  if (resourceType === 'workflow') {
    assertSame(page.surfaceId, workflowAssistSurfaceId(scope.rawResource.id), 'assist_capability_surface_mismatch');
    assertSame(
      page.revision,
      workflowAssistSurfaceRevision(scope.rawResource),
      'assist_capability_surface_revision_mismatch'
    );
  }
  assertSame(cleanText(args[scope.resourceIdKey], 200), scope.resource.id, 'assist_capability_resource_scope_mismatch');
  if (resourceType === 'workflow' && expectedRevision !== Number(scope.resource.revision))
    throw new HttpError(409, {
      error: 'workflow_graph_revision_conflict',
      expected_revision: expectedRevision,
      current_revision: Number(scope.resource.revision)
    });
}

function capabilityOperations(descriptor, args, resourceType) {
  let operations, primary;
  if (descriptor.id === 'project.workflow.graph.patch') {
    if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 100)
      throw new HttpError(400, { error: 'assist_capability_operations_invalid' });
    operations = structuredClone(args.operations);
    for (const operation of operations) normalizeCreatedId(resourceType, operation);
    primary = { type: 'patch_graph' };
  } else {
    primary = structuredClone(plainObject(args.operation, 'assist_capability_operation_invalid'));
    const expectedType = descriptor.input_schema.properties.operation.properties.type.const;
    if (primary.type !== expectedType)
      throw new HttpError(400, {
        error: 'assist_capability_action_mismatch',
        expected: expectedType,
        received: primary.type || null
      });
    normalizeCreatedId(resourceType, primary);
    operations = [primary];
  }
  return { operations, primary };
}

function preparedCapabilityResult(input) {
  const { turn, descriptor, tool, page, expectedRevision, resourceType, resource, operations, primary, target } = input;
  return {
    descriptor,
    tool,
    targetId: target.id,
    targetLabel: target.label,
    inputSchema: bindInputSchema(descriptor.input_schema, {
      project_id: turn.project_id,
      [input.resourceIdKey]: resource.id,
      route: page.route,
      surface_id: page.surfaceId,
      surface_revision: page.revision,
      browser_instance_id: page.browserInstanceId,
      expected_revision: Number(resource.revision)
    }),
    request: {
      project_id: turn.project_id,
      resource_type: resourceType,
      resource_id: resource.id,
      expected_revision: expectedRevision,
      operations,
      primary_type: primary.type,
      target_id: target.id,
      value_kind: valueKind(resourceType, primary.type),
      route: page.route,
      surface_id: page.surfaceId,
      surface_revision: page.revision,
      browser_instance_id: page.browserInstanceId,
      replaces_proposal_id: pendingProposalId(input.state, input.reference)
    }
  };
}

function assertOperationReference(state, turn, descriptor, targetId, page, resourceType, resourceId) {
  if (!turn.operation_reference_id) return null;
  const reference = state.assist_operations.find((item) => item.id === turn.operation_reference_id);
  if (!reference) throw new HttpError(404, { error: 'assist_operation_reference_not_found' });
  assertOperationReferenceScope(reference, turn, page);
  if (reference.target_id !== targetId)
    throw new HttpError(409, { error: 'assist_operation_reference_target_mismatch' });
  assertOperationReferenceResource(reference, resourceType, resourceId);
  if (!descriptor.id.startsWith(capabilityPrefix(resourceType)))
    throw new HttpError(409, { error: 'assist_operation_reference_capability_mismatch' });
  assertOperationReferenceProposal(state, reference, resourceType, resourceId);
  return reference;
}

function assertOperationReferenceScope(reference, turn, page) {
  const matches =
    reference.session_id === turn.session_id &&
    reference.project_id === turn.project_id &&
    reference.route === page.route &&
    reference.surface_id === page.surfaceId &&
    reference.surface_revision === page.revision;
  if (!matches) throw new HttpError(409, { error: 'assist_operation_reference_scope_mismatch' });
}

function assertOperationReferenceResource(reference, resourceType, resourceId) {
  if (!reference.domain_request) return;
  const matches =
    reference.domain_request.resource_type === resourceType && reference.domain_request.resource_id === resourceId;
  if (!matches) throw new HttpError(409, { error: 'assist_operation_reference_resource_mismatch' });
}

function capabilityPrefix(resourceType) {
  if (resourceType === 'brief') return 'project.brief.';
  return resourceType === 'workflow' ? 'project.workflow.' : 'project.workflow_draft.';
}

function assertOperationReferenceProposal(state, reference, resourceType, resourceId) {
  if (resourceType !== 'workflow' || !reference.proposal_id) return;
  const proposal = state.change_proposals.find((item) => item.id === reference.proposal_id);
  const matches =
    proposal && (proposal.workflow_id === resourceId || proposal.apply_action?.workflow_id === resourceId);
  if (!matches) throw new HttpError(409, { error: 'assist_operation_reference_proposal_scope_mismatch' });
}

function descriptorResourceType(descriptor) {
  return descriptor.id.startsWith('project.brief.')
    ? 'brief'
    : descriptor.id.startsWith('project.workflow_draft.')
      ? 'workflow_draft'
      : 'workflow';
}
function resourceAvailable(descriptor, brief, draft, workflow) {
  const type = descriptorResourceType(descriptor);
  return type === 'brief' ? Boolean(brief) : type === 'workflow_draft' ? Boolean(draft) : Boolean(workflow);
}
function pendingProposalId(state, operation) {
  if (!operation?.proposal_id) return null;
  return (
    state.change_proposals.find((item) => item.id === operation.proposal_id && item.status === 'pending')?.id || null
  );
}
