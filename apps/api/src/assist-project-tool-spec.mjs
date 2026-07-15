import {
  ASSIST_CAPABILITY_MANIFEST, assistCapabilityForToolName, assistCapabilityToolName
} from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { cleanText } from './assist-v3-domain.mjs';
import {
  assertArgumentKeys, assertSame, bindInputSchema, currentBrief, currentWorkflowDraft, initialTarget, matchesRoute,
  normalizeCreatedId, pageIdentity, plainObject, routeProjectId, valueKind
} from './assist-project-tool-context.mjs';

export const PROJECT_TOOL_NAMESPACE = 'aiws_project';
export const PROJECT_CAPABILITIES = Object.freeze(ASSIST_CAPABILITY_MANIFEST.filter((item) => item.id.startsWith('project.')));

export function projectCapabilityToolSpec(state, projectId, viewContext) {
  const page = pageIdentity(viewContext);
  if (!projectId || !page.route || !page.surfaceId || !page.revision || !page.browserInstanceId) return null;
  const brief = currentBrief(state, projectId), draft = currentWorkflowDraft(state, projectId);
  const tools = PROJECT_CAPABILITIES.filter((descriptor) => matchesRoute(descriptor.route, page.route))
    .filter((descriptor) => descriptor.id.startsWith('project.brief.') ? Boolean(brief) : Boolean(draft))
    .map((descriptor) => {
      const resource = descriptor.id.startsWith('project.brief.') ? { key: 'brief_id', id: brief.id } : { key: 'workflow_draft_id', id: draft.id };
      return {
        type: 'function', name: assistCapabilityToolName(descriptor),
        description: `${descriptor.label_zh}。仅操作当前页面中已登记的${descriptor.locator_label}，并使用 expected_revision 进行原子并发控制。`,
        inputSchema: bindInputSchema(descriptor.input_schema, { project_id: projectId, [resource.key]: resource.id, route: page.route, surface_id: page.surfaceId, surface_revision: page.revision, browser_instance_id: page.browserInstanceId })
      };
    });
  return tools.length ? { type: 'namespace', name: PROJECT_TOOL_NAMESPACE, description: 'Versioned project Brief and initial WorkflowDraft operations for the exact current AIWS surface.', tools } : null;
}

export function prepareProjectCapabilityOperation(state, session, turn, params = {}) {
  const namespace = cleanText(params.namespace, 100), tool = cleanText(params.tool, 100);
  const descriptor = namespace === PROJECT_TOOL_NAMESPACE ? assistCapabilityForToolName(tool) : null;
  if (!descriptor) throw new HttpError(400, { error: 'assist_dynamic_tool_not_allowed' });
  if (turn.collaboration_mode === 'plan' || turn.mode === 'plan') throw new HttpError(409, { error: 'assist_plan_capability_write_forbidden' });
  if (turn.session_id !== session.id || turn.project_id !== session.project_id) throw new HttpError(409, { error: 'assist_turn_scope_mismatch' });
  const args = plainObject(params.arguments, 'assist_capability_arguments_invalid'); assertArgumentKeys(args, descriptor.input_schema);
  const page = pageIdentity(turn.view_context);
  if (!page.route || !page.surfaceId || !page.revision || !page.browserInstanceId) throw new HttpError(409, { error: 'assist_page_surface_revision_required' });
  assertSame(cleanText(args.project_id, 200), turn.project_id, 'assist_capability_project_scope_mismatch');
  assertSame(cleanText(args.route, 2_000), page.route, 'assist_capability_route_mismatch');
  assertSame(cleanText(args.surface_id, 200), page.surfaceId, 'assist_capability_surface_mismatch');
  assertSame(cleanText(args.surface_revision, 200), page.revision, 'assist_capability_surface_revision_mismatch');
  assertSame(cleanText(args.browser_instance_id, 200), page.browserInstanceId, 'assist_capability_browser_mismatch');
  if (!matchesRoute(descriptor.route, page.route) || routeProjectId(page.route) !== turn.project_id) throw new HttpError(409, { error: 'assist_capability_route_scope_mismatch' });
  const expectedRevision = Number(args.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new HttpError(400, { error: 'expected_revision_required' });
  const primary = structuredClone(plainObject(args.operation, 'assist_capability_operation_invalid'));
  const expectedType = descriptor.input_schema.properties.operation.properties.type.const;
  if (primary.type !== expectedType) throw new HttpError(400, { error: 'assist_capability_action_mismatch', expected: expectedType, received: primary.type || null });
  const resourceType = descriptor.id.startsWith('project.brief.') ? 'brief' : 'workflow_draft';
  const resource = resourceType === 'brief' ? currentBrief(state, turn.project_id) : currentWorkflowDraft(state, turn.project_id);
  if (!resource) throw new HttpError(404, { error: resourceType === 'brief' ? 'project_brief_not_found' : 'workflow_draft_not_found' });
  const resourceIdKey = resourceType === 'brief' ? 'brief_id' : 'workflow_draft_id';
  assertSame(cleanText(args[resourceIdKey], 200), resource.id, 'assist_capability_resource_scope_mismatch');
  normalizeCreatedId(resourceType, primary);
  const target = initialTarget(resourceType, primary, resource); assertOperationReference(state, turn, descriptor, target.id, page, resourceType, resource.id);
  return {
    descriptor, tool, targetId: target.id, targetLabel: target.label,
    inputSchema: bindInputSchema(descriptor.input_schema, { project_id: turn.project_id, [resourceIdKey]: resource.id, route: page.route, surface_id: page.surfaceId, surface_revision: page.revision, browser_instance_id: page.browserInstanceId }),
    request: { project_id: turn.project_id, resource_type: resourceType, resource_id: resource.id, expected_revision: expectedRevision, operations: [primary], primary_type: primary.type, target_id: target.id, value_kind: valueKind(resourceType, primary.type), route: page.route, surface_id: page.surfaceId, surface_revision: page.revision, browser_instance_id: page.browserInstanceId }
  };
}

function assertOperationReference(state, turn, descriptor, targetId, page, resourceType, resourceId) {
  if (!turn.operation_reference_id) return;
  const reference = state.assist_operations.find((item) => item.id === turn.operation_reference_id);
  if (!reference) throw new HttpError(404, { error: 'assist_operation_reference_not_found' });
  if (reference.session_id !== turn.session_id || reference.project_id !== turn.project_id || reference.route !== page.route || reference.surface_id !== page.surfaceId || reference.surface_revision !== page.revision) throw new HttpError(409, { error: 'assist_operation_reference_scope_mismatch' });
  if (reference.target_id !== targetId) throw new HttpError(409, { error: 'assist_operation_reference_target_mismatch' });
  if (reference.domain_request && (reference.domain_request.resource_type !== resourceType || reference.domain_request.resource_id !== resourceId)) throw new HttpError(409, { error: 'assist_operation_reference_resource_mismatch' });
  if (!descriptor.id.startsWith(resourceType === 'brief' ? 'project.brief.' : 'project.workflow_draft.')) throw new HttpError(409, { error: 'assist_operation_reference_capability_mismatch' });
}
