import { id } from '../../../packages/shared/index.mjs';
import { HttpError } from './http.mjs';
import { cleanText } from './assist-v3-domain.mjs';
import { currentProjectWorkflow, workflowGraphSnapshot } from './workflow-graph-service.mjs';

export function bindInputSchema(source, values) {
  const schema = structuredClone(source);
  for (const [key, value] of Object.entries(values))
    schema.properties[key] = { ...schema.properties[key], enum: [value] };
  return schema;
}
export function currentBrief(state, projectId) {
  return (
    state.project_briefs
      .filter((item) => item.project_id === projectId && item.status !== 'superseded')
      .sort(
        (a, b) => Number(b.version || 0) - Number(a.version || 0) || Number(b.revision || 0) - Number(a.revision || 0)
      )[0] || null
  );
}
export function currentWorkflowDraft(state, projectId) {
  return state.workflow_drafts.find((item) => item.project_id === projectId && item.status !== 'activated') || null;
}
export function currentWorkflow(state, projectId) {
  return currentProjectWorkflow(state, projectId);
}
export function workflowResource(state, workflow) {
  const graph = workflowGraphSnapshot(state, workflow);
  return graph
    ? {
        ...structuredClone(workflow),
        revision: Number(workflow.version || 1),
        nodes: graph.nodes.map((node) => ({ ...node, dependency_ids: [...node.dependency_ids] }))
      }
    : null;
}
export function requireResource(state, request) {
  let resource;
  if (request.resource_type === 'brief')
    resource = state.project_briefs.find(
      (item) =>
        item.id === request.resource_id && item.project_id === request.project_id && item.status !== 'superseded'
    );
  else if (request.resource_type === 'workflow_draft')
    resource = state.workflow_drafts.find(
      (item) => item.id === request.resource_id && item.project_id === request.project_id && item.status !== 'activated'
    );
  else {
    const workflow = state.workflows.find(
      (item) => item.id === request.resource_id && item.project_id === request.project_id && item.status !== 'archived'
    );
    resource = workflow ? workflowResource(state, workflow) : null;
  }
  if (!resource)
    throw new HttpError(404, {
      error:
        request.resource_type === 'brief'
          ? 'project_brief_not_found'
          : request.resource_type === 'workflow'
            ? 'workflow_not_found'
            : 'workflow_draft_not_found'
    });
  return resource;
}
export function resourceSnapshot(resource) {
  return structuredClone(resource);
}
export function resourceValue(resourceType, resource) {
  return resourceType === 'brief' ? resource.content : resource.nodes;
}
export function sectionIndex(resource, targetId) {
  return resource.content.sections.findIndex((item) => item.id === targetId);
}
export function nodeIndex(resource, targetId) {
  return resource.nodes.findIndex((item) => item.id === targetId);
}
export function routeProjectId(route) {
  const match = String(route)
    .split(/[?#]/)[0]
    .match(/^\/projects\/([^/]+)\/(?:onboarding|workflow)\/?$/);
  try {
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}
export function matchesRoute(pattern, route) {
  const escaped = pattern
    .split('/')
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}(?:/)?$`).test(String(route).split(/[?#]/)[0]);
}
export function pageIdentity(viewContext) {
  return {
    route: cleanText(viewContext?.route, 2_000),
    surfaceId: cleanText(viewContext?.surface?.id || viewContext?.surface?.surface_id, 200) || null,
    revision: cleanText(viewContext?.surface?.revision, 200),
    browserInstanceId:
      cleanText(viewContext?.browser_instance_id || viewContext?.surface?.browser_instance_id, 200) || null
  };
}
export function assertSame(value, expected, error) {
  if (!value || value !== expected) throw new HttpError(409, { error, expected, received: value || null });
}
export function plainObject(value, error) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, { error });
  return value;
}
export function assertArgumentKeys(args, schema) {
  const allowed = new Set(Object.keys(schema.properties || {}));
  for (const key of Object.keys(args))
    if (!allowed.has(key)) throw new HttpError(400, { error: 'assist_capability_argument_not_allowed', field: key });
  for (const key of schema.required || [])
    if (args[key] === undefined || args[key] === null || args[key] === '')
      throw new HttpError(400, { error: 'assist_capability_argument_required', field: key });
}
export function normalizeCreatedId(resourceType, operation) {
  if (resourceType === 'brief' && operation.type === 'add_section') {
    operation.section = plainObject(operation.section || {}, 'brief_section_required');
    operation.section.id ||= id('brs');
  }
  if (['workflow_draft', 'workflow'].includes(resourceType) && operation.type === 'add_node') {
    operation.node = plainObject(operation.node || {}, 'workflow_node_required');
    operation.node.id ||= id(resourceType === 'workflow' ? 'wfn' : 'wfdn');
  }
}
export function targetLabel(resourceType, targetId, resource) {
  return resourceType === 'brief'
    ? resource.content.sections.find((item) => item.id === targetId)?.title || null
    : resource.nodes.find((item) => item.id === targetId)?.title || null;
}
export function initialTarget(resourceType, operation, resource) {
  if (resourceType === 'brief') {
    const targetId =
      operation.type === 'add_section'
        ? operation.section.id
        : cleanText(operation.section_id || operation.id, 120) || resource.id;
    return {
      id: targetId,
      label: targetLabel(resourceType, targetId, resource) || cleanText(operation.section?.title, 200) || '项目简报'
    };
  }
  const graphTarget = operation.type === 'patch_graph' || operation.type === 'reorder_nodes';
  const targetId =
    operation.type === 'add_node'
      ? operation.node.id
      : graphTarget
        ? resource.id
        : cleanText(operation.node_id || operation.id, 120) || resource.id;
  return {
    id: targetId,
    label:
      targetLabel(resourceType, targetId, resource) ||
      cleanText(operation.node?.title, 200) ||
      (resourceType === 'workflow' ? resource.title || '正式工作流' : '初始工作流')
  };
}
export function valueKind(resourceType, type) {
  if (resourceType === 'brief')
    return type === 'rename_section'
      ? 'brief_section_title'
      : type === 'move_section'
        ? 'brief_section_index'
        : 'brief_section';
  if (resourceType === 'workflow' && type === 'patch_graph') return 'workflow_graph';
  return type === 'reorder_nodes'
    ? 'workflow_order'
    : ['connect', 'disconnect'].includes(type)
      ? 'workflow_dependencies'
      : 'workflow_node';
}
export function targetValue(resourceType, kind, targetId, resource) {
  if (resourceType === 'brief') {
    const section = resource.content.sections.find((item) => item.id === targetId);
    if (kind === 'brief_section_title') return section?.title ?? null;
    if (kind === 'brief_section_index') return section ? sectionIndex(resource, targetId) : null;
    return section ? structuredClone(section) : null;
  }
  const node = resource.nodes.find((item) => item.id === targetId);
  if (kind === 'workflow_graph')
    return { workflow_id: resource.id, revision: resource.revision, nodes: structuredClone(resource.nodes) };
  if (kind === 'workflow_order') return resource.nodes.map((item) => item.id);
  if (kind === 'workflow_dependencies') return node ? [...node.dependency_ids] : null;
  return node ? structuredClone(node) : null;
}
export function sectionPatch(value, current) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (current?.type === 'markdown') return { markdown: String(value ?? '') };
  if (current?.type === 'list' && Array.isArray(value)) return { items: value };
  throw new HttpError(400, { error: 'assist_operation_revision_value_invalid' });
}
export function requiredText(value) {
  const text = cleanText(value, 200);
  if (!text) throw new HttpError(400, { error: 'assist_operation_revision_value_invalid' });
  return text;
}
export function requiredIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0)
    throw new HttpError(400, { error: 'assist_operation_revision_value_invalid' });
  return index;
}
export function stringArray(value) {
  if (!Array.isArray(value)) throw new HttpError(400, { error: 'assist_operation_revision_value_invalid' });
  return [...new Set(value.map((item) => cleanText(item, 120)).filter(Boolean))];
}
