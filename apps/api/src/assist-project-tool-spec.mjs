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
  if (turn.collaboration_mode === 'plan' || turn.mode === 'plan')
    throw new HttpError(409, { error: 'assist_plan_capability_write_forbidden' });
  if (turn.session_id !== session.id || turn.project_id !== session.project_id)
    throw new HttpError(409, { error: 'assist_turn_scope_mismatch' });
  const args = plainObject(params.arguments, 'assist_capability_arguments_invalid');
  assertArgumentKeys(args, descriptor.input_schema);
  const page = pageIdentity(turn.view_context);
  if (!page.route || !page.surfaceId || !page.revision || !page.browserInstanceId)
    throw new HttpError(409, { error: 'assist_page_surface_revision_required' });
  assertSame(cleanText(args.project_id, 200), turn.project_id, 'assist_capability_project_scope_mismatch');
  assertSame(cleanText(args.route, 2_000), page.route, 'assist_capability_route_mismatch');
  assertSame(cleanText(args.surface_id, 200), page.surfaceId, 'assist_capability_surface_mismatch');
  assertSame(cleanText(args.surface_revision, 200), page.revision, 'assist_capability_surface_revision_mismatch');
  assertSame(cleanText(args.browser_instance_id, 200), page.browserInstanceId, 'assist_capability_browser_mismatch');
  if (!matchesRoute(descriptor.route, page.route) || routeProjectId(page.route) !== turn.project_id)
    throw new HttpError(409, { error: 'assist_capability_route_scope_mismatch' });
  const expectedRevision = args.expected_revision;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new HttpError(400, { error: 'expected_revision_required' });
  const resourceType = descriptorResourceType(descriptor);
  const rawResource =
    resourceType === 'brief'
      ? currentBrief(state, turn.project_id)
      : resourceType === 'workflow_draft'
        ? currentWorkflowDraft(state, turn.project_id)
        : currentWorkflow(state, turn.project_id);
  const resource = resourceType === 'workflow' && rawResource ? workflowResource(state, rawResource) : rawResource;
  if (!resource)
    throw new HttpError(404, {
      error:
        resourceType === 'brief'
          ? 'project_brief_not_found'
          : resourceType === 'workflow'
            ? 'workflow_not_found'
            : 'workflow_draft_not_found'
    });
  if (resourceType === 'workflow') {
    assertSame(page.surfaceId, workflowAssistSurfaceId(rawResource.id), 'assist_capability_surface_mismatch');
    assertSame(
      page.revision,
      workflowAssistSurfaceRevision(rawResource),
      'assist_capability_surface_revision_mismatch'
    );
  }
  const resourceIdKey =
    resourceType === 'brief' ? 'brief_id' : resourceType === 'workflow_draft' ? 'workflow_draft_id' : 'workflow_id';
  assertSame(cleanText(args[resourceIdKey], 200), resource.id, 'assist_capability_resource_scope_mismatch');
  if (resourceType === 'workflow' && expectedRevision !== Number(resource.revision))
    throw new HttpError(409, {
      error: 'workflow_graph_revision_conflict',
      expected_revision: expectedRevision,
      current_revision: Number(resource.revision)
    });
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
  if (resourceType === 'workflow_draft') assertStartupWorkflowOperations(resource.nodes, operations);
  const target = initialTarget(resourceType, primary, resource),
    reference = assertOperationReference(state, turn, descriptor, target.id, page, resourceType, resource.id);
  return {
    descriptor,
    tool,
    targetId: target.id,
    targetLabel: target.label,
    inputSchema: bindInputSchema(descriptor.input_schema, {
      project_id: turn.project_id,
      [resourceIdKey]: resource.id,
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
      replaces_proposal_id: pendingProposalId(state, reference)
    }
  };
}

function assertOperationReference(state, turn, descriptor, targetId, page, resourceType, resourceId) {
  if (!turn.operation_reference_id) return null;
  const reference = state.assist_operations.find((item) => item.id === turn.operation_reference_id);
  if (!reference) throw new HttpError(404, { error: 'assist_operation_reference_not_found' });
  if (
    reference.session_id !== turn.session_id ||
    reference.project_id !== turn.project_id ||
    reference.route !== page.route ||
    reference.surface_id !== page.surfaceId ||
    reference.surface_revision !== page.revision
  )
    throw new HttpError(409, { error: 'assist_operation_reference_scope_mismatch' });
  if (reference.target_id !== targetId)
    throw new HttpError(409, { error: 'assist_operation_reference_target_mismatch' });
  if (
    reference.domain_request &&
    (reference.domain_request.resource_type !== resourceType || reference.domain_request.resource_id !== resourceId)
  )
    throw new HttpError(409, { error: 'assist_operation_reference_resource_mismatch' });
  const prefix =
    resourceType === 'brief'
      ? 'project.brief.'
      : resourceType === 'workflow'
        ? 'project.workflow.'
        : 'project.workflow_draft.';
  if (!descriptor.id.startsWith(prefix))
    throw new HttpError(409, { error: 'assist_operation_reference_capability_mismatch' });
  if (resourceType === 'workflow' && reference.proposal_id) {
    const proposal = state.change_proposals.find((item) => item.id === reference.proposal_id);
    if (!proposal || (proposal.workflow_id !== resourceId && proposal.apply_action?.workflow_id !== resourceId))
      throw new HttpError(409, { error: 'assist_operation_reference_proposal_scope_mismatch' });
  }
  return reference;
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
